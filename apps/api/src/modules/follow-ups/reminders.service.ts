import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { logJson } from "../../common/logger";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { SettingsService } from "../settings/settings.service";
import { reminderConsentState, remindersAllowed } from "../privacy/consent";
import { LOG_ONLY_PREFIX, REMINDER_PROVIDER, type ReminderProvider } from "./reminder.provider";

/** A failed delivery is retried after 5, then 10 minutes; the third failure is final. */
export const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60_000;

type Outcome = "sent" | "skipped" | "retried" | "failed";

/** SMS-length message. Deliberately carries no patient name or clinical detail (CLAUDE.md §32). */
export function reminderText(a: { doctor: string; facility: string; startAt: Date; timezone: string }): string {
  const when = new Intl.DateTimeFormat("en-IN", { timeZone: a.timezone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(a.startAt);
  return `Reminder: your follow-up with ${a.doctor} at ${a.facility} is on ${when}. Please bring your previous prescription.`;
}

@Injectable()
export class RemindersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(REMINDER_PROVIDER) private readonly provider: ReminderProvider,
  ) {}

  /**
   * Replaces a follow-up's pending reminders, inside the caller's transaction, with one per configured offset that is
   * still in the future. Only BOOKED follow-ups get reminders; other appointment types are left untouched.
   */
  async replan(tx: Db, appt: { id: string; tenantId: string; facilityId: string; patientId: string; type: string; status: string; startAt: Date }, now = new Date()): Promise<void> {
    if (appt.type !== "FOLLOW_UP") return;
    await this.cancelPending(tx, appt.tenantId, appt.id);
    if (appt.status !== "BOOKED") return;
    if (!(await this.settings.get(tx, appt.tenantId, appt.facilityId, "FOLLOWUP_REMINDERS_ENABLED"))) return;
    if (!(await this.mayRemind(tx, appt.tenantId, appt.facilityId, appt.patientId))) return;
    const offsets = await this.settings.get(tx, appt.tenantId, appt.facilityId, "FOLLOWUP_REMINDER_OFFSETS_MINUTES");
    const due = offsets.map((m) => ({ offsetMinutes: m, sendAt: new Date(appt.startAt.getTime() - m * 60_000) })).filter((r) => r.sendAt > now);
    if (due.length === 0) return;
    await tx.appointmentReminder.createMany({
      data: due.map((r) => ({ tenantId: appt.tenantId, facilityId: appt.facilityId, appointmentId: appt.id, offsetMinutes: r.offsetMinutes, appointmentStartAt: appt.startAt, sendAt: r.sendAt })),
    });
  }

  /** Cancelled, no-show and checked-in follow-ups must never be reminded about. */
  /** The patient's recorded reminder consent combined with the hospital's REMINDERS_REQUIRE_CONSENT setting. */
  private async mayRemind(tx: Db, tenantId: string, facilityId: string, patientId: string): Promise<boolean> {
    return remindersAllowed(await reminderConsentState(tx, tenantId, patientId), await this.settings.get(tx, tenantId, facilityId, "REMINDERS_REQUIRE_CONSENT"));
  }

  async cancelPending(tx: Db, tenantId: string, appointmentId: string): Promise<number> {
    const r = await tx.appointmentReminder.updateMany({ where: { tenantId, appointmentId, status: "PENDING" }, data: { status: "CANCELLED" } });
    return r.count;
  }

  async list(ctx: RequestContext, appointmentId: string) {
    const appt = await this.prisma.appointment.findFirst({ where: { id: appointmentId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
    if (!appt) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.appointmentReminder.findMany({
      where: { tenantId: ctx.tenantId, appointmentId }, orderBy: [{ createdAt: "asc" }, { sendAt: "asc" }],
      select: { id: true, channel: true, offsetMinutes: true, sendAt: true, status: true, attempts: true, lastError: true, sentAt: true, providerMessageId: true },
    });
    return rows.map(({ providerMessageId, ...r }) => ({ ...r, logOnly: providerMessageId?.startsWith(LOG_ONLY_PREFIX) ?? false }));
  }

  /**
   * Delivers every reminder due at `now`. Each is claimed with FOR UPDATE SKIP LOCKED in its own short transaction, so
   * several API instances never deliver the same one, and re-checked against its appointment just before sending:
   * a moved, cancelled, checked-in or past appointment, or a patient without a mobile number, means SKIPPED.
   */
  async runDue(now = new Date(), provider: ReminderProvider = this.provider, limit = 100): Promise<Record<Outcome, number>> {
    const counts: Record<Outcome, number> = { sent: 0, skipped: 0, retried: 0, failed: 0 };
    // Which hospitals have something due comes from a narrow database function; each is then served under its own scope,
    // so a reminder is only ever read and updated with its own hospital's context (docs/rls.md).
    const tenants = await tenantScope.system("reminder worker: hospitals with reminders due", () =>
      this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT medos_tenants_with_due_reminders(${now}::timestamptz)::text AS tenant_id`);
    let done = 0;
    for (const { tenant_id: tenantId } of tenants) {
      while (done < limit) {
        const outcome = await tenantScope.run(tenantId, () => this.prisma.$transaction((tx) => this.deliverOne(tx, now, provider)));
        if (!outcome) break;
        counts[outcome]++;
        done++;
      }
    }
    return counts;
  }

  private async deliverOne(tx: Db, now: Date, provider: ReminderProvider): Promise<Outcome | null> {
    const [r] = await tx.$queryRaw<{ id: string; tenantId: string; appointmentId: string; appointmentStartAt: Date; attempts: number }[]>`
      SELECT id, "tenantId", "appointmentId", "appointmentStartAt", attempts FROM "AppointmentReminder"
      WHERE status = 'PENDING' AND "sendAt" <= ${now} ORDER BY "sendAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!r) return null;
    const where = { id: r.id, tenantId: r.tenantId };
    const appt = await tx.appointment.findFirst({
      where: { id: r.appointmentId, tenantId: r.tenantId },
      select: { status: true, startAt: true, patientId: true, facilityId: true, patient: { select: { mobile: true } }, practitioner: { select: { displayName: true } }, facility: { select: { name: true, timezone: true } } },
    });
    const skip = async (reason: string): Promise<Outcome> => {
      await tx.appointmentReminder.updateMany({ where, data: { status: "SKIPPED", lastError: reason } });
      logJson("info", "reminder_skipped", { reminderId: r.id, appointmentId: r.appointmentId, reason });
      return "skipped";
    };
    if (!appt || appt.status !== "BOOKED" || appt.startAt.getTime() !== r.appointmentStartAt.getTime()) return skip("The appointment changed after this reminder was planned");
    if (appt.startAt <= now) return skip("The appointment time has already passed");
    if (!appt.patient.mobile) return skip("The patient has no mobile number");
    // Re-checked at send time: consent may have been withdrawn (or the hospital's rule changed) since the reminder was planned.
    if (!(await this.mayRemind(tx, r.tenantId, appt.facilityId, appt.patientId))) return skip("The patient has not agreed to reminders");

    const attempts = r.attempts + 1;
    try {
      const d = await provider.send({
        reminderId: r.id, appointmentId: r.appointmentId, to: appt.patient.mobile,
        text: reminderText({ doctor: appt.practitioner.displayName, facility: appt.facility.name, startAt: appt.startAt, timezone: appt.facility.timezone }),
      });
      await tx.appointmentReminder.updateMany({ where, data: { status: "SENT", sentAt: now, attempts, providerMessageId: d.providerMessageId.slice(0, 200), lastError: null } });
      return "sent";
    } catch (e) {
      const lastError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      logJson("warn", "reminder_delivery_failed", { reminderId: r.id, appointmentId: r.appointmentId, provider: provider.name, attempts, errorMessage: lastError });
      if (attempts >= MAX_ATTEMPTS) {
        await tx.appointmentReminder.updateMany({ where, data: { status: "FAILED", attempts, lastError } });
        return "failed";
      }
      await tx.appointmentReminder.updateMany({ where, data: { attempts, lastError, sendAt: new Date(now.getTime() + RETRY_DELAY_MS * attempts) } });
      return "retried";
    }
  }
}
