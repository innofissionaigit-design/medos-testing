import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { assertUnlocked, type PortalSession } from "../portal/portal.access";
import { feePaid, feeState } from "../appointments/booking-fee";
import { EmailService } from "../email/email.service";
import { RemindersService } from "../follow-ups/reminders.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SettingsService } from "../settings/settings.service";
import { CONSENT_VERSION, IDENTITY_METHODS, joinWindow, LIVE_APPOINTMENT, roomUrl } from "./telemedicine.domain";

const uuid = z.string().uuid();
export const createTeleSchema = z.object({ appointmentId: uuid }).strict();
export const cancelTeleSchema = z.object({ reason: z.string().trim().min(5).max(300) }).strict();
export const joinTeleSchema = z.object({ identityMethod: z.enum(IDENTITY_METHODS).optional() }).strict();
export const patientJoinSchema = z.object({ consent: z.boolean().optional() }).strict();
export const listTeleSchema = z.object({
  status: z.enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");
const isLive = (status: string) => (LIVE_APPOINTMENT as readonly string[]).includes(status);

/**
 * Video consultations (docs/telemedicine.md). A booked appointment is made a video consultation; the doctor and the patient each get a link to the same room
 * only when they are allowed to join: the right person, inside the time window, and (for the patient) after agreeing to a video consultation. The consultation,
 * prescription and bill are the appointment's normal visit. MedOS does not carry the video: the hospital's video service does.
 */
@Injectable()
export class TelemedicineService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    private readonly reminders: RemindersService, private readonly email: EmailService, private readonly notifications: NotificationsService,
  ) {}

  /**
   * With "pay before joining" on, nobody joins until the video fee on the appointment is paid or skipped. The fee is the appointment's booking fee
   * (docs/booking-fee.md), so it is taken, skipped and given back exactly like one.
   */
  private async assertFeeSettled(db: Prisma.TransactionClient, tenantId: string, facilityId: string, appointmentId: string): Promise<void> {
    if (!(await this.settings.get(db as PrismaService, tenantId, facilityId, "TELECONSULT_PAY_BEFORE_JOIN"))) return;
    const a = await db.appointment.findFirst({ where: { id: appointmentId, tenantId }, select: { bookingFee: true, feeSkippedAt: true, advanceDeposits: { select: { amount: true, refunds: { select: { amount: true } } } } } });
    if (!a) return;
    const state = feeState(a, feePaid(a.advanceDeposits));
    if (state.status === "PENDING") throw new DomainError("BOOKING_FEE_PENDING", `The video consultation fee of ${state.due} has not been paid yet. Please pay at the hospital counter, or ask the front desk.`, 409, { fee: state.fee, paid: state.paid, due: state.due });
  }

  private ownDoctor(ctx: RequestContext, practitionerId: string): boolean {
    return ctx.dataScope.kind === "DOCTOR" && ctx.dataScope.practitionerIds.includes(practitionerId);
  }

  private async videoUrl(db: PrismaService | Prisma.TransactionClient, tenantId: string, facilityId: string): Promise<string> {
    const url = (await this.settings.get(db as PrismaService, tenantId, facilityId, "TELECONSULT_VIDEO_URL")) as string;
    if (!url) throw new DomainError("INVALID_STATE", "The hospital has not set up its video service yet (Administration, Settings)", 409);
    return url;
  }

  async create(ctx: RequestContext, input: z.infer<typeof createTeleSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.videoUrl(tx, ctx.tenantId, ctx.facilityId);
      const a = await tx.appointment.findFirst({ where: { id: input.appointmentId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true, practitionerId: true, startAt: true, status: true, bookingFee: true } });
      if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!isLive(a.status)) throw new DomainError("INVALID_STATE", "This appointment is cancelled or finished", 409);
      if (a.startAt.getTime() < Date.now() - 60 * 60_000) throw new DomainError("INVALID_STATE", "This appointment time has passed", 409);
      try {
        const t = await tx.teleconsult.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: a.patientId, appointmentId: a.id, practitionerId: a.practitionerId, scheduledAt: a.startAt, roomToken: randomBytes(24).toString("base64url"), createdById: ctx.userId }, select: { id: true } });
        await this.audit.record(tx, actorOf(ctx), { action: "TELECONSULT_CREATED", entityType: "Teleconsult", entityId: t.id, metadata: { appointmentId: a.id } });
        // A video fee goes on the appointment as its booking fee (once; an appointment that already has a fee keeps it), so it is taken, skipped and given back the usual way.
        const doctor = await tx.practitioner.findFirst({ where: { id: a.practitionerId, tenantId: ctx.tenantId }, select: { videoFee: true } });
        const feeAmount = doctor?.videoFee != null ? new Decimal(doctor.videoFee.toString()) : new Decimal(await this.settings.get(tx as PrismaService, ctx.tenantId, ctx.facilityId, "TELECONSULT_FEE_AMOUNT"));
        let fee: string | null = a.bookingFee ? new Decimal(a.bookingFee.toString()).toFixed(2) : null;
        if (feeAmount.gt(0) && a.bookingFee === null && a.status === "BOOKED") {
          await tx.appointment.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: a.id } }, data: { bookingFee: feeAmount.toFixed(2), version: { increment: 1 } } });
          await this.audit.record(tx, actorOf(ctx), { action: "TELECONSULT_FEE_SET", entityType: "Appointment", entityId: a.id, metadata: { fee: feeAmount.toFixed(2), teleconsultId: t.id } });
          fee = feeAmount.toFixed(2);
        }
        await this.reminders.planVideo(tx, { id: a.id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: a.patientId, startAt: a.startAt });
        await this.email.videoConsultationEmail(tx, ctx, a.id, t.id);
        return { id: t.id, status: "SCHEDULED" as const, fee };
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "This appointment is already a video consultation", 409);
        throw e;
      }
    });
  }

  /**
   * The appointment was moved. A video consultation that has not started follows it: same doctor, new time (the join window and the reminder move too);
   * another doctor, or a started call, cannot follow, so a not-yet-started one is cancelled and the front desk makes it a video consultation again.
   */
  async onAppointmentMoved(tx: Prisma.TransactionClient, at: { tenantId: string; facilityId: string; userId?: string }, appt: { id: string; patientId: string; practitionerId: string; startAt: Date }): Promise<void> {
    const t = await tx.teleconsult.findFirst({ where: { tenantId: at.tenantId, appointmentId: appt.id, status: "SCHEDULED" }, select: { id: true, practitionerId: true } });
    if (!t) return;
    const actor = { tenantId: at.tenantId, facilityId: at.facilityId, ...(at.userId ? { userId: at.userId } : {}) };
    if (t.practitionerId !== appt.practitionerId) {
      const reason = "The appointment was moved to another doctor. Make it a video consultation again.";
      await tx.teleconsult.update({ where: { tenantId_id: { tenantId: at.tenantId, id: t.id } }, data: { status: "CANCELLED", cancelReason: reason } });
      await this.reminders.cancelPending(tx, at.tenantId, appt.id);
      await this.audit.record(tx, actor, { action: "TELECONSULT_CANCELLED", entityType: "Teleconsult", entityId: t.id, metadata: { appointmentId: appt.id, reason } });
      return;
    }
    await tx.teleconsult.update({ where: { tenantId_id: { tenantId: at.tenantId, id: t.id } }, data: { scheduledAt: appt.startAt } });
    await this.reminders.planVideo(tx, { id: appt.id, tenantId: at.tenantId, facilityId: at.facilityId, patientId: appt.patientId, startAt: appt.startAt });
    await this.audit.record(tx, actor, { action: "TELECONSULT_RESCHEDULED", entityType: "Teleconsult", entityId: t.id, metadata: { appointmentId: appt.id, startAt: appt.startAt.toISOString() } });
  }

  async list(ctx: RequestContext, q: z.infer<typeof listTeleSchema>) {
    const where: Prisma.TeleconsultWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status } : {}),
      ...(ctx.dataScope.kind === "DOCTOR" ? { practitionerId: { in: [...ctx.dataScope.practitionerIds] } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.teleconsult.findMany({
        where, orderBy: [{ scheduledAt: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }, appointment: { select: { status: true, bookingFee: true, feeSkippedAt: true, advanceDeposits: { select: { amount: true, refunds: { select: { amount: true } } } }, practitioner: { select: { displayName: true } } } } },
      }),
      this.prisma.teleconsult.count({ where }),
    ]);
    const now = new Date();
    return {
      total, page: q.page, pageSize: q.pageSize,
      items: rows.map((r) => {
        const w = joinWindow(r.scheduledAt, now);
        const fee = feeState(r.appointment, feePaid(r.appointment.advanceDeposits));
        return {
          id: r.id, appointmentId: r.appointmentId, patient: nameOf(r.patient), mrn: r.patient.identifiers[0]?.value ?? null, doctor: r.appointment.practitioner.displayName, scheduledAt: r.scheduledAt, status: r.status,
          consented: !!r.consentAt, doctorJoined: !!r.doctorJoinedAt, patientJoined: !!r.patientJoinedAt, patientWaiting: !!r.patientWaitingAt && !r.patientJoinedAt, identityChecked: !!r.identityVerifiedAt, feeStatus: fee.status, feeDue: fee.due, windowOpensAt: w.opensAt,
          canJoin: ctx.permissions.has("TELE_CONDUCT") && this.ownDoctor(ctx, r.practitionerId) && w.open && isLive(r.appointment.status) && (r.status === "SCHEDULED" || r.status === "IN_PROGRESS"),
        };
      }),
    };
  }

  private async mine(tx: Prisma.TransactionClient, ctx: RequestContext, id: string) {
    const t = await tx.teleconsult.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { appointment: { select: { status: true } } } });
    if (!t || !this.ownDoctor(ctx, t.practitionerId)) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return t;
  }

  /** The doctor opens the call. Only the appointment's own doctor, only in the time window; the first time starts the consultation. */
  async join(ctx: RequestContext, id: string, input: z.infer<typeof joinTeleSchema> = {}) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.mine(tx, ctx, id);
      if (t.status !== "SCHEDULED" && t.status !== "IN_PROGRESS") throw new DomainError("INVALID_STATE", "This video consultation is over", 409);
      if (!isLive(t.appointment.status)) throw new DomainError("INVALID_STATE", "The appointment is cancelled or finished", 409);
      const w = joinWindow(t.scheduledAt, new Date());
      if (!w.open) throw new DomainError("INVALID_STATE", "The call can be opened from 15 minutes before the appointment", 409, { opensAt: w.opensAt.toISOString() });
      const url = await this.videoUrl(tx, ctx.tenantId, ctx.facilityId);
      await this.assertFeeSettled(tx, ctx.tenantId, ctx.facilityId, t.appointmentId);
      if (!t.doctorJoinedAt) {
        // Before the call starts the doctor confirms who they will be talking to; it is recorded and cannot be changed.
        if (!input.identityMethod) throw new DomainError("IDENTITY_CHECK_REQUIRED", "Confirm the patient's identity before starting the call", 409);
        const now = new Date();
        await tx.teleconsult.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "IN_PROGRESS", doctorJoinedAt: now, identityVerifiedAt: now, identityVerifiedById: ctx.userId, identityMethod: input.identityMethod } });
        await this.audit.record(tx, actorOf(ctx), { action: "TELECONSULT_IDENTITY_CHECKED", entityType: "Teleconsult", entityId: id, metadata: { appointmentId: t.appointmentId, method: input.identityMethod } });
        await this.audit.record(tx, actorOf(ctx), { action: "TELECONSULT_DOCTOR_JOINED", entityType: "Teleconsult", entityId: id, metadata: { appointmentId: t.appointmentId } });
      }
      return { url: roomUrl(url, t.roomToken), patientJoined: !!t.patientJoinedAt };
    });
  }

  async end(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.mine(tx, ctx, id);
      if (t.status !== "IN_PROGRESS") throw new DomainError("INVALID_STATE", "Only a call in progress can be ended", 409);
      await tx.teleconsult.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "COMPLETED", endedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), { action: "TELECONSULT_ENDED", entityType: "Teleconsult", entityId: id, metadata: { appointmentId: t.appointmentId } });
      return { id, status: "COMPLETED" as const };
    });
  }

  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof cancelTeleSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.teleconsult.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, status: true, appointmentId: true } });
      if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (t.status !== "SCHEDULED") throw new DomainError("INVALID_STATE", "Only a video consultation that has not started can be cancelled", 409);
      await tx.teleconsult.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CANCELLED", cancelReason: input.reason } });
      await this.reminders.cancelPending(tx, ctx.tenantId, t.appointmentId);
      await this.audit.record(tx, actorOf(ctx), { action: "TELECONSULT_CANCELLED", entityType: "Teleconsult", entityId: id, metadata: { appointmentId: t.appointmentId, reason: input.reason } });
      return { id, status: "CANCELLED" as const };
    });
  }

  // ───── the patient's side (patient app) ─────

  /** The checks both "I am here" and "Join" need: the patient's own session, a live appointment, the time window, and the fee if it must be paid first. */
  private async patientVideo(tx: Prisma.TransactionClient, p: PortalSession, id: string) {
    const t = await tx.teleconsult.findFirst({ where: { id, tenantId: p.tenantId, facilityId: p.facilityId, patient: { mobile: p.mobile, status: "ACTIVE", mergedIntoId: null } }, include: { appointment: { select: { status: true } } } });
    if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    await assertUnlocked(tx, p, t.patientId);
    if (t.status !== "SCHEDULED" && t.status !== "IN_PROGRESS") throw new DomainError("INVALID_STATE", "This video consultation is over", 409);
    if (!isLive(t.appointment.status)) throw new DomainError("INVALID_STATE", "The appointment is cancelled or finished", 409);
    const w = joinWindow(t.scheduledAt, new Date());
    if (!w.open) throw new DomainError("INVALID_STATE", "You can join from 15 minutes before the appointment", 409, { opensAt: w.opensAt.toISOString() });
    await this.assertFeeSettled(tx, p.tenantId, p.facilityId, t.appointmentId);
    return t;
  }

  /**
   * Waiting room: the patient tells the doctor they are here, after agreeing to a video consultation. The doctor is notified once and sees "patient waiting";
   * the patient sees whether the doctor has started. The patient gets the room's link only after the doctor has started (see patientJoin).
   */
  async patientArrive(p: PortalSession, id: string, input: z.infer<typeof patientJoinSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.patientVideo(tx, p, id);
      if (!t.consentAt && input.consent !== true) throw new DomainError("VALIDATION_FAILED", "Please agree to a video consultation to continue", 409);
      if (!t.consentAt || !t.patientWaitingAt) {
        const now = new Date();
        await tx.teleconsult.update({ where: { tenantId_id: { tenantId: p.tenantId, id } }, data: { consentAt: t.consentAt ?? now, consentVersion: t.consentVersion ?? CONSENT_VERSION, patientWaitingAt: t.patientWaitingAt ?? now } });
        await this.audit.record(tx, { tenantId: p.tenantId, facilityId: p.facilityId }, { action: "TELECONSULT_PATIENT_WAITING", entityType: "Teleconsult", entityId: id, metadata: { actor: "PATIENT", patientId: t.patientId, consentGiven: !t.consentAt, consentVersion: CONSENT_VERSION } });
        const doctor = await this.notifications.doctorUser(tx, p.tenantId, t.practitionerId);
        if (doctor) await this.notifications.notify(tx, [doctor], { tenantId: p.tenantId, facilityId: p.facilityId, type: "TELECONSULT_PATIENT_WAITING", entityType: "Teleconsult", entityId: id, dedupeKey: `TELECONSULT_PATIENT_WAITING:${id}` });
      }
      return { waiting: true as const, doctorStarted: !!t.doctorJoinedAt };
    });
  }

  /** The patient joins from the app, after the doctor has started. Needs their own session, the right appointment, the time window, and agreement to a video consultation the first time. */
  async patientJoin(p: PortalSession, id: string, input: z.infer<typeof patientJoinSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.patientVideo(tx, p, id);
      if (!t.consentAt && input.consent !== true) throw new DomainError("VALIDATION_FAILED", "Please agree to a video consultation to continue", 409);
      if (!t.doctorJoinedAt) throw new DomainError("WAITING_FOR_DOCTOR", "The doctor has not started the call yet. Please wait on this page; you can join as soon as the doctor starts.", 409);
      const url = await this.videoUrl(tx, p.tenantId, p.facilityId);
      if (!t.consentAt || !t.patientJoinedAt) {
        const now = new Date();
        await tx.teleconsult.update({ where: { tenantId_id: { tenantId: p.tenantId, id } }, data: { consentAt: t.consentAt ?? now, consentVersion: t.consentVersion ?? CONSENT_VERSION, patientWaitingAt: t.patientWaitingAt ?? now, patientJoinedAt: t.patientJoinedAt ?? now } });
        await this.audit.record(tx, { tenantId: p.tenantId, facilityId: p.facilityId }, { action: "TELECONSULT_PATIENT_JOINED", entityType: "Teleconsult", entityId: id, metadata: { actor: "PATIENT", patientId: t.patientId, consentGiven: !t.consentAt, consentVersion: CONSENT_VERSION } });
      }
      return { url: roomUrl(url, t.roomToken) };
    });
  }
}
