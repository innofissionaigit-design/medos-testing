import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { PrismaService, type Db } from "../../common/prisma.service";
import { tenantScope } from "../../common/tenant-scope";
import { REMINDER_PROVIDER, type ReminderProvider } from "../follow-ups/reminder.provider";
import { reminderConsentState, remindersAllowed } from "../privacy/consent";
import { SettingsService } from "../settings/settings.service";
import { FeedbackLinkService } from "./feedback-link.service";
import { FeedbackService } from "./feedback.service";

const dayOf = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const MAX_TRIES = 3;
const RETRY_MS = 5 * 60_000;

export interface AftercareRun { reminders: { sent: number; skipped: number; retried: number; failed: number }; feedbackLinks: number; escalated: number }

/**
 * The background work of the after-discharge journey (docs/aftercare.md): the text to a patient whose review is due and not booked, the feedback link after a review visit,
 * and the escalation of complaints past their deadline. Each hospital is served under its own scope; rows are claimed with SKIP LOCKED so several instances never do the same one.
 */
@Injectable()
export class AftercareJobsService {
  constructor(
    private readonly prisma: PrismaService, private readonly settings: SettingsService, private readonly links: FeedbackLinkService, private readonly complaints: FeedbackService,
    @Inject(REMINDER_PROVIDER) private readonly provider: ReminderProvider, @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async runDue(now = new Date(), provider: ReminderProvider = this.provider, baseUrl: string | undefined = this.config.PUBLIC_WEB_URL): Promise<AftercareRun> {
    const out: AftercareRun = { reminders: { sent: 0, skipped: 0, retried: 0, failed: 0 }, feedbackLinks: 0, escalated: 0 };
    const tenants = await tenantScope.system("aftercare worker: hospitals with work due", () =>
      this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT medos_tenants_with_aftercare_work(${now}::timestamptz)::text AS tenant_id`);
    for (const { tenant_id: tenantId } of tenants) {
      await tenantScope.run(tenantId, async () => {
        await this.prisma.$transaction(async (tx) => { await this.reminders(tx, tenantId, now, provider, out); }, { timeout: 30_000 });
        await this.prisma.$transaction(async (tx) => { await this.feedbackLinks(tx, tenantId, now, provider, baseUrl, out); }, { timeout: 30_000 });
        await this.prisma.$transaction(async (tx) => { await this.escalate(tx, tenantId, now, out); }, { timeout: 30_000 });
      });
    }
    return out;
  }

  private async reminders(tx: Db, tenantId: string, now: Date, provider: ReminderProvider, out: AftercareRun): Promise<void> {
    const ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AftercareTask" WHERE "tenantId" = ${tenantId}::uuid AND status = 'PENDING' AND "reminderSentAt" IS NULL AND "reminderAttempts" < ${MAX_TRIES}
        AND "dueDate" <= (${now}::timestamptz)::date + 30 AND ("reminderNextAt" IS NULL OR "reminderNextAt" <= ${now}) ORDER BY "dueDate", id FOR UPDATE SKIP LOCKED LIMIT 50`;
    for (const { id } of ids) {
      const t = await tx.aftercareTask.findFirstOrThrow({ where: { id, tenantId }, select: { id: true, facilityId: true, patientId: true, dueDate: true, reminderAttempts: true, patient: { select: { mobile: true } }, facility: { select: { name: true, timezone: true } } } });
      if (!(await this.settings.get(tx, tenantId, t.facilityId, "AFTERCARE_REMINDER_ENABLED"))) continue;
      const lead = await this.settings.get(tx, tenantId, t.facilityId, "AFTERCARE_CALL_LEAD_DAYS");
      const due = t.dueDate.toISOString().slice(0, 10);
      if (dayOf(now, t.facility.timezone) < addDays(due, -lead)) continue;
      const give = async (why: string) => { await tx.aftercareTask.update({ where: { tenantId_id: { tenantId, id } }, data: { reminderAttempts: MAX_TRIES, reminderError: why } }); out.reminders.skipped++; };
      if (!t.patient.mobile) { await give("The patient has no mobile number"); continue; }
      if (!remindersAllowed(await reminderConsentState(tx, tenantId, t.patientId), await this.settings.get(tx, tenantId, t.facilityId, "REMINDERS_REQUIRE_CONSENT"))) { await give("The patient has not agreed to messages"); continue; }
      const when = new Intl.DateTimeFormat("en-IN", { timeZone: t.facility.timezone, day: "numeric", month: "short" }).format(t.dueDate);
      const attempts = t.reminderAttempts + 1;
      try {
        await provider.send({ reminderId: t.id, appointmentId: t.id, to: t.patient.mobile, text: `Your review visit after your stay at ${t.facility.name} is due around ${when}. Please call us to book a time that suits you.` });
        await tx.aftercareTask.update({ where: { tenantId_id: { tenantId, id } }, data: { reminderSentAt: now, reminderAttempts: attempts, reminderError: null } });
        out.reminders.sent++;
      } catch (e) {
        const why = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        logJson("warn", "aftercare_reminder_failed", { taskId: id, attempts, errorMessage: why });
        await tx.aftercareTask.update({ where: { tenantId_id: { tenantId, id } }, data: { reminderAttempts: attempts, reminderError: why, reminderNextAt: new Date(now.getTime() + RETRY_MS * attempts) } });
        if (attempts >= MAX_TRIES) out.reminders.failed++; else out.reminders.retried++;
      }
    }
  }

  private async feedbackLinks(tx: Db, tenantId: string, now: Date, provider: ReminderProvider, baseUrl: string | undefined, out: AftercareRun): Promise<void> {
    const ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM "AftercareTask" t WHERE t."tenantId" = ${tenantId}::uuid AND t.status = 'COMPLETED' AND t."completedAt" > ${now}::timestamptz - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM "FeedbackRequest" f WHERE f."tenantId" = t."tenantId" AND f."taskId" = t.id) ORDER BY t."completedAt", t.id FOR UPDATE OF t SKIP LOCKED LIMIT 50`;
    for (const { id } of ids) {
      const t = await tx.aftercareTask.findFirstOrThrow({ where: { id, tenantId }, select: { facilityId: true, assignedToId: true } });
      if (!t.assignedToId || !(await this.settings.get(tx, tenantId, t.facilityId, "AFTERCARE_FEEDBACK_REQUEST_ENABLED"))) continue;
      await this.links.issue(tx, { tenantId, facilityId: t.facilityId, userId: t.assignedToId }, id, true, baseUrl, provider);
      out.feedbackLinks++;
    }
  }

  private async escalate(tx: Db, tenantId: string, now: Date, out: AftercareRun): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string; facilityId: string }[]>`
      SELECT id, "facilityId" FROM "Complaint" WHERE "tenantId" = ${tenantId}::uuid AND status IN ('OPEN', 'IN_PROGRESS') AND "dueAt" <= ${now} AND "escalatedAt" IS NULL ORDER BY "dueAt", id FOR UPDATE SKIP LOCKED LIMIT 50`;
    for (const r of rows) {
      if (await this.complaints.escalateIn(tx, { tenantId, facilityId: r.facilityId, userId: null }, r.id, null, "Not resolved by its deadline")) out.escalated++;
    }
  }
}

/** Polls every REMINDER_POLL_SECONDS, like the appointment reminders. Off in tests (they call AftercareJobsService.runDue directly). */
@Injectable()
export class AftercareWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  constructor(private readonly jobs: AftercareJobsService, @Inject(CONFIG) private readonly config: AppConfig) {}

  onModuleInit(): void {
    if (this.config.NODE_ENV === "test" || !this.config.REMINDER_WORKER_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), this.config.REMINDER_POLL_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const c = await this.jobs.runDue();
      if (c.reminders.sent + c.reminders.failed + c.feedbackLinks + c.escalated > 0) logJson("info", "aftercare_processed", { ...c });
    } catch (e) {
      logJson("error", "aftercare_worker_failed", { errorName: e instanceof Error ? e.name : typeof e, errorMessage: e instanceof Error ? e.message.slice(0, 300) : undefined });
    } finally { this.busy = false; }
  }
}
