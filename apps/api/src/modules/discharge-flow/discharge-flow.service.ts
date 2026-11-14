import { Injectable } from "@nestjs/common";
import { DomainError, type Permission } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { admissionScope, admissionScopeSql } from "../../common/data-scope";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { dateOnly, endOfLocalDay, localDateStr, startOfLocalDay } from "../../common/time";
import { SettingsService } from "../settings/settings.service";
import { DischargeService, EXIT_STAGE, STAGE_INFO, SUMMARY_STAGE, type Step } from "../discharge/discharge.service";
import {
  addMinutes, clockState, currentReasons, DELAY_REASON_LABEL, DELAY_REASONS, leftBeforeNoon, minutesBetween, summariseTurnaround, type ClockState, type ClockTargets,
} from "./discharge-flow.domain";
import { buildFamilySheet, FAMILY_LANGS } from "./family-sheet";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD");
export const FLOW_STAGES = ["NURSING", "CHARGES_REVIEWED", "PHARMACY", "LAB_RADIOLOGY", "OT_PROCEDURE", "INSURANCE", "BILLING", "FINANCIAL_RELEASE", "SUMMARY", "EXIT", "INSURER_PAYMENT"] as const;
export type FlowStage = (typeof FLOW_STAGES)[number];

export const planSchema = z.object({ expectedDate: day, note: z.string().trim().max(300).optional() }).strict();
export const delaySchema = z.object({ stage: z.enum(FLOW_STAGES), reason: z.enum(DELAY_REASONS), note: z.string().trim().max(300).optional() }).strict()
  .refine((d) => d.reason !== "OTHER" || (d.note?.length ?? 0) >= 3, { path: ["note"], message: "Say what the other reason is" });
export const insurerSentSchema = z.object({ sentAt: z.string().datetime({ offset: true }).optional(), note: z.string().trim().max(300).optional() }).strict();
export const familySheetSchema = z.object({ lang: z.enum(FAMILY_LANGS).default("en") }).strict();
export const flowRangeSchema = z.object({ from: day.optional(), to: day.optional() }).strict();
const MAX_DAYS = 93;
const BOARD_LIMIT = 50;
/** An insurer has answered once its claim moves to one of these. */
const INSURER_ANSWERED = ["APPROVED", "SETTLED", "REJECTED", "CLOSED"] as const;
const LIVE_CLAIM = ["PREAUTH_APPROVED", "SUBMITTED", "QUERY", "APPROVED"] as const;

/**
 * Who may act on, or say why they are stuck on, each stage. A person sees a stage as theirs when they hold any of these permissions.
 * (Permissions, never role names: a hospital can reshape its roles.)
 */
export const STAGE_PERMISSIONS: Record<FlowStage, readonly Permission[]> = {
  NURSING: ["NURSING_DOCUMENT"],
  // The billing team (final-bill rights), not everyone who may post a charge (doctors and nurses can too).
  CHARGES_REVIEWED: ["IPD_FINAL_BILL"],
  PHARMACY: ["PHARMACY_DISPENSE"],
  LAB_RADIOLOGY: ["LAB_RESULT", "LAB_VERIFY", "RAD_REPORT", "TEST_BILL"],
  OT_PROCEDURE: ["PROCEDURE_MANAGE"],
  INSURANCE: ["CLAIM_MANAGE"],
  BILLING: ["IPD_FINAL_BILL"],
  FINANCIAL_RELEASE: ["DISCHARGE_FINANCIAL_EXCEPTION"],
  SUMMARY: ["CONSULTATION_CREATE", "CONSULTATION_SIGN", "CONSULTATION_VERIFY"],
  EXIT: ["DISCHARGE_DEPARTURE_CONFIRM"],
  INSURER_PAYMENT: ["CLAIM_MANAGE"],
};

const STAGE_LABEL = (s: FlowStage): { label: string; owner: string } => {
  if (s === "SUMMARY") return { label: SUMMARY_STAGE.stage, owner: SUMMARY_STAGE.responsible };
  if (s === "EXIT") return { label: EXIT_STAGE.stage, owner: EXIT_STAGE.responsible };
  if (s === "INSURER_PAYMENT") return { label: "Insurer's reply", owner: "Insurance desk" };
  const i = STAGE_INFO[s as Step];
  return { label: i.stage, owner: i.responsible };
};

type Status = Awaited<ReturnType<DischargeService["status"]>>;

export interface FlowItem {
  stage: FlowStage; label: string; owner: string; state: ClockState; deadline: Date | null; waitingMinutes: number; blockers: string[];
  reason: { code: string; label: string; note: string | null; at: Date } | null; mine: boolean;
}

export interface FlowTargets { ward: ClockTargets; insurer: ClockTargets }

@Injectable()
export class DischargeFlowService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService, private readonly discharge: DischargeService) {}

  async targets(db: Db, tenantId: string, facilityId: string): Promise<FlowTargets> {
    const [dTarget, dRem, iTarget, iRem] = await Promise.all([
      this.settings.get(db, tenantId, facilityId, "DISCHARGE_TARGET_MINUTES"), this.settings.get(db, tenantId, facilityId, "DISCHARGE_REMINDER_MINUTES"),
      this.settings.get(db, tenantId, facilityId, "INSURER_TARGET_MINUTES"), this.settings.get(db, tenantId, facilityId, "INSURER_REMINDER_MINUTES"),
    ]);
    return { ward: { targetMinutes: dTarget as number, reminderMinutes: dRem as number }, insurer: { targetMinutes: iTarget as number, reminderMinutes: iRem as number } };
  }

  // ───── 1. the planned going-home date ─────

  /** The doctor sets or changes the date the ward expects the patient to go home. It is a plan, not a decision: it never marks anyone fit to go. */
  async setPlan(ctx: RequestContext, admissionId: string, input: z.infer<typeof planSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lock(tx, ctx, admissionId);
      if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "A going-home date can only be set for a current admission", 409);
      const tz = (await tx.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
      const admittedDay = localDateStr(adm.admittedAt, tz);
      const today = localDateStr(new Date(), tz);
      if (input.expectedDate < admittedDay) throw new DomainError("VALIDATION_FAILED", "The going-home date cannot be before the admission date", 400, [{ path: "expectedDate", message: "Before the admission date" }]);
      if ((dateOnly(input.expectedDate).getTime() - dateOnly(today).getTime()) / 86_400_000 > 180) throw new DomainError("VALIDATION_FAILED", "The going-home date is too far ahead", 400, [{ path: "expectedDate", message: "More than 180 days ahead" }]);
      const before = await tx.dischargePlan.findFirst({ where: { tenantId: ctx.tenantId, admissionId }, select: { expectedDate: true } });
      const plan = await tx.dischargePlan.upsert({
        where: { admissionId },
        create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, expectedDate: dateOnly(input.expectedDate), note: input.note ?? null, setById: ctx.userId },
        update: { expectedDate: dateOnly(input.expectedDate), note: input.note ?? null, setById: ctx.userId },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "DISCHARGE_PLAN_SET", entityType: "Admission", entityId: admissionId, metadata: { expectedDate: input.expectedDate, ...(before ? { previousDate: before.expectedDate.toISOString().slice(0, 10) } : {}) } });
      return { admissionId, expectedDate: plan.expectedDate.toISOString().slice(0, 10), note: plan.note };
    });
  }

  // ───── 2-5. the checklist and the clocks of one patient ─────

  async flow(ctx: RequestContext, admissionId: string, now = new Date()) {
    const adm = await this.prisma.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, select: { id: true } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.build(this.prisma, ctx, admissionId, now);
  }

  /** The whole picture for one admission, from the records. The system only reports: it never decides fitness, signs, or clears a stage. */
  async build(db: Db | PrismaService, ctx: RequestContext, admissionId: string, now: Date) {
    const st: Status = await this.discharge.status(ctx, admissionId);
    const adm = await db.admission.findFirstOrThrow({
      where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      select: { id: true, admissionNumber: true, status: true, dischargeType: true, dischargedAt: true, admittedAt: true, encounterId: true, patient: { select: { firstName: true, lastName: true } } },
    });
    const [targets, plan, departure, delays, send] = await Promise.all([
      this.targets(db as Db, ctx.tenantId, ctx.facilityId),
      db.dischargePlan.findFirst({ where: { tenantId: ctx.tenantId, admissionId }, select: { expectedDate: true, note: true } }),
      db.admissionDeparture.findFirst({ where: { tenantId: ctx.tenantId, admissionId }, select: { departedAt: true } }),
      db.dischargeDelay.findMany({ where: { tenantId: ctx.tenantId, admissionId }, orderBy: [{ at: "asc" }, { id: "asc" }], select: { stage: true, reason: true, note: true, at: true } }),
      db.insurerBillSend.findFirst({ where: { tenantId: ctx.tenantId, admissionId }, select: { sentAt: true, claimId: true } }),
    ]);
    const fit = st.steps.find((s) => s.step === "MEDICALLY_FIT");
    const fitAt = fit && fit.status !== "PENDING" ? fit.at : null;
    const absconded = adm.dischargeType === "ABSCONDED";
    const stoppedAt = departure?.departedAt ?? (absconded ? adm.dischargedAt : null);
    const reasons = currentReasons(delays);
    const reasonOf = (stage: string) => { const r = reasons.get(stage); return r ? { code: r.reason, label: DELAY_REASON_LABEL[r.reason], note: r.note, at: r.at } : null; };
    const mine = (s: FlowStage) => STAGE_PERMISSIONS[s].some((p) => ctx.permissions.has(p));

    const elapsed = fitAt ? minutesBetween(fitAt, stoppedAt ?? now) : 0;
    const state = fitAt && !stoppedAt ? clockState(elapsed, targets.ward) : "ON_TIME";
    const deadline = fitAt ? addMinutes(fitAt, targets.ward.targetMinutes) : null;

    const items: FlowItem[] = [];
    const push = (stage: FlowStage, blockers: string[]) => {
      const { label, owner } = STAGE_LABEL(stage);
      items.push({ stage, label, owner, state, deadline, waitingMinutes: elapsed, blockers, reason: reasonOf(stage), mine: mine(stage) });
    };
    if (fitAt && !stoppedAt) {
      const sm = st.summary;
      const summaryDone = sm.status === "SIGNED" || sm.status === "AMENDED" || sm.status === "VERIFIED";
      if ((st.requireSummary && !summaryDone) || (sm.verificationRequired && sm.status !== "VERIFIED")) push("SUMMARY", [sm.hisStatus]);
      for (const s of st.steps) if (s.step !== "MEDICALLY_FIT" && s.required && s.status === "PENDING") push(s.step as FlowStage, s.blockers);
      push("EXIT", st.status === "ADMITTED" ? ["The patient can leave once the doctor completes the discharge"] : []);
    }

    // The insurer's own clock: it starts when the insurance desk sends the final bill, and stops at the insurer's answer, so a slow insurer never hides a slow ward.
    let insurer: { startedAt: Date; answeredAt: Date | null; elapsedMinutes: number; state: ClockState; deadline: Date; reason: FlowItem["reason"]; mine: boolean } | null = null;
    if (send) {
      const answer = await db.claimEvent.findFirst({ where: { tenantId: ctx.tenantId, claimId: send.claimId, toStatus: { in: [...INSURER_ANSWERED] }, at: { gt: send.sentAt } }, orderBy: { at: "asc" }, select: { at: true } });
      const m = minutesBetween(send.sentAt, answer?.at ?? now);
      insurer = { startedAt: send.sentAt, answeredAt: answer?.at ?? null, elapsedMinutes: m, state: answer ? "ON_TIME" : clockState(m, targets.insurer), deadline: addMinutes(send.sentAt, targets.insurer.targetMinutes), reason: reasonOf("INSURER_PAYMENT"), mine: mine("INSURER_PAYMENT") };
    }

    const plannedDate = plan?.expectedDate.toISOString().slice(0, 10) ?? null;
    return {
      admissionId, admissionNumber: adm.admissionNumber, patientName: [adm.patient.firstName, adm.patient.lastName].filter(Boolean).join(" "), admissionStatus: adm.status,
      plan: plannedDate ? { expectedDate: plannedDate, note: plan?.note ?? null } : null,
      // The doctor's own words, taken from the record: while this is null nobody is "fit to go" and no clock runs.
      fitToGo: fitAt ? { at: fitAt, byName: fit?.byName ?? null } : null,
      clock: { running: !!fitAt && !stoppedAt, startedAt: fitAt, stoppedAt, elapsedMinutes: elapsed, state, deadline, targetMinutes: targets.ward.targetMinutes, reminderMinutes: targets.ward.reminderMinutes },
      items,
      insurer: insurer ? { ...insurer, targetMinutes: targets.insurer.targetMinutes, reminderMinutes: targets.insurer.reminderMinutes } : null,
      // Everything the cashier, nurse and pharmacist cleared on their own is in the checklist above; this tells the doctor what is left on the doctor's side.
      doctorStillToDo: { fitToGo: !fitAt, summary: items.some((i) => i.stage === "SUMMARY"), dischargeToComplete: !!fitAt && st.status === "ADMITTED" && st.canComplete },
      canComplete: st.canComplete,
    };
  }

  // ───── 3. each person's own pending work ─────

  /** Only the items this person can act on, across the facility's waiting patients. */
  async myWork(ctx: RequestContext, now = new Date()) {
    const board = await this.board(ctx, now);
    const items = board.waiting.flatMap((w) => w.items.filter((i) => i.mine).map((i) => ({ admissionId: w.admissionId, admissionNumber: w.admissionNumber, patientName: w.patientName, bed: w.bed, ...i })));
    items.sort((a, b) => b.waitingMinutes - a.waitingMinutes);
    const insurer = board.insurerWaiting.filter((w) => w.insurer?.mine);
    return { items, insurerWaiting: insurer };
  }

  // ───── 6. everyone waiting to go home ─────

  async board(ctx: RequestContext, now = new Date()) {
    const base: Prisma.AdmissionWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] };
    // A patient is waiting once the doctor has said "fit to go" and has not yet left (an absconded patient never waits).
    const rows = await this.prisma.admission.findMany({
      where: { ...base, clearances: { some: { step: "MEDICALLY_FIT" } }, departure: null, OR: [{ status: "ADMITTED" }, { status: "DISCHARGED", dischargeType: { not: "ABSCONDED" } }] },
      select: { id: true, assignments: { where: { releasedAt: null }, select: { bed: { select: { code: true, ward: { select: { name: true } } } } }, take: 1 } },
      orderBy: [{ admittedAt: "asc" }, { id: "asc" }], take: BOARD_LIMIT,
    });
    // One evaluation per waiting patient: the board is capped, and each stage's own reconciliation is the source of truth for "what is holding them up".
    const waiting = [];
    for (const r of rows) {
      const v = await this.build(this.prisma, ctx, r.id, now);
      const b = r.assignments[0]?.bed;
      waiting.push({ ...v, bed: b ? `${b.ward.name} · ${b.code}` : null });
    }
    waiting.sort((a, b) => b.clock.elapsedMinutes - a.clock.elapsedMinutes || a.admissionNumber.localeCompare(b.admissionNumber));
    const sent = await this.prisma.admission.findMany({
      where: { ...base, insurerBillSend: { isNot: null } }, select: { id: true }, orderBy: [{ insurerBillSend: { sentAt: "asc" } }, { id: "asc" }], take: BOARD_LIMIT,
    });
    const insurerWaiting = [];
    for (const r of sent) {
      const v = await this.build(this.prisma, ctx, r.id, now);
      if (v.insurer && !v.insurer.answeredAt) insurerWaiting.push({ ...v, bed: null as string | null });
    }
    insurerWaiting.sort((a, b) => (b.insurer?.elapsedMinutes ?? 0) - (a.insurer?.elapsedMinutes ?? 0));
    return { generatedAt: now, waiting, insurerWaiting, capped: rows.length === BOARD_LIMIT };
  }

  // ───── 8. why something is stuck ─────

  async recordDelay(ctx: RequestContext, admissionId: string, input: z.infer<typeof delaySchema>) {
    const owns = STAGE_PERMISSIONS[input.stage].some((p) => ctx.permissions.has(p)) || ctx.permissions.has("ADMISSION_DISCHARGE");
    if (!owns) throw new DomainError("FORBIDDEN", "You do not have permission to give a reason for this step", 403);
    await this.flow(ctx, admissionId); // visibility under the caller's data scope
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, ctx, admissionId);
      const v = await this.build(tx, ctx, admissionId, new Date());
      const open = input.stage === "INSURER_PAYMENT" ? !!v.insurer && !v.insurer.answeredAt : v.items.some((i) => i.stage === input.stage);
      if (!open) throw new DomainError("INVALID_STATE", "This step is not waiting for anything, so there is nothing to explain", 409);
      await tx.dischargeDelay.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, stage: input.stage, reason: input.reason, note: input.note ?? null, byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "DISCHARGE_DELAY_REASON_RECORDED", entityType: "Admission", entityId: admissionId, metadata: { stage: input.stage, reason: input.reason } });
      return this.build(tx, ctx, admissionId, new Date());
    });
  }

  // ───── 5. the insurer's clock starts ─────

  /** The insurance desk says the final bill went to the insurer. Once per admission. */
  async recordInsurerBillSent(ctx: RequestContext, admissionId: string, input: z.infer<typeof insurerSentSchema>) {
    await this.flow(ctx, admissionId);
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lock(tx, ctx, admissionId);
      if (!adm.finalInvoiceId) throw new DomainError("INVALID_STATE", "The final bill has not been generated yet", 409);
      if (await tx.insurerBillSend.findFirst({ where: { tenantId: ctx.tenantId, admissionId }, select: { id: true } })) throw new DomainError("CONFLICT", "The final bill has already been marked as sent to the insurer", 409);
      const claim = await tx.claim.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: adm.encounterId, status: { in: [...LIVE_CLAIM] } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: { id: true } });
      if (!claim) throw new DomainError("INVALID_STATE", "There is no open insurance claim for this admission", 409);
      const now = new Date();
      const sentAt = input.sentAt ? new Date(input.sentAt) : now;
      if (sentAt.getTime() > now.getTime() + 5 * 60_000) throw new DomainError("VALIDATION_FAILED", "The sending time cannot be in the future", 400, [{ path: "sentAt", message: "In the future" }]);
      if (sentAt < adm.admittedAt) throw new DomainError("VALIDATION_FAILED", "The sending time cannot be before the admission", 400, [{ path: "sentAt", message: "Before the admission" }]);
      await tx.insurerBillSend.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, claimId: claim.id, sentAt, note: input.note ?? null, byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "INSURER_BILL_SENT", entityType: "Admission", entityId: admissionId, metadata: { claimId: claim.id, sentAt: sentAt.toISOString() } });
      return this.build(tx, ctx, admissionId, now);
    });
  }

  // ───── 12. the family's sheet ─────

  async familySheet(ctx: RequestContext, admissionId: string, input: z.infer<typeof familySheetSchema>) {
    const v = await this.flow(ctx, admissionId);
    const reasonCodes: Record<string, string> = {};
    for (const i of v.items) if (i.reason) reasonCodes[i.stage] = i.reason.code;
    const tz = (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
    const fitAt = v.fitToGo ? new Intl.DateTimeFormat(input.lang === "en" ? "en-IN" : input.lang === "hi" ? "hi-IN" : "bn-IN", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(v.fitToGo.at) : null;
    // Only stages the family can understand and wait on: never the internal "exit" step before the doctor completes the discharge.
    const pending = v.items.map((i) => ({ stage: i.stage }));
    return buildFamilySheet({ lang: input.lang, patientName: v.patientName, expectedDate: v.plan?.expectedDate ?? null, fitAt, pending, reasonCodes });
  }

  // ───── 13. management report ─────

  async report(ctx: RequestContext, q: z.infer<typeof flowRangeSchema>) {
    const f = await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    const today = localDateStr(new Date(), f.timezone);
    const from = q.from ?? q.to ?? today; const to = q.to ?? q.from ?? today;
    if (from > to) throw new DomainError("VALIDATION_FAILED", "The start date must not be after the end date", 400);
    if ((dateOnly(to).getTime() - dateOnly(from).getTime()) / 86_400_000 >= MAX_DAYS) throw new DomainError("VALIDATION_FAILED", `Choose a range of at most ${MAX_DAYS} days`, 400);
    const start = startOfLocalDay(from, f.timezone); const end = endOfLocalDay(to, f.timezone);
    const targets = await this.targets(this.prisma, ctx.tenantId, ctx.facilityId);

    const stays = await this.prisma.$queryRaw<{ id: string; fitAt: Date; departedAt: Date }[]>`
      SELECT a.id, fit."at" AS "fitAt", dep."departedAt" AS "departedAt"
      FROM "Admission" a
      JOIN "AdmissionDeparture" dep ON dep."admissionId" = a.id AND dep."tenantId" = a."tenantId"
      JOIN "DischargeClearance" fit ON fit."admissionId" = a.id AND fit."tenantId" = a."tenantId" AND fit.step = 'MEDICALLY_FIT'
      WHERE a."tenantId" = ${ctx.tenantId}::uuid AND a."facilityId" = ${ctx.facilityId}::uuid AND dep."departedAt" >= ${start} AND dep."departedAt" < ${end} ${admissionScopeSql(ctx)}
      ORDER BY dep."departedAt", a.id LIMIT 5000`;
    const summary = summariseTurnaround(stays.map((s) => ({ minutes: minutesBetween(s.fitAt, s.departedAt), beforeNoon: leftBeforeNoon(s.departedAt, f.timezone) })), targets.ward.targetMinutes);
    const ids = stays.map((s) => s.id);

    // The newest reason recorded for each stage of each stay, added up by reason and by the team that answers for the stage.
    const reasons = ids.length ? await this.prisma.$queryRaw<{ stage: string; reason: string; n: number }[]>`
      SELECT x.stage, x.reason::text AS reason, COUNT(*)::int AS n FROM (
        SELECT DISTINCT ON (d."admissionId", d.stage) d.stage, d.reason FROM "DischargeDelay" d
        WHERE d."tenantId" = ${ctx.tenantId}::uuid AND d."admissionId" = ANY(${ids}::uuid[]) ORDER BY d."admissionId", d.stage, d."at" DESC, d.id DESC
      ) x GROUP BY 1, 2` : [];
    const byReason = new Map<string, number>(); const byStage = new Map<string, number>();
    for (const r of reasons) { byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + r.n); byStage.set(r.stage, (byStage.get(r.stage) ?? 0) + r.n); }

    // How long each stage that keeps a time of its own took after the doctor's "fit to go".
    const clears = ids.length ? await this.prisma.$queryRaw<{ step: string; avg: number; n: number }[]>`
      SELECT c.step::text AS step, round(avg(extract(epoch FROM (c."at" - fit."at")) / 60))::int AS avg, COUNT(*)::int AS n
      FROM "DischargeClearance" c JOIN "DischargeClearance" fit ON fit."admissionId" = c."admissionId" AND fit."tenantId" = c."tenantId" AND fit.step = 'MEDICALLY_FIT'
      WHERE c."tenantId" = ${ctx.tenantId}::uuid AND c."admissionId" = ANY(${ids}::uuid[]) AND c.step <> 'MEDICALLY_FIT' GROUP BY 1` : [];

    const insurerRows = await this.prisma.$queryRaw<{ minutes: number }[]>`
      SELECT round(extract(epoch FROM (ans."at" - s."sentAt")) / 60)::int AS minutes
      FROM "InsurerBillSend" s
      JOIN LATERAL (SELECT e."at" FROM "ClaimEvent" e WHERE e."tenantId" = s."tenantId" AND e."claimId" = s."claimId" AND e."toStatus" IN ('APPROVED','SETTLED','REJECTED','CLOSED') AND e."at" > s."sentAt" ORDER BY e."at" LIMIT 1) ans ON true
      WHERE s."tenantId" = ${ctx.tenantId}::uuid AND s."facilityId" = ${ctx.facilityId}::uuid AND s."sentAt" >= ${start} AND s."sentAt" < ${end}`;
    const insurerMinutes = insurerRows.map((r) => Math.max(0, r.minutes));

    const labelOf = (s: string) => (FLOW_STAGES as readonly string[]).includes(s) ? STAGE_LABEL(s as FlowStage) : { label: s, owner: "" };
    return {
      from, to, targetMinutes: targets.ward.targetMinutes, ...summary,
      delaysByReason: [...byReason].map(([code, count]) => ({ code, label: DELAY_REASON_LABEL[code as keyof typeof DELAY_REASON_LABEL] ?? code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
      delaysByDepartment: [...byStage].map(([stage, count]) => ({ stage, ...labelOf(stage), count })).sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage)),
      slowestStages: clears.map((c) => ({ stage: c.step, ...labelOf(c.step), averageMinutesAfterFit: c.avg, stays: c.n })).sort((a, b) => b.averageMinutesAfterFit - a.averageMinutesAfterFit),
      insurer: { answered: insurerMinutes.length, averageMinutes: insurerMinutes.length ? Math.round(insurerMinutes.reduce((a, b) => a + b, 0) / insurerMinutes.length) : null, withinTarget: insurerMinutes.filter((m) => m <= targets.insurer.targetMinutes).length, targetMinutes: targets.insurer.targetMinutes },
    };
  }

  private async lock(tx: Db, ctx: RequestContext, admissionId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Admission" WHERE id = ${admissionId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const adm = await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return adm;
  }
}
