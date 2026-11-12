import { Injectable } from "@nestjs/common";
import { Decimal } from "@medos/shared";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { CostLedgerService, movementLines, type LedgerWho } from "./cost-ledger.service";

const CHUNK = 400;
export type BackfillKind = "RECEIPT" | "PURCHASE_RETURN" | "DEBIT_NOTE_CREDITED" | "SUPPLIER_PAYMENT" | "SUPPLIER_PAYMENT_RUN" | "CONSUMPTION" | "STOCK_MOVE" | "LOC_MOVE";
const KINDS: BackfillKind[] = ["RECEIPT", "PURCHASE_RETURN", "DEBIT_NOTE_CREDITED", "SUPPLIER_PAYMENT", "SUPPLIER_PAYMENT_RUN", "CONSUMPTION", "STOCK_MOVE", "LOC_MOVE"];
const money = (v: string | number | null | undefined) => new Decimal(v ?? 0).toDecimalPlaces(2);

/**
 * Posts to the cost ledger the events that happened before it existed, from their own records, with the same entries and the same keys as live posting, so an event is never
 * posted twice (running it again does nothing). It works in chunks: call it again until `done`. The entries are dated when the event happened.
 */
@Injectable()
export class CostLedgerBackfillService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly ledger: CostLedgerService) {}

  private unposted(tx: Db | PrismaService, ctx: RequestContext, kind: BackfillKind, limit: number) {
    const t = ctx.tenantId, f = ctx.facilityId;
    switch (kind) {
      case "RECEIPT": return tx.$queryRaw<Record<string, unknown>[]>`SELECT p.id::text AS id, p."receivedAt" AS at, p."purchaseNumber" AS ref, p.subtotal::text AS a, p."taxTotal"::text AS b FROM "Purchase" p WHERE p."tenantId" = ${t}::uuid AND p."facilityId" = ${f}::uuid AND (p.subtotal + p."taxTotal") > 0 AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."tenantId" = p."tenantId" AND e."sourceKey" = 'RECEIPT:' || p.id::text) ORDER BY p."receivedAt", p.id LIMIT ${limit}`;
      case "PURCHASE_RETURN": return tx.$queryRaw<Record<string, unknown>[]>`SELECT r.id::text AS id, r."createdAt" AS at, r."returnNumber" AS ref, r.total::text AS a, COALESCE((SELECT SUM(ROUND(pi."purchasePrice" * ri.quantity, 2)) FROM "PurchaseReturnItem" ri JOIN "PurchaseItem" pi ON pi.id = ri."purchaseItemId" AND pi."tenantId" = ri."tenantId" WHERE ri."returnId" = r.id AND ri."tenantId" = r."tenantId"), 0)::text AS b FROM "PurchaseReturn" r WHERE r."tenantId" = ${t}::uuid AND r."facilityId" = ${f}::uuid AND r.total > 0 AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."tenantId" = r."tenantId" AND e."sourceKey" = 'PURCHASE_RETURN:' || r.id::text) ORDER BY r."createdAt", r.id LIMIT ${limit}`;
      case "DEBIT_NOTE_CREDITED": return tx.$queryRaw<Record<string, unknown>[]>`SELECT d.id::text AS id, d."creditedAt" AS at, d."noteNumber" AS ref, d.amount::text AS a FROM "SupplierDebitNote" d WHERE d."tenantId" = ${t}::uuid AND d."facilityId" = ${f}::uuid AND d.status = 'CREDITED' AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."tenantId" = d."tenantId" AND e."sourceKey" = 'DEBIT_NOTE_CREDITED:' || d.id::text) ORDER BY d."creditedAt", d.id LIMIT ${limit}`;
      case "SUPPLIER_PAYMENT": return tx.$queryRaw<Record<string, unknown>[]>`SELECT x.id::text AS id, x."paidOn"::timestamptz AS at, p."purchaseNumber" AS ref, x.amount::text AS a, x.method::text AS m FROM "SupplierPayment" x JOIN "Purchase" p ON p.id = x."purchaseId" AND p."tenantId" = x."tenantId" WHERE x."tenantId" = ${t}::uuid AND x."facilityId" = ${f}::uuid AND x."runId" IS NULL AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."tenantId" = x."tenantId" AND e."sourceKey" = 'SUPPLIER_PAYMENT:' || x.id::text) ORDER BY x."paidOn", x.id LIMIT ${limit}`;
      case "SUPPLIER_PAYMENT_RUN": return tx.$queryRaw<Record<string, unknown>[]>`SELECT r.id::text AS id, r."paidOn"::timestamptz AS at, s.name AS ref, r.total::text AS a, r.method::text AS m FROM "SupplierPaymentRun" r JOIN "Supplier" s ON s.id = r."supplierId" AND s."tenantId" = r."tenantId" WHERE r."tenantId" = ${t}::uuid AND r."facilityId" = ${f}::uuid AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."tenantId" = r."tenantId" AND e."sourceKey" = 'SUPPLIER_PAYMENT_RUN:' || r.id::text) ORDER BY r."paidOn", r.id LIMIT ${limit}`;
      case "CONSUMPTION": return tx.$queryRaw<Record<string, unknown>[]>`SELECT c.id::text AS id, c."createdAt" AS at, l.name AS ref, c."totalCost"::text AS a, c.quantity AS q FROM "StockConsumption" c JOIN "StockLocation" l ON l.id = c."locationId" AND l."tenantId" = c."tenantId" WHERE c."tenantId" = ${t}::uuid AND c."facilityId" = ${f}::uuid AND c."totalCost" > 0 AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."tenantId" = c."tenantId" AND e."sourceKey" = 'CONSUMPTION:' || c.id::text) ORDER BY c."createdAt", c.id LIMIT ${limit}`;
      case "STOCK_MOVE": return tx.$queryRaw<Record<string, unknown>[]>`SELECT s.id::text AS id, s."createdAt" AS at, s.type::text AS m, s.direction::text AS d, s.quantity AS q, s.reason AS ref, b."purchasePrice"::text AS a FROM "StockLedger" s JOIN "MedicineBatch" b ON b.id = s."batchId" AND b."tenantId" = s."tenantId" WHERE s."tenantId" = ${t}::uuid AND s."facilityId" = ${f}::uuid AND s.type IN ('SALE', 'PATIENT_RETURN', 'ADJUSTMENT', 'DAMAGE') AND b."purchasePrice" > 0 AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."tenantId" = s."tenantId" AND e."sourceKey" = 'STOCK_MOVE:' || s.id::text) ORDER BY s."createdAt", s.id LIMIT ${limit}`;
      case "LOC_MOVE": return tx.$queryRaw<Record<string, unknown>[]>`SELECT s.id::text AS id, s."createdAt" AS at, s.direction::text AS d, s.quantity AS q, l.name AS ref, (s."issueId" IS NOT NULL) AS issue, b."purchasePrice"::text AS a FROM "StockLocationLedger" s JOIN "StockLocation" l ON l.id = s."locationId" AND l."tenantId" = s."tenantId" JOIN "MedicineBatch" b ON b.id = s."batchId" AND b."tenantId" = s."tenantId" WHERE s."tenantId" = ${t}::uuid AND s."facilityId" = ${f}::uuid AND (s."issueId" IS NOT NULL OR s."countId" IS NOT NULL) AND b."purchasePrice" > 0 AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."tenantId" = s."tenantId" AND e."sourceKey" = 'LOC_MOVE:' || s.id::text) ORDER BY s."createdAt", s.id LIMIT ${limit}`;
    }
  }

  /** How many events of each kind are not yet in the ledger. */
  async pending(ctx: RequestContext): Promise<Record<BackfillKind, number>> {
    const out = {} as Record<BackfillKind, number>;
    for (const k of KINDS) out[k] = (await this.unposted(this.prisma, ctx, k, 100_000)).length;
    return out;
  }

  async run(ctx: RequestContext) {
    const who: LedgerWho = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId };
    const posted = {} as Record<BackfillKind, number>;
    for (const k of KINDS) posted[k] = 0;
    let budget = CHUNK;
    await this.prisma.$transaction(async (tx) => {
      for (const kind of KINDS) {
        if (budget <= 0) break;
        const rows = await this.unposted(tx, ctx, kind, budget);
        for (const r of rows) {
          const id = String(r["id"]), at = new Date(String(r["at"])), ref = String(r["ref"] ?? "");
          const post = (sourceType: string, narration: string, lines: Parameters<CostLedgerService["post"]>[2]["lines"]) => this.ledger.post(tx, who, { sourceKey: `${kind}:${id}`, sourceType, sourceId: id, date: at, narration, lines });
          if (kind === "RECEIPT") { const sub = money(r["a"] as string), tax = money(r["b"] as string); await post("Purchase", `Goods received ${ref}`, [{ account: "INVENTORY", costCentre: "Main store", debit: sub }, { account: "GST_INPUT", debit: tax }, { account: "SUPPLIER_PAYABLE", credit: sub.plus(tax) }]); }
          else if (kind === "PURCHASE_RETURN") { const total = money(r["a"] as string), net = money(r["b"] as string); await post("PurchaseReturn", `Goods returned to the supplier ${ref}`, [{ account: "SUPPLIER_PAYABLE", debit: total }, { account: "INVENTORY", costCentre: "Main store", credit: net }, { account: "GST_INPUT", credit: total.minus(net) }]); }
          else if (kind === "DEBIT_NOTE_CREDITED") { const a = money(r["a"] as string); await post("SupplierDebitNote", `Supplier credited ${ref}`, [{ account: "SUPPLIER_PAYABLE", debit: a }, { account: "PURCHASE_RETURNS", credit: a }]); }
          else if (kind === "SUPPLIER_PAYMENT") { const a = money(r["a"] as string); await post("SupplierPayment", `Paid a supplier against ${ref}`, [{ account: "SUPPLIER_PAYABLE", debit: a }, { account: r["m"] === "CASH" ? "CASH" : "BANK", credit: a }]); }
          else if (kind === "SUPPLIER_PAYMENT_RUN") { const a = money(r["a"] as string); await post("SupplierPaymentRun", `Paid ${ref} for several invoices`, [{ account: "SUPPLIER_PAYABLE", debit: a }, { account: r["m"] === "CASH" ? "CASH" : "BANK", credit: a }]); }
          else if (kind === "CONSUMPTION") { const a = money(r["a"] as string); await post("StockConsumption", `Stock used (${ref})`, [{ account: "CONSUMPTION_EXPENSE", costCentre: ref, debit: a }, { account: "INVENTORY", costCentre: ref, credit: a }]); }
          else if (kind === "STOCK_MOVE") {
            const type = String(r["m"]), dir = String(r["d"]) as "IN" | "OUT", cost = money(r["a"] as string).times(Number(r["q"])).toDecimalPlaces(2), sold = type === "SALE" || type === "PATIENT_RETURN";
            await post("StockLedger", sold ? (type === "SALE" ? "Medicines sold" : "Medicines returned by a patient") : `Stock ${type === "DAMAGE" ? "written off" : dir === "OUT" ? "adjusted down" : "adjusted up"}${ref ? `: ${ref}` : ""}`, movementLines(sold ? "SOLD" : "ADJUSTED", dir, cost, sold ? "Pharmacy sales" : "Main store", "Main store"));
          } else {
            const dir = String(r["d"]) as "IN" | "OUT", cost = money(r["a"] as string).times(Number(r["q"])).toDecimalPlaces(2), issue = r["issue"] === true;
            await post("StockLocationLedger", issue ? `Medicines issued to a patient from ${ref}` : `Stock count difference in ${ref}`, movementLines(issue ? "SOLD" : "ADJUSTED", dir, cost, ref, ref));
          }
          posted[kind] += 1; budget -= 1;
        }
      }
      const total = Object.values(posted).reduce((a, b) => a + b, 0);
      await this.audit.record(tx, actorOf(ctx), { action: "COST_LEDGER_BACKFILLED", entityType: "JournalEntry", entityId: null, metadata: { entries: total, ...posted } });
    }, { timeout: 60_000 });
    const left = await this.pending(ctx);
    const remaining = Object.values(left).reduce((a, b) => a + b, 0);
    return { posted, remaining, done: remaining === 0 };
  }
}
