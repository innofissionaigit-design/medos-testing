import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt } from "./billing.domain";
import { amount } from "./money.schema";

export const openShiftSchema = z.object({ openingCash: amount() }).strict();
export const closeShiftSchema = z.object({ actualCash: amount(), notes: z.string().trim().max(500).optional() }).strict();
export const listShiftsSchema = z.object({
  status: z.enum(["OPEN", "CLOSED"]).optional(), cashierId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"] as const;

@Injectable()
export class ShiftsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async open(ctx: RequestContext, input: z.infer<typeof openShiftSchema>) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const s = await tx.cashierShift.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, cashierId: ctx.userId, openingCash: input.openingCash.toFixed(2) } });
        await this.audit.record(tx, actorOf(ctx), { action: "SHIFT_OPENED", entityType: "CashierShift", entityId: s.id, metadata: { openingCash: fmt(s.openingCash) } });
        return this.summary(tx, ctx, s.id);
      });
    } catch (e) {
      if (e instanceof Error && /Unique constraint|CashierShift_one_open/i.test(e.message)) throw new DomainError("CONFLICT", "You already have an open shift. Close it first.", 409);
      throw e;
    }
  }

  async current(ctx: RequestContext) {
    const s = await this.prisma.cashierShift.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, cashierId: ctx.userId, status: "OPEN" }, select: { id: true } });
    return s ? this.summary(this.prisma, ctx, s.id) : null;
  }

  /** Closes the caller's shift. Expected cash = opening + cash receipts - cash refunds, computed from the ledger. */
  async close(ctx: RequestContext, id: string, input: z.infer<typeof closeShiftSchema>) {
    return this.prisma.$transaction(async (tx) => {
      // Exclusive lock: waits for in-flight payments (which hold a share lock) and blocks new ones until commit.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "CashierShift" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const shift = await tx.cashierShift.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
      if (shift.cashierId !== ctx.userId) throw new DomainError("FORBIDDEN", "Only the cashier who opened a shift can close it", 403);
      if (shift.status !== "OPEN") throw new DomainError("INVALID_STATE", "This shift is already closed", 409);
      const totals = await this.cashTotals(tx, ctx, id);
      const expected = new Decimal(shift.openingCash.toString()).plus(totals.cashIn).minus(totals.cashOut);
      const difference = input.actualCash.minus(expected);
      if (!difference.isZero() && (input.notes ?? "").length < 5) {
        throw new DomainError("VALIDATION_FAILED", `The counted cash differs from the expected ${fmt(expected)} by ${fmt(difference)}. Explain the difference in the notes.`, 400, [{ path: "notes", message: "Required when cash does not reconcile" }]);
      }
      await tx.cashierShift.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: { status: "CLOSED", closedAt: new Date(), expectedCash: expected.toFixed(2), actualCash: input.actualCash.toFixed(2), difference: difference.toFixed(2), closeNotes: input.notes ?? null },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "SHIFT_CLOSED", entityType: "CashierShift", entityId: id, metadata: { expectedCash: fmt(expected), actualCash: fmt(input.actualCash), difference: fmt(difference) } });
      return this.summary(tx, ctx, id);
    });
  }

  async get(ctx: RequestContext, id: string) {
    const s = await this.prisma.cashierShift.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { cashierId: true } });
    if (!s) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (s.cashierId !== ctx.userId && !ctx.permissions.has("REPORT_READ")) throw new DomainError("FORBIDDEN", "You can only view your own shifts", 403);
    return this.summary(this.prisma, ctx, id);
  }

  async list(ctx: RequestContext, q: z.infer<typeof listShiftsSchema>) {
    const canSeeAll = ctx.permissions.has("REPORT_READ");
    const where: Prisma.CashierShiftWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId,
      ...(canSeeAll ? (q.cashierId ? { cashierId: q.cashierId } : {}) : { cashierId: ctx.userId }),
      ...(q.status ? { status: q.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.cashierShift.findMany({ where, orderBy: { openedAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
      this.prisma.cashierShift.count({ where }),
    ]);
    return { items: await Promise.all(rows.map((r) => this.summary(this.prisma, ctx, r.id))), total };
  }

  // ───── internals ─────

  private async cashTotals(db: Db, ctx: RequestContext, shiftId: string) {
    // Advances count when they are taken or given back (cash in the drawer), not when they are used up against an invoice.
    const [inn, advIn, out, advOut] = await Promise.all([
      db.payment.aggregate({ where: { tenantId: ctx.tenantId, method: "CASH", advanceUseId: null, receipt: { shiftId } }, _sum: { amount: true } }),
      db.advanceTender.aggregate({ where: { tenantId: ctx.tenantId, method: "CASH", deposit: { shiftId } }, _sum: { amount: true } }),
      db.refund.aggregate({ where: { tenantId: ctx.tenantId, method: "CASH", shiftId }, _sum: { amount: true } }),
      db.advanceRefund.aggregate({ where: { tenantId: ctx.tenantId, method: "CASH", shiftId }, _sum: { amount: true } }),
    ]);
    const d = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? 0);
    return { cashIn: d(inn._sum.amount).plus(d(advIn._sum.amount)), cashOut: d(out._sum.amount).plus(d(advOut._sum.amount)) };
  }

  async summary(db: Db, ctx: RequestContext, id: string) {
    const s = await db.cashierShift.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
    const [paidPay, paidAdv, refundedInv, refundedAdv, receiptCount, depositCount, cashier] = await Promise.all([
      db.payment.groupBy({ by: ["method"], where: { tenantId: ctx.tenantId, advanceUseId: null, receipt: { shiftId: id } }, _sum: { amount: true } }),
      db.advanceTender.groupBy({ by: ["method"], where: { tenantId: ctx.tenantId, deposit: { shiftId: id } }, _sum: { amount: true } }),
      db.refund.groupBy({ by: ["method"], where: { tenantId: ctx.tenantId, shiftId: id }, _sum: { amount: true } }),
      db.advanceRefund.groupBy({ by: ["method"], where: { tenantId: ctx.tenantId, shiftId: id }, _sum: { amount: true } }),
      db.receipt.count({ where: { tenantId: ctx.tenantId, shiftId: id } }),
      db.advanceDeposit.count({ where: { tenantId: ctx.tenantId, shiftId: id } }),
      db.user.findFirst({ where: { id: s.cashierId, tenantId: ctx.tenantId }, select: { fullName: true } }),
    ]);
    // Advances taken and given back are money in and out of the drawer; advances used up against an invoice are not counted again.
    const add = (a: { method: string; _sum: { amount: Prisma.Decimal | null } }[], b: { method: string; _sum: { amount: Prisma.Decimal | null } }[]) =>
      METHODS.map((m) => ({ method: m as string, _sum: { amount: new Decimal(a.find((r) => r.method === m)?._sum.amount?.toString() ?? 0).plus(b.find((r) => r.method === m)?._sum.amount?.toString() ?? 0).toFixed(2) as unknown as Prisma.Decimal } }));
    const paid = add(paidPay, paidAdv);
    const refunded = add(refundedInv, refundedAdv);
    const sum = (rows: { method: string; _sum: { amount: Prisma.Decimal | null } }[], m: string) => new Decimal(rows.find((r) => r.method === m)?._sum.amount?.toString() ?? 0);
    const { cashIn, cashOut } = await this.cashTotals(db, ctx, id);
    const liveExpected = new Decimal(s.openingCash.toString()).plus(cashIn).minus(cashOut);
    return {
      id: s.id, status: s.status, cashierId: s.cashierId, cashierName: cashier?.fullName ?? null, openedAt: s.openedAt, closedAt: s.closedAt,
      openingCash: fmt(s.openingCash), expectedCash: fmt(s.expectedCash ?? liveExpected), actualCash: s.actualCash ? fmt(s.actualCash) : null, difference: s.difference ? fmt(s.difference) : null, closeNotes: s.closeNotes,
      receiptCount: receiptCount + depositCount,
      collectionsByMethod: Object.fromEntries(METHODS.map((m) => [m, fmt(sum(paid, m))])),
      refundsByMethod: Object.fromEntries(METHODS.map((m) => [m, fmt(sum(refunded, m))])),
      netCollections: fmt(METHODS.reduce((a, m) => a.plus(sum(paid, m)).minus(sum(refunded, m)), new Decimal(0))),
    };
  }
}
