import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { chartPatientIds } from "../patients/patient-links";
import { dateOnly, localDateStr } from "../../common/time";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((s) => !Number.isNaN(dateOnly(s).getTime()) && dateOnly(s).toISOString().startsWith(s), "Not a real date");

export const recordConsentSchema = z.object({
  purpose: z.enum(["PRIVACY_NOTICE_ACKNOWLEDGED", "APPOINTMENT_REMINDERS", "EMAIL_MESSAGES"]),
  status: z.enum(["GRANTED", "WITHDRAWN"]),
  method: z.enum(["VERBAL", "WRITTEN", "DIGITAL"]),
  noticeVersion: z.string().trim().min(1).max(60).optional(),
  note: z.string().trim().min(1).max(300).optional(),
}).strict();

export const createDataRequestSchema = z.object({
  type: z.enum(["ACCESS", "CORRECTION", "ERASURE", "GRIEVANCE"]),
  details: z.string().trim().min(10, "Describe the request (at least 10 characters)").max(2000),
  receivedOn: day.optional(),
  dueOn: day.optional(),
}).strict();

export const updateDataRequestSchema = z.object({
  status: z.enum(["IN_PROGRESS", "COMPLETED", "REJECTED"]),
  resolution: z.string().trim().min(5, "Record the outcome (at least 5 characters)").max(2000).optional(),
  version: z.number().int().min(1),
}).strict().superRefine((v, c) => {
  if ((v.status === "COMPLETED" || v.status === "REJECTED") && !v.resolution) c.addIssue({ code: "custom", path: ["resolution"], message: "Record the outcome when closing a request" });
});

export const listDataRequestsSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "REJECTED"]).optional(),
  patientId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

/** Allowed moves of a data request; a closed request never reopens (log a new one). */
export const DATA_REQUEST_TRANSITIONS: Record<string, readonly string[]> = {
  OPEN: ["IN_PROGRESS", "COMPLETED", "REJECTED"],
  IN_PROGRESS: ["COMPLETED", "REJECTED"],
  COMPLETED: [],
  REJECTED: [],
};

const CONSENT_VIEW = { id: true, purpose: true, status: true, method: true, noticeVersion: true, note: true, recordedById: true, recordedAt: true } satisfies Prisma.PatientConsentSelect;
const REQUEST_VIEW = { id: true, patientId: true, type: true, status: true, details: true, receivedOn: true, dueOn: true, resolution: true, closedAt: true, version: true, createdAt: true } satisfies Prisma.PatientDataRequestSelect;
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

@Injectable()
export class PrivacyService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async assertPatient(db: Pick<PrismaService, "patient">, ctx: RequestContext, patientId: string): Promise<void> {
    const p = await db.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!p) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
  }

  /** New decisions go on the real patient, never on a merged duplicate. */
  private async assertNotMerged(db: Pick<PrismaService, "patient">, ctx: RequestContext, patientId: string): Promise<void> {
    const p = await db.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { mergedIntoId: true } });
    if (p?.mergedIntoId) throw new DomainError("PATIENT_MERGED", "This patient record was merged into another. Record this on the real patient.", 409, { mergedIntoId: p.mergedIntoId });
  }

  // ───── consent ─────

  /** Current decision per purpose (newest record wins) plus the full history, newest first. */
  async consents(ctx: RequestContext, patientId: string) {
    await this.assertPatient(this.prisma, ctx, patientId);
    const history = await this.prisma.patientConsent.findMany({ where: { tenantId: ctx.tenantId, patientId: { in: (await chartPatientIds(this.prisma, ctx.tenantId, patientId)) ?? [patientId] } }, select: CONSENT_VIEW, orderBy: [{ recordedAt: "desc" }, { id: "desc" }], take: 200 });
    const current = new Map<string, (typeof history)[number]>();
    for (const h of history) if (!current.has(h.purpose)) current.set(h.purpose, h);
    return { current: [...current.values()], history };
  }

  async recordConsent(ctx: RequestContext, patientId: string, input: z.infer<typeof recordConsentSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertPatient(tx, ctx, patientId);
      await this.assertNotMerged(tx, ctx, patientId);
      const chart = (await chartPatientIds(tx, ctx.tenantId, patientId)) ?? [patientId];
      // Serialise decisions about the same patient and purpose, so two people recording at once cannot both pass the "unchanged" check.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`consent:${patientId}:${input.purpose}`}, 0))`;
      const latest = await tx.patientConsent.findFirst({ where: { tenantId: ctx.tenantId, patientId: { in: chart }, purpose: input.purpose }, orderBy: [{ recordedAt: "desc" }, { id: "desc" }], select: { status: true } });
      if (latest?.status === input.status) throw new DomainError("CONSENT_UNCHANGED", `This is already recorded as ${input.status.toLowerCase()}`, 409);
      const row = await tx.patientConsent.create({
        data: { tenantId: ctx.tenantId, patientId, purpose: input.purpose, status: input.status, method: input.method, noticeVersion: input.noticeVersion ?? null, note: input.note ?? null, recordedById: ctx.userId },
        select: CONSENT_VIEW,
      });
      let remindersCancelled = 0;
      if (input.purpose === "APPOINTMENT_REMINDERS" && input.status === "WITHDRAWN") {
        remindersCancelled = (await tx.appointmentReminder.updateMany({ where: { tenantId: ctx.tenantId, status: "PENDING", appointment: { patientId: { in: chart } } }, data: { status: "CANCELLED" } })).count;
      }
      await this.audit.record(tx, actorOf(ctx), {
        action: input.status === "GRANTED" ? "CONSENT_GRANTED" : "CONSENT_WITHDRAWN", entityType: "Patient", entityId: patientId,
        metadata: { consentId: row.id, purpose: input.purpose, method: input.method, ...(input.noticeVersion ? { noticeVersion: input.noticeVersion } : {}), ...(remindersCancelled ? { remindersCancelled } : {}) },
      });
      return row;
    });
  }

  // ───── data requests ─────

  async createRequest(ctx: RequestContext, patientId: string, input: z.infer<typeof createDataRequestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertPatient(tx, ctx, patientId);
      const tz = (await tx.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
      const receivedOn = input.receivedOn ?? localDateStr(new Date(), tz);
      if (receivedOn > localDateStr(new Date(), tz)) throw new DomainError("VALIDATION_FAILED", "The received date cannot be in the future", 400, [{ path: "receivedOn", message: "Cannot be in the future" }]);
      if (input.dueOn && input.dueOn < receivedOn) throw new DomainError("VALIDATION_FAILED", "The due date cannot be before the received date", 400, [{ path: "dueOn", message: "Before the received date" }]);
      const row = await tx.patientDataRequest.create({
        data: { tenantId: ctx.tenantId, patientId, type: input.type, details: input.details, receivedOn: dateOnly(receivedOn), dueOn: input.dueOn ? dateOnly(input.dueOn) : null, createdById: ctx.userId },
        select: REQUEST_VIEW,
      });
      await this.audit.record(tx, actorOf(ctx), { action: "DATA_REQUEST_CREATED", entityType: "PatientDataRequest", entityId: row.id, metadata: { patientId, type: input.type } });
      return this.toView(row, localDateStr(new Date(), tz));
    });
  }

  async listRequests(ctx: RequestContext, q: z.infer<typeof listDataRequestsSchema>) {
    const where: Prisma.PatientDataRequestWhereInput = { tenantId: ctx.tenantId, ...(q.status ? { status: q.status } : {}), ...(q.patientId ? { patientId: q.patientId } : {}) };
    const tz = (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
    const [rows, total] = await Promise.all([
      this.prisma.patientDataRequest.findMany({
        where, select: { ...REQUEST_VIEW, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true }, take: 1 } } } },
        orderBy: [{ receivedOn: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      this.prisma.patientDataRequest.count({ where }),
    ]);
    const today = localDateStr(new Date(), tz);
    return { items: rows.map(({ patient, ...r }) => ({ ...this.toView(r, today), patientName: [patient.firstName, patient.lastName].filter(Boolean).join(" "), mrn: patient.identifiers[0]?.value ?? null })), total };
  }

  /** Records progress and the outcome of a request. It never changes or erases the patient's records: any such action is a separate, deliberate step. */
  async updateRequest(ctx: RequestContext, id: string, input: z.infer<typeof updateDataRequestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.patientDataRequest.findFirst({ where: { id, tenantId: ctx.tenantId }, select: { status: true, version: true, patientId: true, type: true } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (existing.version !== input.version) throw new DomainError("STALE_VERSION", "This request was changed by someone else. Reload and try again.", 409);
      if (!DATA_REQUEST_TRANSITIONS[existing.status]?.includes(input.status)) {
        throw new DomainError("INVALID_STATE", `A ${existing.status.toLowerCase().replace("_", " ")} request cannot become ${input.status.toLowerCase().replace("_", " ")}`, 409);
      }
      const closing = input.status === "COMPLETED" || input.status === "REJECTED";
      const res = await tx.patientDataRequest.updateMany({
        where: { id, tenantId: ctx.tenantId, version: input.version, status: existing.status },
        data: { status: input.status, version: { increment: 1 }, ...(input.resolution ? { resolution: input.resolution } : {}), ...(closing ? { closedAt: new Date(), closedById: ctx.userId } : {}) },
      });
      if (res.count !== 1) throw new DomainError("STALE_VERSION", "This request was changed by someone else. Reload and try again.", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "DATA_REQUEST_UPDATED", entityType: "PatientDataRequest", entityId: id, metadata: { patientId: existing.patientId, type: existing.type, from: existing.status, to: input.status } });
      const tz = (await tx.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
      return this.toView(await tx.patientDataRequest.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: REQUEST_VIEW }), localDateStr(new Date(), tz));
    });
  }

  private toView(r: Prisma.PatientDataRequestGetPayload<{ select: typeof REQUEST_VIEW }>, today: string) {
    const open = r.status === "OPEN" || r.status === "IN_PROGRESS";
    return { ...r, receivedOn: ymd(r.receivedOn), dueOn: r.dueOn ? ymd(r.dueOn) : null, overdue: open && !!r.dueOn && ymd(r.dueOn) < today };
  }
}
