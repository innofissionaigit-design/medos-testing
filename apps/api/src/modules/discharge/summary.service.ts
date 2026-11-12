import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { admissionScope } from "../../common/data-scope";
import { ClinicianService } from "../clinical/clinician.service";

const line = (max: number) => z.string().trim().min(1).max(max);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const summaryContentSchema = z.object({
  finalDiagnoses: z.array(z.object({ text: z.string().trim().min(2).max(200), code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9.\-]{0,19}$/).optional() }).strict()).max(20).default([]),
  hospitalCourse: z.string().trim().max(8000).optional(),
  procedures: z.array(z.object({ name: line(160), date: isoDay.optional(), notes: line(500).optional() }).strict()).max(30).default([]),
  investigationSummary: z.string().trim().max(4000).optional(),
  conditionAtDischarge: z.string().trim().max(500).optional(),
  dischargeMedications: z.array(z.object({
    genericName: line(120), brandName: line(120).optional(), strength: line(40).optional(), dosage: line(60), route: z.enum(["ORAL", "IV", "IM", "SC", "TOPICAL", "OTHER"]),
    frequency: z.enum(["OD", "BD", "TDS", "QID", "HS", "SOS", "STAT", "OTHER"]), durationDays: z.number().int().min(1).max(365).optional(), instructions: line(200).optional(),
  }).strict()).max(30).default([]),
  advice: z.string().trim().max(4000).optional(),
  followUp: z.object({ afterDays: z.number().int().min(1).max(365).optional(), date: isoDay.optional(), notes: z.string().trim().max(500).optional() }).strict().optional(),
}).strict();
export type SummaryContent = z.infer<typeof summaryContentSchema>;

export const saveSummarySchema = z.object({ content: summaryContentSchema, version: z.number().int().min(1).optional() }).strict();
export const signSummarySchema = z.object({ version: z.number().int().min(1) }).strict();
export const verifySummarySchema = z.object({ version: z.number().int().min(1), note: z.string().trim().min(3).max(300).optional() }).strict();
export const amendSummarySchema = z.object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().min(10).max(500), content: summaryContentSchema }).strict();

/** Drops null fields so a suggestion can be saved as-is under the strict content schema. */
const compact = <T extends Record<string, unknown>>(o: T): { [K in keyof T]?: NonNullable<T[K]> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as { [K in keyof T]?: NonNullable<T[K]> };

@Injectable()
export class SummaryService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly clinicians: ClinicianService) {}

  private async admission(db: Db, ctx: RequestContext, id: string) {
    const a = await db.admission.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
    if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return a;
  }

  /** The working document plus a scaffold of facts already in the record (never auto-signed). */
  async get(ctx: RequestContext, admissionId: string) {
    const adm = await this.prisma.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, include: { patient: { include: { identifiers: { where: { type: "MRN" } } } }, consultant: { select: { displayName: true } }, department: { select: { name: true } } } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const doc = await this.prisma.clinicalDocument.findFirst({
      where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, kind: "DISCHARGE_SUMMARY" },
      include: { versions: { orderBy: { version: "asc" }, select: { version: true, kind: true, reason: true, authorId: true, createdAt: true } } },
    });
    let content: unknown = doc?.draft ?? null;
    if (doc && doc.status !== "DRAFT") content = (await this.prisma.clinicalDocumentVersion.findFirstOrThrow({ where: { tenantId: ctx.tenantId, documentId: doc.id, version: doc.currentVersion } })).content;
    const [diagnoses, orders, procedures] = await Promise.all([
      this.prisma.diagnosis.findMany({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, status: "ACTIVE" }, select: { text: true, code: true } }),
      this.prisma.medicationOrderItem.findMany({ where: { tenantId: ctx.tenantId, status: "ACTIVE", order: { encounterId: adm.encounterId, status: "SIGNED" } }, orderBy: { lineNo: "asc" }, select: { genericName: true, brandName: true, strength: true, dosage: true, route: true, frequency: true, durationDays: true, instructions: true } }),
      this.prisma.charge.findMany({ where: { tenantId: ctx.tenantId, admissionId, type: "PROCEDURE", status: { not: "VOIDED" } }, orderBy: { chargedAt: "asc" }, select: { description: true, chargedAt: true } }),
    ]);
    const verification = doc && doc.status !== "DRAFT" ? await this.prisma.dischargeSummaryVerification.findFirst({ where: { tenantId: ctx.tenantId, documentId: doc.id, version: doc.currentVersion } }) : null;
    const names = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set([doc?.authorId, doc?.signedById, verification?.verifiedById, ...(doc?.versions.map((v) => v.authorId) ?? [])].filter((x): x is string => !!x))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return {
      admission: {
        id: adm.id, admissionNumber: adm.admissionNumber, admittedAt: adm.admittedAt, dischargedAt: adm.dischargedAt, status: adm.status, dischargeType: adm.dischargeType,
        patientName: [adm.patient.firstName, adm.patient.lastName].filter(Boolean).join(" "), mrn: adm.patient.identifiers[0]?.value ?? null, consultant: adm.consultant.displayName, department: adm.department?.name ?? null,
      },
      document: doc ? {
        id: doc.id, status: doc.status, version: doc.version, currentVersion: doc.currentVersion, content, signedAt: doc.signedAt, signedByName: doc.signedById ? names.get(doc.signedById) ?? null : null,
        preparedByName: names.get(doc.authorId) ?? null,
        verified: !!verification, verifiedAt: verification?.at ?? null, verifiedByName: verification ? names.get(verification.verifiedById) ?? null : null, verificationNote: verification?.note ?? null,
        versions: doc.versions.map((v) => ({ ...v, authorName: names.get(v.authorId) ?? null })),
      } : null,
      suggested: {
        finalDiagnoses: diagnoses.map((d) => compact(d)), dischargeMedications: orders.map((o) => compact(o)),
        procedures: procedures.map((p) => ({ name: p.description, date: p.chargedAt.toISOString().slice(0, 10) })),
      },
    };
  }

  async saveDraft(ctx: RequestContext, admissionId: string, input: z.infer<typeof saveSummarySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.admission(tx, ctx, admissionId);
      if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "The discharge summary can only be drafted while the patient is admitted", 409);
      const clinician = await this.clinicians.requireActive(tx, ctx);
      const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, kind: "DISCHARGE_SUMMARY" } });
      if (!doc) {
        if (input.version !== undefined && input.version !== 1) throw new DomainError("STALE_VERSION", "Reload and try again", 409);
        const created = await tx.clinicalDocument.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, encounterId: adm.encounterId, kind: "DISCHARGE_SUMMARY", authorId: ctx.userId, draft: input.content as Prisma.InputJsonObject } });
        await this.audit.record(tx, actorOf(ctx), { action: "DISCHARGE_SUMMARY_STARTED", entityType: "ClinicalDocument", entityId: created.id, metadata: { admissionId } });
        return { id: created.id, status: created.status, version: created.version, content: input.content };
      }
      if (doc.status !== "DRAFT") throw new DomainError("CONSULTATION_SIGNED", "The discharge summary is signed. Use an amendment.", 409);
      // The RMO prepares the draft and the treating consultant reviews and corrects it before signing, so both may change it; nobody else.
      if (doc.authorId !== ctx.userId && adm.consultantId !== clinician.id) throw new DomainError("FORBIDDEN", "This draft belongs to another doctor", 403);
      if (input.version !== doc.version) throw new DomainError("STALE_VERSION", "The summary was changed elsewhere. Reload and try again.", 409, { currentVersion: doc.version });
      const res = await tx.clinicalDocument.updateMany({ where: { id: doc.id, tenantId: ctx.tenantId, status: "DRAFT", version: doc.version }, data: { draft: input.content as Prisma.InputJsonObject, version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("STALE_VERSION", "The summary was changed elsewhere", 409);
      return { id: doc.id, status: doc.status, version: doc.version + 1, content: input.content };
    });
  }

  async sign(ctx: RequestContext, admissionId: string, input: z.infer<typeof signSummarySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.admission(tx, ctx, admissionId);
      if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "The admission is already closed", 409);
      const clinician = await this.clinicians.requireActive(tx, ctx);
      if (adm.consultantId !== clinician.id) throw new DomainError("FORBIDDEN", "Only the treating consultant can sign the discharge summary", 403);
      const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, kind: "DISCHARGE_SUMMARY" } });
      if (!doc) throw new DomainError("INVALID_STATE", "There is no discharge summary to sign", 409);
      if (doc.status !== "DRAFT") throw new DomainError("CONSULTATION_SIGNED", "The discharge summary is already signed", 409);
      if (doc.version !== input.version) throw new DomainError("STALE_VERSION", "The summary changed since you opened it. Review and sign again.", 409, { currentVersion: doc.version });
      const content = doc.draft as SummaryContent;
      if (!content.hospitalCourse?.trim()) throw new DomainError("VALIDATION_FAILED", "Describe the hospital course before signing", 400, [{ path: "hospitalCourse", message: "Required to sign" }]);
      if (!content.finalDiagnoses?.length) throw new DomainError("VALIDATION_FAILED", "Record at least one final diagnosis before signing", 400, [{ path: "finalDiagnoses", message: "Required to sign" }]);

      // Final diagnoses also enter the patient's longitudinal diagnosis history.
      const existing = new Set((await tx.diagnosis.findMany({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, status: "ACTIVE", type: "FINAL" }, select: { text: true } })).map((d) => d.text.toLowerCase()));
      const fresh = content.finalDiagnoses.filter((d) => !existing.has(d.text.toLowerCase()));
      if (fresh.length) await tx.diagnosis.createMany({ data: fresh.map((d) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, encounterId: adm.encounterId, text: d.text, code: d.code ?? null, type: "FINAL" as const, recordedById: ctx.userId })) });
      await tx.clinicalDocumentVersion.create({ data: { tenantId: ctx.tenantId, documentId: doc.id, version: 1, kind: "SIGNED", content: content as Prisma.InputJsonObject, snapshot: { admissionNumber: adm.admissionNumber, admittedAt: adm.admittedAt.toISOString() }, authorId: ctx.userId } });
      const res = await tx.clinicalDocument.updateMany({ where: { id: doc.id, tenantId: ctx.tenantId, status: "DRAFT", version: doc.version }, data: { status: "SIGNED", currentVersion: 1, signedAt: new Date(), signedById: ctx.userId } });
      if (res.count !== 1) throw new DomainError("STALE_VERSION", "The summary was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "DISCHARGE_SUMMARY_SIGNED", entityType: "ClinicalDocument", entityId: doc.id, metadata: { admissionId, version: 1 } });
      return { id: doc.id, status: "SIGNED" as const, currentVersion: 1 };
    });
  }

  async amend(ctx: RequestContext, admissionId: string, input: z.infer<typeof amendSummarySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.admission(tx, ctx, admissionId);
      await this.clinicians.requireActive(tx, ctx);
      const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, kind: "DISCHARGE_SUMMARY" } });
      if (!doc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (doc.status === "DRAFT") throw new DomainError("INVALID_STATE", "A draft is edited directly; amendments apply only to signed summaries", 409);
      if (doc.currentVersion !== input.expectedVersion) throw new DomainError("STALE_VERSION", "The summary was amended by someone else. Review the latest version first.", 409, { currentVersion: doc.currentVersion });
      if (!input.content.hospitalCourse?.trim() || !input.content.finalDiagnoses.length) throw new DomainError("VALIDATION_FAILED", "The hospital course and a final diagnosis are required", 400);
      const next = doc.currentVersion + 1;
      await tx.clinicalDocumentVersion.create({ data: { tenantId: ctx.tenantId, documentId: doc.id, version: next, kind: "AMENDED", content: input.content as Prisma.InputJsonObject, snapshot: { admissionNumber: adm.admissionNumber }, reason: input.reason, authorId: ctx.userId } });
      const res = await tx.clinicalDocument.updateMany({ where: { id: doc.id, tenantId: ctx.tenantId, currentVersion: doc.currentVersion, status: { in: ["SIGNED", "AMENDED"] } }, data: { status: "AMENDED", currentVersion: next } });
      if (res.count !== 1) throw new DomainError("STALE_VERSION", "The summary was amended by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "DISCHARGE_SUMMARY_AMENDED", entityType: "ClinicalDocument", entityId: doc.id, metadata: { admissionId, fromVersion: doc.currentVersion, toVersion: next, reason: input.reason } });
      return { id: doc.id, status: "AMENDED" as const, currentVersion: next };
    });
  }

  /**
   * The RMO checks the signed summary and verifies it. It is not the same act as signing: the treating consultant signs, someone else
   * confirms the signed copy is complete and correct. The verification belongs to one version: an amendment has to be verified again.
   */
  async verify(ctx: RequestContext, admissionId: string, input: z.infer<typeof verifySummarySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] } });
      if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "The admission is already closed", 409);
      await this.clinicians.requireActive(tx, ctx);
      const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, kind: "DISCHARGE_SUMMARY" } });
      if (!doc) throw new DomainError("INVALID_STATE", "There is no discharge summary to verify", 409);
      if (doc.status === "DRAFT") throw new DomainError("INVALID_STATE", "The summary has to be signed by the treating consultant before it can be verified", 409);
      if (doc.currentVersion !== input.version) throw new DomainError("STALE_VERSION", "The summary was amended since you opened it. Review the latest version first.", 409, { currentVersion: doc.currentVersion });
      // The person who put their name to the signed version cannot be the one who checks it. For an amendment the author of that version signs it.
      const v = await tx.clinicalDocumentVersion.findFirstOrThrow({ where: { tenantId: ctx.tenantId, documentId: doc.id, version: doc.currentVersion }, select: { authorId: true } });
      if (v.authorId === ctx.userId || doc.signedById === ctx.userId) throw new DomainError("FORBIDDEN", "The person who signed or amended this summary cannot verify it", 403);
      if (await tx.dischargeSummaryVerification.findFirst({ where: { tenantId: ctx.tenantId, documentId: doc.id, version: doc.currentVersion }, select: { id: true } })) throw new DomainError("CONFLICT", "This version of the summary is already verified", 409);
      await tx.dischargeSummaryVerification.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, documentId: doc.id, version: doc.currentVersion, verifiedById: ctx.userId, note: input.note ?? null } });
      await this.audit.record(tx, actorOf(ctx), { action: "DISCHARGE_SUMMARY_VERIFIED", entityType: "ClinicalDocument", entityId: doc.id, metadata: { admissionId, version: doc.currentVersion } });
      return { id: doc.id, status: "VERIFIED" as const, currentVersion: doc.currentVersion };
    });
  }

  async getVersion(ctx: RequestContext, admissionId: string, version: number) {
    const adm = await this.admission(this.prisma, ctx, admissionId);
    const doc = await this.prisma.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, kind: "DISCHARGE_SUMMARY" }, select: { id: true } });
    if (!doc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const v = await this.prisma.clinicalDocumentVersion.findFirst({ where: { tenantId: ctx.tenantId, documentId: doc.id, version } });
    if (!v) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return { version: v.version, kind: v.kind, reason: v.reason, content: v.content, createdAt: v.createdAt };
  }
}
