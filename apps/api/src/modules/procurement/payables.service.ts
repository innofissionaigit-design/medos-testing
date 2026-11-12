import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { dateOnly } from "../../common/time";
import { fmt } from "../billing/billing.domain";
import { amount } from "../billing/money.schema";
import { CostLedgerService } from "./cost-ledger.service";

const uuid = z.string().uuid();
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(dateOnly(s).getTime()) && dateOnly(s).toISOString().startsWith(s), "Invalid date");

export const payableListSchema = z.object({
  show: z.enum(["OPEN", "ALL"]).default("OPEN"), supplierId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const paySchema = z.object({
  amount: amount({ positive: true }), method: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"]), reference: z.string().trim().max(60).optional(), paidOn: isoDay.optional(),
}).strict().refine((v) => v.method === "CASH" || (v.reference ?? "").length >= 4, { path: ["reference"], message: "A reference (transaction id, cheque or UTR number) is required unless the payment is cash" });
const method = z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"]);
/** One payment that settles several invoices of a supplier: either the amount for each invoice, or one amount that is spread over the oldest invoices first. */
export const payStatementSchema = z.object({
  supplierId: uuid, method, reference: z.string().trim().max(60).optional(), paidOn: isoDay.optional(),
  lines: z.array(z.object({ purchaseId: uuid, amount: amount({ positive: true }) }).strict()).min(1).max(50).optional(),
  amount: amount({ positive: true }).optional(),
}).strict()
  .refine((v) => (v.lines === undefined) !== (v.amount === undefined), { path: ["lines"], message: "Give either the amount for each invoice or one amount to spread over the oldest invoices" })
  .refine((v) => !v.lines || new Set(v.lines.map((l) => l.purchaseId)).size === v.lines.length, { path: ["lines"], message: "Each invoice can be listed once" })
  .refine((v) => v.method === "CASH" || (v.reference ?? "").length >= 4, { path: ["reference"], message: "A reference (transaction id, cheque or UTR number) is required unless the payment is cash" });
export const creditSchema = z.object({ reference: z.string().trim().min(3).max(60) }).strict();
export const debitNoteListSchema = z.object({
  status: z.enum(["RAISED", "CREDITED"]).optional(), supplierId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

interface Row { id: string; purchaseNumber: string; supplierInvoiceNo: string; supplierInvoiceDate: Date; total: string; supplierId: string; supplier: string; poNumber: string | null; returned: string; credited: string; claimed: string; paid: string }

/**
 * What the hospital owes its suppliers (docs/procurement.md). Each goods receipt is the supplier's invoice. It is matched to the purchase order at receipt (supplier, lines,
 * quantity still expected, rate); what is owed is the invoice, less goods returned, less credit the supplier has agreed for rejected goods, less what has been paid. Payments are
 * recorded against an invoice, never more than it leaves owing, and are never edited. MedOS keeps no general ledger: this is a payables record, not accounts.
 */
@Injectable()
export class PayablesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly idempotency: IdempotencyService, private readonly ledger: CostLedgerService) {}

  private async rows(db: Db | PrismaService, ctx: RequestContext, extra: { purchaseId?: string; supplierId?: string; onlyOpen: boolean; limit: number; offset: number }) {
    return db.$queryRaw<Row[]>`
      WITH x AS (
        SELECT p.id, p."purchaseNumber", p."supplierInvoiceNo", p."supplierInvoiceDate", p.total::numeric(14,2)::text AS total, s.id AS "supplierId", s.name AS supplier, po."poNumber", p."receivedAt",
          COALESCE((SELECT SUM(r.total) FROM "PurchaseReturn" r WHERE r."purchaseId" = p.id AND r."tenantId" = p."tenantId"), 0)::numeric(14,2)::text AS returned,
          COALESCE((SELECT SUM(d.amount) FROM "SupplierDebitNote" d WHERE d."purchaseId" = p.id AND d."tenantId" = p."tenantId" AND d.status = 'CREDITED'), 0)::numeric(14,2)::text AS credited,
          COALESCE((SELECT SUM(d.amount) FROM "SupplierDebitNote" d WHERE d."purchaseId" = p.id AND d."tenantId" = p."tenantId" AND d.status = 'RAISED'), 0)::numeric(14,2)::text AS claimed,
          COALESCE((SELECT SUM(x.amount) FROM "SupplierPayment" x WHERE x."purchaseId" = p.id AND x."tenantId" = p."tenantId"), 0)::numeric(14,2)::text AS paid
        FROM "Purchase" p JOIN "Supplier" s ON s.id = p."supplierId" AND s."tenantId" = p."tenantId" LEFT JOIN "PurchaseOrder" po ON po.id = p."purchaseOrderId" AND po."tenantId" = p."tenantId"
        WHERE p."tenantId" = ${ctx.tenantId}::uuid AND p."facilityId" = ${ctx.facilityId}::uuid
          AND (${extra.purchaseId ?? null}::uuid IS NULL OR p.id = ${extra.purchaseId ?? null}::uuid) AND (${extra.supplierId ?? null}::uuid IS NULL OR p."supplierId" = ${extra.supplierId ?? null}::uuid))
      SELECT x.id, x."purchaseNumber", x."supplierInvoiceNo", x."supplierInvoiceDate", x.total, x."supplierId", x.supplier, x."poNumber", x.returned, x.credited, x.claimed, x.paid FROM x
      WHERE (NOT ${extra.onlyOpen}::boolean OR (x.total::numeric - x.returned::numeric - x.credited::numeric - x.paid::numeric) > 0)
      ORDER BY x."receivedAt" DESC, x.id LIMIT ${extra.limit} OFFSET ${extra.offset}`;
  }

  private view(r: Row) {
    const balance = new Decimal(r.total).minus(r.returned).minus(r.credited).minus(r.paid);
    return {
      purchaseId: r.id, purchaseNumber: r.purchaseNumber, supplierId: r.supplierId, supplier: r.supplier, supplierInvoiceNo: r.supplierInvoiceNo, supplierInvoiceDate: r.supplierInvoiceDate.toISOString().slice(0, 10),
      purchaseOrder: r.poNumber, matched: r.poNumber ? `Matched to ${r.poNumber}` : "No purchase order",
      invoiceTotal: fmt(r.total), returned: fmt(r.returned), credited: fmt(r.credited), creditAsked: fmt(r.claimed), paid: fmt(r.paid),
      balance: fmt(balance), creditDue: balance.lt(0) ? fmt(balance.abs()) : "0.00",
    };
  }

  async list(ctx: RequestContext, q: z.infer<typeof payableListSchema>) {
    const rows = await this.rows(this.prisma, ctx, { supplierId: q.supplierId, onlyOpen: q.show === "OPEN", limit: q.pageSize + 1, offset: (q.page - 1) * q.pageSize });
    const all = await this.rows(this.prisma, ctx, { supplierId: q.supplierId, onlyOpen: true, limit: 5000, offset: 0 });
    const bySupplier = new Map<string, { supplierId: string; supplier: string; owed: Decimal; invoices: number }>();
    for (const r of all) {
      const e = bySupplier.get(r.supplierId) ?? { supplierId: r.supplierId, supplier: r.supplier, owed: new Decimal(0), invoices: 0 };
      e.owed = e.owed.plus(new Decimal(r.total).minus(r.returned).minus(r.credited).minus(r.paid)); e.invoices += 1; bySupplier.set(r.supplierId, e);
    }
    return {
      page: q.page, pageSize: q.pageSize, hasMore: rows.length > q.pageSize, items: rows.slice(0, q.pageSize).map((r) => this.view(r)),
      owedToSuppliers: fmt([...bySupplier.values()].reduce((a, e) => a.plus(e.owed), new Decimal(0))),
      bySupplier: [...bySupplier.values()].map((e) => ({ supplierId: e.supplierId, supplier: e.supplier, invoices: e.invoices, owed: fmt(e.owed) })).sort((a, b) => a.supplier.localeCompare(b.supplier)),
    };
  }

  /** Pays a supplier against one invoice. Never more than the invoice leaves owing; a retry with the same Idempotency-Key does not pay twice. */
  async pay(ctx: RequestContext, purchaseId: string, input: z.infer<typeof paySchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required to pay a supplier", 400);
    return this.idempotency.run(ctx.tenantId, `SUPPLIER_PAY:${purchaseId}`, key, input, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Purchase" WHERE id = ${purchaseId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const [row] = await this.rows(tx, ctx, { purchaseId, onlyOpen: false, limit: 1, offset: 0 });
      const v = this.view(row!);
      const owing = new Decimal(v.balance);
      if (owing.lte(0)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", "Nothing is owing on this invoice", 409);
      if (input.amount.gt(owing)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", `The invoice leaves ${fmt(owing)} owing; the payment of ${fmt(input.amount)} is more than that`, 409, { owing: fmt(owing) });
      const p = await tx.supplierPayment.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, purchaseId, amount: input.amount.toFixed(2), method: input.method, reference: input.reference || null, paidOn: input.paidOn ? dateOnly(input.paidOn) : dateOnly(new Date().toISOString().slice(0, 10)), paidById: ctx.userId }, select: { id: true } });
      await this.ledger.post(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId }, {
        sourceKey: `SUPPLIER_PAYMENT:${p.id}`, sourceType: "SupplierPayment", sourceId: p.id, date: new Date(), narration: `Paid ${row!.supplier} against ${row!.purchaseNumber}`,
        lines: [{ account: "SUPPLIER_PAYABLE", debit: input.amount }, { account: input.method === "CASH" ? "CASH" : "BANK", credit: input.amount }],
      });
      await this.audit.record(tx, actorOf(ctx), { action: "SUPPLIER_PAID", entityType: "Purchase", entityId: purchaseId, metadata: { paymentId: p.id, purchaseNumber: row!.purchaseNumber, amount: fmt(input.amount), method: input.method } });
      const [after] = await this.rows(tx, ctx, { purchaseId, onlyOpen: false, limit: 1, offset: 0 });
      return { paymentId: p.id, ...this.view(after!) };
    });
  }

  // ───── debit notes ─────

  private async noteViews(db: Db | PrismaService, ctx: RequestContext, f: { id?: string; status?: "RAISED" | "CREDITED" | undefined; supplierId?: string | undefined; page?: number; pageSize?: number }) {
    const rows = await db.supplierDebitNote.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(f.id ? { id: f.id } : {}), ...(f.status ? { status: f.status } : {}), ...(f.supplierId ? { supplierId: f.supplierId } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: ((f.page ?? 1) - 1) * (f.pageSize ?? 25), take: f.pageSize ?? 25,
      include: { supplier: { select: { name: true } }, purchase: { select: { purchaseNumber: true } } },
    });
    const users = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.flatMap((r) => [r.createdById, ...(r.creditedById ? [r.creditedById] : [])]))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id, noteNumber: r.noteNumber, purchaseId: r.purchaseId, purchaseNumber: r.purchase.purchaseNumber, supplierId: r.supplierId, supplier: r.supplier.name, amount: fmt(r.amount), reason: r.reason, status: r.status,
      createdAt: r.createdAt, createdBy: users.get(r.createdById) ?? null, creditedAt: r.creditedAt, creditedBy: r.creditedById ? users.get(r.creditedById) ?? null : null, creditReference: r.creditReference,
    }));
  }

  /**
   * Paying a supplier for several invoices at once. The payments are recorded against each invoice (never more than it leaves owing), grouped under one payment run, and posted
   * to the cost ledger as one entry. With only an amount, the oldest invoices (by the supplier's invoice date) are paid first; it may not be more than the supplier is owed in all.
   */
  async payStatement(ctx: RequestContext, input: z.infer<typeof payStatementSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required to pay a supplier", 400);
    return this.idempotency.run(ctx.tenantId, `SUPPLIER_STATEMENT_PAY:${input.supplierId}`, key, input, async (tx) => {
      const sup = await tx.supplier.findFirst({ where: { id: input.supplierId, tenantId: ctx.tenantId }, select: { id: true, name: true } });
      if (!sup) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const ids = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Purchase" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND "supplierId" = ${input.supplierId}::uuid ORDER BY id FOR UPDATE`;
      if (ids.length === 0) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", "Nothing is owing to this supplier", 409);
      const open = (await this.rows(tx, ctx, { supplierId: input.supplierId, onlyOpen: true, limit: 1000, offset: 0 })).map((r) => this.view(r)).filter((v) => new Decimal(v.balance).gt(0));
      const owingAll = open.reduce((a, v) => a.plus(v.balance), new Decimal(0));
      let split: { purchaseId: string; purchaseNumber: string; amount: Decimal }[] = [];
      if (input.lines) {
        for (const l of input.lines) {
          const v = open.find((o) => o.purchaseId === l.purchaseId);
          if (!v) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", "An invoice listed is not one of this supplier's open invoices", 409, { purchaseId: l.purchaseId });
          if (l.amount.gt(v.balance)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", `Invoice ${v.supplierInvoiceNo} leaves ${v.balance} owing; ${fmt(l.amount)} is more than that`, 409, { purchaseId: l.purchaseId, owing: v.balance });
          split.push({ purchaseId: l.purchaseId, purchaseNumber: v.purchaseNumber, amount: l.amount });
        }
      } else {
        let left = input.amount!;
        if (left.gt(owingAll)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", `This supplier is owed ${fmt(owingAll)} in all; ${fmt(left)} is more than that`, 409, { owing: fmt(owingAll) });
        for (const v of [...open].sort((a, b) => a.supplierInvoiceDate.localeCompare(b.supplierInvoiceDate) || a.purchaseNumber.localeCompare(b.purchaseNumber))) {
          if (left.lte(0)) break;
          const pay = Decimal.min(left, new Decimal(v.balance));
          split.push({ purchaseId: v.purchaseId, purchaseNumber: v.purchaseNumber, amount: pay });
          left = left.minus(pay);
        }
      }
      split = split.filter((s) => s.amount.gt(0));
      const total = split.reduce((a, s) => a.plus(s.amount), new Decimal(0));
      const paidOn = input.paidOn ? dateOnly(input.paidOn) : dateOnly(new Date().toISOString().slice(0, 10));
      const run = await tx.supplierPaymentRun.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, supplierId: sup.id, total: total.toFixed(2), method: input.method, reference: input.reference || null, paidOn, paidById: ctx.userId } });
      for (const s of split) {
        await tx.supplierPayment.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, purchaseId: s.purchaseId, amount: s.amount.toFixed(2), method: input.method, reference: input.reference || null, paidOn, paidById: ctx.userId, runId: run.id } });
      }
      await this.ledger.post(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId }, {
        sourceKey: `SUPPLIER_PAYMENT_RUN:${run.id}`, sourceType: "SupplierPaymentRun", sourceId: run.id, date: new Date(), narration: `Paid ${sup.name} for ${split.length} invoice(s)`,
        lines: [{ account: "SUPPLIER_PAYABLE", debit: total }, { account: input.method === "CASH" ? "CASH" : "BANK", credit: total }],
      });
      await this.audit.record(tx, actorOf(ctx), { action: "SUPPLIER_STATEMENT_PAID", entityType: "SupplierPaymentRun", entityId: run.id, metadata: { supplierId: sup.id, invoices: split.length, total: fmt(total), method: input.method } });
      return { runId: run.id, supplier: sup.name, total: fmt(total), method: input.method, paidOn: paidOn.toISOString().slice(0, 10), payments: split.map((s) => ({ purchaseId: s.purchaseId, purchaseNumber: s.purchaseNumber, amount: fmt(s.amount) })) };
    });
  }

  async listDebitNotes(ctx: RequestContext, q: z.infer<typeof debitNoteListSchema>) { return this.noteViews(this.prisma, ctx, q); }

  /** The supplier agreed to credit the goods (or replace them): the note no longer counts as owed to them. Credited once, with their reference. */
  async creditDebitNote(ctx: RequestContext, id: string, input: z.infer<typeof creditSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SupplierDebitNote" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const n = await tx.supplierDebitNote.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
      if (n.status !== "RAISED") throw new DomainError("INVALID_STATE", "This debit note has already been credited", 409);
      await tx.supplierDebitNote.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CREDITED", creditedById: ctx.userId, creditedAt: new Date(), creditReference: input.reference } });
      await this.ledger.post(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId }, {
        sourceKey: `DEBIT_NOTE_CREDITED:${id}`, sourceType: "SupplierDebitNote", sourceId: id, date: new Date(), narration: `Supplier credited ${n.noteNumber}`,
        lines: [{ account: "SUPPLIER_PAYABLE", debit: n.amount.toString() }, { account: "PURCHASE_RETURNS", credit: n.amount.toString() }],
      });
      await this.audit.record(tx, actorOf(ctx), { action: "DEBIT_NOTE_CREDITED", entityType: "SupplierDebitNote", entityId: id, metadata: { noteNumber: n.noteNumber, amount: fmt(n.amount) } });
      return (await this.noteViews(tx, ctx, { id }))[0]!;
    });
  }
}
