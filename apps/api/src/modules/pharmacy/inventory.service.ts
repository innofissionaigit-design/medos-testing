import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { dateOnly } from "../../common/time";
import { fmt, round2 } from "../billing/billing.domain";
import { amount, percent } from "../billing/money.schema";
import { NumberingService } from "../numbering/numbering.service";
import { StockService } from "./stock.service";

const uuid = z.string().uuid();
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s, c) => {
  const d = dateOnly(s);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) c.addIssue({ code: "custom", message: "Invalid date" });
  return d;
});
const batchNo = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9/._-]{0,29}$/, "Batch number: letters, digits, / . _ -");
const qty = z.number().int().min(1).max(1_000_000);

const pricing = { mrp: amount(), purchasePrice: amount(), sellingPrice: amount() };
const checkPrices = (v: { mrp: Decimal; purchasePrice: Decimal; sellingPrice: Decimal }, c: z.RefinementCtx) => {
  if (v.sellingPrice.gt(v.mrp)) c.addIssue({ code: "custom", path: ["sellingPrice"], message: "Selling price cannot exceed the MRP" });
};

export const openingBatchSchema = z.object({ medicineId: uuid, batchNo, expiryDate: isoDay, ...pricing, quantity: qty }).strict().superRefine(checkPrices);
export const blockBatchSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();

export const adjustSchema = z.object({
  batchId: uuid, direction: z.enum(["IN", "OUT"]), quantity: qty,
  kind: z.enum(["ADJUSTMENT", "DAMAGE"]).default("ADJUSTMENT"),
  reason: z.string().trim().min(5).max(240),
}).strict().superRefine((v, c) => { if (v.kind === "DAMAGE" && v.direction === "IN") c.addIssue({ code: "custom", path: ["direction"], message: "Damaged stock can only be removed" }); });

export const purchaseSchema = z.object({
  supplierId: uuid, supplierInvoiceNo: z.string().trim().min(1).max(40), supplierInvoiceDate: isoDay, notes: z.string().trim().max(500).optional(),
  items: z.array(z.object({ medicineId: uuid, batchNo, expiryDate: isoDay, quantity: qty, gstPercent: percent.optional(), ...pricing }).strict().superRefine(checkPrices)).min(1).max(50),
}).strict();

export const purchaseReturnSchema = z.object({
  reason: z.string().trim().min(5).max(240),
  items: z.array(z.object({ purchaseItemId: uuid, quantity: qty }).strict()).min(1).max(50),
}).strict();

export const stockQuerySchema = z.object({
  q: z.string().trim().min(2).max(60).optional(),
  lowStock: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  nearExpiryDays: z.coerce.number().int().min(1).max(365).default(90),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const batchQuerySchema = z.object({
  medicineId: uuid.optional(), includeEmpty: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export const ledgerQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }).strict();
export const purchaseListSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict();

const BATCH_VIEW = {
  id: true, medicineId: true, batchNo: true, expiryDate: true, mrp: true, purchasePrice: true, sellingPrice: true, receivedQuantity: true, status: true, blockReason: true,
  balance: { select: { quantity: true } }, medicine: { select: { brandName: true, genericName: true, strength: true } },
} satisfies Prisma.MedicineBatchSelect;
type BatchRow = Prisma.MedicineBatchGetPayload<{ select: typeof BATCH_VIEW }>;
const day = (d: Date) => d.toISOString().slice(0, 10);
export const toBatchView = (b: BatchRow, today: Date) => ({
  id: b.id, medicineId: b.medicineId, medicineName: [b.medicine.brandName, b.medicine.strength].filter(Boolean).join(" "), genericName: b.medicine.genericName,
  batchNo: b.batchNo, expiryDate: day(b.expiryDate), expired: b.expiryDate < today, mrp: fmt(b.mrp), purchasePrice: fmt(b.purchasePrice), sellingPrice: fmt(b.sellingPrice),
  receivedQuantity: b.receivedQuantity, quantity: b.balance?.quantity ?? 0, status: b.status, blockReason: b.blockReason,
});

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly stock: StockService,
    private readonly numbering: NumberingService, private readonly idempotency: IdempotencyService,
  ) {}

  // ───── batches ─────

  async listBatches(ctx: RequestContext, q: z.infer<typeof batchQuerySchema>) {
    const today = await this.stock.today(this.prisma, ctx);
    const where: Prisma.MedicineBatchWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.medicineId ? { medicineId: q.medicineId } : {}),
      ...(q.includeEmpty ? {} : { balance: { quantity: { gt: 0 } } }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.medicineBatch.findMany({ where, select: BATCH_VIEW, orderBy: [{ expiryDate: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.medicineBatch.count({ where }),
    ]);
    return { items: rows.map((b) => toBatchView(b, today)), total };
  }

  /** Opening stock for go-live / data migration: a batch plus an ADJUSTMENT-in ledger row. */
  async createOpeningBatch(ctx: RequestContext, input: z.infer<typeof openingBatchSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required", 400);
    return this.idempotency.run(ctx.tenantId, "OPENING_BATCH", key, input, async (tx) => {
      const today = await this.stock.today(tx, ctx);
      if (input.expiryDate < today) throw new DomainError("VALIDATION_FAILED", "This batch has already expired", 400, [{ path: "expiryDate", message: "Already expired" }]);
      await this.assertMedicine(tx, ctx, input.medicineId);
      const b = await this.upsertBatch(tx, ctx, input.medicineId, input.batchNo, input.expiryDate, input);
      await this.stock.move(tx, ctx, { batchId: b.id, medicineId: input.medicineId, type: "ADJUSTMENT", direction: "IN", quantity: input.quantity, reason: "Opening stock", sourceType: "OPENING" });
      await tx.medicineBatch.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: b.id } }, data: { receivedQuantity: { increment: input.quantity } } });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_OPENING_RECORDED", entityType: "MedicineBatch", entityId: b.id, metadata: { medicineId: input.medicineId, quantity: input.quantity } });
      return this.batchView(tx, ctx, b.id);
    });
  }

  async setBlocked(ctx: RequestContext, id: string, blocked: boolean, reason: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const b = await tx.medicineBatch.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!b) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const next = blocked ? "BLOCKED" : "ACTIVE";
      if (b.status === next) throw new DomainError("INVALID_STATE", blocked ? "This batch is already blocked" : "This batch is not blocked", 409);
      await tx.medicineBatch.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: next, blockReason: blocked ? reason : null } });
      await this.audit.record(tx, actorOf(ctx), { action: blocked ? "BATCH_BLOCKED" : "BATCH_UNBLOCKED", entityType: "MedicineBatch", entityId: id, metadata: { reason } });
      return this.batchView(tx, ctx, id);
    });
  }

  /** Reconstructs the batch history from the ledger and proves it equals the live balance. */
  async ledger(ctx: RequestContext, batchId: string, q: z.infer<typeof ledgerQuerySchema>) {
    const batch = await this.prisma.medicineBatch.findFirst({ where: { id: batchId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: BATCH_VIEW });
    if (!batch) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const [rows, total, sums] = await Promise.all([
      this.prisma.stockLedger.findMany({ where: { tenantId: ctx.tenantId, batchId }, orderBy: { seq: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { seq: true, type: true, direction: true, quantity: true, balanceAfter: true, sourceType: true, sourceId: true, reason: true, userId: true, createdAt: true } }),
      this.prisma.stockLedger.count({ where: { tenantId: ctx.tenantId, batchId } }),
      this.prisma.stockLedger.groupBy({ by: ["direction"], where: { tenantId: ctx.tenantId, batchId }, _sum: { quantity: true } }),
    ]);
    const inn = sums.find((s) => s.direction === "IN")?._sum.quantity ?? 0;
    const out = sums.find((s) => s.direction === "OUT")?._sum.quantity ?? 0;
    const balance = batch.balance?.quantity ?? 0;
    return {
      batch: toBatchView(batch, await this.stock.today(this.prisma, ctx)),
      reconciliation: { balance, ledgerIn: inn, ledgerOut: out, ledgerNet: inn - out, reconciles: balance === inn - out },
      items: rows.map((r) => ({ ...r, seq: r.seq.toString() })), total,
    };
  }

  // ───── adjustments ─────

  async adjust(ctx: RequestContext, input: z.infer<typeof adjustSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for stock adjustments", 400);
    const { result, replayed } = await this.idempotency.run(ctx.tenantId, "STOCK_ADJUST", key, input, async (tx) => {
      const b = await tx.medicineBatch.findFirst({ where: { id: input.batchId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!b) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const after = await this.stock.move(tx, ctx, { batchId: b.id, medicineId: b.medicineId, type: input.kind, direction: input.direction, quantity: input.quantity, reason: input.reason, sourceType: "MANUAL" });
      await this.audit.record(tx, actorOf(ctx), {
        action: "STOCK_ADJUSTED", entityType: "MedicineBatch", entityId: b.id,
        metadata: { kind: input.kind, direction: input.direction, quantity: input.quantity, balanceAfter: after, reason: input.reason },
      });
      return { batch: await this.batchView(tx, ctx, b.id), balanceAfter: after };
    });
    return { result, replayed };
  }

  // ───── stock view ─────

  async stockSummary(ctx: RequestContext, q: z.infer<typeof stockQuerySchema>) {
    const today = await this.stock.today(this.prisma, ctx);
    const horizon = new Date(today.getTime() + q.nearExpiryDays * 86_400_000);
    const medWhere: Prisma.MedicineWhereInput = {
      tenantId: ctx.tenantId, status: "ACTIVE",
      ...(q.q ? { OR: [{ brandName: { contains: q.q, mode: "insensitive" } }, { genericName: { contains: q.q, mode: "insensitive" } }] } : {}),
      batches: { some: { facilityId: ctx.facilityId } },
    };
    const meds = await this.prisma.medicine.findMany({ where: medWhere, select: { id: true, brandName: true, genericName: true, strength: true, dosageForm: true, reorderLevel: true }, orderBy: { brandName: "asc" } });
    const batches = await this.prisma.medicineBatch.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, medicineId: { in: meds.map((m) => m.id) } }, select: BATCH_VIEW, orderBy: [{ expiryDate: "asc" }, { id: "asc" }],
    });
    const rows = meds.map((m) => {
      const own = batches.filter((b) => b.medicineId === m.id);
      const qtyOf = (f: (b: BatchRow) => boolean) => own.filter(f).reduce((a, b) => a + (b.balance?.quantity ?? 0), 0);
      const sellable = qtyOf((b) => b.status === "ACTIVE" && b.expiryDate >= today);
      return {
        medicineId: m.id, brandName: m.brandName, genericName: m.genericName, strength: m.strength, dosageForm: m.dosageForm, reorderLevel: m.reorderLevel,
        sellableQuantity: sellable, expiredQuantity: qtyOf((b) => b.expiryDate < today), nearExpiryQuantity: qtyOf((b) => b.status === "ACTIVE" && b.expiryDate >= today && b.expiryDate <= horizon),
        blockedQuantity: qtyOf((b) => b.status === "BLOCKED"), lowStock: sellable <= m.reorderLevel,
        batches: own.filter((b) => (b.balance?.quantity ?? 0) > 0).map((b) => toBatchView(b, today)),
      };
    });
    const filtered = q.lowStock ? rows.filter((r) => r.lowStock) : rows;
    return { items: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: filtered.length };
  }

  // ───── procurement ─────

  async receivePurchase(ctx: RequestContext, input: z.infer<typeof purchaseSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for purchases", 400);
    try {
      return await this.idempotency.run(ctx.tenantId, "PURCHASE", key, input, async (tx) => {
        const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, tenantId: ctx.tenantId, status: "ACTIVE" } });
        if (!supplier) throw new DomainError("VALIDATION_FAILED", "Supplier not found or inactive", 400, [{ path: "supplierId", message: "Unknown supplier" }]);
        const today = await this.stock.today(tx, ctx);
        const medicines = await tx.medicine.findMany({ where: { id: { in: [...new Set(input.items.map((i) => i.medicineId))] }, tenantId: ctx.tenantId, status: "ACTIVE" } });
        const byId = new Map(medicines.map((m) => [m.id, m]));
        const lines = input.items.map((it, i) => {
          const med = byId.get(it.medicineId);
          if (!med) throw new DomainError("VALIDATION_FAILED", "A medicine does not exist or is inactive", 400, [{ path: `items.${i}.medicineId`, message: "Unknown medicine" }]);
          if (it.expiryDate < today) throw new DomainError("VALIDATION_FAILED", `Batch ${it.batchNo} has already expired`, 400, [{ path: `items.${i}.expiryDate`, message: "Already expired" }]);
          const gst = it.gstPercent ?? new Decimal(med.gstPercent.toString());
          const net = round2(it.purchasePrice.times(it.quantity));
          return { ...it, gst, net, tax: round2(net.times(gst).div(100)) };
        });
        const subtotal = lines.reduce((a, l) => a.plus(l.net), new Decimal(0));
        const taxTotal = lines.reduce((a, l) => a.plus(l.tax), new Decimal(0));
        const purchaseNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "PURCHASE");
        const purchase = await tx.purchase.create({
          data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, purchaseNumber, supplierId: supplier.id, supplierInvoiceNo: input.supplierInvoiceNo, supplierInvoiceDate: input.supplierInvoiceDate, subtotal: subtotal.toFixed(2), taxTotal: taxTotal.toFixed(2), total: subtotal.plus(taxTotal).toFixed(2), notes: input.notes ?? null, receivedById: ctx.userId },
        });
        // Deterministic order => deterministic lock order when several receipts touch the same batches.
        const ordered = [...lines.entries()].sort(([, a], [, b]) => (a.medicineId + a.batchNo).localeCompare(b.medicineId + b.batchNo));
        const itemRows: Prisma.PurchaseItemCreateManyInput[] = [];
        for (const [idx, l] of ordered) {
          const b = await this.upsertBatch(tx, ctx, l.medicineId, l.batchNo, l.expiryDate, l);
          await this.stock.move(tx, ctx, { batchId: b.id, medicineId: l.medicineId, type: "PURCHASE", direction: "IN", quantity: l.quantity, sourceType: "PURCHASE", sourceId: purchase.id });
          await tx.medicineBatch.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: b.id } }, data: { receivedQuantity: { increment: l.quantity } } });
          itemRows.push({ tenantId: ctx.tenantId, purchaseId: purchase.id, lineNo: idx + 1, medicineId: l.medicineId, batchId: b.id, quantity: l.quantity, purchasePrice: l.purchasePrice.toFixed(2), mrp: l.mrp.toFixed(2), sellingPrice: l.sellingPrice.toFixed(2), gstPercent: l.gst.toFixed(2), lineTotal: l.net.plus(l.tax).toFixed(2) });
        }
        await tx.purchaseItem.createMany({ data: itemRows });
        await this.audit.record(tx, actorOf(ctx), { action: "PURCHASE_RECEIVED", entityType: "Purchase", entityId: purchase.id, metadata: { purchaseNumber, supplierId: supplier.id, items: lines.length, total: fmt(subtotal.plus(taxTotal)) } });
        return this.purchaseView(tx, ctx, purchase.id);
      });
    } catch (e) {
      if (e instanceof Error && /Unique constraint|supplierInvoiceNo/i.test(e.message) && !(e instanceof DomainError)) {
        throw new DomainError("CONFLICT", "A purchase with this supplier invoice number was already received", 409);
      }
      throw e;
    }
  }

  async listPurchases(ctx: RequestContext, q: z.infer<typeof purchaseListSchema>) {
    const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId };
    const [rows, total] = await Promise.all([
      this.prisma.purchase.findMany({ where, orderBy: { receivedAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
      this.prisma.purchase.count({ where }),
    ]);
    return { items: await Promise.all(rows.map((r) => this.purchaseView(this.prisma, ctx, r.id))), total };
  }

  async getPurchase(ctx: RequestContext, id: string) {
    const p = await this.prisma.purchase.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
    if (!p) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.purchaseView(this.prisma, ctx, id);
  }

  /** Returns stock to the supplier: ledger PURCHASE_RETURN rows, capped by what was bought and what is still on the shelf. */
  async returnPurchase(ctx: RequestContext, purchaseId: string, input: z.infer<typeof purchaseReturnSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for purchase returns", 400);
    return this.idempotency.run(ctx.tenantId, `PURCHASE_RETURN:${purchaseId}`, key, input, async (tx) => {
      const purchase = await tx.purchase.findFirst({ where: { id: purchaseId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { items: true } });
      if (!purchase) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const merged = new Map<string, number>();
      for (const i of input.items) merged.set(i.purchaseItemId, (merged.get(i.purchaseItemId) ?? 0) + i.quantity);
      const returnNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "PURCHASE_RETURN");
      const rows: { purchaseItemId: string; quantity: number; amount: Decimal }[] = [];
      for (const [itemId, quantity] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const item = purchase.items.find((p) => p.id === itemId);
        if (!item) throw new DomainError("VALIDATION_FAILED", "An item does not belong to this purchase", 400, [{ path: "items", message: "Unknown purchase item" }]);
        const cap = await tx.purchaseItem.updateMany({ where: { id: itemId, tenantId: ctx.tenantId, returnedQuantity: { lte: item.quantity - quantity } }, data: { returnedQuantity: { increment: quantity } } });
        if (cap.count !== 1) throw new DomainError("INVALID_AMOUNT", `Only ${item.quantity - item.returnedQuantity} unit(s) of this item can still be returned`, 409);
        await this.stock.move(tx, ctx, { batchId: item.batchId, medicineId: item.medicineId, type: "PURCHASE_RETURN", direction: "OUT", quantity, sourceType: "PURCHASE_RETURN", sourceId: purchaseId });
        const net = round2(new Decimal(item.purchasePrice.toString()).times(quantity));
        rows.push({ purchaseItemId: itemId, quantity, amount: net.plus(round2(net.times(item.gstPercent.toString()).div(100))) });
      }
      const total = rows.reduce((a, r) => a.plus(r.amount), new Decimal(0));
      const ret = await tx.purchaseReturn.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, returnNumber, purchaseId, reason: input.reason, total: total.toFixed(2), createdById: ctx.userId } });
      await tx.purchaseReturnItem.createMany({ data: rows.map((r) => ({ tenantId: ctx.tenantId, returnId: ret.id, purchaseItemId: r.purchaseItemId, quantity: r.quantity, amount: r.amount.toFixed(2) })) });
      const after = await tx.purchaseItem.findMany({ where: { tenantId: ctx.tenantId, purchaseId } });
      const status = after.every((i) => i.returnedQuantity === i.quantity) ? "RETURNED" : "PARTIALLY_RETURNED";
      await tx.purchase.updateMany({ where: { id: purchaseId, tenantId: ctx.tenantId }, data: { status } });
      await this.audit.record(tx, actorOf(ctx), { action: "PURCHASE_RETURNED", entityType: "Purchase", entityId: purchaseId, metadata: { returnNumber, total: fmt(total), reason: input.reason, status } });
      return { returnNumber, total: fmt(total), purchase: await this.purchaseView(tx, ctx, purchaseId) };
    });
  }

  // ───── internals ─────

  private async assertMedicine(db: Db, ctx: RequestContext, id: string): Promise<void> {
    const m = await db.medicine.findFirst({ where: { id, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
    if (!m) throw new DomainError("VALIDATION_FAILED", "Medicine not found or inactive", 400, [{ path: "medicineId", message: "Unknown medicine" }]);
  }

  /** Finds the batch for (facility, medicine, batch no) or creates it. Existing batches must match expiry and prices. */
  private async upsertBatch(tx: Db, ctx: RequestContext, medicineId: string, no: string, expiry: Date, p: { mrp: Decimal; purchasePrice: Decimal; sellingPrice: Decimal }) {
    const existing = await tx.medicineBatch.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, medicineId, batchNo: no } });
    if (existing) {
      const same = existing.expiryDate.getTime() === expiry.getTime() && existing.mrp.equals(p.mrp) && existing.purchasePrice.equals(p.purchasePrice) && existing.sellingPrice.equals(p.sellingPrice);
      if (!same) throw new DomainError("CONFLICT", `Batch ${no} already exists with a different expiry date or prices`, 409);
      return existing;
    }
    const b = await tx.medicineBatch.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, medicineId, batchNo: no, expiryDate: expiry, mrp: p.mrp.toFixed(2), purchasePrice: p.purchasePrice.toFixed(2), sellingPrice: p.sellingPrice.toFixed(2) } });
    await this.stock.openBalance(tx, ctx, b.id, medicineId);
    return b;
  }

  private async batchView(db: Db, ctx: RequestContext, id: string) {
    const b = await db.medicineBatch.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: BATCH_VIEW });
    return toBatchView(b, await this.stock.today(db, ctx));
  }

  private async purchaseView(db: Db, ctx: RequestContext, id: string) {
    const p = await db.purchase.findFirstOrThrow({
      where: { id, tenantId: ctx.tenantId },
      include: { supplier: { select: { name: true } }, items: { orderBy: { lineNo: "asc" }, include: { medicine: { select: { brandName: true, strength: true } } } }, returns: { select: { returnNumber: true, total: true, reason: true, createdAt: true } } },
    });
    const batches = await db.medicineBatch.findMany({ where: { tenantId: ctx.tenantId, id: { in: p.items.map((i) => i.batchId) } }, select: { id: true, batchNo: true, expiryDate: true } });
    const byBatch = new Map(batches.map((b) => [b.id, b]));
    return {
      id: p.id, purchaseNumber: p.purchaseNumber, supplierName: p.supplier.name, supplierInvoiceNo: p.supplierInvoiceNo, supplierInvoiceDate: day(p.supplierInvoiceDate), status: p.status,
      subtotal: fmt(p.subtotal), taxTotal: fmt(p.taxTotal), total: fmt(p.total), receivedAt: p.receivedAt, notes: p.notes,
      items: p.items.map((i) => ({ id: i.id, lineNo: i.lineNo, medicineName: [i.medicine.brandName, i.medicine.strength].filter(Boolean).join(" "), batchNo: byBatch.get(i.batchId)?.batchNo ?? null, expiryDate: byBatch.get(i.batchId) ? day(byBatch.get(i.batchId)!.expiryDate) : null, quantity: i.quantity, returnedQuantity: i.returnedQuantity, purchasePrice: fmt(i.purchasePrice), mrp: fmt(i.mrp), sellingPrice: fmt(i.sellingPrice), gstPercent: fmt(i.gstPercent), lineTotal: fmt(i.lineTotal) })),
      returns: p.returns.map((r) => ({ returnNumber: r.returnNumber, total: fmt(r.total), reason: r.reason, createdAt: r.createdAt })),
    };
  }
}
