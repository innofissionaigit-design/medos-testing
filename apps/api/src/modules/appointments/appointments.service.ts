import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { isRestricted, visitScope } from "../../common/data-scope";
import { chartPatientIds } from "../patients/patient-links";
import { dateOnly, endOfLocalDay, formatHm, localDateStr, localMinutes, localParts, parseHm, startOfLocalDay, zonedToUtc } from "../../common/time";
import { EncountersService, toEncounterView } from "../encounters/encounters.service";
import { RemindersService } from "../follow-ups/reminders.service";
import { NumberingService } from "../numbering/numbering.service";
import { SettingsService } from "../settings/settings.service";
import { Decimal } from "@medos/shared";
import { fmt } from "../billing/billing.domain";
import { feeHeld, feePaid, feeState } from "./booking-fee";
import { PaymentLinksService } from "./payment-links.service";
import { WebhooksService } from "../integrations/webhooks.service";
import { assertNoDuplicateBooking, findDuplicateBookings } from "./duplicate-booking";
import { AdvancesService } from "../billing/advances.service";
import { InvoicesService } from "../billing/invoices.service";
import { RegistrationFeeService } from "../patients/registration-fee.service";

export type AppointmentStatusName = "BOOKED" | "CHECKED_IN" | "WAITING" | "IN_CONSULTATION" | "COMPLETED" | "NO_SHOW" | "CANCELLED";

/** Single source of truth for appointment transitions (mirrored by a database trigger). */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatusName, readonly AppointmentStatusName[]> = {
  BOOKED: ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CHECKED_IN: ["WAITING", "CANCELLED"],
  WAITING: ["IN_CONSULTATION", "CANCELLED"],
  IN_CONSULTATION: ["COMPLETED"],
  COMPLETED: [],
  NO_SHOW: [],
  CANCELLED: [],
};
export const LIVE_STATUSES: AppointmentStatusName[] = ["BOOKED", "CHECKED_IN", "WAITING", "IN_CONSULTATION"];

export function canTransition(from: AppointmentStatusName, to: AppointmentStatusName): boolean {
  return APPOINTMENT_TRANSITIONS[from].includes(to);
}

// ───────────────────────── schemas ─────────────────────────

const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const reason = z.string().trim().min(3).max(240);
const hm = z.string().transform((s, c) => {
  const m = parseHm(s);
  if (m === null) c.addIssue({ code: "custom", message: "Use HH:MM (24h)" });
  return m ?? 0;
});

export const scheduleSchema = z.object({
  windows: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6), start: hm, end: hm, slotMinutes: z.number().int().min(5).max(120).default(15),
  }).strict()).max(28),
}).strict().superRefine((v, c) => {
  v.windows.forEach((w, i) => { if (w.start >= w.end) c.addIssue({ code: "custom", path: ["windows", i, "end"], message: "End must be after start" }); });
  for (let d = 0; d < 7; d++) {
    const day = v.windows.map((w, i) => ({ ...w, i })).filter((w) => w.dayOfWeek === d).sort((a, b) => a.start - b.start);
    for (let k = 1; k < day.length; k++) {
      if ((day[k] as { start: number }).start < (day[k - 1] as { end: number }).end) c.addIssue({ code: "custom", path: ["windows", (day[k] as { i: number }).i], message: "Overlaps another window on the same day" });
    }
  }
});

const overbook = z.object({ reason }).strict();
/** Book despite a suspected duplicate booking (docs/duplicate-booking.md): needs DUPLICATE_OVERRIDE and a reason. */
const duplicateOverride = z.object({ reason }).strict();

export const createAppointmentSchema = z.object({
  patientId: uuid, practitionerId: uuid, startAt: instant,
  durationMinutes: z.number().int().min(5).max(240).default(15),
  type: z.enum(["CONSULTATION", "FOLLOW_UP", "PROCEDURE"]).default("CONSULTATION"),
  notes: z.string().trim().max(500).optional(),
  overbook: overbook.optional(),
  duplicateOverride: duplicateOverride.optional(),
}).strict();

export const rescheduleSchema = z.object({
  version: z.number().int().min(1), startAt: instant.optional(), durationMinutes: z.number().int().min(5).max(240).optional(),
  practitionerId: uuid.optional(), overbook: overbook.optional(), duplicateOverride: duplicateOverride.optional(),
}).strict().refine((v) => v.startAt || v.durationMinutes || v.practitionerId, "Nothing to change");

export const cancelSchema = z.object({ reason }).strict();
/** Skipping a booking fee: the reason must be one of the hospital's configured reasons (checked against the setting, not trusted from the client). */
export const skipBookingFeeSchema = z.object({ reason: z.string().trim().min(3).max(60), note: z.string().trim().max(240).optional() }).strict();

export const walkInSchema = z.object({
  patientId: uuid, practitionerId: uuid,
  type: z.enum(["CONSULTATION", "FOLLOW_UP", "PROCEDURE"]).default("CONSULTATION"),
  priority: z.enum(["NORMAL", "PRIORITY", "EMERGENCY"]).default("NORMAL"),
  notes: z.string().trim().max(500).optional(),
  duplicateOverride: duplicateOverride.optional(),
}).strict();

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(dateOnly(s).getTime()) && dateOnly(s).toISOString().slice(0, 10) === s, "Invalid date");
export const listAppointmentsSchema = z.object({
  date: ymd.optional(), practitionerId: uuid.optional(), patientId: uuid.optional(),
  status: z.enum(["BOOKED", "CHECKED_IN", "WAITING", "IN_CONSULTATION", "COMPLETED", "NO_SHOW", "CANCELLED"]).optional(),
  type: z.enum(["CONSULTATION", "FOLLOW_UP", "PROCEDURE"]).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export const availabilitySchema = z.object({ date: ymd }).strict();
export const historySchema = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

// ───────────────────────── views ─────────────────────────

export const VIEW = {
  id: true, startAt: true, endAt: true, status: true, type: true, source: true, notes: true, overbooked: true, overbookReason: true,
  cancelReason: true, encounterId: true, followUpOfEncounterId: true, version: true, patientId: true, practitionerId: true, departmentId: true,
  bookingFee: true, feeSkippedAt: true, feeSkipReason: true, feeSkipNote: true,
  advanceDeposits: { select: { id: true, amount: true, refunds: { select: { amount: true } }, uses: { select: { amount: true } }, returns: { select: { amount: true } } } },
  paymentLink: { select: { status: true, dueBy: true, sendStatus: true, sentAt: true, providerMessageId: true } },
  patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" as const }, select: { value: true } } } },
  practitioner: { select: { displayName: true } },
  department: { select: { name: true } },
  followUpOf: { select: { encounterNumber: true, startedAt: true } },
} satisfies Prisma.AppointmentSelect;
type Row = Prisma.AppointmentGetPayload<{ select: typeof VIEW }>;

export function toAppointmentView(a: Row) {
  const { patient, practitioner, department, followUpOf, advanceDeposits, paymentLink, bookingFee, feeSkippedAt, feeSkipReason, feeSkipNote, ...rest } = a;
  const fee = feeState({ bookingFee, feeSkippedAt }, feePaid(advanceDeposits));
  return {
    ...rest,
    bookingFee: fee.fee, feeStatus: fee.status, feePaid: fee.paid, feeDue: fee.due,
    /** Booking-fee money still held for the patient (for example after a cancellation): what can be given back, and from which advance. */
    feeHeld: feeHeld(advanceDeposits),
    feeSkip: feeSkippedAt ? { at: feeSkippedAt, reason: feeSkipReason, note: feeSkipNote } : null,
    /** The payment link and its deadline, when the hospital uses them. `placeholder` is true while WhatsApp delivery is not connected: nothing was actually sent. */
    paymentLink: paymentLink ? { status: paymentLink.status, dueBy: paymentLink.dueBy, sendStatus: paymentLink.sendStatus, sentAt: paymentLink.sentAt, placeholder: paymentLink.providerMessageId?.startsWith("log-only:") ?? true } : null,
    patientName: [patient.firstName, patient.lastName].filter(Boolean).join(" "),
    mrn: patient.identifiers[0]?.value ?? null,
    practitionerName: practitioner.displayName,
    departmentName: department?.name ?? null,
    followUpOfVisit: followUpOf ? { encounterNumber: followUpOf.encounterNumber, startedAt: followUpOf.startedAt } : null,
  };
}

function isConstraintViolation(e: unknown, name: string): boolean {
  return e instanceof Error && e.message.includes(name);
}

// ───────────────────────── service ─────────────────────────

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly encounters: EncountersService,
    private readonly numbering: NumberingService,
    private readonly idempotency: IdempotencyService,
    private readonly reminders: RemindersService,
    private readonly registrationFee: RegistrationFeeService,
    private readonly settings: SettingsService,
    private readonly webhooks: WebhooksService,
    private readonly paymentLinks: PaymentLinksService,
    private readonly advances: AdvancesService,
    private readonly invoices: InvoicesService,
  ) {}

  /**
   * Serialises concurrent bookings that touch the same practitioner or patient. The exclusion constraints still
   * guarantee correctness; the advisory locks (released at commit) prevent them from deadlocking each other.
   */
  private async lockBooking(tx: Db, ...keys: string[]): Promise<void> {
    for (const k of [...new Set(keys)].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
  }

  private async tz(db: Db, ctx: RequestContext): Promise<string> {
    const f = await db.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    return f.timezone;
  }

  // ───── schedules ─────

  async getSchedule(ctx: RequestContext, practitionerId: string) {
    await this.assertPractitioner(this.prisma, ctx, practitionerId, false);
    const rows = await this.prisma.practitionerSchedule.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, status: "ACTIVE" },
      orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
    });
    return rows.map((r) => ({ dayOfWeek: r.dayOfWeek, start: formatHm(r.startMinute), end: formatHm(r.endMinute), slotMinutes: r.slotMinutes }));
  }

  async setSchedule(ctx: RequestContext, practitionerId: string, input: z.infer<typeof scheduleSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertPractitioner(tx, ctx, practitionerId, false);
      await tx.practitionerSchedule.updateMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, status: "ACTIVE" }, data: { status: "INACTIVE" } });
      if (input.windows.length) {
        await tx.practitionerSchedule.createMany({
          data: input.windows.map((w) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, dayOfWeek: w.dayOfWeek, startMinute: w.start, endMinute: w.end, slotMinutes: w.slotMinutes })),
        });
      }
      await this.audit.record(tx, actorOf(ctx), { action: "PRACTITIONER_SCHEDULE_REPLACED", entityType: "Practitioner", entityId: practitionerId, metadata: { windows: input.windows.length } });
      return input.windows.map((w) => ({ dayOfWeek: w.dayOfWeek, start: formatHm(w.start), end: formatHm(w.end), slotMinutes: w.slotMinutes }));
    });
  }

  async availability(ctx: RequestContext, practitionerId: string, date: string) {
    const tz = await this.tz(this.prisma, ctx);
    await this.assertPractitioner(this.prisma, ctx, practitionerId, true);
    const weekday = localParts(zonedToUtc(date, 12 * 60, tz), tz).weekday;
    const windows = await this.prisma.practitionerSchedule.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, status: "ACTIVE", dayOfWeek: weekday }, orderBy: { startMinute: "asc" },
    });
    const dayStart = startOfLocalDay(date, tz);
    const dayEnd = endOfLocalDay(date, tz);
    const booked = await this.prisma.appointment.findMany({
      where: { tenantId: ctx.tenantId, practitionerId, overbooked: false, status: { in: LIVE_STATUSES }, startAt: { lt: dayEnd }, endAt: { gt: dayStart } },
      select: { startAt: true, endAt: true },
    });
    const now = Date.now();
    const slots: { startAt: string; endAt: string; available: boolean }[] = [];
    for (const w of windows) {
      for (let m = w.startMinute; m + w.slotMinutes <= w.endMinute; m += w.slotMinutes) {
        const s = zonedToUtc(date, m, tz);
        const e = zonedToUtc(date, m + w.slotMinutes, tz);
        const taken = booked.some((b) => b.startAt < e && b.endAt > s);
        slots.push({ startAt: s.toISOString(), endAt: e.toISOString(), available: !taken && s.getTime() >= now });
      }
    }
    return slots;
  }

  // ───── queries ─────

  /** API clients (outside systems, bots) only ever see and change the appointments they made themselves. People are not limited this way. */
  private own(ctx: RequestContext): Prisma.AppointmentWhereInput {
    return { ...(ctx.apiClientId ? { createdById: ctx.userId } : {}), ...(isRestricted(ctx) ? { AND: [visitScope(ctx)] } : {}) };
  }

  async list(ctx: RequestContext, q: z.infer<typeof listAppointmentsSchema>) {
    const tz = await this.tz(this.prisma, ctx);
    const date = q.date ?? localDateStr(new Date(), tz);
    const where: Prisma.AppointmentWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...this.own(ctx),
      startAt: { gte: startOfLocalDay(date, tz), lt: endOfLocalDay(date, tz) },
      ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}),
      ...(q.patientId ? { patientId: { in: (await chartPatientIds(this.prisma, ctx.tenantId, q.patientId)) ?? [q.patientId] } } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.appointment.findMany({ where, select: VIEW, orderBy: { startAt: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.appointment.count({ where }),
    ]);
    return { items: rows.map(toAppointmentView), total };
  }

  /** A patient's appointments at this facility, newest first, follow-ups included with the visit that ordered them. */
  async history(ctx: RequestContext, patientId: string, q: z.infer<typeof historySchema>) {
    const ids = await chartPatientIds(this.prisma, ctx.tenantId, patientId);
    if (!ids) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    const where: Prisma.AppointmentWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...this.own(ctx), patientId: { in: ids } };
    const [rows, total] = await Promise.all([
      this.prisma.appointment.findMany({ where, select: VIEW, orderBy: [{ startAt: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.appointment.count({ where }),
    ]);
    return { items: rows.map(toAppointmentView), total };
  }

  async get(ctx: RequestContext, id: string) {
    const a = await this.prisma.appointment.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...this.own(ctx) }, select: VIEW });
    if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return toAppointmentView(a);
  }

  // ───── commands ─────

  /** `followUpOfEncounterId` is set only by FollowUpsService, which has already checked the consultation and its doctor. */
  async create(ctx: RequestContext, input: z.infer<typeof createAppointmentSchema>, link: { followUpOfEncounterId?: string } = {}) {
    this.assertCreate(ctx, input);
    try {
      return await this.prisma.$transaction((tx) => this.createInTx(tx, ctx, input, link));
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  /**
   * Booking that is safe to retry: the same Idempotency-Key with the same request returns the first result instead of booking again, which is what
   * a bot or another system needs when a call times out (docs/integration-api.md). A key reused for a different request is refused.
   */
  async createIdempotent(ctx: RequestContext, input: z.infer<typeof createAppointmentSchema>, key: string) {
    this.assertCreate(ctx, input);
    try {
      return await this.idempotency.run(ctx.tenantId, "APPOINTMENT_CREATE", key, input, (tx) => this.createInTx(tx, ctx, input, {}));
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  private assertCreate(ctx: RequestContext, input: z.infer<typeof createAppointmentSchema>): void {
    this.assertOverbookAllowed(ctx, input.overbook);
    this.assertNotInPast(input.startAt);
  }

  private async createInTx(tx: Db, ctx: RequestContext, input: z.infer<typeof createAppointmentSchema>, link: { followUpOfEncounterId?: string }) {
    const endAt = new Date(input.startAt.getTime() + input.durationMinutes * 60_000);
    await this.lockBooking(tx, `practitioner:${input.practitionerId}`, `patient:${input.patientId}`);
    const tz = await this.tz(tx, ctx);
    const practitioner = await this.assertPractitioner(tx, ctx, input.practitionerId, true);
    await this.assertPatient(tx, ctx, input.patientId);
    if (!input.overbook) await this.assertWithinSchedule(tx, ctx, input.practitionerId, input.startAt, endAt, tz);
    const isFollowUp = input.type === "FOLLOW_UP" || !!link.followUpOfEncounterId;
    const dupes = isFollowUp ? [] : await findDuplicateBookings(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, tz }, { patientId: input.patientId, practitionerId: input.practitionerId, departmentId: practitioner.departmentId, startAt: input.startAt, endAt });
    assertNoDuplicateBooking(dupes, input.duplicateOverride, ctx.permissions);
    // A fee is asked for ordinary bookings only; follow-ups booked from a consultation and walk-ins never carry one.
    const bookingFee = input.type === "FOLLOW_UP" || link.followUpOfEncounterId ? null : await this.currentFee(tx, ctx);
    const a = await tx.appointment.create({
      data: {
        bookingFee: bookingFee ? bookingFee.toFixed(2) : null,
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, practitionerId: input.practitionerId,
        departmentId: practitioner.departmentId, startAt: input.startAt, endAt, type: input.type, notes: input.notes ?? null,
        overbooked: !!input.overbook, overbookReason: input.overbook?.reason ?? null, createdById: ctx.userId,
        followUpOfEncounterId: link.followUpOfEncounterId ?? null,
      },
      select: VIEW,
    });
    await this.audit.record(tx, actorOf(ctx), { action: "APPOINTMENT_CREATED", entityType: "Appointment", entityId: a.id, metadata: { practitionerId: input.practitionerId, startAt: input.startAt.toISOString() } });
    if (input.overbook) {
      await this.audit.record(tx, actorOf(ctx), { action: "APPOINTMENT_OVERBOOKED", entityType: "Appointment", entityId: a.id, metadata: { reason: input.overbook.reason } });
    }
    if (dupes.length > 0 && input.duplicateOverride) await this.auditDuplicateOverride(tx, ctx, a.id, input.duplicateOverride.reason, dupes);
    if (link.followUpOfEncounterId) {
      await this.audit.record(tx, actorOf(ctx), { action: "FOLLOW_UP_SCHEDULED", entityType: "Appointment", entityId: a.id, metadata: { encounterId: link.followUpOfEncounterId, practitionerId: input.practitionerId, startAt: input.startAt.toISOString() } });
    }
    await this.reminders.replan(tx, { id: a.id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, type: input.type, status: "BOOKED", startAt: input.startAt });
    await this.webhooks.enqueue(tx, ctx.tenantId, { id: a.id, facilityId: ctx.facilityId, createdById: ctx.userId, status: "BOOKED", startAt: input.startAt, endAt, practitionerId: input.practitionerId, version: 1 }, "appointment.booked");
    // A fee-bearing booking gets a payment link and a deadline when the hospital uses them (docs/booking-payment-link.md).
    const linked = await this.paymentLinks.createFor(tx, { id: a.id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, startAt: input.startAt, bookingFee });
    return toAppointmentView(linked ? await tx.appointment.findFirstOrThrow({ where: { id: a.id, tenantId: ctx.tenantId }, select: VIEW }) : a);
  }

  async reschedule(ctx: RequestContext, id: string, input: z.infer<typeof rescheduleSchema>) {
    this.assertOverbookAllowed(ctx, input.overbook);
    // Moving an appointment (later or earlier) is only ever to a time that has not passed yet.
    if (input.startAt && input.startAt.getTime() < Date.now()) throw new DomainError("VALIDATION_FAILED", "An appointment cannot be moved to a date or time that has already passed", 400, [{ path: "startAt", message: "Choose a time from now on" }]);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const tz = await this.tz(tx, ctx);
        const existing = await tx.appointment.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...this.own(ctx) } });
        if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        if (existing.status !== "BOOKED") throw new DomainError("APPOINTMENT_INVALID_STATE", "Only booked appointments can be rescheduled", 409);
        await this.lockBooking(tx, `practitioner:${existing.practitionerId}`, `practitioner:${input.practitionerId ?? existing.practitionerId}`, `patient:${existing.patientId}`);
        const practitionerId = input.practitionerId ?? existing.practitionerId;
        const practitioner = await this.assertPractitioner(tx, ctx, practitionerId, true);
        const startAt = input.startAt ?? existing.startAt;
        const duration = input.durationMinutes ?? Math.round((existing.endAt.getTime() - existing.startAt.getTime()) / 60_000);
        const endAt = new Date(startAt.getTime() + duration * 60_000);
        if (!input.overbook) await this.assertWithinSchedule(tx, ctx, practitionerId, startAt, endAt, tz);
        const dupes = existing.type === "FOLLOW_UP" ? [] : await findDuplicateBookings(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, tz }, { patientId: existing.patientId, practitionerId, departmentId: practitioner.departmentId, startAt, endAt, excludeAppointmentId: id });
        assertNoDuplicateBooking(dupes, input.duplicateOverride, ctx.permissions);
        if (dupes.length > 0 && input.duplicateOverride) await this.auditDuplicateOverride(tx, ctx, id, input.duplicateOverride.reason, dupes);
        const res = await tx.appointment.updateMany({
          where: { id, tenantId: ctx.tenantId, status: "BOOKED", version: input.version },
          data: {
            startAt, endAt, practitionerId, departmentId: practitioner.departmentId,
            overbooked: !!input.overbook, overbookReason: input.overbook?.reason ?? null, version: { increment: 1 },
          },
        });
        if (res.count !== 1) throw new DomainError("STALE_VERSION", "This appointment was changed by someone else. Reload and try again.", 409);
        await this.audit.record(tx, actorOf(ctx), {
          action: "APPOINTMENT_RESCHEDULED", entityType: "Appointment", entityId: id,
          metadata: { from: { startAt: existing.startAt.toISOString(), practitionerId: existing.practitionerId }, to: { startAt: startAt.toISOString(), practitionerId } },
        });
        await this.reminders.replan(tx, { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: existing.patientId, type: existing.type, status: "BOOKED", startAt });
        await this.webhooks.enqueue(tx, ctx.tenantId, { id, facilityId: ctx.facilityId, createdById: existing.createdById, status: "BOOKED", startAt, endAt, practitionerId, version: input.version + 1 }, "appointment.moved");
        return toAppointmentView(await tx.appointment.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW }));
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof cancelSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.appointment.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...this.own(ctx) }, include: { queueEntry: true } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const from = existing.status as AppointmentStatusName;
      if (!canTransition(from, "CANCELLED")) throw new DomainError("APPOINTMENT_INVALID_STATE", `A ${from.replace("_", " ").toLowerCase()} appointment cannot be cancelled`, 409);
      const res = await tx.appointment.updateMany({ where: { id, tenantId: ctx.tenantId, status: from }, data: { status: "CANCELLED", cancelReason: input.reason, version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("APPOINTMENT_INVALID_STATE", "Appointment was changed by someone else", 409);
      if (existing.queueEntry) {
        const q = await tx.queueEntry.updateMany({ where: { id: existing.queueEntry.id, tenantId: ctx.tenantId, status: { in: ["WAITING", "CALLED", "SKIPPED"] } }, data: { status: "CANCELLED", version: { increment: 1 } } });
        if (q.count !== 1) throw new DomainError("APPOINTMENT_INVALID_STATE", "The patient is already in consultation", 409);
      }
      if (existing.encounterId) await this.encounters.transition(tx, ctx, existing.encounterId, "CANCELLED", input.reason);
      const remindersCancelled = await this.reminders.cancelPending(tx, ctx.tenantId, id);
      await this.paymentLinks.close(tx, ctx.tenantId, id, "CANCELLED");
      const fee = await this.settleFeeOnCancel(tx, ctx, existing);
      await this.webhooks.enqueue(tx, ctx.tenantId, { id, facilityId: ctx.facilityId, createdById: existing.createdById, status: "CANCELLED", startAt: existing.startAt, endAt: existing.endAt, practitionerId: existing.practitionerId, version: existing.version + 1, cancelReason: input.reason }, "appointment.cancelled");
      await this.audit.record(tx, actorOf(ctx), { action: "APPOINTMENT_CANCELLED", entityType: "Appointment", entityId: id, metadata: { from, reason: input.reason, remindersCancelled, ...(fee ? { feeCharged: fee.charged, feeToGiveBack: fee.refundable } : {}) } });
      return toAppointmentView(await tx.appointment.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW }));
    });
  }

  async markNoShow(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.appointment.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...this.own(ctx) } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!canTransition(existing.status as AppointmentStatusName, "NO_SHOW")) throw new DomainError("APPOINTMENT_INVALID_STATE", "Only booked appointments can be marked as no-show", 409);
      if (existing.startAt.getTime() > Date.now()) throw new DomainError("APPOINTMENT_INVALID_STATE", "The appointment time has not arrived yet", 409);
      const res = await tx.appointment.updateMany({ where: { id, tenantId: ctx.tenantId, status: "BOOKED" }, data: { status: "NO_SHOW", version: { increment: 1 } } });
      if (res.count !== 1) throw new DomainError("APPOINTMENT_INVALID_STATE", "Appointment was changed by someone else", 409);
      await this.reminders.cancelPending(tx, ctx.tenantId, id);
      await this.paymentLinks.close(tx, ctx.tenantId, id, "CANCELLED");
      await this.audit.record(tx, actorOf(ctx), { action: "APPOINTMENT_NO_SHOW", entityType: "Appointment", entityId: id });
      return toAppointmentView(await tx.appointment.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW }));
    });
  }

  /** BOOKED -> CHECKED_IN -> WAITING, opening the OPD encounter and queue token in one transaction. */
  async checkIn(ctx: RequestContext, id: string, priority: "NORMAL" | "PRIORITY" | "EMERGENCY" = "NORMAL") {
    return this.prisma.$transaction(async (tx) => {
      const tz = await this.tz(tx, ctx);
      const existing = await tx.appointment.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (existing.status !== "BOOKED") throw new DomainError("APPOINTMENT_INVALID_STATE", "This appointment is not waiting to be checked in", 409);
      await this.assertFeeSettled(tx, ctx, existing);
      if (localDateStr(existing.startAt, tz) !== localDateStr(new Date(), tz)) {
        throw new DomainError("APPOINTMENT_INVALID_STATE", "Only today's appointments can be checked in", 409);
      }
      return this.checkInCore(tx, ctx, existing, priority, tz);
    });
  }

  /** Walk-in: creates an immediate appointment and checks it in, idempotently (safe against double-clicks). */
  async walkIn(ctx: RequestContext, input: z.infer<typeof walkInSchema>, idempotencyKey: string | undefined) {
    if (input.priority !== "NORMAL" && !ctx.permissions.has("QUEUE_MANAGE")) throw new DomainError("FORBIDDEN", "You do not have permission to set queue priority", 403);
    try {
      const { result, replayed } = await this.idempotency.run(ctx.tenantId, "WALK_IN", idempotencyKey, input, async (tx) => {
        await this.lockBooking(tx, `practitioner:${input.practitionerId}`, `patient:${input.patientId}`);
        const tz = await this.tz(tx, ctx);
        const practitioner = await this.assertPractitioner(tx, ctx, input.practitionerId, true);
        await this.assertPatient(tx, ctx, input.patientId);
        const now = new Date();
        const dupes = input.type === "FOLLOW_UP" ? [] : await findDuplicateBookings(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, tz }, { patientId: input.patientId, practitionerId: input.practitionerId, departmentId: practitioner.departmentId, startAt: now, endAt: new Date(now.getTime() + 15 * 60_000) });
        assertNoDuplicateBooking(dupes, input.duplicateOverride, ctx.permissions);
        const a = await tx.appointment.create({
          data: {
            tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, practitionerId: input.practitionerId,
            departmentId: practitioner.departmentId, startAt: now, endAt: new Date(now.getTime() + 15 * 60_000), type: input.type,
            source: "WALK_IN", notes: input.notes ?? null, overbooked: true, overbookReason: "Walk-in", createdById: ctx.userId,
          },
        });
        await this.audit.record(tx, actorOf(ctx), { action: "APPOINTMENT_CREATED", entityType: "Appointment", entityId: a.id, metadata: { walkIn: true, practitionerId: input.practitionerId } });
        if (dupes.length > 0 && input.duplicateOverride) await this.auditDuplicateOverride(tx, ctx, a.id, input.duplicateOverride.reason, dupes);
        return this.checkInCore(tx, ctx, a, input.priority, tz, { practitioner });
      });
      return { result, replayed };
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  // ───── booking fee (docs/booking-fee.md) ─────

  /**
   * A paid booking fee when the booking is cancelled (healthcare practice: the fee is the patient's money until a service or a charge is due).
   * Cancelled at least BOOKING_FEE_FREE_CANCEL_HOURS before the appointment: nothing is charged and all of it can be given back. Later: the
   * BOOKING_FEE_CANCEL_CHARGE_PERCENT share becomes an issued "cancellation charge" bill paid from that same fee, so the books show a charge and a
   * payment, never money silently kept. What is left stays the patient's advance until the cashier gives it back (an advance refund).
   */
  private async settleFeeOnCancel(tx: Db, ctx: RequestContext, appt: { id: string; patientId: string; startAt: Date; bookingFee: { toString(): string } | null }) {
    const deposits = await tx.advanceDeposit.findMany({ where: { tenantId: ctx.tenantId, appointmentId: appt.id }, select: { id: true, amount: true, refunds: { select: { amount: true } }, uses: { select: { amount: true } }, returns: { select: { amount: true } } } });
    if (deposits.length === 0 || appt.bookingFee === null) return null;
    const held = new Decimal(feeHeld(deposits).amount);
    if (held.lte(0)) return { charged: "0.00", refundable: "0.00" };
    const [freeHours, percent] = await Promise.all([
      this.settings.get(tx, ctx.tenantId, ctx.facilityId, "BOOKING_FEE_FREE_CANCEL_HOURS"),
      this.settings.get(tx, ctx.tenantId, ctx.facilityId, "BOOKING_FEE_CANCEL_CHARGE_PERCENT"),
    ]);
    const late = appt.startAt.getTime() - Date.now() < freeHours * 3_600_000;
    const charge = late && percent > 0 ? Decimal.min(held, new Decimal(appt.bookingFee.toString()).times(percent).div(100).toDecimalPlaces(2)) : new Decimal(0);
    if (charge.gt(0)) {
      const inv = await this.invoices.createIssuedFromSource(tx, ctx, {
        patientId: appt.patientId, encounterId: null, kind: "OTHER", notes: `Cancellation charge (${percent}% of the booking fee) for the appointment of ${appt.startAt.toISOString().slice(0, 10)}`,
        lines: [{ description: "Appointment cancellation charge", quantity: new Decimal(1), unitPrice: charge, taxPercent: new Decimal(0), sourceType: "APPOINTMENT_CANCELLATION", sourceId: appt.id }],
      });
      await this.advances.applyInTx(tx, ctx, inv.id, charge, appt.id);
      await this.audit.record(tx, actorOf(ctx), { action: "BOOKING_CANCELLATION_CHARGED", entityType: "Appointment", entityId: appt.id, metadata: { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, charge: charge.toFixed(2), percent, freeHours } });
    }
    return { charged: charge.toFixed(2), refundable: held.minus(charge).toFixed(2) };
  }

  private async auditDuplicateOverride(tx: Db, ctx: RequestContext, appointmentId: string, reason: string, dupes: { appointmentId: string; rule: string; match: string }[]): Promise<void> {
    await this.audit.record(tx, actorOf(ctx), {
      action: "APPOINTMENT_DUPLICATE_OVERRIDDEN", entityType: "Appointment", entityId: appointmentId,
      metadata: { reason, matches: dupes.map((d) => ({ appointmentId: d.appointmentId, rule: d.rule, match: d.match })) },
    });
  }

  /** The fee to ask for on a new booking, or null when the feature is off or the amount is zero. */
  private async currentFee(db: Db, ctx: RequestContext): Promise<Decimal | null> {
    if (!(await this.settings.get(db, ctx.tenantId, ctx.facilityId, "BOOKING_FEE_ENABLED"))) return null;
    const amount = new Decimal(await this.settings.get(db, ctx.tenantId, ctx.facilityId, "BOOKING_FEE_AMOUNT"));
    return amount.gt(0) ? amount : null;
  }

  async bookingFeeConfig(ctx: RequestContext) {
    const [enabled, amount, reasons] = await Promise.all([
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "BOOKING_FEE_ENABLED"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "BOOKING_FEE_AMOUNT"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "BOOKING_FEE_SKIP_REASONS"),
    ]);
    const [linkEnabled, windowMinutes] = await Promise.all([
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "BOOKING_PAYMENT_LINK_ENABLED"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "BOOKING_PAYMENT_WINDOW_MINUTES"),
    ]);
    return { enabled, amount: new Decimal(amount).toFixed(2), skipReasons: reasons, paymentLinkEnabled: linkEnabled, paymentWindowMinutes: windowMinutes };
  }

  /** A patient with an unpaid booking fee cannot be checked in; the message says how much and what can be done. */
  private async assertFeeSettled(db: Db, ctx: RequestContext, appt: { id: string; bookingFee: { toString(): string } | null; feeSkippedAt: Date | null }): Promise<void> {
    if (appt.bookingFee === null || appt.feeSkippedAt) return;
    const deposits = await db.advanceDeposit.findMany({ where: { tenantId: ctx.tenantId, appointmentId: appt.id }, select: { amount: true, refunds: { select: { amount: true } } } });
    const state = feeState(appt, feePaid(deposits));
    if (state.status === "PENDING") {
      throw new DomainError("BOOKING_FEE_PENDING", `The booking fee of ${state.due} has not been paid. Collect it, or have someone with permission skip it for a special case.`, 409, { fee: state.fee, paid: state.paid, due: state.due });
    }
  }

  /** Skips the booking fee of an appointment that has not been checked in. Needs BOOKING_FEE_SKIP, a reason from the configured list, and is audited. */
  async skipBookingFee(ctx: RequestContext, id: string, input: z.infer<typeof skipBookingFeeSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const allowed = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "BOOKING_FEE_SKIP_REASONS");
      const reason = allowed.find((r) => r.toLowerCase() === input.reason.toLowerCase());
      if (!reason) throw new DomainError("VALIDATION_FAILED", "Choose one of the reasons set up for skipping a booking fee", 400, [{ path: "reason", message: "Not an allowed reason" }]);
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Appointment" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const appt = await tx.appointment.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
      if (appt.bookingFee === null) throw new DomainError("INVALID_STATE", "This appointment has no booking fee", 409);
      if (appt.feeSkippedAt) throw new DomainError("INVALID_STATE", "The booking fee of this appointment was already skipped", 409);
      if (appt.status !== "BOOKED") throw new DomainError("APPOINTMENT_INVALID_STATE", "The booking fee can only be skipped before check-in", 409);
      const deposits = await tx.advanceDeposit.findMany({ where: { tenantId: ctx.tenantId, appointmentId: id }, select: { amount: true, refunds: { select: { amount: true } } } });
      if (feeState(appt, feePaid(deposits)).status === "PAID") throw new DomainError("INVALID_STATE", "The booking fee has already been paid", 409);
      await tx.appointment.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: { feeSkippedAt: new Date(), feeSkippedById: ctx.userId, feeSkipReason: reason, feeSkipNote: input.note ?? null, version: { increment: 1 } },
      });
      await this.paymentLinks.close(tx, ctx.tenantId, id, "CANCELLED"); // a skipped fee has nothing left to pay by a deadline
      await this.audit.record(tx, actorOf(ctx), {
        action: "BOOKING_FEE_SKIPPED", entityType: "Appointment", entityId: id,
        metadata: { fee: new Decimal(appt.bookingFee.toString()).toFixed(2), reason, ...(input.note ? { note: input.note } : {}), patientId: appt.patientId },
      });
      return toAppointmentView(await tx.appointment.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW }));
    });
  }

  // ───── internals ─────

  private async checkInCore(
    tx: Db, ctx: RequestContext,
    appt: { id: string; patientId: string; practitionerId: string; departmentId: string | null; type?: string; bookingFee?: { toString(): string } | null },
    priority: "NORMAL" | "PRIORITY" | "EMERGENCY", tz: string,
    /** Set by walk-in, which has just validated the practitioner and patient in this same transaction and created the appointment itself. */
    justValidated?: { practitioner: { departmentId: string | null } },
  ) {
    // A patient whose registration fee is still pending cannot be checked in (an emergency is never held up).
    await this.registrationFee.gate(tx, ctx, appt.patientId, priority === "EMERGENCY");
    // When the hospital requires it, the OPD consultation must be paid before the visit starts. Not held up: emergencies, follow-up visits, and appointments that carry a booking fee (that fee is the payment).
    let coverId: string | null = null;
    const exempt = priority === "EMERGENCY" || appt.type === "FOLLOW_UP" || (appt.bookingFee !== null && appt.bookingFee !== undefined);
    if (!exempt && (await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "OPD_FEE_BEFORE_VISIT"))) {
      const cover = await this.findCover(tx, ctx, appt.patientId, tz);
      if (!cover) throw new DomainError("CONSULTATION_PAYMENT_REQUIRED", "The OPD consultation fee has not been paid. Create a bill with the OPD consultation, collect the payment, then start the visit.", 409);
      coverId = cover.id;
    }
    const cas = await tx.appointment.updateMany({ where: { id: appt.id, tenantId: ctx.tenantId, status: "BOOKED" }, data: { status: "CHECKED_IN", version: { increment: 1 } } });
    if (cas.count !== 1) throw new DomainError("APPOINTMENT_INVALID_STATE", "This appointment was already checked in", 409);
    if (!justValidated) await this.reminders.cancelPending(tx, ctx.tenantId, appt.id); // the patient is here: no reminder needed (a brand-new walk-in has none)

    const practitioner = justValidated?.practitioner ?? await this.assertPractitioner(tx, ctx, appt.practitionerId, true);
    const departmentId = appt.departmentId ?? practitioner.departmentId;
    // The queue token is allocated BEFORE the visit number so that the facility-wide visit-number row is locked for the shortest
    // possible time (only the statements that must follow it). Both counters are always taken in this order, so they cannot deadlock.
    const tokenDate = localDateStr(new Date(), tz);
    const token = await this.numbering.counter(tx, ctx.tenantId, ctx.facilityId, "QUEUE_TOKEN", `${tokenDate}:${appt.practitionerId}`);
    const encounter = await this.encounters.openOpd(tx, ctx, { patientId: appt.patientId, practitionerId: appt.practitionerId, departmentId }, { patientVerified: !!justValidated });
    if (coverId) {
      // The paid bill now belongs to this visit and cannot cover another.
      await tx.visitConsultationBill.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: encounter.id, invoiceId: coverId, createdById: ctx.userId } })
        .catch((e: unknown) => { if ((e as { code?: string }).code === "P2002") throw new DomainError("CONSULTATION_PAYMENT_REQUIRED", "That consultation bill was just used for another visit. Create and pay a new one.", 409); throw e; });
    }
    const queue = await tx.queueEntry.create({
      data: {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: encounter.id, patientId: appt.patientId,
        practitionerId: appt.practitionerId, departmentId, appointmentId: appt.id, tokenDate: dateOnly(tokenDate),
        tokenNumber: Number(token), priority, createdById: ctx.userId,
      },
    });
    await tx.appointment.updateMany({ where: { id: appt.id, tenantId: ctx.tenantId, status: "CHECKED_IN" }, data: { status: "WAITING", encounterId: encounter.id, version: { increment: 1 } } });
    await this.audit.record(tx, actorOf(ctx), {
      action: "APPOINTMENT_CHECKED_IN", entityType: "Appointment", entityId: appt.id,
      metadata: { encounterId: encounter.id, queueEntryId: queue.id, tokenNumber: queue.tokenNumber, priority },
    });
    const full = await tx.appointment.findFirstOrThrow({ where: { id: appt.id, tenantId: ctx.tenantId }, select: VIEW });
    return {
      appointment: toAppointmentView(full), encounter: toEncounterView(encounter),
      queueEntry: { id: queue.id, tokenNumber: queue.tokenNumber, priority: queue.priority, status: queue.status, practitionerId: queue.practitionerId },
    };
  }

  /** Today's paid OPD consultation bill of this patient that has not covered a visit yet (the oldest first). */
  private async findCover(db: Db, ctx: RequestContext, patientId: string, tz: string): Promise<{ id: string; invoiceNumber: string | null } | null> {
    const rows = await db.invoice.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId, kind: "OPD", status: "PAID", visitCover: { is: null }, lines: { some: { service: { category: "CONSULTATION" } } } },
      orderBy: { issuedAt: "asc" }, take: 20, select: { id: true, invoiceNumber: true, issuedAt: true },
    });
    const today = localDateStr(new Date(), tz);
    return rows.find((r) => r.issuedAt && localDateStr(r.issuedAt, tz) === today) ?? null;
  }

  /** Where the patient stands before an OPD visit can start, for the patient's page: paid, a bill waiting for payment, or no consultation bill yet. */
  async consultationPayment(ctx: RequestContext, patientId: string) {
    await this.assertPatient(this.prisma, ctx, patientId);
    if (!(await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "OPD_FEE_BEFORE_VISIT"))) return { required: false, status: "NOT_REQUIRED" as const };
    const tz = await this.tz(this.prisma, ctx);
    const cover = await this.findCover(this.prisma, ctx, patientId, tz);
    if (cover) return { required: true, status: "PAID" as const, invoiceId: cover.id, invoiceNumber: cover.invoiceNumber };
    const open = await this.prisma.invoice.findFirst({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId, kind: "OPD", status: { in: ["DRAFT", "ISSUED", "PARTIALLY_PAID"] }, visitCover: { is: null }, createdAt: { gte: startOfLocalDay(localDateStr(new Date(), tz), tz) }, lines: { some: { service: { category: "CONSULTATION" } } } },
      orderBy: { createdAt: "desc" }, select: { id: true, invoiceNumber: true, status: true, total: true, paidTotal: true },
    });
    if (open) return { required: true, status: "NEEDS_PAYMENT" as const, invoiceId: open.id, invoiceNumber: open.invoiceNumber, invoiceStatus: open.status, total: fmt(open.total.toString()), due: fmt(new Decimal(open.total.toString()).minus(open.paidTotal.toString())) };
    return { required: true, status: "NEEDS_BILL" as const };
  }

  private async assertPractitioner(db: Db, ctx: RequestContext, practitionerId: string, mustBeActive: boolean) {
    const p = await db.practitioner.findFirst({
      where: { id: practitionerId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(mustBeActive ? { status: "ACTIVE" as const } : {}) },
      select: { id: true, departmentId: true, userId: true },
    });
    if (!p) throw new DomainError("VALIDATION_FAILED", "Practitioner not found or inactive at this facility", 400);
    return p;
  }

  private async assertPatient(db: Db, ctx: RequestContext, patientId: string): Promise<void> {
    const p = await db.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
    if (!p) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
  }

  private assertOverbookAllowed(ctx: RequestContext, overbookInput: unknown): void {
    if (overbookInput && !ctx.permissions.has("APPOINTMENT_OVERBOOK")) {
      throw new DomainError("FORBIDDEN", "You do not have permission to book over an existing appointment", 403);
    }
  }

  private assertNotInPast(startAt: Date): void {
    if (startAt.getTime() < Date.now() - 15 * 60_000) throw new DomainError("VALIDATION_FAILED", "The appointment time is in the past", 400);
  }

  private async assertWithinSchedule(tx: Db, ctx: RequestContext, practitionerId: string, startAt: Date, endAt: Date, tz: string): Promise<void> {
    const windows = await tx.practitionerSchedule.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, status: "ACTIVE" } });
    if (windows.length === 0) return; // no schedule defined: the practitioner is open at any time
    const s = localParts(startAt, tz);
    const sameDay = localDateStr(endAt, tz) === s.dateStr || (localMinutes(endAt, tz) === 0 && endAt.getTime() - startAt.getTime() < 24 * 3600_000);
    const startMin = localMinutes(startAt, tz);
    const endMin = localMinutes(endAt, tz) === 0 ? 1440 : localMinutes(endAt, tz);
    const ok = sameDay && windows.some((w) => w.dayOfWeek === s.weekday && startMin >= w.startMinute && endMin <= w.endMinute);
    if (!ok) throw new DomainError("SLOT_UNAVAILABLE", "The practitioner is not available at that time", 409);
  }

  private mapConflict(e: unknown): unknown {
    if (isConstraintViolation(e, "appointment_no_practitioner_overlap")) {
      return new DomainError("SLOT_UNAVAILABLE", "That time slot is already booked for this practitioner", 409);
    }
    if (isConstraintViolation(e, "appointment_no_patient_overlap")) {
      return new DomainError("SLOT_UNAVAILABLE", "The patient already has an appointment at that time", 409);
    }
    return e;
  }
}
