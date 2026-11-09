import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { endOfLocalDay, localDateStr, startOfLocalDay } from "../../common/time";
import { amount as moneyInput } from "../billing/money.schema";
import { fmt } from "../billing/billing.domain";
import { SettingsService } from "../settings/settings.service";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Percent and fixed amount are given together or alone depending on the mode; the database enforces the same. */
export const createRuleSchema = z.object({
  /** The doctor this applies to; leave out for the default that applies to every doctor without a rule of their own. */
  practitionerId: z.string().uuid().optional(),
  mode: z.enum(["PERCENT", "FIXED", "MIXED"]),
  percent: z.number().min(0).max(100).multipleOf(0.01).optional(),
  fixedAmount: moneyInput().optional(),
  /** The first day it applies (default today). Earlier visits keep the rule that was in force then. */
  effectiveFrom: day.optional(),
  note: z.string().trim().max(240).optional(),
}).strict().superRefine((v, c) => {
  const needPercent = v.mode !== "FIXED";
  const needFixed = v.mode !== "PERCENT";
  if (needPercent && v.percent === undefined) c.addIssue({ code: "custom", path: ["percent"], message: "Enter the doctor's percentage" });
  if (!needPercent && v.percent !== undefined) c.addIssue({ code: "custom", path: ["percent"], message: "A fixed amount has no percentage" });
  if (needFixed && v.fixedAmount === undefined) c.addIssue({ code: "custom", path: ["fixedAmount"], message: "Enter the fixed amount" });
  if (!needFixed && v.fixedAmount !== undefined) c.addIssue({ code: "custom", path: ["fixedAmount"], message: "A percentage has no fixed amount" });
});

/** How doctors are paid in this hospital: a commission (percentage), a fixed value for each visit, or either one for each doctor. */
export const setModelSchema = z.object({ model: z.enum(["BOTH", "COMMISSION", "FIXED_VALUE"]) }).strict();
export const ledgerQuerySchema = z.object({ from: day.optional(), to: day.optional(), practitionerId: z.string().uuid().optional() }).strict();
const LEDGER_LIMIT = 300;
const MAX_DAYS = 93;
const D = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? 0);

const VIEW = { id: true, practitionerId: true, mode: true, percent: true, fixedAmount: true, effectiveFrom: true, note: true, createdAt: true, createdById: true } as const;

/** How the amount collected for consultations is split between the hospital and each doctor (docs/earnings-and-reports.md). */
@Injectable()
export class EarningsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  async model(ctx: RequestContext) {
    return { model: await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "EARNINGS_MODEL") };
  }

  /** Chooses commission, fixed value or either. Rules already saved are kept as history; new rules must follow the choice. */
  async setModel(ctx: RequestContext, input: z.infer<typeof setModelSchema>) {
    await this.settings.put(ctx, "EARNINGS_MODEL", input.model);
    return this.model(ctx);
  }

  /** Every line of the doctor-share ledger in a date range (the facility's days), newest first, with totals and a total for each doctor. */
  async ledger(ctx: RequestContext, q: z.infer<typeof ledgerQuerySchema>) {
    const tz = (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
    const today = localDateStr(new Date(), tz);
    const from = q.from ?? today, to = q.to ?? q.from ?? today;
    if (to < from) throw new DomainError("VALIDATION_FAILED", "The end date is before the start date", 400);
    if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > MAX_DAYS) throw new DomainError("VALIDATION_FAILED", `Choose at most ${MAX_DAYS} days`, 400);
    const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, createdAt: { gte: startOfLocalDay(from, tz), lt: endOfLocalDay(to, tz) }, ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}) };
    const [rows, perDoctor, model] = await Promise.all([
      this.prisma.doctorShareEntry.findMany({
        where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: LEDGER_LIMIT + 1,
        select: { id: true, createdAt: true, trigger: true, ruleMode: true, collectedDelta: true, doctorDelta: true, hospitalDelta: true, practitioner: { select: { displayName: true } }, encounter: { select: { id: true, encounterNumber: true } }, invoice: { select: { id: true, invoiceNumber: true, kind: true } } },
      }),
      this.prisma.doctorShareEntry.groupBy({ by: ["practitionerId"], where, _sum: { collectedDelta: true, doctorDelta: true, hospitalDelta: true } }),
      this.model(ctx),
    ]);
    const names = new Map((await this.prisma.practitioner.findMany({ where: { tenantId: ctx.tenantId, id: { in: perDoctor.map((p) => p.practitionerId) } }, select: { id: true, displayName: true } })).map((p) => [p.id, p.displayName]));
    const total = perDoctor.reduce((a, p) => ({ collected: a.collected.plus(D(p._sum.collectedDelta)), doctor: a.doctor.plus(D(p._sum.doctorDelta)), hospital: a.hospital.plus(D(p._sum.hospitalDelta)) }), { collected: new Decimal(0), doctor: new Decimal(0), hospital: new Decimal(0) });
    return {
      from, to, model: model.model,
      totals: { collected: fmt(total.collected), doctorShare: fmt(total.doctor), hospitalShare: fmt(total.hospital) },
      doctors: perDoctor.map((p) => ({ practitionerId: p.practitionerId, doctor: names.get(p.practitionerId) ?? "", collected: fmt(D(p._sum.collectedDelta)), doctorShare: fmt(D(p._sum.doctorDelta)), hospitalShare: fmt(D(p._sum.hospitalDelta)) }))
        .sort((x, y) => x.doctor.localeCompare(y.doctor)),
      entries: rows.slice(0, LEDGER_LIMIT).map((r) => ({
        id: r.id, at: r.createdAt, trigger: r.trigger, ruleMode: r.ruleMode, doctor: r.practitioner.displayName, encounterId: r.encounter.id, visitNumber: r.encounter.encounterNumber,
        invoiceId: r.invoice.id, invoiceNumber: r.invoice.invoiceNumber, billKind: r.invoice.kind, collected: fmt(r.collectedDelta), doctorShare: fmt(r.doctorDelta), hospitalShare: fmt(r.hospitalDelta),
      })),
      truncated: rows.length > LEDGER_LIMIT,
    };
  }

  /**
   * One visit's bill and share in one place, for the final bill screen: what was billed and collected on its OPD and IPD bills (money used from the patient's
   * advance included), what the doctor earns from it, what the hospital keeps, and the ledger lines behind those numbers.
   */
  async visit(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, encounterNumber: true, type: true, practitioner: { select: { displayName: true } } } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const [bills, entries, model] = await Promise.all([
      this.prisma.invoice.findMany({ where: { tenantId: ctx.tenantId, encounterId: enc.id, kind: { in: ["OPD", "IPD"] }, status: { notIn: ["DRAFT", "CANCELLED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, invoiceNumber: true, kind: true, status: true, total: true, paidTotal: true, refundedTotal: true } }),
      this.prisma.doctorShareEntry.findMany({ where: { tenantId: ctx.tenantId, encounterId: enc.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, createdAt: true, trigger: true, ruleMode: true, collectedDelta: true, doctorDelta: true, hospitalDelta: true, rule: { select: { mode: true, percent: true, fixedAmount: true } }, invoice: { select: { invoiceNumber: true } } } }),
      this.model(ctx),
    ]);
    const billIds = bills.map((b) => b.id);
    const [used, returned] = await Promise.all([
      this.prisma.advanceUse.aggregate({ where: { tenantId: ctx.tenantId, invoiceId: { in: billIds } }, _sum: { amount: true } }),
      this.prisma.advanceReturn.aggregate({ where: { tenantId: ctx.tenantId, invoiceId: { in: billIds } }, _sum: { amount: true } }),
    ]);
    const sum = (pick: (e: (typeof entries)[number]) => { toString(): string }) => entries.reduce<Decimal>((a, e) => a.plus(pick(e).toString()), new Decimal(0));
    const rule = entries[0]?.rule ?? null;
    return {
      encounterId: enc.id, visitNumber: enc.encounterNumber, type: enc.type, doctor: enc.practitioner?.displayName ?? null, model: model.model,
      rule: rule ? { mode: rule.mode, percent: rule.percent === null ? null : D(rule.percent).toFixed(2), fixedAmount: rule.fixedAmount === null ? null : fmt(rule.fixedAmount) } : null,
      bills: bills.map((b) => ({ id: b.id, invoiceNumber: b.invoiceNumber, kind: b.kind, status: b.status, total: fmt(b.total), paid: fmt(b.paidTotal), refunded: fmt(b.refundedTotal) })),
      billed: fmt(bills.reduce<Decimal>((a, b) => a.plus(b.total.toString()), new Decimal(0))),
      paidFromDeposit: fmt(D(used._sum.amount).minus(D(returned._sum.amount))),
      collected: fmt(sum((e) => e.collectedDelta)), doctorShare: fmt(sum((e) => e.doctorDelta)), hospitalNet: fmt(sum((e) => e.hospitalDelta)),
      entries: entries.map((e) => ({ id: e.id, at: e.createdAt, trigger: e.trigger, ruleMode: e.ruleMode, invoiceNumber: e.invoice.invoiceNumber, collected: fmt(e.collectedDelta), doctorShare: fmt(e.doctorDelta), hospitalShare: fmt(e.hospitalDelta) })),
    };
  }

  /** Every rule of the facility, newest first, with the doctor's name; an empty doctor means "the default for all doctors". */
  async list(ctx: RequestContext) {
    const rows = await this.prisma.doctorShareRule.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { ...VIEW, practitioner: { select: { displayName: true } } },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }], take: 500,
    });
    const names = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map(({ practitioner, createdById, ...r }) => ({
      ...r, doctor: practitioner?.displayName ?? null, percent: r.percent === null ? null : new Decimal(r.percent.toString()).toFixed(2),
      fixedAmount: r.fixedAmount === null ? null : fmt(r.fixedAmount.toString()), effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10), createdBy: names.get(createdById) ?? null,
    }));
  }

  async create(ctx: RequestContext, input: z.infer<typeof createRuleSchema>) {
    const tz = (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
    const effectiveFrom = input.effectiveFrom ?? localDateStr(new Date(), tz);
    const { model } = await this.model(ctx);
    if (model === "COMMISSION" && input.mode !== "PERCENT") throw new DomainError("VALIDATION_FAILED", "This hospital pays doctors a commission: add a percentage rule, or change the payment model first", 400, [{ path: "mode", message: "Percentage rules only" }]);
    if (model === "FIXED_VALUE" && input.mode !== "FIXED") throw new DomainError("VALIDATION_FAILED", "This hospital pays doctors a fixed value: add a fixed-amount rule, or change the payment model first", 400, [{ path: "mode", message: "Fixed-amount rules only" }]);
    const id =await this.prisma.$transaction(async (tx) => {
      if (input.practitionerId) {
        const p = await tx.practitioner.findFirst({ where: { id: input.practitionerId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
        if (!p) throw new DomainError("NOT_FOUND", "Doctor not found", 404);
      }
      const row = await tx.doctorShareRule.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId: input.practitionerId ?? null, mode: input.mode,
          percent: input.percent === undefined ? null : input.percent.toFixed(2), fixedAmount: input.fixedAmount ? input.fixedAmount.toFixed(2) : null,
          effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`), note: input.note ?? null, createdById: ctx.userId,
        },
        select: { id: true },
      });
      await this.audit.record(tx, actorOf(ctx), {
        action: "EARNINGS_RULE_CREATED", entityType: "DoctorShareRule", entityId: row.id,
        metadata: { practitionerId: input.practitionerId ?? null, mode: input.mode, percent: input.percent ?? null, fixedAmount: input.fixedAmount ? fmt(input.fixedAmount) : null, effectiveFrom },
      });
      return row.id;
    });
    return (await this.list(ctx)).find((r) => r.id === id);
  }

  /** All rules of a facility, for the reports. */
  async rulesFor(db: Db, ctx: RequestContext) {
    return db.doctorShareRule.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { practitionerId: true, mode: true, percent: true, fixedAmount: true, effectiveFrom: true, createdAt: true } });
  }
}
