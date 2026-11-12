import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { JournalAccount } from "@medos/database";
import { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { dateOnly } from "../../common/time";
import { fmt } from "../billing/billing.domain";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the form YYYY-MM-DD");
export const ledgerRangeSchema = z.object({ from: isoDay.optional(), to: isoDay.optional() }).strict();
export const ledgerEntriesSchema = z.object({
  from: isoDay.optional(), to: isoDay.optional(), account: z.enum(["INVENTORY", "GST_INPUT", "SUPPLIER_PAYABLE", "CONSUMPTION_EXPENSE", "PURCHASE_RETURNS", "CASH", "BANK", "COST_OF_GOODS_SOLD", "STOCK_ADJUSTMENT"]).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export interface LedgerLine { account: JournalAccount; costCentre?: string | null; debit?: Decimal.Value; credit?: Decimal.Value }
export interface LedgerPost { sourceKey: string; sourceType: string; sourceId: string; date: Date; narration: string; lines: LedgerLine[] }
export interface LedgerWho { tenantId: string; facilityId: string; userId: string }

const ACCOUNT_NAMES: Record<string, string> = {
  INVENTORY: "Stock held", GST_INPUT: "GST paid to suppliers", SUPPLIER_PAYABLE: "Owed to suppliers", CONSUMPTION_EXPENSE: "Cost of stock used",
  PURCHASE_RETURNS: "Goods returned or credited by suppliers", CASH: "Cash paid", BANK: "Bank, UPI and card paid",
  COST_OF_GOODS_SOLD: "Cost of medicines sold or issued to wards", STOCK_ADJUSTMENT: "Stock gained or lost (opening stock, damage, counts)",
};

/** A stock movement that is not a purchase or a transfer, as ledger lines: medicines sold or issued (cost of goods sold) or stock adjusted. Out of stock is a debit of the expense and a credit of stock; in is the reverse. */
export function movementLines(kind: "SOLD" | "ADJUSTED", direction: "IN" | "OUT", cost: Decimal.Value, expenseCentre: string, stockCentre: string): LedgerLine[] {
  const expense = kind === "SOLD" ? "COST_OF_GOODS_SOLD" : "STOCK_ADJUSTMENT";
  return direction === "OUT"
    ? [{ account: expense, costCentre: expenseCentre, debit: cost }, { account: "INVENTORY", costCentre: stockCentre, credit: cost }]
    : [{ account: "INVENTORY", costCentre: stockCentre, debit: cost }, { account: expense, costCentre: expenseCentre, credit: cost }];
}
const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * The cost ledger (docs/procurement.md). Every purchase, supplier return and credit, supplier payment and consumption of stock is posted as a balanced entry (debits equal credits,
 * checked by the database at commit), in the same transaction as the event, so the ledger can never disagree with the stock and payables records. It is a cost ledger, not a
 * general ledger: it has no revenue, no patient billing and no tax returns, and the cost of medicines sold to patients is not posted.
 */
@Injectable()
export class CostLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Posts one event. An event already posted (same source key) is left alone, so a retry never doubles it. Zero lines are dropped; an entry with nothing left is not made. */
  async post(tx: Db, who: LedgerWho, e: LedgerPost): Promise<void> {
    const lines = e.lines
      .map((l) => ({ ...l, debit: new Decimal(l.debit ?? 0).toDecimalPlaces(2), credit: new Decimal(l.credit ?? 0).toDecimalPlaces(2) }))
      .filter((l) => l.debit.gt(0) || l.credit.gt(0));
    if (lines.length === 0) return;
    const entry = await tx.journalEntry.upsert({
      where: { tenantId_sourceKey: { tenantId: who.tenantId, sourceKey: e.sourceKey } }, update: {},
      create: { tenantId: who.tenantId, facilityId: who.facilityId, sourceKey: e.sourceKey, sourceType: e.sourceType, sourceId: e.sourceId, entryDate: e.date, narration: e.narration.slice(0, 300), createdById: who.userId },
      select: { id: true, createdAt: true, lines: { select: { id: true }, take: 1 } },
    });
    if (entry.lines.length > 0) return;
    await tx.journalLine.createMany({ data: lines.map((l) => ({ tenantId: who.tenantId, entryId: entry.id, account: l.account, costCentre: l.costCentre ?? null, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2) })) });
  }

  /** The stock value the ledger should agree with: units held in the main store and in every location, at each batch's purchase price. */
  async reconciliation(ctx: RequestContext) {
    const [stock, ledger] = await Promise.all([
      this.prisma.$queryRaw<{ main: string; locations: string }[]>`
        SELECT COALESCE((SELECT SUM(s.quantity * b."purchasePrice") FROM "StockBalance" s JOIN "MedicineBatch" b ON b.id = s."batchId" AND b."tenantId" = s."tenantId" WHERE s."tenantId" = ${ctx.tenantId}::uuid AND s."facilityId" = ${ctx.facilityId}::uuid), 0)::text AS main,
               COALESCE((SELECT SUM(s.quantity * b."purchasePrice") FROM "StockLocationBalance" s JOIN "MedicineBatch" b ON b.id = s."batchId" AND b."tenantId" = s."tenantId" WHERE s."tenantId" = ${ctx.tenantId}::uuid AND s."facilityId" = ${ctx.facilityId}::uuid), 0)::text AS locations`,
      this.prisma.$queryRaw<{ net: string | null }[]>`
        SELECT SUM(l.debit - l.credit)::text AS net FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" AND e."tenantId" = l."tenantId"
        WHERE e."tenantId" = ${ctx.tenantId}::uuid AND e."facilityId" = ${ctx.facilityId}::uuid AND l.account = 'INVENTORY'`,
    ]);
    const held = new Decimal(stock[0]?.main ?? 0).plus(stock[0]?.locations ?? 0).toDecimalPlaces(2);
    const posted = new Decimal(ledger[0]?.net ?? 0).toDecimalPlaces(2);
    return { stockHeldAtCost: fmt(held), mainStore: fmt(new Decimal(stock[0]?.main ?? 0)), locations: fmt(new Decimal(stock[0]?.locations ?? 0)), ledgerStock: fmt(posted), difference: fmt(held.minus(posted)), reconciled: held.eq(posted) };
  }

  private range(q: z.infer<typeof ledgerRangeSchema>, today: string) {
    const to = q.to ?? today, from = q.from ?? addDays(to, -29);
    if (from > to) throw new DomainError("VALIDATION_FAILED", "The start date is after the end date", 400);
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw new DomainError("VALIDATION_FAILED", "Choose a period of at most a year", 400);
    return { from, to };
  }

  /** What each account holds over a period, and where the cost of stock used went. The two sides always agree. */
  async trialBalance(ctx: RequestContext, q: z.infer<typeof ledgerRangeSchema>) {
    const { from, to } = this.range(q, new Date().toISOString().slice(0, 10));
    const start = dateOnly(from), end = dateOnly(addDays(to, 1));
    const [accounts, centres, opening] = await Promise.all([
      this.prisma.$queryRaw<{ account: string; debit: string; credit: string }[]>`
        SELECT l.account::text AS account, SUM(l.debit)::text AS debit, SUM(l.credit)::text AS credit FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" AND e."tenantId" = l."tenantId"
        WHERE e."tenantId" = ${ctx.tenantId}::uuid AND e."facilityId" = ${ctx.facilityId}::uuid AND e."entryDate" >= ${start} AND e."entryDate" < ${end} GROUP BY l.account`,
      this.prisma.$queryRaw<{ centre: string; cost: string }[]>`
        SELECT COALESCE(l."costCentre", 'Unassigned') AS centre, SUM(l.debit - l.credit)::text AS cost FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" AND e."tenantId" = l."tenantId"
        WHERE e."tenantId" = ${ctx.tenantId}::uuid AND e."facilityId" = ${ctx.facilityId}::uuid AND e."entryDate" >= ${start} AND e."entryDate" < ${end} AND l.account = 'CONSUMPTION_EXPENSE'
        GROUP BY COALESCE(l."costCentre", 'Unassigned') HAVING SUM(l.debit - l.credit) <> 0 ORDER BY SUM(l.debit - l.credit) DESC`,
      this.prisma.$queryRaw<{ account: string; net: string }[]>`
        SELECT l.account::text AS account, SUM(l.debit - l.credit)::text AS net FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" AND e."tenantId" = l."tenantId"
        WHERE e."tenantId" = ${ctx.tenantId}::uuid AND e."facilityId" = ${ctx.facilityId}::uuid AND e."entryDate" < ${start} GROUP BY l.account`,
    ]);
    const open = new Map(opening.map((o) => [o.account, new Decimal(o.net)]));
    const rows = Object.keys(ACCOUNT_NAMES).map((account) => {
      const a = accounts.find((x) => x.account === account);
      const debit = new Decimal(a?.debit ?? 0), credit = new Decimal(a?.credit ?? 0), op = open.get(account) ?? new Decimal(0);
      return { account, name: ACCOUNT_NAMES[account]!, opening: fmt(op), debit: fmt(debit), credit: fmt(credit), closing: fmt(op.plus(debit).minus(credit)) };
    });
    const totalDebit = rows.reduce((s, r) => s.plus(r.debit), new Decimal(0)), totalCredit = rows.reduce((s, r) => s.plus(r.credit), new Decimal(0));
    return { from, to, accounts: rows, totalDebit: fmt(totalDebit), totalCredit: fmt(totalCredit), balanced: totalDebit.eq(totalCredit), consumptionByCostCentre: centres.map((c) => ({ costCentre: c.centre, cost: fmt(c.cost) })) };
  }

  async entries(ctx: RequestContext, q: z.infer<typeof ledgerEntriesSchema>) {
    const { from, to } = this.range(q, new Date().toISOString().slice(0, 10));
    const where = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, entryDate: { gte: dateOnly(from), lt: dateOnly(addDays(to, 1)) },
      ...(q.account ? { lines: { some: { account: q.account } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.journalEntry.findMany({ where, orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { lines: { orderBy: [{ debit: "desc" }, { id: "asc" }] } } }),
      this.prisma.journalEntry.count({ where }),
    ]);
    return {
      items: rows.map((e) => ({
        id: e.id, date: e.entryDate.toISOString().slice(0, 10), narration: e.narration, sourceType: e.sourceType, sourceId: e.sourceId,
        lines: e.lines.map((l) => ({ account: l.account, name: ACCOUNT_NAMES[l.account] ?? l.account, costCentre: l.costCentre, debit: fmt(l.debit.toString()), credit: fmt(l.credit.toString()) })),
      })),
      total, page: q.page, pageSize: q.pageSize,
    };
  }
}
