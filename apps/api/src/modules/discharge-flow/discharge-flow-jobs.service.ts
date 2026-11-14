import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Permission } from "@medos/shared";
import { AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { NotificationsService } from "../notifications/notifications.service";
import { levelsReached, minutesBetween, type FlowAlertLevel } from "./discharge-flow.domain";
import { DischargeFlowService, STAGE_PERMISSIONS, type FlowStage } from "./discharge-flow.service";

export interface FlowRun { reminders: number; departmentEscalations: number; administratorEscalations: number }

/** Not a person: the background job reads the same records a signed-in reader would, for every patient of the hospital. */
const systemCtx = (tenantId: string, facilityId: string): RequestContext => ({
  tenantId, facilityId, userId: "00000000-0000-0000-0000-000000000000", permissions: new Set<Permission>(), requestId: "discharge-flow-worker", dataScope: { kind: "ALL" },
});

/**
 * The reminders and escalations of the discharge flow (docs/discharge-flow.md). Every run looks at the patients waiting to go home (and at insurers
 * that have not answered) and sends each alert level once per stage: the ledger's unique key makes a second run, or a second server, send nothing twice.
 */
@Injectable()
export class DischargeFlowJobsService {
  constructor(private readonly prisma: PrismaService, private readonly flow: DischargeFlowService, private readonly notifications: NotificationsService, private readonly audit: AuditService) {}

  /** `only`: work for just these hospitals (a manual run; the worker passes nothing and serves every hospital). */
  async runDue(now = new Date(), only?: readonly string[]): Promise<FlowRun> {
    const out: FlowRun = { reminders: 0, departmentEscalations: 0, administratorEscalations: 0 };
    const tenants = await tenantScope.system("discharge flow worker: hospitals with patients waiting", () =>
      this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT medos_tenants_with_discharge_wait(${now}::timestamptz)::text AS tenant_id`);
    for (const { tenant_id: tenantId } of tenants) {
      if (only && !only.includes(tenantId)) continue;
      await tenantScope.run(tenantId, async () => {
        const waiting = await this.prisma.admission.findMany({
          where: { tenantId, clearances: { some: { step: "MEDICALLY_FIT", at: { gt: new Date(now.getTime() - 7 * 86_400_000) } } }, departure: null, OR: [{ status: "ADMITTED" }, { status: "DISCHARGED", dischargeType: { not: "ABSCONDED" } }] },
          select: { id: true, facilityId: true, consultantId: true, clearances: { where: { step: "MEDICALLY_FIT" }, select: { at: true }, take: 1 } }, orderBy: [{ admittedAt: "asc" }, { id: "asc" }], take: 500,
        });
        const insurerWaiting = await this.prisma.admission.findMany({
          where: { tenantId, insurerBillSend: { sentAt: { gt: new Date(now.getTime() - 14 * 86_400_000) } } }, select: { id: true, facilityId: true, consultantId: true, insurerBillSend: { select: { sentAt: true } } }, orderBy: [{ admittedAt: "asc" }, { id: "asc" }], take: 500,
        });
        // Most waiting patients are nowhere near the first reminder: look at the clock first (cheap) and only evaluate the checklist of those that could trigger an alert.
        const targetsOf = new Map<string, Awaited<ReturnType<DischargeFlowService["targets"]>>>();
        const targets = async (facilityId: string) => { let t = targetsOf.get(facilityId); if (!t) { t = await this.flow.targets(this.prisma, tenantId, facilityId); targetsOf.set(facilityId, t); } return t; };
        const due: typeof waiting = [];
        for (const a of waiting) { const fit = a.clearances[0]?.at; if (fit && levelsReached(minutesBetween(fit, now), (await targets(a.facilityId)).ward).length > 0) due.push(a); }
        for (const a of insurerWaiting) { const sent = a.insurerBillSend?.sentAt; if (sent && levelsReached(minutesBetween(sent, now), (await targets(a.facilityId)).insurer).length > 0) due.push({ ...a, clearances: [] }); }
        const seen = new Set<string>();
        for (const a of due) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          await this.prisma.$transaction(async (tx) => { await this.one(tx, tenantId, a.facilityId, a.id, a.consultantId, now, out); }, { timeout: 30_000 });
        }
      });
    }
    return out;
  }

  private async one(tx: Db, tenantId: string, facilityId: string, admissionId: string, consultantId: string, now: Date, out: FlowRun): Promise<void> {
    const ctx = systemCtx(tenantId, facilityId);
    const v = await this.flow.build(tx, ctx, admissionId, now);
    const targets = await this.flow.targets(tx, tenantId, facilityId);
    const jobs: { clock: "DISCHARGE" | "INSURER"; stage: FlowStage; levels: FlowAlertLevel[] }[] = [];
    if (v.clock.running) for (const i of v.items) jobs.push({ clock: "DISCHARGE", stage: i.stage, levels: levelsReached(v.clock.elapsedMinutes, targets.ward) });
    if (v.insurer && !v.insurer.answeredAt) jobs.push({ clock: "INSURER", stage: "INSURER_PAYMENT", levels: levelsReached(v.insurer.elapsedMinutes, targets.insurer) });
    for (const j of jobs) {
      for (const level of j.levels) {
        // One notification per person per patient per level, however many of that person's stages are pending (the ledger below still records each stage).
        // The ledger first: if another run already sent this level for this stage, nobody is told twice.
        // (The ledger is append-only, so who was told is worked out before the row is written.)
        const to = [...new Set(await this.recipients(tx, tenantId, facilityId, level, j.stage, consultantId))];
        const made = await tx.dischargeAlert.createMany({ data: [{ tenantId, facilityId, admissionId, clock: j.clock, level, stage: j.stage, recipients: to.length }], skipDuplicates: true });
        if (made.count === 0) continue;
        const sent = await this.notifications.notify(tx, to, {
          tenantId, facilityId, type: level === "REMINDER" ? "DISCHARGE_REMINDER" : "DISCHARGE_ESCALATION", entityType: "Admission", entityId: admissionId, dedupeKey: `DISCHARGE:${j.clock}:${level}:${admissionId}`,
        });
        await this.audit.record(tx, { tenantId, facilityId, userId: null }, { action: "DISCHARGE_ALERT_SENT", entityType: "Admission", entityId: admissionId, metadata: { clock: j.clock, level, stage: j.stage, recipients: sent } });
        if (level === "REMINDER") out.reminders++; else if (level === "ESCALATION_DEPARTMENT") out.departmentEscalations++; else out.administratorEscalations++;
      }
    }
  }

  /** Reminder: whoever answers for the stage (and the treating doctor for the summary). Department head: the heads who also work that stage, or all heads if none does. Administrator: the administrators. */
  private async recipients(tx: Db, tenantId: string, facilityId: string, level: FlowAlertLevel, stage: FlowStage, consultantId: string): Promise<string[]> {
    // The summary is the treating doctor's and the RMO's, not every doctor's.
    const owners = stage === "SUMMARY"
      ? await this.notifications.recipientsWith(tx, tenantId, facilityId, ["CONSULTATION_VERIFY"])
      : await this.notifications.recipientsWith(tx, tenantId, facilityId, [...STAGE_PERMISSIONS[stage]]);
    if (level === "REMINDER") {
      const doctor = stage === "SUMMARY" ? await this.notifications.doctorUser(tx, tenantId, consultantId) : null;
      return doctor ? [...owners, doctor] : owners;
    }
    if (level === "ESCALATION_ADMINISTRATOR") return this.notifications.recipientsWith(tx, tenantId, facilityId, ["DISCHARGE_ESCALATE_ADMIN"]);
    const heads = await this.notifications.recipientsWith(tx, tenantId, facilityId, ["DISCHARGE_ESCALATE_DEPT"]);
    const ofStage = heads.filter((h) => owners.includes(h));
    return ofStage.length ? ofStage : heads;
  }
}

/** Polls like the other workers. Off in tests (they call runDue directly). */
@Injectable()
export class DischargeFlowWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  constructor(private readonly jobs: DischargeFlowJobsService, @Inject(CONFIG) private readonly config: AppConfig) {}

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
      if (c.reminders + c.departmentEscalations + c.administratorEscalations > 0) logJson("info", "discharge_flow_alerts_sent", { ...c });
    } catch (e) {
      logJson("error", "discharge_flow_worker_failed", { errorName: e instanceof Error ? e.name : typeof e, errorMessage: e instanceof Error ? e.message.slice(0, 300) : undefined });
    } finally { this.busy = false; }
  }
}
