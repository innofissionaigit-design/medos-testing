import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { checklistOf, normLabel, type Checklist, type ClaimKind } from "./claim-checklist.domain";

const label = z.string().trim().min(2).max(60);
export const requiredDocumentSchema = z.object({ label, claimType: z.enum(["CASHLESS", "REIMBURSEMENT"]).nullable().default(null) }).strict();
export const requiredDocumentActiveSchema = z.object({ active: z.boolean() }).strict();
export const waiverSchema = z.object({ label, reason: z.string().trim().min(10).max(300) }).strict();

/** Statuses before the claim goes to the insurer: only then does the checklist matter. */
const NOT_SENT = ["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED"];

/**
 * The checklist for one claim: what the insurer requires (set per insurer), what is attached, and what a manager has waived with a reason. Used by the claim's
 * submit step so a claim cannot be sent with something missing, and by the screen.
 */
export async function checklistFor(db: Db, ctx: RequestContext, claim: { id: string; policyId: string; type: ClaimKind }): Promise<Checklist> {
  const policy = await db.patientPolicy.findFirst({ where: { id: claim.policyId, tenantId: ctx.tenantId }, select: { insurerId: true } });
  if (!policy) return { items: [], missing: [], complete: true };
  const [required, attached, waived] = await Promise.all([
    db.insurerRequiredDocument.findMany({ where: { tenantId: ctx.tenantId, insurerId: policy.insurerId, active: true }, orderBy: { createdAt: "asc" }, select: { id: true, label: true, claimType: true } }),
    db.claimDocument.findMany({ where: { tenantId: ctx.tenantId, claimId: claim.id, status: "ACTIVE" }, orderBy: { uploadedAt: "asc" }, select: { id: true, label: true } }),
    db.claimDocumentWaiver.findMany({ where: { tenantId: ctx.tenantId, claimId: claim.id }, select: { label: true, reason: true } }),
  ]);
  return checklistOf(required, attached, waived, claim.type);
}

/** Stops the claim being sent while a required document is missing. */
export async function assertDocumentsComplete(db: Db, ctx: RequestContext, claim: { id: string; policyId: string; type: ClaimKind }): Promise<void> {
  const c = await checklistFor(db, ctx, claim);
  if (!c.complete) throw new DomainError("CLAIM_DOCUMENTS_MISSING", `Attach the missing documents before sending the claim: ${c.missing.join(", ")}`, 409, c.missing.map((m) => ({ path: "documents", message: m })));
}

@Injectable()
export class ClaimChecklistService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async insurer(db: Db, ctx: RequestContext, insurerId: string) {
    const i = await db.insurer.findFirst({ where: { id: insurerId, tenantId: ctx.tenantId }, select: { id: true, name: true } });
    if (!i) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return i;
  }

  // ───── what each insurer requires ─────

  async required(ctx: RequestContext, insurerId: string) {
    await this.insurer(this.prisma, ctx, insurerId);
    const rows = await this.prisma.insurerRequiredDocument.findMany({ where: { tenantId: ctx.tenantId, insurerId }, orderBy: [{ active: "desc" }, { createdAt: "asc" }], select: { id: true, label: true, claimType: true, active: true, createdAt: true } });
    return { items: rows };
  }

  async addRequired(ctx: RequestContext, insurerId: string, input: z.infer<typeof requiredDocumentSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const ins = await this.insurer(tx, ctx, insurerId);
      const existing = (await tx.insurerRequiredDocument.findMany({ where: { tenantId: ctx.tenantId, insurerId } })).find((r) => normLabel(r.label) === normLabel(input.label) && r.claimType === input.claimType);
      if (existing?.active) throw new DomainError("VALIDATION_FAILED", "That document is already on the list", 409);
      const pick = { id: true, label: true, claimType: true, active: true } as const;
      const row = existing
        ? await tx.insurerRequiredDocument.update({ where: { id: existing.id }, data: { active: true }, select: pick })
        : await tx.insurerRequiredDocument.create({ data: { tenantId: ctx.tenantId, insurerId, label: input.label, claimType: input.claimType, createdById: ctx.userId }, select: pick });
      await this.audit.record(tx, actorOf(ctx), { action: "INSURER_REQUIRED_DOCUMENT_ADDED", entityType: "Insurer", entityId: insurerId, metadata: { insurer: ins.name, label: row.label, claimType: row.claimType } });
      return row;
    });
  }

  async setRequiredActive(ctx: RequestContext, requirementId: string, active: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.insurerRequiredDocument.findFirst({ where: { id: requirementId, tenantId: ctx.tenantId } });
      if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (r.active === active) return { id: r.id, label: r.label, claimType: r.claimType, active: r.active };
      const row = await tx.insurerRequiredDocument.update({ where: { id: r.id }, data: { active }, select: { id: true, label: true, claimType: true, active: true } });
      await this.audit.record(tx, actorOf(ctx), { action: active ? "INSURER_REQUIRED_DOCUMENT_ADDED" : "INSURER_REQUIRED_DOCUMENT_REMOVED", entityType: "Insurer", entityId: r.insurerId, metadata: { label: r.label, claimType: r.claimType } });
      return row;
    });
  }

  // ───── one claim ─────

  private async claimOf(db: Db, ctx: RequestContext, claimId: string) {
    const c = await db.claim.findFirst({ where: { id: claimId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, claimNumber: true, policyId: true, type: true, status: true } });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return c;
  }

  async checklist(ctx: RequestContext, claimId: string) {
    const c = await this.claimOf(this.prisma, ctx, claimId);
    return { claimId: c.id, status: c.status, ...(await checklistFor(this.prisma, ctx, c)) };
  }

  /** A manager decides one required document is not needed on this claim, and says why. Never undone. Only before the claim has been sent. */
  async waive(ctx: RequestContext, claimId: string, input: z.infer<typeof waiverSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.claimOf(tx, ctx, claimId);
      if (!NOT_SENT.includes(c.status)) throw new DomainError("INVALID_STATE", "This claim has already been sent", 409);
      const list = await checklistFor(tx, ctx, c);
      const item = list.items.find((i) => normLabel(i.label) === normLabel(input.label));
      if (!item) throw new DomainError("VALIDATION_FAILED", "That document is not on this claim's list", 400, [{ path: "label", message: "Not on the list" }]);
      if (item.state !== "MISSING") throw new DomainError("VALIDATION_FAILED", item.state === "WAIVED" ? "Already waived" : "Already attached", 409);
      await tx.claimDocumentWaiver.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, claimId, label: item.label, reason: input.reason, waivedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_DOCUMENT_WAIVED", entityType: "Claim", entityId: claimId, metadata: { claimNumber: c.claimNumber, label: item.label, reason: input.reason } });
      return { claimId, ...(await checklistFor(tx, ctx, c)) };
    });
  }
}
