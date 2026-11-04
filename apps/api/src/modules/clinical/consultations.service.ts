import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { assertEncounterVisible, visitScope } from "../../common/data-scope";
import { chartPatientIds } from "../patients/patient-links";
import { currentAge } from "../patients/patient.domain";
import { orderItemSchema, PrescriptionsService, type OrderView } from "../prescriptions/prescriptions.service";
import { TestOrdersService } from "../test-orders/test-orders.service";
import { PrescriptionDeliveryService } from "../prescriptions/prescription-delivery.service";
import { EncountersService } from "../encounters/encounters.service";
import { AllergiesService } from "./allergies.service";
import { ClinicianService } from "./clinician.service";

// ───────────────────────── schemas ─────────────────────────

const section = z.string().trim().max(4000);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const consultationContentSchema = z.object({
  chiefComplaint: section.optional(),
  historyOfPresentIllness: section.optional(),
  pastHistory: section.optional(),
  examination: section.optional(),
  advice: section.optional(),
  /** Tests the doctor asks the patient to get done (docs/prescriptions.md). */
  investigationsAdvised: z.array(z.string().trim().min(2).max(120)).max(20).optional(),
  /** Radiology and imaging (X-ray, ultrasound, CT, MRI and so on). */
  otherTestsAdvised: z.array(z.string().trim().min(2).max(120)).max(20).optional(),
  /** Cardiology investigations (ECG, echo, stress test and so on). */
  cardiologyAdvised: z.array(z.string().trim().min(2).max(120)).max(20).optional(),
  /** Other diagnostic procedures (endoscopy, biopsy, spirometry and so on). */
  proceduresAdvised: z.array(z.string().trim().min(2).max(120)).max(20).optional(),
  dietAdvice: section.optional(),
  referral: z.string().trim().max(500).optional(),
  followUp: z.object({ afterDays: z.number().int().min(1).max(365).optional(), date: isoDay.optional(), notes: z.string().trim().max(500).optional() }).strict().optional(),
}).strict();
export type ConsultationContent = z.infer<typeof consultationContentSchema>;

export const saveConsultationSchema = z.object({ content: consultationContentSchema, version: z.number().int().min(1).optional() }).strict();
export const signConsultationSchema = z.object({ version: z.number().int().min(1), acknowledgeAllergyWarnings: z.boolean().optional() }).strict();

const diagnosisInput = z.object({
  text: z.string().trim().min(2).max(200),
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9.\-]{0,19}$/, "Invalid code").optional(),
  type: z.enum(["PROVISIONAL", "FINAL", "SECONDARY"]),
}).strict();
export type DiagnosisInput = z.infer<typeof diagnosisInput>;
export const addDiagnosisSchema = diagnosisInput;
export const removeDiagnosisSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();

export const amendConsultationSchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(10, "Explain why the record is being amended").max(500),
  content: consultationContentSchema,
  diagnoses: z.array(diagnosisInput).min(1).max(20).optional(),
  prescription: z.object({ items: z.array(orderItemSchema).min(1).max(30) }).strict().optional(),
  acknowledgeAllergyWarnings: z.boolean().optional(),
}).strict();

const DIAGNOSIS_VIEW = { id: true, text: true, code: true, type: true, status: true, recordedById: true, recordedAt: true, encounterId: true, removeReason: true, supersededAtVersion: true } satisfies Prisma.DiagnosisSelect;

interface Snapshot { diagnoses: { text: string; code: string | null; type: string }[]; prescriptions: { orderNumber: string | null; items: Record<string, unknown>[] }[] }

@Injectable()
export class ConsultationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly encounters: EncountersService,
    private readonly clinicians: ClinicianService,
    private readonly prescriptions: PrescriptionsService,
    private readonly allergies: AllergiesService,
    private readonly testOrders: TestOrdersService,
    private readonly deliveries: PrescriptionDeliveryService,
  ) {}

  // ───── draft ─────

  async saveDraft(ctx: RequestContext, encounterId: string, input: z.infer<typeof saveConsultationSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const enc = await this.encounters.assertActive(tx, ctx, encounterId);
      if (enc.type !== "OPD") throw new DomainError("INVALID_STATE", "OPD consultations are only available for outpatient visits", 409);
      await this.clinicians.requireActive(tx, ctx);
      const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId, kind: "CONSULTATION" } });
      if (!doc) {
        if (input.version !== undefined && input.version !== 1) throw new DomainError("STALE_VERSION", "Reload the consultation and try again", 409);
        const created = await tx.clinicalDocument.create({
          data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId, kind: "CONSULTATION", authorId: ctx.userId, draft: input.content as Prisma.InputJsonObject },
        });
        await this.audit.record(tx, actorOf(ctx), { action: "CONSULTATION_STARTED", entityType: "ClinicalDocument", entityId: created.id, metadata: { encounterId } });
        return { id: created.id, status: created.status, version: created.version, content: input.content };
      }
      if (doc.status !== "DRAFT") throw new DomainError("CONSULTATION_SIGNED", "This consultation is signed. Use an amendment to change it.", 409);
      if (doc.authorId !== ctx.userId) throw new DomainError("FORBIDDEN", "This consultation draft belongs to another doctor", 403);
      if (input.version !== doc.version) throw new DomainError("STALE_VERSION", "The consultation was changed elsewhere. Reload and try again.", 409, { currentVersion: doc.version });
      const res = await tx.clinicalDocument.updateMany({
        where: { id: doc.id, tenantId: ctx.tenantId, status: "DRAFT", version: doc.version },
        data: { draft: input.content as Prisma.InputJsonObject, version: { increment: 1 } },
      });
      if (res.count !== 1) throw new DomainError("STALE_VERSION", "The consultation was changed elsewhere. Reload and try again.", 409);
      return { id: doc.id, status: doc.status, version: doc.version + 1, content: input.content };
    });
  }

  // ───── diagnoses ─────

  async addDiagnosis(ctx: RequestContext, encounterId: string, input: DiagnosisInput) {
    return this.prisma.$transaction(async (tx) => {
      const enc = await this.encounters.assertActive(tx, ctx, encounterId);
      await this.clinicians.requireActive(tx, ctx);
      await this.assertEditable(tx, ctx, encounterId);
      const active = await tx.diagnosis.findMany({ where: { tenantId: ctx.tenantId, encounterId, status: "ACTIVE" }, select: { text: true, type: true } });
      if (active.length >= 20) throw new DomainError("VALIDATION_FAILED", "A visit can have at most 20 diagnoses", 400);
      if (active.some((d) => d.text.toLowerCase() === input.text.toLowerCase() && d.type === input.type)) throw new DomainError("CONFLICT", "This diagnosis is already recorded for the visit", 409);
      const d = await tx.diagnosis.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId, text: input.text, code: input.code ?? null, type: input.type, recordedById: ctx.userId },
        select: DIAGNOSIS_VIEW,
      });
      await this.audit.record(tx, actorOf(ctx), { action: "DIAGNOSIS_RECORDED", entityType: "Diagnosis", entityId: d.id, metadata: { encounterId, type: input.type } });
      return d;
    });
  }

  async removeDiagnosis(ctx: RequestContext, diagnosisId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.clinicians.requireActive(tx, ctx);
      const d = await tx.diagnosis.findFirst({ where: { id: diagnosisId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!d) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await this.encounters.assertActive(tx, ctx, d.encounterId);
      await this.assertEditable(tx, ctx, d.encounterId);
      if (d.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This diagnosis was already removed", 409);
      const res = await tx.diagnosis.updateMany({ where: { id: diagnosisId, tenantId: ctx.tenantId, status: "ACTIVE" }, data: { status: "REMOVED", removedAt: new Date(), removedById: ctx.userId, removeReason: reason } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This diagnosis was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "DIAGNOSIS_REMOVED", entityType: "Diagnosis", entityId: diagnosisId, metadata: { encounterId: d.encounterId, reason } });
      return tx.diagnosis.findFirstOrThrow({ where: { id: diagnosisId, tenantId: ctx.tenantId }, select: DIAGNOSIS_VIEW });
    });
  }

  async diagnosesForEncounter(ctx: RequestContext, encounterId: string, includeRemoved: boolean) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.prisma.diagnosis.findMany({ where: { tenantId: ctx.tenantId, encounterId, ...(includeRemoved ? {} : { status: "ACTIVE" }) }, select: DIAGNOSIS_VIEW, orderBy: { recordedAt: "asc" } });
  }

  /** Longitudinal history: diagnoses across the patient's visits, newest first. */
  async diagnosesForPatient(ctx: RequestContext, patientId: string) {
    const ids = await chartPatientIds(this.prisma, ctx.tenantId, patientId);
    if (!ids) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    const rows = await this.prisma.diagnosis.findMany({
      where: { tenantId: ctx.tenantId, patientId: { in: ids }, status: "ACTIVE" }, orderBy: { recordedAt: "desc" }, take: 200,
      select: { ...DIAGNOSIS_VIEW, encounter: { select: { encounterNumber: true, startedAt: true, type: true } } },
    });
    return rows.map(({ encounter, ...d }) => ({ ...d, encounterNumber: encounter.encounterNumber, visitDate: encounter.startedAt, visitType: encounter.type }));
  }

  // ───── read ─────

  async get(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true, patientId: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const doc = await this.prisma.clinicalDocument.findFirst({
      where: { tenantId: ctx.tenantId, encounterId, kind: "CONSULTATION" },
      include: { versions: { orderBy: { version: "asc" }, select: { version: true, kind: true, reason: true, authorId: true, createdAt: true } } },
    });
    const diagnoses = await this.prisma.diagnosis.findMany({ where: { tenantId: ctx.tenantId, encounterId, status: "ACTIVE" }, select: DIAGNOSIS_VIEW, orderBy: { recordedAt: "asc" } });
    const rx = ctx.permissions.has("PRESCRIPTION_READ") ? await this.prescriptions.listForEncounter(ctx, encounterId) : null;
    if (!doc) return { document: null, diagnoses, prescription: rx };

    let content: unknown = doc.draft;
    if (doc.status !== "DRAFT") {
      const latest = await this.prisma.clinicalDocumentVersion.findFirstOrThrow({ where: { tenantId: ctx.tenantId, documentId: doc.id, version: doc.currentVersion } });
      content = latest.content;
    }
    const authorIds = [...new Set([doc.authorId, doc.signedById, ...doc.versions.map((v) => v.authorId)].filter((x): x is string => !!x))];
    const users = await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: authorIds } }, select: { id: true, fullName: true } });
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    return {
      document: {
        id: doc.id, status: doc.status, version: doc.version, currentVersion: doc.currentVersion, content,
        authorName: names.get(doc.authorId) ?? null, signedAt: doc.signedAt, signedByName: doc.signedById ? names.get(doc.signedById) ?? null : null,
        versions: doc.versions.map((v) => ({ ...v, authorName: names.get(v.authorId) ?? null })),
      },
      diagnoses, prescription: rx,
    };
  }

  /** The original (and every later) version stays recoverable exactly as it was signed. */
  async getVersion(ctx: RequestContext, encounterId: string, version: number) {
    await assertEncounterVisible(this.prisma, ctx, encounterId);
    const doc = await this.prisma.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, kind: "CONSULTATION" }, select: { id: true } });
    if (!doc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const v = await this.prisma.clinicalDocumentVersion.findFirst({ where: { tenantId: ctx.tenantId, documentId: doc.id, version } });
    if (!v) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const author = await this.prisma.user.findFirst({ where: { id: v.authorId, tenantId: ctx.tenantId }, select: { fullName: true } });
    return { version: v.version, kind: v.kind, reason: v.reason, content: v.content, snapshot: v.snapshot, createdAt: v.createdAt, authorName: author?.fullName ?? null };
  }

  // ───── sign / amend ─────

  async sign(ctx: RequestContext, encounterId: string, input: z.infer<typeof signConsultationSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const enc = await this.encounters.assertActive(tx, ctx, encounterId);
      const clinician = await this.clinicians.requireActive(tx, ctx);
      if (enc.practitionerId !== clinician.id) throw new DomainError("FORBIDDEN", "Only the treating doctor can sign this consultation", 403);
      const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId, kind: "CONSULTATION" } });
      if (!doc) throw new DomainError("INVALID_STATE", "There is no consultation to sign", 409);
      if (doc.status !== "DRAFT") throw new DomainError("CONSULTATION_SIGNED", "This consultation is already signed", 409);
      if (doc.version !== input.version) throw new DomainError("STALE_VERSION", "The consultation changed since you opened it. Review and sign again.", 409, { currentVersion: doc.version });

      const content = doc.draft as ConsultationContent;
      // With the doctor's handwritten prescription uploaded (and not sent back by the pharmacy), the doctor may sign straight away: the prescription is the handwritten
      // picture. Without one, the complaint and a diagnosis are required before signing.
      const handwritten = await tx.prescriptionScan.count({ where: { tenantId: ctx.tenantId, encounterId, OR: [{ pharmacyOutcome: null }, { pharmacyOutcome: "DISPENSED" }] } });
      if (handwritten === 0) {
        if (!content.chiefComplaint?.trim()) throw new DomainError("VALIDATION_FAILED", "Record the chief complaint before signing", 400, [{ path: "chiefComplaint", message: "Required to sign" }]);
        const diagnosisCount = await tx.diagnosis.count({ where: { tenantId: ctx.tenantId, encounterId, status: "ACTIVE" } });
        if (diagnosisCount === 0) throw new DomainError("VALIDATION_FAILED", "Record at least one diagnosis before signing", 400, [{ path: "diagnoses", message: "Required to sign" }]);
      }

      await this.prescriptions.signDraft(tx, ctx, encounterId, input.acknowledgeAllergyWarnings === true);
      // The tests the doctor advised go to the Cashier to be billed, in the same transaction as the signature.
      await this.testOrders.syncFromConsultation(tx, ctx, { id: encounterId, patientId: enc.patientId }, content, 1);
      const snapshot = await this.buildSnapshot(tx, ctx, encounterId);
      await tx.clinicalDocumentVersion.create({ data: { tenantId: ctx.tenantId, documentId: doc.id, version: 1, kind: "SIGNED", content: content as Prisma.InputJsonObject, snapshot: snapshot as unknown as Prisma.InputJsonObject, authorId: ctx.userId } });
      const res = await tx.clinicalDocument.updateMany({
        where: { id: doc.id, tenantId: ctx.tenantId, status: "DRAFT", version: doc.version },
        data: { status: "SIGNED", currentVersion: 1, signedAt: new Date(), signedById: ctx.userId },
      });
      if (res.count !== 1) throw new DomainError("STALE_VERSION", "The consultation was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "CONSULTATION_SIGNED", entityType: "ClinicalDocument", entityId: doc.id, metadata: { encounterId, version: 1 } });
      await this.deliveries.queueAuto(tx, ctx, encounterId);
      return { id: doc.id, status: "SIGNED" as const, currentVersion: 1 };
    });
  }

  async amend(ctx: RequestContext, encounterId: string, input: z.infer<typeof amendConsultationSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const enc = await tx.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true } });
      if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await this.clinicians.requireActive(tx, ctx);
      const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId, kind: "CONSULTATION" } });
      if (!doc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (doc.status === "DRAFT") throw new DomainError("INVALID_STATE", "A draft consultation is edited directly; amendments apply only to signed records", 409);
      if (doc.currentVersion !== input.expectedVersion) throw new DomainError("STALE_VERSION", "The consultation was amended by someone else. Review the latest version first.", 409, { currentVersion: doc.currentVersion });
      if (!input.content.chiefComplaint?.trim()) throw new DomainError("VALIDATION_FAILED", "The chief complaint cannot be empty", 400, [{ path: "content.chiefComplaint", message: "Required" }]);

      const next = doc.currentVersion + 1;
      if (input.diagnoses) {
        await tx.diagnosis.updateMany({
          where: { tenantId: ctx.tenantId, encounterId, status: "ACTIVE" },
          data: { status: "REMOVED", removedAt: new Date(), removedById: ctx.userId, removeReason: `Replaced by amendment v${next}`, supersededAtVersion: next },
        });
        await tx.diagnosis.createMany({ data: input.diagnoses.map((d) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId, text: d.text, code: d.code ?? null, type: d.type, recordedById: ctx.userId })) });
      }
      if (input.prescription) await this.prescriptions.amend(tx, ctx, encounterId, enc.patientId, input.prescription.items, next, input.acknowledgeAllergyWarnings === true);
      await this.testOrders.syncFromConsultation(tx, ctx, { id: encounterId, patientId: enc.patientId }, input.content, next);

      const snapshot = await this.buildSnapshot(tx, ctx, encounterId);
      await tx.clinicalDocumentVersion.create({
        data: { tenantId: ctx.tenantId, documentId: doc.id, version: next, kind: "AMENDED", content: input.content as Prisma.InputJsonObject, snapshot: snapshot as unknown as Prisma.InputJsonObject, reason: input.reason, authorId: ctx.userId },
      });
      const res = await tx.clinicalDocument.updateMany({
        where: { id: doc.id, tenantId: ctx.tenantId, currentVersion: doc.currentVersion, status: { in: ["SIGNED", "AMENDED"] } },
        data: { status: "AMENDED", currentVersion: next },
      });
      if (res.count !== 1) throw new DomainError("STALE_VERSION", "The consultation was amended by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "CONSULTATION_AMENDED", entityType: "ClinicalDocument", entityId: doc.id, metadata: { encounterId, fromVersion: doc.currentVersion, toVersion: next, reason: input.reason, diagnosesReplaced: !!input.diagnoses, prescriptionReplaced: !!input.prescription } });
      return { id: doc.id, status: "AMENDED" as const, currentVersion: next };
    });
  }

  // ───── workspace ─────

  /** Everything the doctor needs on one screen: header, allergies, vitals, draft state and recent visits. */
  async workspace(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({
      where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] },
      include: { patient: { include: { identifiers: { where: { type: "MRN" }, select: { value: true } } } }, practitioner: { select: { displayName: true, specialty: true, registrationNo: true } }, department: { select: { name: true } } },
    });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const p = enc.patient;
    const [allergies, vitals, previous, consultation] = await Promise.all([
      this.allergies.list(ctx, p.id, false),
      ctx.permissions.has("VITALS_READ")
        ? this.prisma.observation.findMany({ where: { tenantId: ctx.tenantId, encounterId, status: "FINAL" }, orderBy: { recordedAt: "desc" }, take: 30, select: { id: true, type: true, value: true, unit: true, recordedAt: true } })
        : Promise.resolve([]),
      this.previousVisits(ctx, p.id, encounterId),
      this.get(ctx, encounterId),
    ]);
    const latestVitals: Record<string, { value: string; unit: string; recordedAt: Date }> = {};
    for (const o of vitals) if (!latestVitals[o.type]) latestVitals[o.type] = { value: o.value.toString(), unit: o.unit, recordedAt: o.recordedAt };
    return {
      header: {
        patientId: p.id, mrn: p.identifiers[0]?.value ?? null, name: [p.firstName, p.lastName].filter(Boolean).join(" "),
        gender: p.gender, age: currentAge(p), bloodGroup: p.bloodGroup, mobile: p.mobile,
        encounterId: enc.id, encounterNumber: enc.encounterNumber, visitStatus: enc.status, startedAt: enc.startedAt,
        practitionerId: enc.practitionerId, practitionerName: enc.practitioner?.displayName ?? null, practitionerSpecialty: enc.practitioner?.specialty ?? null, practitionerRegistrationNo: enc.practitioner?.registrationNo ?? null, departmentName: enc.department?.name ?? null,
      },
      allergies, latestVitals, previousVisits: previous, consultation,
    };
  }

  private async previousVisits(ctx: RequestContext, patientId: string, excludeEncounterId: string) {
    const encounters = await this.prisma.encounter.findMany({
      where: { tenantId: ctx.tenantId, patientId: { in: (await chartPatientIds(this.prisma, ctx.tenantId, patientId)) ?? [patientId] }, id: { not: excludeEncounterId }, status: "COMPLETED" },
      orderBy: { startedAt: "desc" }, take: 5,
      select: { id: true, encounterNumber: true, type: true, startedAt: true, practitioner: { select: { displayName: true } } },
    });
    if (encounters.length === 0) return [];
    const ids = encounters.map((e) => e.id);
    const [diagnoses, docs] = await Promise.all([
      this.prisma.diagnosis.findMany({ where: { tenantId: ctx.tenantId, encounterId: { in: ids }, status: "ACTIVE" }, select: { encounterId: true, text: true, type: true } }),
      this.prisma.clinicalDocument.findMany({ where: { tenantId: ctx.tenantId, encounterId: { in: ids }, kind: "CONSULTATION" }, select: { id: true, encounterId: true, currentVersion: true, status: true } }),
    ]);
    const versions = await this.prisma.clinicalDocumentVersion.findMany({ where: { tenantId: ctx.tenantId, OR: docs.filter((d) => d.status !== "DRAFT").map((d) => ({ documentId: d.id, version: d.currentVersion })) } });
    const complaintByDoc = new Map(versions.map((v) => [v.documentId, (v.content as ConsultationContent).chiefComplaint ?? null]));
    return encounters.map((e) => {
      const doc = docs.find((d) => d.encounterId === e.id);
      return {
        encounterId: e.id, encounterNumber: e.encounterNumber, type: e.type, visitDate: e.startedAt, practitionerName: e.practitioner?.displayName ?? null,
        chiefComplaint: doc ? complaintByDoc.get(doc.id) ?? null : null, diagnoses: diagnoses.filter((d) => d.encounterId === e.id).map((d) => d.text),
      };
    });
  }

  // ───── internals ─────

  private async assertEditable(tx: Db, ctx: RequestContext, encounterId: string): Promise<void> {
    const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId, kind: "CONSULTATION" }, select: { status: true } });
    if (doc && doc.status !== "DRAFT") throw new DomainError("CONSULTATION_SIGNED", "The consultation is signed. Use an amendment to change diagnoses.", 409);
  }

  private async buildSnapshot(tx: Db, ctx: RequestContext, encounterId: string): Promise<Snapshot> {
    const diagnoses = await tx.diagnosis.findMany({ where: { tenantId: ctx.tenantId, encounterId, status: "ACTIVE" }, orderBy: { recordedAt: "asc" }, select: { text: true, code: true, type: true } });
    const orders: OrderView[] = await tx.medicationOrder.findMany({
      where: { tenantId: ctx.tenantId, encounterId, status: "SIGNED", source: "DIGITAL" }, orderBy: { signedAt: "asc" },
      select: { id: true, orderNumber: true, status: true, source: true, encounterId: true, patientId: true, orderedById: true, signedById: true, signedAt: true, supersededAtVersion: true, createdAt: true,
        items: { orderBy: { lineNo: "asc" }, select: { id: true, lineNo: true, medicineId: true, genericName: true, brandName: true, strength: true, dosage: true, route: true, frequency: true, frequencyText: true, foodRelation: true, durationDays: true, quantity: true, instructions: true, status: true, dispensedQuantity: true, stopReason: true } } },
    });
    return {
      diagnoses,
      prescriptions: orders.map((o) => ({
        orderNumber: o.orderNumber,
        items: o.items.map(({ id: _id, dispensedQuantity: _d, stopReason: _s, status: _st, ...rest }) => rest),
      })),
    };
  }
}
