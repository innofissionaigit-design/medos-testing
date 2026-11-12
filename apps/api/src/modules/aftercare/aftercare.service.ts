import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { AppointmentsService } from "../appointments/appointments.service";
import { SettingsService } from "../settings/settings.service";

const uuid = z.string().uuid();
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the form YYYY-MM-DD");
const instant = z.string().datetime({ offset: true }).transform((s) => new Date(s));

export const aftercareListSchema = z.object({
  /** DUE: pending reviews on or near their date, or with a call-back that has come; PENDING: every review not yet booked; BOOKED; DONE; CLOSED; ALL. */
  show: z.enum(["DUE", "PENDING", "BOOKED", "DONE", "CLOSED", "ALL"]).default("DUE"),
  mine: z.enum(["0", "1"]).default("0"),
  search: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const contactSchema = z.object({
  outcome: z.enum(["CALL_AGAIN", "NO_ANSWER", "WRONG_NUMBER", "DECLINED", "ALREADY_VISITED"]),
  note: z.string().trim().max(500).optional(),
  /** When to call again. Required for CALL_AGAIN. */
  nextCallAt: instant.optional(),
  /** From the call timer on the screen. */
  durationSeconds: z.number().int().min(0).max(14400).optional(),
}).strict().refine((v) => v.outcome !== "CALL_AGAIN" || v.nextCallAt, { path: ["nextCallAt"], message: "Say when to call again" })
  .refine((v) => !["DECLINED", "ALREADY_VISITED"].includes(v.outcome) || (v.note?.length ?? 0) >= 3, { path: ["note"], message: "Say why (at least 3 characters)" });
export const bookReviewSchema = z.object({
  practitionerId: uuid, startAt: instant, durationMinutes: z.number().int().min(5).max(240).optional(), notes: z.string().trim().max(500).optional(),
}).strict();
export const updateTaskSchema = z.object({ dueDate: isoDay.optional(), assignedToId: uuid.nullable().optional() }).strict().refine((v) => v.dueDate !== undefined || v.assignedToId !== undefined, "Nothing to change");
export const closeTaskSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
export const summarySchema = z.object({ from: isoDay.optional(), to: isoDay.optional() }).strict();

const CLAIM_MINUTES = 15;
const dayOf = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * The post-discharge journey (docs/aftercare.md): a review visit is due after every stay, the care coordinator or call centre calls the patient and books it
 * as an ordinary follow-up appointment, and the task follows that appointment to completion.
 */
@Injectable()
export class AftercareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly appointments: AppointmentsService,
  ) {}

  /**
   * Called inside the transaction that completes a discharge. A review is due after a routine, referred or left-against-advice discharge;
   * not after a death or an absconding. The date comes from the signed summary's follow-up advice, or the hospital's default.
   */
  async createForDischarge(tx: Db, ctx: RequestContext, adm: { id: string; patientId: string; encounterId: string }, type: string, now: Date): Promise<void> {
    if (type === "DEATH" || type === "ABSCONDED") return;
    const fac = await tx.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    const today = dayOf(now, fac.timezone);
    const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, kind: "DISCHARGE_SUMMARY" }, select: { id: true, status: true, draft: true, currentVersion: true } });
    let content: unknown = doc?.draft ?? null;
    if (doc && doc.status !== "DRAFT") content = (await tx.clinicalDocumentVersion.findFirst({ where: { tenantId: ctx.tenantId, documentId: doc.id, version: doc.currentVersion }, select: { content: true } }))?.content ?? null;
    const advice = ((content ?? {}) as { followUp?: { afterDays?: number; date?: string; notes?: string } }).followUp;
    const fallback = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "AFTERCARE_REVIEW_DAYS");
    const due = advice?.date && /^\d{4}-\d{2}-\d{2}$/.test(advice.date) && advice.date >= today ? advice.date : addDays(today, advice?.afterDays ?? fallback);
    const exists = await tx.aftercareTask.findFirst({ where: { tenantId: ctx.tenantId, admissionId: adm.id }, select: { id: true } });
    if (exists) return;
    const t = await tx.aftercareTask.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId: adm.id, dueDate: new Date(`${due}T00:00:00Z`), adviceNote: advice?.notes?.slice(0, 500) || null } });
    await this.audit.record(tx, actorOf(ctx), { action: "AFTERCARE_TASK_CREATED", entityType: "AftercareTask", entityId: t.id, metadata: { admissionId: adm.id, dueDate: due } });
  }

  async list(ctx: RequestContext, q: z.infer<typeof aftercareListSchema>) {
    const fac = await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    const now = new Date();
    const today = dayOf(now, fac.timezone);
    const lead = await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "AFTERCARE_CALL_LEAD_DAYS");
    const status = { PENDING: "PENDING", BOOKED: "BOOKED", DONE: "COMPLETED", CLOSED: "CLOSED" } as const;
    const where: Prisma.AftercareTaskWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId,
      ...(q.show === "ALL" ? {} : q.show === "DUE" ? { status: "PENDING", OR: [{ dueDate: { lte: new Date(`${addDays(today, lead)}T00:00:00Z`) } }, { nextCallAt: { lte: now } }] } : { status: status[q.show] }),
      ...(q.mine === "1" ? { assignedToId: ctx.userId } : {}),
      ...(q.search ? { patient: { OR: [{ searchName: { contains: q.search.toLowerCase() } }, { mobile: { contains: q.search } }, { identifiers: { some: { value: { contains: q.search, mode: "insensitive" as const } } } }] } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.aftercareTask.findMany({
        where, orderBy: [{ dueDate: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: {
          patient: { select: { id: true, firstName: true, lastName: true, mobile: true, identifiers: { where: { type: "MRN" }, select: { value: true }, take: 1 } } },
          admission: { select: { admissionNumber: true, dischargedAt: true } },
          appointment: { select: { startAt: true, status: true, practitioner: { select: { displayName: true } } } },
          contacts: { orderBy: { at: "desc" }, take: 1, select: { outcome: true, at: true } },
        },
      }),
      this.prisma.aftercareTask.count({ where }),
    ]);
    const users = await this.names(this.prisma, ctx, rows.map((r) => r.assignedToId));
    return {
      items: rows.map((r) => ({
        id: r.id, patientId: r.patient.id, patient: [r.patient.firstName, r.patient.lastName].filter(Boolean).join(" "), mrn: r.patient.identifiers[0]?.value ?? null, mobile: r.patient.mobile,
        admissionNumber: r.admission.admissionNumber, dischargedAt: r.admission.dischargedAt, dueDate: r.dueDate.toISOString().slice(0, 10),
        daysOverdue: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - r.dueDate.getTime()) / 86_400_000)),
        status: r.status, adviceNote: r.adviceNote, attempts: r.attempts, nextCallAt: r.nextCallAt, claimedUntil: r.claimedUntil && r.claimedUntil > now ? r.claimedUntil : null, assignedToId: r.assignedToId, assignedTo: r.assignedToId ? users.get(r.assignedToId) ?? null : null,
        lastContact: r.contacts[0] ? { outcome: r.contacts[0].outcome, at: r.contacts[0].at } : null,
        appointment: r.appointment ? { startAt: r.appointment.startAt, status: r.appointment.status, doctor: r.appointment.practitioner.displayName } : null,
        closeReason: r.closeReason,
      })),
      total, page: q.page, pageSize: q.pageSize,
    };
  }

  async get(ctx: RequestContext, id: string) { return this.getIn(this.prisma, ctx, id); }

  async getIn(db: Db | PrismaService, ctx: RequestContext, id: string) {
    const t = await db.aftercareTask.findFirst({
      where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      include: { contacts: { orderBy: { at: "asc" } }, appointment: { select: { id: true, startAt: true, status: true, practitioner: { select: { displayName: true } } } }, admission: { select: { admissionNumber: true, dischargedAt: true } }, patient: { select: { firstName: true, lastName: true, mobile: true } } },
    });
    if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const users = await this.names(db, ctx, [t.assignedToId, ...t.contacts.map((c) => c.byId)]);
    return {
      id: t.id, patientId: t.patientId, patient: [t.patient.firstName, t.patient.lastName].filter(Boolean).join(" "), mobile: t.patient.mobile, admissionId: t.admissionId, admissionNumber: t.admission.admissionNumber,
      dischargedAt: t.admission.dischargedAt, dueDate: t.dueDate.toISOString().slice(0, 10), adviceNote: t.adviceNote, status: t.status, attempts: t.attempts, nextCallAt: t.nextCallAt,
      assignedToId: t.assignedToId, assignedTo: t.assignedToId ? users.get(t.assignedToId) ?? null : null, closeReason: t.closeReason, completedAt: t.completedAt,
      appointment: t.appointment ? { id: t.appointment.id, startAt: t.appointment.startAt, status: t.appointment.status, doctor: t.appointment.practitioner.displayName } : null,
      reminderSentAt: t.reminderSentAt, reminderError: t.reminderError,
      contacts: t.contacts.map((c) => ({ outcome: c.outcome, note: c.note, nextCallAt: c.nextCallAt, durationSeconds: c.durationSeconds, at: c.at, by: users.get(c.byId) ?? null })),
    };
  }

  /** One call: what happened, and when to call again. Declined and already-visited close the review, with the reason. */
  async logContact(ctx: RequestContext, id: string, input: z.infer<typeof contactSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, ctx, id);
      if (t.status !== "PENDING") throw new DomainError("INVALID_STATE", `This review is already ${t.status.toLowerCase()}`, 409);
      if (input.nextCallAt && input.nextCallAt.getTime() < Date.now() - 60_000) throw new DomainError("VALIDATION_FAILED", "The next call cannot be in the past", 400, [{ path: "nextCallAt", message: "In the past" }]);
      await tx.contactAttempt.create({ data: { tenantId: ctx.tenantId, taskId: id, outcome: input.outcome, note: input.note || null, nextCallAt: input.nextCallAt ?? null, durationSeconds: input.durationSeconds ?? null, byId: ctx.userId } });
      const closing = input.outcome === "DECLINED" || input.outcome === "ALREADY_VISITED";
      await tx.aftercareTask.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: {
          attempts: { increment: 1 }, nextCallAt: closing ? null : input.nextCallAt ?? null, claimedUntil: null,
          ...(t.assignedToId ? {} : { assignedToId: ctx.userId }),
          ...(closing ? { status: "CLOSED", closeReason: `${input.outcome === "DECLINED" ? "Patient declined" : "Already visited"}: ${input.note}`.slice(0, 300), closedById: ctx.userId, closedAt: new Date() } : {}),
        },
      });
      await this.audit.record(tx, actorOf(ctx), { action: closing ? "AFTERCARE_CLOSED" : "AFTERCARE_CONTACTED", entityType: "AftercareTask", entityId: id, metadata: { outcome: input.outcome } });
      return this.viewIn(tx, ctx, id);
    });
  }

  /** The review is booked as an ordinary follow-up appointment linked to the stay, so the doctor's schedule, check-in, the OPD queue and the appointment reminders all apply. */
  async book(ctx: RequestContext, id: string, input: z.infer<typeof bookReviewSchema>) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const t = await this.lock(tx, ctx, id);
        if (t.status !== "PENDING") throw new DomainError("INVALID_STATE", t.status === "BOOKED" ? "This review is already booked" : `This review is already ${t.status.toLowerCase()}`, 409);
        const adm = await tx.admission.findFirstOrThrow({ where: { id: t.admissionId, tenantId: ctx.tenantId }, select: { encounterId: true } });
        const create = { patientId: t.patientId, practitionerId: input.practitionerId, startAt: input.startAt, ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}), type: "FOLLOW_UP" as const, notes: input.notes ?? "Review after discharge" };
        this.appointments.assertCreate(ctx, create);
        const appt = await this.appointments.createInTx(tx, ctx, create, { followUpOfEncounterId: adm.encounterId });
        await tx.contactAttempt.create({ data: { tenantId: ctx.tenantId, taskId: id, outcome: "BOOKED", note: `Review booked for ${input.startAt.toISOString()}`, byId: ctx.userId } });
        await tx.aftercareTask.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "BOOKED", appointmentId: (appt as { id: string }).id, attempts: { increment: 1 }, nextCallAt: null, claimedUntil: null, ...(t.assignedToId ? {} : { assignedToId: ctx.userId }) } });
        await this.audit.record(tx, actorOf(ctx), { action: "AFTERCARE_BOOKED", entityType: "AftercareTask", entityId: id, metadata: { appointmentId: (appt as { id: string }).id } });
        return this.viewIn(tx, ctx, id);
      });
    } catch (e) {
      throw this.appointments.mapConflict(e);
    }
  }

  /**
   * The call queue: "take the next patient". The most overdue review that is due for a call and that nobody else is on is given to this person for CLAIM_MINUTES; they are the only one
   * offered it until then. Two people asking at once get two different patients (rows are claimed with SKIP LOCKED). Logging the call or booking the review ends the claim;
   * so does releasing it, or the time running out.
   */
  async next(ctx: RequestContext) {
    return this.prisma.$transaction(async (tx) => {
      const fac = await tx.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
      const now = new Date();
      const lead = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "AFTERCARE_CALL_LEAD_DAYS");
      const horizon = new Date(`${addDays(dayOf(now, fac.timezone), lead)}T00:00:00Z`);
      // Whoever already holds a claim is given the same patient again rather than a second one.
      const mine = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "AftercareTask" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND status = 'PENDING' AND "assignedToId" = ${ctx.userId}::uuid AND "claimedUntil" > ${now}
        ORDER BY "claimedUntil" DESC, id LIMIT 1 FOR UPDATE`;
      const rows = mine.length > 0 ? mine : await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "AftercareTask" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND status = 'PENDING'
          AND ("dueDate" <= ${horizon}::date OR "nextCallAt" <= ${now}) AND ("nextCallAt" IS NULL OR "nextCallAt" <= ${now}) AND ("claimedUntil" IS NULL OR "claimedUntil" <= ${now})
        ORDER BY "dueDate", attempts, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return null;
      const id = rows[0]!.id;
      await tx.aftercareTask.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { assignedToId: ctx.userId, claimedUntil: new Date(now.getTime() + CLAIM_MINUTES * 60_000) } });
      await this.audit.record(tx, actorOf(ctx), { action: "AFTERCARE_CLAIMED", entityType: "AftercareTask", entityId: id, metadata: { minutes: CLAIM_MINUTES } });
      return this.getIn(tx, ctx, id);
    });
  }

  /** Gives the patient back to the queue without calling (the person is busy, or it is not a good time). */
  async release(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, ctx, id);
      if (t.status !== "PENDING") throw new DomainError("INVALID_STATE", `This review is already ${t.status.toLowerCase()}`, 409);
      if (t.assignedToId !== ctx.userId || !t.claimedUntil) throw new DomainError("INVALID_STATE", "You are not holding this patient in the queue", 409);
      await tx.aftercareTask.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { claimedUntil: null, assignedToId: null } });
      await this.audit.record(tx, actorOf(ctx), { action: "AFTERCARE_RELEASED", entityType: "AftercareTask", entityId: id, metadata: {} });
      return this.viewIn(tx, ctx, id);
    });
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof updateTaskSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, ctx, id);
      if (["COMPLETED", "CLOSED"].includes(t.status)) throw new DomainError("INVALID_STATE", `This review is already ${t.status.toLowerCase()}`, 409);
      if (input.assignedToId) {
        const u = await tx.user.findFirst({ where: { id: input.assignedToId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
        if (!u) throw new DomainError("VALIDATION_FAILED", "That person cannot be given this review", 400, [{ path: "assignedToId", message: "Not an active user" }]);
      }
      await tx.aftercareTask.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: { ...(input.dueDate ? { dueDate: new Date(`${input.dueDate}T00:00:00Z`) } : {}), ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}) },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "AFTERCARE_UPDATED", entityType: "AftercareTask", entityId: id, metadata: { dueDate: input.dueDate ?? null, assignedToId: input.assignedToId ?? null } });
      return this.viewIn(tx, ctx, id);
    });
  }

  /** Stops chasing a review for a reason (for example the patient moved away). A booked review is closed by cancelling its appointment, which puts the patient back on the list. */
  async close(ctx: RequestContext, id: string, input: z.infer<typeof closeTaskSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, ctx, id);
      if (t.status !== "PENDING") throw new DomainError("INVALID_STATE", t.status === "BOOKED" ? "Cancel the booked visit first" : `This review is already ${t.status.toLowerCase()}`, 409);
      await tx.aftercareTask.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CLOSED", closeReason: input.reason, closedById: ctx.userId, closedAt: new Date(), nextCallAt: null } });
      await this.audit.record(tx, actorOf(ctx), { action: "AFTERCARE_CLOSED", entityType: "AftercareTask", entityId: id, metadata: { reason: "closed by staff" } });
      return this.viewIn(tx, ctx, id);
    });
  }

  /** How the journey is going over a period: reviews due, reached, booked and kept; what patients rated; complaints and how long they took. */
  async summary(ctx: RequestContext, q: z.infer<typeof summarySchema>) {
    const fac = await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    const today = dayOf(new Date(), fac.timezone);
    const to = q.to ?? today, from = q.from ?? addDays(to, -29);
    if (from > to) throw new DomainError("VALIDATION_FAILED", "The start date is after the end date", 400);
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw new DomainError("VALIDATION_FAILED", "Choose a period of at most a year", 400);
    const start = new Date(`${from}T00:00:00Z`), end = new Date(`${addDays(to, 1)}T00:00:00Z`);
    const base = { tenantId: ctx.tenantId, facilityId: ctx.facilityId };
    const [byStatus, contacted, feedback, complaints, resolved] = await Promise.all([
      this.prisma.aftercareTask.groupBy({ by: ["status"], where: { ...base, dueDate: { gte: start, lt: end } }, _count: { _all: true } }),
      this.prisma.aftercareTask.count({ where: { ...base, dueDate: { gte: start, lt: end }, attempts: { gt: 0 } } }),
      this.prisma.patientFeedback.groupBy({ by: ["rating"], where: { ...base, recordedAt: { gte: start, lt: end } }, _count: { _all: true } }),
      this.prisma.complaint.groupBy({ by: ["status"], where: { ...base, createdAt: { gte: start, lt: end } }, _count: { _all: true } }),
      this.prisma.complaint.findMany({ where: { ...base, createdAt: { gte: start, lt: end }, resolvedAt: { not: null } }, select: { createdAt: true, resolvedAt: true } }),
    ]);
    const n = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
    const due = byStatus.reduce((a, b) => a + b._count._all, 0);
    const ratings = feedback.reduce((a, b) => a + b._count._all, 0);
    const days = resolved.map((r) => (r.resolvedAt!.getTime() - r.createdAt.getTime()) / 86_400_000);
    return {
      from, to,
      reviews: { due, pending: n("PENDING"), booked: n("BOOKED"), completed: n("COMPLETED"), closed: n("CLOSED"), reached: contacted },
      feedback: { count: ratings, average: ratings ? Math.round((feedback.reduce((a, b) => a + b.rating * b._count._all, 0) / ratings) * 10) / 10 : null, byRating: [1, 2, 3, 4, 5].map((r) => ({ rating: r, count: feedback.find((f) => f.rating === r)?._count._all ?? 0 })) },
      complaints: { total: complaints.reduce((a, b) => a + b._count._all, 0), open: complaints.filter((c) => c.status === "OPEN" || c.status === "IN_PROGRESS").reduce((a, b) => a + b._count._all, 0), resolved: resolved.length, averageDaysToResolve: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null },
    };
  }

  private async lock(tx: Db, ctx: RequestContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "AftercareTask" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.aftercareTask.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
  }

  private async names(db: Db | PrismaService, ctx: RequestContext, ids: (string | null)[]) {
    const list = [...new Set(ids.filter((i): i is string => !!i))];
    if (list.length === 0) return new Map<string, string>();
    return new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: list } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
  }

  private async viewIn(tx: Db, ctx: RequestContext, id: string) {
    const t = await tx.aftercareTask.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, include: { appointment: { select: { id: true, startAt: true, status: true } } } });
    return { id: t.id, status: t.status, attempts: t.attempts, dueDate: t.dueDate.toISOString().slice(0, 10), nextCallAt: t.nextCallAt, assignedToId: t.assignedToId, closeReason: t.closeReason, appointment: t.appointment };
  }
}
