import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { endOfLocalDay, localDateStr, startOfLocalDay } from "../../common/time";
import { fmt } from "../billing/billing.domain";
import { amount as moneyInput } from "../billing/money.schema";
import { NumberingService } from "../numbering/numbering.service";
import { SettingsService } from "../settings/settings.service";

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const D = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? 0);
const MAX_DAYS = 366;

export const createPayoutSchema = z.object({
  practitionerId: uuid,
  /** The share being paid out, before tax deducted at source. */
  amount: moneyInput({ positive: true }),
  /** Tax deducted at source; the hospital's default (DOCTOR_PAYOUT_TDS_PERCENT) when left out. */
  tdsPercent: z.number().min(0).max(30).multipleOf(0.01).optional(),
  method: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"]),
  reference: z.string().trim().min(4).max(80).optional(),
  note: z.string().trim().max(240).optional(),
}).strict();
export const reversePayoutSchema = z.object({ reason: z.string().trim().min(5).max(240) }).strict();
export const payoutListSchema = z.object({ practitionerId: uuid.optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict();
export const statementQuerySchema = z.object({ practitionerId: uuid, from: day.optional(), to: day.optional() }).strict();
export const myStatementQuerySchema = z.object({ from: day.optional(), to: day.optional() }).strict();

const VIEW = {
  id: true, payoutNumber: true, kind: true, reversesId: true, grossAmount: true, tdsPercent: true, tdsAmount: true, netAmount: true, method: true, reference: true, note: true, paidAt: true, createdAt: true, createdById: true,
  practitioner: { select: { id: true, displayName: true } }, reversedBy: { select: { id: true, payoutNumber: true } }, reverses: { select: { payoutNumber: true } },
} as const;

/**
 * Paying doctors what the doctor share ledger says they have earned (docs/doctor-payouts.md). What is still owed to a doctor is everything the ledger has earned
 * for them less everything already paid out (before tax deducted at source). A payout voucher is never edited or deleted; one made in error is undone with a
 * reversal that mirrors it. This records the payout; it does not move money, and it is not part of a cashier's shift.
 */
@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService,
    private readonly settings: SettingsService, private readonly idempotency: IdempotencyService,
  ) {}

  private async earnedAndPaid(db: Db | PrismaService, ctx: RequestContext, practitionerId: string, before?: Date) {
    const when = before ? { createdAt: { lt: before } } : {};
    const [earned, paid] = await Promise.all([
      db.doctorShareEntry.aggregate({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, ...when }, _sum: { doctorDelta: true } }),
      db.doctorPayout.aggregate({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId, ...when }, _sum: { grossAmount: true } }),
    ]);
    return { earned: D(earned._sum.doctorDelta), paid: D(paid._sum.grossAmount) };
  }

  /** Every doctor with something earned or paid: earned, paid out (before tax) and still owed. */
  async balances(ctx: RequestContext) {
    const [earned, paid, tds] = await Promise.all([
      this.prisma.doctorShareEntry.groupBy({ by: ["practitionerId"], where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, _sum: { doctorDelta: true } }),
      this.prisma.doctorPayout.groupBy({ by: ["practitionerId"], where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, _sum: { grossAmount: true, tdsAmount: true, netAmount: true } }),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "DOCTOR_PAYOUT_TDS_PERCENT"),
    ]);
    const ids = [...new Set([...earned.map((e) => e.practitionerId), ...paid.map((p) => p.practitionerId)])];
    const names = new Map((await this.prisma.practitioner.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, displayName: true } })).map((p) => [p.id, p.displayName]));
    const rows = ids.map((id) => {
      const e = D(earned.find((x) => x.practitionerId === id)?._sum.doctorDelta);
      const p = paid.find((x) => x.practitionerId === id);
      return { practitionerId: id, doctor: names.get(id) ?? "", earned: fmt(e), paid: fmt(D(p?._sum.grossAmount)), tdsDeducted: fmt(D(p?._sum.tdsAmount)), netPaid: fmt(D(p?._sum.netAmount)), owed: fmt(e.minus(D(p?._sum.grossAmount))) };
    }).sort((a, b) => a.doctor.localeCompare(b.doctor));
    const sum = (k: "earned" | "paid" | "owed") => rows.reduce((n, r) => n.plus(r[k]), new Decimal(0));
    return { defaultTdsPercent: D(tds).toFixed(2), totals: { earned: fmt(sum("earned")), paid: fmt(sum("paid")), owed: fmt(sum("owed")) }, doctors: rows };
  }

  async pay(ctx: RequestContext, input: z.infer<typeof createPayoutSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for doctor payouts", 400);
    return this.idempotency.run(ctx.tenantId, "DOCTOR_PAYOUT", key, input, async (tx) => {
      const doc = await tx.practitioner.findFirst({ where: { id: input.practitionerId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, displayName: true } });
      if (!doc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (input.method !== "CASH" && !input.reference) throw new DomainError("VALIDATION_FAILED", "A reference (transaction id or cheque number) is required for this way of paying", 400, [{ path: "reference", message: "Reference required" }]);
      // Payouts to one doctor are worked out one at a time, so two at once can never pay the same earnings twice.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payout:${doc.id}`}, 0))`;
      const { earned, paid } = await this.earnedAndPaid(tx, ctx, doc.id);
      const owed = earned.minus(paid);
      const gross = new Decimal(input.amount.toString());
      if (gross.gt(owed)) throw new DomainError("PAYOUT_EXCEEDS_BALANCE", `${doc.displayName} is owed ${fmt(Decimal.max(0, owed))}; the payout of ${fmt(gross)} is more than that`, 409, { owed: fmt(Decimal.max(0, owed)) });
      const pct = new Decimal(input.tdsPercent ?? (await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "DOCTOR_PAYOUT_TDS_PERCENT")));
      const tds = gross.times(pct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const payoutNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "DOCTOR_PAYOUT");
      const row = await tx.doctorPayout.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId: doc.id, payoutNumber, kind: "PAYMENT", grossAmount: gross.toFixed(2), tdsPercent: pct.toFixed(2), tdsAmount: tds.toFixed(2), netAmount: gross.minus(tds).toFixed(2),
          method: input.method, reference: input.reference ?? null, note: input.note ?? null, createdById: ctx.userId,
        },
        select: { id: true },
      });
      await this.audit.record(tx, actorOf(ctx), {
        action: "DOCTOR_PAYOUT_PAID", entityType: "DoctorPayout", entityId: row.id,
        metadata: { payoutNumber, practitionerId: doc.id, gross: fmt(gross), tdsPercent: pct.toFixed(2), tds: fmt(tds), net: fmt(gross.minus(tds)), method: input.method, owedAfter: fmt(owed.minus(gross)) },
      });
      return (await this.views(tx, ctx, { id: row.id })).items[0]!;
    });
  }

  /** Undoes a voucher made in error with a mirror voucher; what the doctor is owed goes back up by the gross amount. */
  async reverse(ctx: RequestContext, payoutId: string, input: z.infer<typeof reversePayoutSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required to reverse a payout", 400);
    return this.idempotency.run(ctx.tenantId, `DOCTOR_PAYOUT_REVERSE:${payoutId}`, key, input, async (tx) => {
      const o = await tx.doctorPayout.findFirst({ where: { id: payoutId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { reversedBy: { select: { id: true } } } });
      if (!o) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (o.kind !== "PAYMENT") throw new DomainError("INVALID_STATE", "A reversal cannot itself be reversed", 409);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payout:${o.practitionerId}`}, 0))`;
      if (o.reversedBy) throw new DomainError("INVALID_STATE", "This payout was already reversed", 409);
      const payoutNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "DOCTOR_PAYOUT");
      const row = await tx.doctorPayout.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId: o.practitionerId, payoutNumber, kind: "REVERSAL", reversesId: o.id,
          grossAmount: D(o.grossAmount).negated().toFixed(2), tdsPercent: D(o.tdsPercent).toFixed(2), tdsAmount: D(o.tdsAmount).negated().toFixed(2), netAmount: D(o.netAmount).negated().toFixed(2),
          method: o.method, reference: o.reference, note: input.reason, createdById: ctx.userId,
        },
        select: { id: true },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "DOCTOR_PAYOUT_REVERSED", entityType: "DoctorPayout", entityId: row.id, metadata: { payoutNumber, reverses: o.payoutNumber, gross: fmt(D(o.grossAmount)), reason: input.reason } });
      return (await this.views(tx, ctx, { id: row.id })).items[0]!;
    });
  }

  async list(ctx: RequestContext, q: z.infer<typeof payoutListSchema>) {
    return this.views(this.prisma, ctx, { practitionerId: q.practitionerId, page: q.page, pageSize: q.pageSize });
  }

  async get(ctx: RequestContext, payoutId: string) {
    const v = (await this.views(this.prisma, ctx, { id: payoutId })).items[0];
    if (!v) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return v;
  }

  private async views(db: Db | PrismaService, ctx: RequestContext, f: { id?: string; practitionerId?: string | undefined; page?: number; pageSize?: number }) {
    const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(f.id ? { id: f.id } : {}), ...(f.practitionerId ? { practitionerId: f.practitionerId } : {}) };
    const page = f.page ?? 1, pageSize = f.pageSize ?? 25;
    const [rows, total] = await Promise.all([
      db.doctorPayout.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize, select: VIEW }),
      db.doctorPayout.count({ where }),
    ]);
    const users = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return {
      total, page, pageSize,
      items: rows.map((r) => ({
        id: r.id, payoutNumber: r.payoutNumber, kind: r.kind, doctor: r.practitioner.displayName, practitionerId: r.practitioner.id, gross: fmt(r.grossAmount), tdsPercent: D(r.tdsPercent).toFixed(2), tds: fmt(r.tdsAmount), net: fmt(r.netAmount),
        method: r.method, reference: r.reference, note: r.note, paidAt: r.paidAt, by: users.get(r.createdById) ?? null,
        reversedBy: r.reversedBy?.payoutNumber ?? null, reverses: r.reverses?.payoutNumber ?? null,
      })),
    };
  }

  /**
   * One doctor's account for a date range (the facility's days): what was owed at the start, each ledger line earned, each voucher paid, and what is owed at the end.
   * Amounts are the doctor's share before tax deducted at source; the voucher lines also show the tax and what was received.
   */
  async statement(ctx: RequestContext, practitionerId: string, q: { from?: string | undefined; to?: string | undefined }) {
    const doc = await this.prisma.practitioner.findFirst({ where: { id: practitionerId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, displayName: true, registrationNo: true } });
    if (!doc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const tz = (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
    const today = localDateStr(new Date(), tz);
    const to = q.to ?? today;
    const from = q.from ?? `${to.slice(0, 8)}01`;
    if (to < from) throw new DomainError("VALIDATION_FAILED", "The end date is before the start date", 400);
    if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > MAX_DAYS) throw new DomainError("VALIDATION_FAILED", `Choose at most ${MAX_DAYS} days`, 400);
    const start = startOfLocalDay(from, tz), end = endOfLocalDay(to, tz);
    const range = { gte: start, lt: end };
    const [opening, lines, vouchers] = await Promise.all([
      this.earnedAndPaid(this.prisma, ctx, doc.id, start),
      this.prisma.doctorShareEntry.findMany({
        where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId: doc.id, createdAt: range, doctorDelta: { not: 0 } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 2000,
        select: { id: true, createdAt: true, trigger: true, doctorDelta: true, encounter: { select: { encounterNumber: true } }, invoice: { select: { invoiceNumber: true } } },
      }),
      this.prisma.doctorPayout.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId: doc.id, createdAt: range }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 500, select: { id: true, payoutNumber: true, kind: true, createdAt: true, grossAmount: true, tdsAmount: true, netAmount: true, method: true } }),
    ]);
    const earned = lines.reduce((n, l) => n.plus(l.doctorDelta.toString()), new Decimal(0));
    const gross = vouchers.reduce((n, v) => n.plus(v.grossAmount.toString()), new Decimal(0));
    const tds = vouchers.reduce((n, v) => n.plus(v.tdsAmount.toString()), new Decimal(0));
    const net = vouchers.reduce((n, v) => n.plus(v.netAmount.toString()), new Decimal(0));
    const openingOwed = opening.earned.minus(opening.paid);
    const entries = [
      ...lines.map((l) => ({ at: l.createdAt, type: l.trigger === "PAYMENT" ? "EARNED" : "EARNED_REDUCED", reference: `${l.encounter.encounterNumber}${l.invoice.invoiceNumber ? ` · ${l.invoice.invoiceNumber}` : ""}`, amount: fmt(l.doctorDelta), tds: null as string | null, net: null as string | null })),
      ...vouchers.map((v) => ({ at: v.createdAt, type: v.kind === "PAYMENT" ? "PAID" : "PAYOUT_REVERSED", reference: v.payoutNumber, amount: fmt(D(v.grossAmount).negated()), tds: fmt(v.tdsAmount), net: fmt(v.netAmount) })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    return {
      doctor: doc.displayName, registrationNo: doc.registrationNo, practitionerId: doc.id, from, to,
      opening: fmt(openingOwed), earned: fmt(earned), paid: fmt(gross), tdsDeducted: fmt(tds), netPaid: fmt(net), closing: fmt(openingOwed.plus(earned).minus(gross)),
      entries,
    };
  }

  /** The signed-in doctor's own statement (never another doctor's). */
  async myStatement(ctx: RequestContext, q: { from?: string | undefined; to?: string | undefined }) {
    const me = await this.prisma.practitioner.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId, status: "ACTIVE" }, select: { id: true } });
    if (!me) throw new DomainError("FORBIDDEN", "This statement is for doctors. Your login is not linked to a doctor record at this facility.", 403);
    return this.statement(ctx, me.id, q);
  }
}
