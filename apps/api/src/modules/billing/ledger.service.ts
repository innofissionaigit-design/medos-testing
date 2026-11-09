import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { AuditService, actorOf } from "../../common/audit.service";
import type { Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { NumberingService } from "../numbering/numbering.service";
import { SettingsService } from "../settings/settings.service";
import { ShareLedgerService } from "../earnings/share-ledger.service";
import { balanceDue, deriveStatus, fmt, netReceived, refundable, type LiveStatus } from "./billing.domain";

export type Method = "CASH" | "UPI" | "CARD" | "BANK_TRANSFER" | "OTHER";
export interface Tender { method: Method; amount: Decimal; reference?: string | null; /** Set only by the advance-payments code: this tender is an advance being used up. */ advanceUseId?: string }

export interface InvoiceMoney { id: string; status: string; total: Decimal; paidTotal: Decimal; refundedTotal: Decimal; creditedTotal: Decimal; version: number }

/**
 * The only code that moves money. Every operation assumes the caller holds the invoice row lock (lock()) inside
 * a transaction, so concurrent payments/refunds/credits on one invoice are fully serialised.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly audit: AuditService, private readonly numbering: NumberingService, private readonly settings: SettingsService, private readonly shares: ShareLedgerService) {}

  /** Locks the invoice row for the transaction and returns it. Tenant and facility scoped (no cross-tenant access). */
  async lock(tx: Db, ctx: RequestContext, invoiceId: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Invoice" WHERE id = ${invoiceId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.invoice.findFirstOrThrow({ where: { id: invoiceId, tenantId: ctx.tenantId } });
  }

  /** The caller's open shift (share-locked so a concurrent close waits for this transaction), or null. */
  async openShift(tx: Db, ctx: RequestContext): Promise<string | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CashierShift"
      WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND "cashierId" = ${ctx.userId}::uuid AND status = 'OPEN'
      FOR SHARE`;
    return rows[0]?.id ?? null;
  }

  /**
   * The shift that cash goes through. If the person has none open, one is opened for them right here (with no opening cash) so taking cash is never blocked;
   * the hospital can turn that off to insist on opening the shift first. Safe when two payments arrive at once: only one shift can be open per person.
   */
  async shiftForCash(tx: Db, ctx: RequestContext, verb: "taking" | "refunding"): Promise<string> {
    const open = await this.openShift(tx, ctx);
    if (open) return open;
    if (!(await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "CASH_AUTO_OPEN_SHIFT"))) throw new DomainError("SHIFT_NOT_OPEN", `Open your cashier shift before ${verb} cash`, 409);
    const made = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "CashierShift" ("tenantId", "facilityId", "cashierId", "openingCash") VALUES (${ctx.tenantId}::uuid, ${ctx.facilityId}::uuid, ${ctx.userId}::uuid, 0)
      ON CONFLICT DO NOTHING RETURNING id`;
    const id = made[0]?.id ?? (await this.openShift(tx, ctx));
    if (!id) throw new DomainError("SHIFT_NOT_OPEN", `Open your cashier shift before ${verb} cash`, 409);
    if (made[0]) await this.audit.record(tx, actorOf(ctx), { action: "SHIFT_OPENED", entityType: "CashierShift", entityId: id, metadata: { openingCash: "0.00", automatic: true } });
    return id;
  }

  async receive(tx: Db, ctx: RequestContext, inv: InvoiceMoney, tenders: Tender[]) {
    if (!["ISSUED", "PARTIALLY_PAID", "PAID"].includes(inv.status)) {
      throw new DomainError("INVALID_STATE", `Payments cannot be taken on a ${inv.status.toLowerCase().replace(/_/g, " ")} invoice`, 409);
    }
    const sum = tenders.reduce((a, t) => a.plus(t.amount), new Decimal(0));
    const due = balanceDue(inv);
    if (due.lte(0)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", "This invoice has no balance due", 409);
    if (sum.gt(due)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", `The payment of ${fmt(sum)} exceeds the balance due of ${fmt(due)}`, 409, { balanceDue: fmt(due) });
    for (const t of tenders) {
      if (t.method !== "CASH" && (!t.reference || t.reference.length < 4)) {
        throw new DomainError("VALIDATION_FAILED", `A reference (transaction id / last digits) is required for ${t.method.replace("_", " ").toLowerCase()} payments`, 400, [{ path: "payments", message: "Reference required" }]);
      }
    }
    const shiftId = tenders.some((t) => t.method === "CASH") ? await this.shiftForCash(tx, ctx, "taking") : await this.openShift(tx, ctx);
    const receiptNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "RECEIPT");
    const receipt = await tx.receipt.create({
      data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, invoiceId: inv.id, receiptNumber, total: sum.toFixed(2), receivedById: ctx.userId, shiftId },
    });
    await tx.payment.createMany({ data: tenders.map((t) => ({ tenantId: ctx.tenantId, receiptId: receipt.id, method: t.method, amount: t.amount.toFixed(2), reference: t.reference ?? null, advanceUseId: t.advanceUseId ?? null })) });
    const paid = inv.paidTotal.plus(sum);
    const status = await this.settle(tx, ctx, inv, { paidTotal: paid });
    await this.audit.record(tx, actorOf(ctx), {
      action: "PAYMENT_RECEIVED", entityType: "Invoice", entityId: inv.id,
      metadata: { receiptId: receipt.id, receiptNumber, total: fmt(sum), methods: tenders.map((t) => t.method), invoiceStatus: status },
    });
    return { receiptId: receipt.id, receiptNumber, total: sum, invoiceStatus: status };
  }

  async refund(
    tx: Db, ctx: RequestContext, inv: InvoiceMoney,
    r: { method: Method; amount: Decimal; reason: string; reference?: string | null; cancelsInvoice?: boolean },
    opts: { skipOverpaymentCheck?: boolean } = {},
  ) {
    if (inv.status === "DRAFT" || inv.status === "CANCELLED" || inv.status === "REFUNDED") {
      throw new DomainError("INVALID_STATE", "Refunds apply only to issued invoices", 409);
    }
    // When the bill was paid from the patient's advance, a refund "by other" first puts that part back into the advance.
    const toAdvance = r.method === "OTHER" ? await this.advancePart(tx, ctx, inv.id, r.amount) : { total: new Decimal(0), parts: [] };
    const paidOut = r.amount.minus(toAdvance.total);
    if (r.method !== "CASH" && paidOut.gt(0) && (!r.reference || r.reference.length < 4)) {
      throw new DomainError("VALIDATION_FAILED", "A reference is required for non-cash refunds", 400, [{ path: "reference", message: "Reference required" }]);
    }
    const net = netReceived(inv);
    if (!opts.skipOverpaymentCheck) {
      const allowed = refundable(inv);
      if (r.amount.gt(allowed)) {
        throw new DomainError("REFUND_EXCEEDS_PAID", `Only ${fmt(allowed)} is refundable. Issue a credit note first to reduce the invoice, then refund the overpayment.`, 409, { refundable: fmt(allowed) });
      }
    } else if (r.amount.gt(net)) {
      throw new DomainError("REFUND_EXCEEDS_PAID", `The refund of ${fmt(r.amount)} exceeds the ${fmt(net)} received`, 409);
    }
    // A method can only be refunded up to what was actually taken through it.
    const paidBy = await tx.payment.groupBy({ by: ["method"], where: { tenantId: ctx.tenantId, receipt: { invoiceId: inv.id } }, _sum: { amount: true } });
    const refundedBy = await tx.refund.groupBy({ by: ["method"], where: { tenantId: ctx.tenantId, invoiceId: inv.id }, _sum: { amount: true } });
    const taken = new Decimal(paidBy.find((p) => p.method === r.method)?._sum.amount?.toString() ?? 0);
    const returned = new Decimal(refundedBy.find((p) => p.method === r.method)?._sum.amount?.toString() ?? 0);
    if (r.amount.gt(taken.minus(returned))) {
      throw new DomainError("REFUND_EXCEEDS_PAID", `Only ${fmt(taken.minus(returned))} was received by ${r.method.replace("_", " ").toLowerCase()}; refund by the original method`, 409);
    }
    const shiftId = r.method === "CASH" ? await this.shiftForCash(tx, ctx, "refunding") : await this.openShift(tx, ctx);
    const refundNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "REFUND");
    const row = await tx.refund.create({
      data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, invoiceId: inv.id, refundNumber, method: r.method, amount: r.amount.toFixed(2), advanceReturned: toAdvance.total.toFixed(2), reason: r.reason, reference: r.reference ?? null, cancelsInvoice: r.cancelsInvoice ?? false, createdById: ctx.userId, shiftId },
    });
    if (toAdvance.parts.length > 0) {
      await tx.advanceReturn.createMany({ data: toAdvance.parts.map((p) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, useId: p.useId, depositId: p.depositId, invoiceId: inv.id, refundId: row.id, amount: p.amount.toFixed(2) })) });
    }
    await this.audit.record(tx, actorOf(ctx), { action: "REFUND_CREATED", entityType: "Invoice", entityId: inv.id, metadata: { refundId: row.id, refundNumber, amount: fmt(r.amount), method: r.method, reason: r.reason, cancelsInvoice: r.cancelsInvoice ?? false, ...(toAdvance.total.gt(0) ? { returnedToAdvance: fmt(toAdvance.total) } : {}) } });
    return { row, refundedTotal: inv.refundedTotal.plus(r.amount) };
  }

  /** How much of a refund goes back into the advance(s) that paid this bill: newest use first, never more than each use took. */
  private async advancePart(tx: Db, ctx: RequestContext, invoiceId: string, amount: Decimal) {
    const uses = await tx.advanceUse.findMany({ where: { tenantId: ctx.tenantId, invoiceId }, orderBy: [{ appliedAt: "desc" }, { id: "desc" }], select: { id: true, depositId: true, amount: true } });
    const parts: { useId: string; depositId: string; amount: Decimal }[] = [];
    if (uses.length === 0) return { total: new Decimal(0), parts };
    const back = await tx.advanceReturn.groupBy({ by: ["useId"], where: { tenantId: ctx.tenantId, invoiceId }, _sum: { amount: true } });
    let left = amount;
    for (const u of uses) {
      if (left.lte(0)) break;
      const room = new Decimal(u.amount.toString()).minus(back.find((b) => b.useId === u.id)?._sum.amount?.toString() ?? 0);
      const take = Decimal.min(left, room);
      if (take.lte(0)) continue;
      parts.push({ useId: u.id, depositId: u.depositId, amount: take });
      left = left.minus(take);
    }
    return { total: amount.minus(left), parts };
  }

  async credit(tx: Db, ctx: RequestContext, inv: InvoiceMoney, c: { amount: Decimal; reason: string }, opts: { allowFull?: boolean } = {}) {
    if (!["ISSUED", "PARTIALLY_PAID", "PAID"].includes(inv.status)) throw new DomainError("INVALID_STATE", "Credit notes apply only to issued invoices", 409);
    const remaining = inv.total.minus(inv.creditedTotal);
    if (c.amount.gt(remaining) || (!opts.allowFull && c.amount.gte(remaining))) {
      throw new DomainError("INVALID_AMOUNT", `A credit note must leave a balance on the invoice (up to ${fmt(remaining.minus(0.01))}). To remove the whole invoice, cancel it.`, 409, { maxCredit: fmt(Decimal.max(0, remaining.minus(0.01))) });
    }
    const creditNoteNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "CREDIT_NOTE");
    const row = await tx.creditNote.create({
      data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, invoiceId: inv.id, creditNoteNumber, amount: c.amount.toFixed(2), reason: c.reason, createdById: ctx.userId },
    });
    const status = await this.settle(tx, ctx, inv, { creditedTotal: inv.creditedTotal.plus(c.amount) });
    await this.audit.record(tx, actorOf(ctx), { action: "CREDIT_NOTE_CREATED", entityType: "Invoice", entityId: inv.id, metadata: { creditNoteId: row.id, creditNoteNumber, amount: fmt(c.amount), reason: c.reason, invoiceStatus: status } });
    return { row, status };
  }

  /** Persists the new running totals and the status they imply, atomically with the ledger rows. */
  async settle(tx: Db, ctx: RequestContext, inv: InvoiceMoney, next: Partial<Pick<InvoiceMoney, "paidTotal" | "refundedTotal" | "creditedTotal">>): Promise<LiveStatus> {
    const money = { total: inv.total, paidTotal: next.paidTotal ?? inv.paidTotal, refundedTotal: next.refundedTotal ?? inv.refundedTotal, creditedTotal: next.creditedTotal ?? inv.creditedTotal };
    const status = deriveStatus(money);
    const data: Prisma.InvoiceUncheckedUpdateManyInput = { status, version: { increment: 1 } };
    if (next.paidTotal) data.paidTotal = next.paidTotal.toFixed(2);
    if (next.refundedTotal) data.refundedTotal = next.refundedTotal.toFixed(2);
    if (next.creditedTotal) data.creditedTotal = next.creditedTotal.toFixed(2);
    const res = await tx.invoice.updateMany({ where: { id: inv.id, tenantId: ctx.tenantId, version: inv.version }, data });
    if (res.count !== 1) throw new DomainError("INVALID_STATE", "The invoice was changed by someone else", 409);
    // Money in or out changes what the visit's doctor earns: the doctor-share ledger follows, in this same transaction.
    if (next.paidTotal || next.refundedTotal) await this.shares.sync(tx, ctx, inv.id, next.refundedTotal ? "REFUND" : "PAYMENT");
    return status;
  }
}
