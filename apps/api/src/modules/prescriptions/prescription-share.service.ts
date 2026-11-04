import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { visitScope } from "../../common/data-scope";
import { tenantScope } from "../../common/tenant-scope";
import { PrintService, type PrintFormat, type Rendered } from "../print/print.service";

export const createShareSchema = z.object({ days: z.number().int().min(1).max(30).default(7) }).strict();

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const notValid = () => new DomainError("NOT_FOUND", "This link is not valid or has expired", 404);

/**
 * Giving a patient their signed prescription (docs/prescriptions.md): staff create a link, the patient opens it without signing in. Only a hash of the link's
 * secret is stored; the link expires (1 to 30 days), can be revoked, and every opening is counted and audited. The system sends nothing itself: the staff
 * member copies the link or opens WhatsApp with the message ready.
 */
@Injectable()
export class PrescriptionShareService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly print: PrintService) {}

  async create(ctx: RequestContext, encounterId: string, input: z.infer<typeof createShareSchema>) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true, patient: { select: { mobile: true } } } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const signed = (await this.prisma.clinicalDocument.count({ where: { tenantId: ctx.tenantId, encounterId, kind: "CONSULTATION", status: { not: "DRAFT" } } }))
      + (await this.prisma.medicationOrder.count({ where: { tenantId: ctx.tenantId, encounterId, status: "SIGNED", source: "DIGITAL" } }));
    if (signed === 0) throw new DomainError("INVALID_STATE", "Only a signed prescription can be shared with the patient", 409);
    const token = randomBytes(32).toString("base64url");
    const mobile = enc.patient.mobile?.replace(/\D/g, "") ?? "";
    const mask = mobile.length >= 4 ? `${"•".repeat(Math.max(0, mobile.length - 4))}${mobile.slice(-4)}` : null;
    const expiresAt = new Date(Date.now() + input.days * 86_400_000);
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await tx.prescriptionShare.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, patientId: enc.patientId, tokenHash: sha256(token), expiresAt, recipientMask: mask, createdById: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SHARED", entityType: "PrescriptionShare", entityId: r.id, metadata: { encounterId, days: input.days, recipient: mask } });
      return r;
    });
    return {
      id: row.id, expiresAt, recipientMask: mask,
      /** Shown once: the link cannot be recovered later, only replaced by a new one. */
      path: `/api/share/${token}`,
      /** Digits for a WhatsApp chat, only for staff who may see the patient's number. */
      whatsappNumber: ctx.permissions.has("PATIENT_READ") && mobile.length >= 10 ? (mobile.length === 10 ? `91${mobile}` : mobile) : null,
    };
  }

  async list(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.prescriptionShare.findMany({ where: { tenantId: ctx.tenantId, encounterId }, orderBy: { createdAt: "desc" }, take: 50 });
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id, status: r.status === "REVOKED" ? "REVOKED" : r.expiresAt.getTime() <= now ? "EXPIRED" : "ACTIVE", createdAt: r.createdAt, expiresAt: r.expiresAt, recipientMask: r.recipientMask,
      createdBy: users.get(r.createdById) ?? null, openCount: r.openCount, lastOpenedAt: r.lastOpenedAt,
    }));
  }

  async revoke(ctx: RequestContext, shareId: string) {
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.prescriptionShare.findFirst({ where: { id: shareId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!s) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (s.status === "REVOKED") throw new DomainError("INVALID_STATE", "This link was already revoked", 409);
      await tx.prescriptionShare.updateMany({ where: { id: s.id, tenantId: ctx.tenantId, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: new Date(), revokedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SHARE_REVOKED", entityType: "PrescriptionShare", entityId: s.id, metadata: { encounterId: s.encounterId } });
      return { id: s.id, status: "REVOKED" };
    });
  }

  /** The patient's side: no sign-in. The hospital is found from the link's hash, then everything runs in that hospital's own scope. */
  async open(token: string, format: PrintFormat, requestId: string): Promise<Rendered> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notValid();
    const found = await tenantScope.system("shared prescription link: find the hospital that issued it", () =>
      this.prisma.$queryRaw<{ tenant_id: string; share_id: string }[]>`SELECT tenant_id::text AS tenant_id, share_id::text AS share_id FROM medos_resolve_prescription_share(${sha256(token)})`);
    const hit = found[0];
    if (!hit) throw notValid();
    return tenantScope.run(hit.tenant_id, async () => {
      const share = await this.prisma.prescriptionShare.findFirst({ where: { id: hit.share_id, tenantId: hit.tenant_id } });
      if (!share || share.status !== "ACTIVE" || share.expiresAt.getTime() <= Date.now()) throw notValid();
      await this.prisma.$transaction(async (tx) => {
        await tx.prescriptionShare.updateMany({ where: { id: share.id, tenantId: share.tenantId }, data: { openCount: { increment: 1 }, lastOpenedAt: new Date() } });
        await this.audit.record(tx, { tenantId: share.tenantId, facilityId: share.facilityId, requestId }, { action: "PRESCRIPTION_SHARE_OPENED", entityType: "PrescriptionShare", entityId: share.id, metadata: { encounterId: share.encounterId, format } });
      });
      // The prescription is rendered with no permissions of its own; the link only ever reaches this one visit's prescription.
      return this.print.prescription({ tenantId: share.tenantId, facilityId: share.facilityId, userId: share.createdById, permissions: new Set(), requestId, dataScope: { kind: "ALL" } }, share.encounterId, format, { quiet: true });
    });
  }
}
