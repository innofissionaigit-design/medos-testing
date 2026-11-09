import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { dateOnly, localDateStr } from "../../common/time";

export type StockType = "PURCHASE" | "SALE" | "PATIENT_RETURN" | "PURCHASE_RETURN" | "ADJUSTMENT" | "DAMAGE" | "TRANSFER";
export type StockDir = "IN" | "OUT";

export interface Movement {
  batchId: string;
  medicineId: string;
  type: StockType;
  direction: StockDir;
  quantity: number;
  sourceType?: string;
  sourceId?: string;
  reason?: string;
}

export interface Allocation {
  batchId: string;
  batchNo: string;
  expiryDate: Date;
  quantity: number;
  sellingPrice: string;
  mrp: string;
}

/**
 * The only writer of stock. Inventory truth is the append-only StockLedger; StockBalance is its materialised sum,
 * updated in the same transaction under a row lock and reconciled to the ledger by the database at commit.
 */
@Injectable()
export class StockService {
  async today(db: Db, ctx: RequestContext): Promise<Date> {
    const f = await db.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    return dateOnly(localDateStr(new Date(), f.timezone));
  }

  /** Creates the zero balance row for a new batch. */
  async openBalance(db: Db, ctx: RequestContext, batchId: string, medicineId: string): Promise<void> {
    await db.stockBalance.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, batchId, medicineId, quantity: 0 } });
  }

  /** Posts one movement: lock balance, check, update balance, append ledger. Returns the balance after the movement. */
  async move(db: Db, ctx: RequestContext, m: Movement): Promise<number> {
    if (!Number.isInteger(m.quantity) || m.quantity <= 0) throw new DomainError("INVALID_AMOUNT", "Quantity must be a positive whole number", 400);
    const rows = await db.$queryRaw<{ quantity: number }[]>`
      SELECT quantity FROM "StockBalance"
      WHERE "batchId" = ${m.batchId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid
      FOR UPDATE`;
    const current = rows[0]?.quantity;
    if (current === undefined) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const next = m.direction === "IN" ? current + m.quantity : current - m.quantity;
    if (next < 0) {
      throw new DomainError("INSUFFICIENT_STOCK", `Only ${current} unit${current === 1 ? "" : "s"} available in this batch`, 409, { available: current, requested: m.quantity });
    }
    await db.stockBalance.updateMany({ where: { batchId: m.batchId, tenantId: ctx.tenantId }, data: { quantity: next } });
    await db.stockLedger.create({
      data: {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, medicineId: m.medicineId, batchId: m.batchId, type: m.type, direction: m.direction,
        quantity: m.quantity, balanceAfter: next, sourceType: m.sourceType ?? null, sourceId: m.sourceId ?? null, reason: m.reason ?? null, userId: ctx.userId,
      },
    });
    return next;
  }

  /**
   * First-Expiry-First-Out allocation across sellable batches (active, unexpired, in stock). Candidate balance rows are
   * locked in a fixed global order (expiry, batch id) so concurrent dispenses can neither deadlock nor oversell.
   */
  async allocateFefo(db: Db, ctx: RequestContext, medicineId: string, quantity: number, opts: { lock: boolean }): Promise<Allocation[]> {
    const today = await this.today(db, ctx);
    const lock = opts.lock ? "FOR UPDATE OF s" : "";
    const rows = await db.$queryRawUnsafe<{ id: string; batchNo: string; expiryDate: Date; sellingPrice: string; mrp: string; quantity: number }[]>(
      `SELECT b.id, b."batchNo", b."expiryDate", b."sellingPrice"::text AS "sellingPrice", b.mrp::text AS mrp, s.quantity
       FROM "MedicineBatch" b JOIN "StockBalance" s ON s."batchId" = b.id
       WHERE b."tenantId" = $1::uuid AND b."facilityId" = $2::uuid AND b."medicineId" = $3::uuid
         AND b.status = 'ACTIVE' AND b."expiryDate" >= $4::date AND s.quantity > 0
       ORDER BY b."expiryDate" ASC, b.id ASC ${lock}`,
      ctx.tenantId, ctx.facilityId, medicineId, today,
    );
    const out: Allocation[] = [];
    let remaining = quantity;
    for (const r of rows) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, r.quantity);
      out.push({ batchId: r.id, batchNo: r.batchNo, expiryDate: r.expiryDate, quantity: take, sellingPrice: r.sellingPrice, mrp: r.mrp });
      remaining -= take;
    }
    if (remaining > 0) {
      const available = quantity - remaining;
      throw new DomainError("INSUFFICIENT_STOCK", `Only ${available} unit${available === 1 ? "" : "s"} of unexpired stock available`, 409, { available, requested: quantity });
    }
    return out;
  }
}
