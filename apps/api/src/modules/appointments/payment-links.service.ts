import { Inject, Injectable } from "@nestjs/common";
import { Decimal } from "@medos/shared";
import { randomBytes } from "node:crypto";
import { AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { EmailService } from "../email/email.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import { tenantScope } from "../../common/tenant-scope";
import { RemindersService } from "../follow-ups/reminders.service";
import { LOG_ONLY_PREFIX } from "../follow-ups/reminder.provider";
import { reminderConsentState, remindersAllowed } from "../privacy/consent";
import { SettingsService } from "../settings/settings.service";
import { feePaid, feeState } from "./booking-fee";
import { PAYMENT_LINK_PROVIDER, type PaymentLinkProvider } from "./payment-link.provider";

/** A failed send is retried after 5, then 10 minutes; the third failure is final (the deadline still stands). */
export const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60_000;
export const AUTO_CANCEL_REASON = "Booking fee not paid in time";

type Outcome = "sent" | "retried" | "gaveUp" | "cancelled" | "settled";

/** Carries no patient name or clinical detail (CLAUDE.md §32). */
export function paymentLinkText(a: { doctor: string; facility: string; startAt: Date; timezone: string; amount: string; minutes: number; url: string }): string {
  const when = new Intl.DateTimeFormat("en-IN", { timeZone: a.timezone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(a.startAt);
  return `Your appointment with ${a.doctor} at ${a.facility} on ${when} is booked. Pay the booking fee of ₹${a.amount} within ${a.minutes} minutes to keep it: ${a.url} Unpaid bookings are cancelled automatically.`;
}

/**
 * Payment link for a booking fee and the automatic cancellation behind it (docs/booking-payment-link.md).
 * Delivery on WhatsApp is a placeholder (the default provider only logs). The deadline is real: a worker cancels an appointment whose fee
 * is still unpaid when the deadline passes, and re-checks the appointment under a lock first, so a fee paid or skipped a moment earlier is never cancelled.
 */
@Injectable()
export class PaymentLinksService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    private readonly reminders: RemindersService, @Inject(PAYMENT_LINK_PROVIDER) private readonly provider: PaymentLinkProvider,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  /**
   * Called inside the booking transaction for an appointment that carries a fee. Creates the link and its deadline when the feature is on and the
   * patient can be reached (has a mobile number and has not withdrawn). Without a link there is no deadline: the appointment simply waits for the fee.
   */
  async createFor(tx: Db, appt: { id: string; tenantId: string; facilityId: string; patientId: string; startAt: Date; bookingFee: { toString(): string } | null }, now = new Date()): Promise<boolean> {
    if (appt.bookingFee === null) return false;
    if (!(await this.settings.get(tx, appt.tenantId, appt.facilityId, "BOOKING_PAYMENT_LINK_ENABLED"))) return false;
    const patient = await tx.patient.findFirst({ where: { id: appt.patientId, tenantId: appt.tenantId }, select: { mobile: true } });
    if (!patient?.mobile) return false;
    const requireConsent = await this.settings.get(tx, appt.tenantId, appt.facilityId, "REMINDERS_REQUIRE_CONSENT");
    if (!remindersAllowed(await reminderConsentState(tx, appt.tenantId, appt.patientId), requireConsent)) return false;
    const minutes = await this.settings.get(tx, appt.tenantId, appt.facilityId, "BOOKING_PAYMENT_WINDOW_MINUTES");
    const dueBy = new Date(Math.min(now.getTime() + minutes * 60_000, appt.startAt.getTime()));
    await tx.bookingPaymentLink.create({
      data: { tenantId: appt.tenantId, facilityId: appt.facilityId, appointmentId: appt.id, token: randomBytes(24).toString("hex"), amount: new Decimal(appt.bookingFee.toString()).toFixed(2), dueBy, nextSendAt: now },
    });
    return true;
  }

  /** The appointment's fee was paid, skipped, or the appointment ended another way: the deadline no longer applies. */
  async close(tx: Db, tenantId: string, appointmentId: string, status: "PAID" | "CANCELLED", now = new Date()): Promise<void> {
    await tx.bookingPaymentLink.updateMany({ where: { tenantId, appointmentId, status: "PENDING" }, data: { status, closedAt: now } });
  }

  /** Sends due links and cancels appointments whose deadline has passed. Each is claimed with FOR UPDATE SKIP LOCKED in its own short transaction. */
  async runDue(now = new Date(), provider: PaymentLinkProvider = this.provider, limit = 100): Promise<Record<Outcome, number>> {
    const counts: Record<Outcome, number> = { sent: 0, retried: 0, gaveUp: 0, cancelled: 0, settled: 0 };
    const tenants = await tenantScope.system("booking payment link worker: hospitals with links due", () =>
      this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT medos_tenants_with_due_payment_links(${now}::timestamptz)::text AS tenant_id`);
    let done = 0;
    for (const { tenant_id: tenantId } of tenants) {
      while (done < limit) {
        const outcome = await tenantScope.run(tenantId, () => this.prisma.$transaction((tx) => this.processOne(tx, now, provider)));
        if (!outcome) break;
        counts[outcome]++;
        done++;
      }
    }
    return counts;
  }

  private async processOne(tx: Db, now: Date, provider: PaymentLinkProvider): Promise<Outcome | null> {
    const [expired] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "BookingPaymentLink" WHERE status = 'PENDING' AND "dueBy" <= ${now} ORDER BY "dueBy", id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (expired) return this.expire(tx, expired.id, now);
    const [due] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "BookingPaymentLink" WHERE status = 'PENDING' AND "sendStatus" = 'PENDING' AND "nextSendAt" <= ${now} AND "dueBy" > ${now}
      ORDER BY "nextSendAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;
    return due ? this.send(tx, due.id, now, provider) : null;
  }

  /** The deadline passed. Cancels the appointment only if it is still booked and its fee is still unpaid and not skipped, decided under the appointment's lock. */
  private async expire(tx: Db, linkId: string, now: Date): Promise<Outcome> {
    const link = await tx.bookingPaymentLink.findFirstOrThrow({ where: { id: linkId } });
    await tx.$queryRaw`SELECT id FROM "Appointment" WHERE id = ${link.appointmentId}::uuid AND "tenantId" = ${link.tenantId}::uuid FOR UPDATE`;
    const appt = await tx.appointment.findFirstOrThrow({ where: { id: link.appointmentId, tenantId: link.tenantId } });
    const deposits = await tx.advanceDeposit.findMany({ where: { tenantId: link.tenantId, appointmentId: appt.id }, select: { amount: true, refunds: { select: { amount: true } } } });
    const state = feeState(appt, feePaid(deposits));
    const settle = async (status: "PAID" | "CANCELLED"): Promise<Outcome> => { await this.close(tx, link.tenantId, appt.id, status, now); return "settled"; };

    if (appt.status !== "BOOKED") return settle("CANCELLED");
    if (state.status === "PAID") return settle("PAID");
    if (state.status !== "PENDING") return settle("CANCELLED"); // skipped, or the fee no longer applies

    const res = await tx.appointment.updateMany({ where: { id: appt.id, tenantId: link.tenantId, status: "BOOKED" }, data: { status: "CANCELLED", cancelReason: AUTO_CANCEL_REASON, version: { increment: 1 } } });
    if (res.count !== 1) return settle("CANCELLED");
    const remindersCancelled = await this.reminders.cancelPending(tx, link.tenantId, appt.id);
    await tx.bookingPaymentLink.updateMany({ where: { id: link.id, status: "PENDING" }, data: { status: "EXPIRED", closedAt: now } });
    // No person did this: the audit row has no actor, and says what the system decided and why.
    await this.audit.record(tx, { tenantId: link.tenantId, facilityId: link.facilityId, userId: null }, {
      action: "APPOINTMENT_AUTO_CANCELLED", entityType: "Appointment", entityId: appt.id,
      metadata: { reason: AUTO_CANCEL_REASON, fee: state.fee ?? "0.00", paid: state.paid, dueBy: link.dueBy.toISOString(), linkId: link.id, remindersCancelled },
    });
    await this.email.appointmentEmail(tx, { tenantId: link.tenantId, facilityId: link.facilityId }, appt.id, "APPOINTMENT_CANCELLED");
    await this.notifications.notifyPermission(tx, ["APPOINTMENT_CANCEL"], { tenantId: link.tenantId, facilityId: link.facilityId, type: "BOOKING_AUTO_CANCELLED", entityType: "Appointment", entityId: appt.id, dedupeKey: `BOOKING_AUTO_CANCELLED:${appt.id}` });
    logJson("info", "appointment_auto_cancelled", { appointmentId: appt.id, linkId: link.id });
    return "cancelled";
  }

  private async send(tx: Db, linkId: string, now: Date, provider: PaymentLinkProvider): Promise<Outcome> {
    const link = await tx.bookingPaymentLink.findFirstOrThrow({
      where: { id: linkId },
      include: { appointment: { select: { startAt: true, patient: { select: { mobile: true } }, practitioner: { select: { displayName: true } }, facility: { select: { name: true, timezone: true } } } } },
    });
    const where = { id: link.id, tenantId: link.tenantId };
    const attempts = link.sendAttempts + 1;
    const mobile = link.appointment.patient.mobile;
    if (!mobile) {
      await tx.bookingPaymentLink.updateMany({ where, data: { sendStatus: "FAILED", sendAttempts: attempts, lastError: "The patient has no mobile number" } });
      return "gaveUp";
    }
    const minutes = Math.max(1, Math.round((link.dueBy.getTime() - link.createdAt.getTime()) / 60_000));
    try {
      const d = await provider.send({
        linkId: link.id, appointmentId: link.appointmentId, to: mobile,
        text: paymentLinkText({
          doctor: link.appointment.practitioner.displayName, facility: link.appointment.facility.name, startAt: link.appointment.startAt, timezone: link.appointment.facility.timezone,
          amount: new Decimal(link.amount.toString()).toFixed(2), minutes, url: `${this.config.PAYMENT_LINK_BASE_URL.replace(/\/+$/, "")}/${link.token}`,
        }),
      });
      await tx.bookingPaymentLink.updateMany({ where, data: { sendStatus: "SENT", sentAt: now, sendAttempts: attempts, providerMessageId: d.providerMessageId.slice(0, 200), lastError: null } });
      return "sent";
    } catch (e) {
      const lastError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      logJson("warn", "payment_link_delivery_failed", { linkId: link.id, appointmentId: link.appointmentId, provider: provider.name, attempts, errorMessage: lastError });
      if (attempts >= MAX_SEND_ATTEMPTS) {
        await tx.bookingPaymentLink.updateMany({ where, data: { sendStatus: "FAILED", sendAttempts: attempts, lastError } });
        return "gaveUp";
      }
      await tx.bookingPaymentLink.updateMany({ where, data: { sendAttempts: attempts, lastError, nextSendAt: new Date(now.getTime() + RETRY_DELAY_MS * attempts) } });
      return "retried";
    }
  }

  /** What the screens show: where the link stands and whether the message was real (it is a placeholder until a provider is connected). */
  view(link: { status: string; dueBy: Date; sendStatus: string; sentAt: Date | null; providerMessageId: string | null } | null) {
    return link ? { status: link.status, dueBy: link.dueBy, sendStatus: link.sendStatus, sentAt: link.sentAt, placeholder: link.providerMessageId?.startsWith(LOG_ONLY_PREFIX) ?? true } : null;
  }

}
