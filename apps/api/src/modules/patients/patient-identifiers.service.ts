import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { assertPatientVisible, isRestricted } from "../../common/data-scope";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

/** What staff may add. The MRN is made by the system, and an ABHA number is recorded through the ABDM screen (docs/abdm.md). */
const ADDABLE = ["LEGACY", "EXTERNAL"] as const;

/** Upper case, one space between words: "wb  12/ab" and "WB 12/AB" are the same number. */
const normalise = (v: string) => v.trim().replace(/\s+/g, " ").toUpperCase();

export const addIdentifierSchema = z.object({
  type: z.enum(ADDABLE),
  value: z.string().transform(normalise).pipe(z.string().regex(/^[A-Z0-9][A-Z0-9 ./_-]{1,39}$/, "2 to 40 letters, digits, space . / _ -")),
  /** Who issued it: the previous system, an insurer, a scheme. Needed for an "other" ID so it can be told apart. */
  issuer: z.string().trim().min(2).max(60).optional(),
}).strict().superRefine((v, c) => {
  if (v.type === "EXTERNAL" && !v.issuer) c.addIssue({ code: "custom", path: ["issuer"], message: "Say who issued it (for example the insurer or scheme)" });
  if (v.issuer && /aadhaar|aadhar|uidai/i.test(v.issuer)) c.addIssue({ code: "custom", path: ["issuer"], message: "Aadhaar numbers are not stored in MedOS" });
});
export const removeIdentifierSchema = z.object({ reason: z.string().trim().min(3, "Say why").max(200) }).strict();

const SELECT = { id: true, type: true, value: true, issuer: true, createdAt: true } as const;

/**
 * The extra numbers a patient is known by (docs/patient-identifiers.md). The MRN is one row of the same table and never changes. Others are added by staff with
 * PATIENT_UPDATE, are unique in the hospital while in use, are never edited, and are retired (not deleted) when wrong. Search finds a patient by any of them.
 */
@Injectable()
export class PatientIdentifiersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async patient(db: Db, ctx: RequestContext, patientId: string) {
    const p = await db.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true, mergedIntoId: true } });
    if (!p) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    await assertPatientVisible(db, ctx, patientId);
    return p;
  }

  /** This patient's numbers, and the ones that belonged to records merged into them (so an old number still leads here). Retired ones are left out. */
  async list(ctx: RequestContext, patientId: string) {
    await this.patient(this.prisma, ctx, patientId);
    const own = await this.prisma.patientIdentifier.findMany({ where: { tenantId: ctx.tenantId, patientId, removedAt: null }, select: SELECT, orderBy: [{ type: "asc" }, { createdAt: "asc" }] });
    const merged = await this.prisma.patientIdentifier.findMany({
      where: { tenantId: ctx.tenantId, removedAt: null, patient: { is: { tenantId: ctx.tenantId, mergedIntoId: patientId } } },
      select: { ...SELECT, patient: { select: { identifiers: { where: { type: "MRN" }, select: { value: true } } } } }, orderBy: { createdAt: "asc" },
    });
    return [
      ...own.map((i) => ({ ...i, fromMergedMrn: null as string | null, canRetire: i.type !== "MRN" })),
      ...merged.map(({ patient, ...i }) => ({ ...i, fromMergedMrn: patient.identifiers[0]?.value ?? null, canRetire: false })),
    ];
  }

  async add(ctx: RequestContext, patientId: string, input: z.infer<typeof addIdentifierSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const p = await this.patient(tx, ctx, patientId);
      if (p.mergedIntoId) throw new DomainError("PATIENT_MERGED", "This patient record was merged into another one. Add the number to the real patient.", 409);
      const clash = await tx.patientIdentifier.findFirst({
        where: { tenantId: ctx.tenantId, type: input.type, value: input.value, removedAt: null },
        select: { patientId: true, patient: { select: { identifiers: { where: { type: "MRN" }, select: { value: true } } } } },
      });
      if (clash) {
        if (clash.patientId === patientId) throw new DomainError("CONFLICT", "This number is already recorded for this patient", 409, [{ path: "value", message: "Already recorded" }]);
        const mrn = isRestricted(ctx) ? null : clash.patient.identifiers[0]?.value ?? null;
        throw new DomainError("CONFLICT", `This number is already recorded for another patient${mrn ? ` (MRN ${mrn})` : ""}. They may be the same person: check before adding it again.`, 409, [{ path: "value", message: "Used by another patient" }]);
      }
      const row = await tx.patientIdentifier.create({ data: { tenantId: ctx.tenantId, patientId, type: input.type, value: input.value, issuer: input.issuer ?? null, createdById: ctx.userId }, select: SELECT });
      // The number itself is not written to the audit trail, only what kind of number it is.
      await this.audit.record(tx, actorOf(ctx), { action: "PATIENT_IDENTIFIER_ADDED", entityType: "Patient", entityId: patientId, metadata: { identifierId: row.id, type: row.type, ...(row.issuer ? { issuer: row.issuer } : {}) } });
      return { ...row, fromMergedMrn: null, canRetire: true };
    });
  }

  async remove(ctx: RequestContext, patientId: string, identifierId: string, input: z.infer<typeof removeIdentifierSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.patient(tx, ctx, patientId);
      const row = await tx.patientIdentifier.findFirst({ where: { id: identifierId, tenantId: ctx.tenantId, patientId }, select: { id: true, type: true, removedAt: true } });
      if (!row) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (row.type === "MRN") throw new DomainError("INVALID_STATE", "The MRN cannot be removed", 409);
      if (row.type === "ABHA") throw new DomainError("INVALID_STATE", "An ABHA number is removed from the ABDM screen", 409);
      const done = await tx.patientIdentifier.updateMany({ where: { id: identifierId, tenantId: ctx.tenantId, patientId, removedAt: null }, data: { removedAt: new Date(), removedById: ctx.userId, removalReason: input.reason } });
      if (done.count !== 1) throw new DomainError("INVALID_STATE", "This number was already removed", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "PATIENT_IDENTIFIER_REMOVED", entityType: "Patient", entityId: patientId, metadata: { identifierId, type: row.type, reason: input.reason } });
      return { id: identifierId, removed: true };
    });
  }
}
