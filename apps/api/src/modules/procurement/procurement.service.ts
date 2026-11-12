import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { dateOnly } from "../../common/time";
import { fmt, round2 } from "../billing/billing.domain";
import { amount, percent } from "../billing/money.schema";
import { NumberingService } from "../numbering/numbering.service";
import { SettingsService } from "../settings/settings.service";

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().max(max);
const qty = z.number().int().min(1).max(1_000_000);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(dateOnly(s).getTime()) && dateOnly(s).toISOString().startsWith(s), "Invalid date");
const unique = (ids: string[]) => new Set(ids).size === ids.length;

export const indentSchema = z.object({
  forLocationId: uuid.nullish(), note: text(500).optional(),
  items: z.array(z.object({ medicineId: uuid, quantity: qty, note: text(200).optional() }).strict()).min(1).max(50),
}).strict().refine((v) => unique(v.items.map((i) => i.medicineId)), { path: ["items"], message: "Each medicine can be listed once" });
export const approveSchema = z.object({ note: text(300).optional() }).strict();
export const reasonSchema = z.object({ reason: text(300).min(5) }).strict();
export const orderSchema = z.object({
  supplierId: uuid, indentId: uuid.optional(), expectedOn: isoDay.optional(), notes: text(500).optional(),
  items: z.array(z.object({ medicineId: uuid, quantity: qty, rate: amount(), gstPercent: percent.optional(), indentItemId: uuid.optional() }).strict()).min(1).max(50),
}).strict().refine((v) => unique(v.items.map((i) => i.medicineId)), { path: ["items"], message: "Each medicine can be listed once" });
export const listSchema = z.object({
  status: z.string().trim().max(30).optional(), mine: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const nameOf = (m: { brandName: string; strength: string | null }) => [m.brandName, m.strength].filter(Boolean).join(" ");
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Procurement (docs/procurement.md): what stock is short (requirement), the indent a department raises to buy it, its approval by someone other than the requester,
 * the purchase order placed with a supplier from the approved indent, and the goods receipt against it (in the inventory service). Every step is audited, the
 * order of steps is enforced here and by the database, and an order or indent is never deleted.
 */
@Injectable()
export class ProcurementService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService, private readonly settings: SettingsService) {}

  // ───── stock requirement ─────

  /**
   * Medicines whose stock (the main store plus every location) has fallen to the reorder level, counting what is already on order or on an indent that has not
   * been ordered yet. The suggestion tops the position up to twice the reorder level. Read-only: nothing is created.
   */
  async requirement(ctx: RequestContext) {
    const rows = await this.prisma.$queryRaw<{ id: string; brandName: string; genericName: string; strength: string | null; reorderLevel: number; main: number; locations: number; onOrder: number; indented: number }[]>`
      SELECT m.id, m."brandName", m."genericName", m.strength, m."reorderLevel",
        COALESCE((SELECT SUM(sb.quantity) FROM "StockBalance" sb WHERE sb."tenantId" = m."tenantId" AND sb."facilityId" = ${ctx.facilityId}::uuid AND sb."medicineId" = m.id), 0)::int AS main,
        COALESCE((SELECT SUM(lb.quantity) FROM "StockLocationBalance" lb WHERE lb."tenantId" = m."tenantId" AND lb."facilityId" = ${ctx.facilityId}::uuid AND lb."medicineId" = m.id), 0)::int AS locations,
        COALESCE((SELECT SUM(poi.quantity - poi."receivedQuantity") FROM "PurchaseOrderItem" poi JOIN "PurchaseOrder" po ON po.id = poi."orderId" AND po."tenantId" = poi."tenantId"
                  WHERE poi."tenantId" = m."tenantId" AND poi."medicineId" = m.id AND po."facilityId" = ${ctx.facilityId}::uuid AND po.status IN ('DRAFT', 'ISSUED', 'PARTIALLY_RECEIVED')), 0)::int AS "onOrder",
        COALESCE((SELECT SUM(ii.quantity - ii."orderedQuantity") FROM "PurchaseIndentItem" ii JOIN "PurchaseIndent" i ON i.id = ii."indentId" AND i."tenantId" = ii."tenantId"
                  WHERE ii."tenantId" = m."tenantId" AND ii."medicineId" = m.id AND i."facilityId" = ${ctx.facilityId}::uuid AND i.status IN ('SUBMITTED', 'APPROVED')), 0)::int AS indented
      FROM "Medicine" m WHERE m."tenantId" = ${ctx.tenantId}::uuid AND m.status = 'ACTIVE' AND m."reorderLevel" > 0`;
    const items = rows.map((r) => {
      const onHand = r.main + r.locations;
      const position = onHand + r.onOrder + r.indented;
      return { medicineId: r.id, medicine: nameOf(r), generic: r.genericName, reorderLevel: r.reorderLevel, mainStore: r.main, locations: r.locations, onHand, onOrder: r.onOrder, onIndent: r.indented, position, suggestedQuantity: position <= r.reorderLevel ? Math.max(1, r.reorderLevel * 2 - position) : 0 };
    }).filter((r) => r.suggestedQuantity > 0).sort((a, b) => b.suggestedQuantity - a.suggestedQuantity || a.medicine.localeCompare(b.medicine));
    return { items: items.slice(0, 500), total: items.length };
  }

  // ───── indents ─────

  private async indentView(db: Db, ctx: RequestContext, id: string) {
    const i = await db.purchaseIndent.findFirstOrThrow({
      where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      include: { items: { orderBy: { lineNo: "asc" }, include: { medicine: { select: { brandName: true, strength: true } } } }, forLocation: { select: { name: true } }, orders: { select: { id: true, poNumber: true, status: true } } },
    });
    const ids = [...new Set([i.requestedById, ...(i.decidedById ? [i.decidedById] : []), ...(i.firstApprovedById ? [i.firstApprovedById] : [])])];
    const users = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return {
      id: i.id, indentNumber: i.indentNumber, status: i.status, forLocationId: i.forLocationId, forLocation: i.forLocation?.name ?? "Main store", note: i.note,
      requestedAt: i.requestedAt, requestedById: i.requestedById, requestedBy: users.get(i.requestedById) ?? null, submittedAt: i.submittedAt,
      decidedAt: i.decidedAt, decidedBy: i.decidedById ? users.get(i.decidedById) ?? null : null, decisionNote: i.decisionNote, cancelReason: i.cancelReason,
      approvalsRequired: i.approvalsRequired, estimatedValue: i.estimatedValue ? new Decimal(i.estimatedValue.toString()).toFixed(2) : null, firstApprovedAt: i.firstApprovedAt, firstApprovedBy: i.firstApprovedById ? users.get(i.firstApprovedById) ?? null : null,
      awaitingSecondApproval: i.status === "SUBMITTED" && i.approvalsRequired === 2 && i.firstApprovedById !== null,
      items: i.items.map((x) => ({ id: x.id, lineNo: x.lineNo, medicineId: x.medicineId, medicine: nameOf(x.medicine), quantity: x.quantity, orderedQuantity: x.orderedQuantity, note: x.note })),
      orders: i.orders.map((o) => ({ id: o.id, poNumber: o.poNumber, status: o.status })),
    };
  }

  private async checkIndentBody(tx: Db, ctx: RequestContext, input: z.infer<typeof indentSchema>) {
    const meds = await tx.medicine.count({ where: { tenantId: ctx.tenantId, status: "ACTIVE", id: { in: input.items.map((i) => i.medicineId) } } });
    if (meds !== input.items.length) throw new DomainError("VALIDATION_FAILED", "A medicine does not exist or is inactive", 400, [{ path: "items", message: "Unknown medicine" }]);
    if (input.forLocationId) {
      const loc = await tx.stockLocation.findFirst({ where: { id: input.forLocationId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true } });
      if (!loc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    }
  }

  async createIndent(ctx: RequestContext, input: z.infer<typeof indentSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.checkIndentBody(tx, ctx, input);
      const indentNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "INDENT");
      const i = await tx.purchaseIndent.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, indentNumber, forLocationId: input.forLocationId ?? null, note: input.note || null, requestedById: ctx.userId }, select: { id: true } });
      await tx.purchaseIndentItem.createMany({ data: input.items.map((x, n) => ({ tenantId: ctx.tenantId, indentId: i.id, lineNo: n + 1, medicineId: x.medicineId, quantity: x.quantity, note: x.note || null })) });
      await this.audit.record(tx, actorOf(ctx), { action: "INDENT_CREATED", entityType: "PurchaseIndent", entityId: i.id, metadata: { indentNumber, lines: input.items.length } });
      return this.indentView(tx, ctx, i.id);
    });
  }

  private async lockIndent(tx: Db, ctx: RequestContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PurchaseIndent" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.purchaseIndent.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
  }

  /** The person who raised an indent works on it while it is a draft; anyone else with the permission to order or approve may read it. */
  private canSeeAll(ctx: RequestContext): boolean { return ["PURCHASE_ORDER", "PURCHASE_APPROVE", "PURCHASE_READ"].some((p) => ctx.permissions.has(p as never)); }

  async updateIndent(ctx: RequestContext, id: string, input: z.infer<typeof indentSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const i = await this.lockIndent(tx, ctx, id);
      if (i.requestedById !== ctx.userId) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (i.status !== "DRAFT") throw new DomainError("INVALID_STATE", "Only a draft indent can be changed", 409);
      await this.checkIndentBody(tx, ctx, input);
      await tx.purchaseIndentItem.deleteMany({ where: { tenantId: ctx.tenantId, indentId: id } });
      await tx.purchaseIndentItem.createMany({ data: input.items.map((x, n) => ({ tenantId: ctx.tenantId, indentId: id, lineNo: n + 1, medicineId: x.medicineId, quantity: x.quantity, note: x.note || null })) });
      await tx.purchaseIndent.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { note: input.note || null, forLocationId: input.forLocationId ?? null } });
      await this.audit.record(tx, actorOf(ctx), { action: "INDENT_UPDATED", entityType: "PurchaseIndent", entityId: id, metadata: { indentNumber: i.indentNumber, lines: input.items.length } });
      return this.indentView(tx, ctx, id);
    });
  }

  async submitIndent(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const i = await this.lockIndent(tx, ctx, id);
      if (i.requestedById !== ctx.userId) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (i.status !== "DRAFT") throw new DomainError("INVALID_STATE", "Only a draft indent can be submitted", 409);
      // The estimate: each line at the latest price this hospital paid for the medicine. It fixes how many approvers the indent needs, whatever the limit becomes later.
      const est = await tx.$queryRaw<{ value: string | null }[]>`
        SELECT SUM(ii.quantity * COALESCE((SELECT b."purchasePrice" FROM "MedicineBatch" b WHERE b."tenantId" = ii."tenantId" AND b."medicineId" = ii."medicineId" ORDER BY b."createdAt" DESC, b.id DESC LIMIT 1), 0))::text AS value
        FROM "PurchaseIndentItem" ii WHERE ii."tenantId" = ${ctx.tenantId}::uuid AND ii."indentId" = ${id}::uuid`;
      const estimated = new Decimal(est[0]?.value ?? "0").toDecimalPlaces(2);
      const limit = new Decimal(String(await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "INDENT_SECOND_APPROVAL_LIMIT")));
      const approvalsRequired = limit.gt(0) && estimated.gt(limit) ? 2 : 1;
      await tx.purchaseIndent.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "SUBMITTED", submittedAt: new Date(), approvalsRequired, estimatedValue: estimated.toString() } });
      await this.audit.record(tx, actorOf(ctx), { action: "INDENT_SUBMITTED", entityType: "PurchaseIndent", entityId: id, metadata: { indentNumber: i.indentNumber } });
      return this.indentView(tx, ctx, id);
    });
  }

  /** Approval is by someone other than the person who asked, with the purchase-approval permission. The database enforces it as well. */
  async decideIndent(ctx: RequestContext, id: string, decision: "APPROVE" | "REJECT", note: string | undefined) {
    return this.prisma.$transaction(async (tx) => {
      const i = await this.lockIndent(tx, ctx, id);
      if (i.status !== "SUBMITTED") throw new DomainError("INVALID_STATE", "Only a submitted indent can be approved or rejected", 409);
      if (i.requestedById === ctx.userId) throw new DomainError("SELF_APPROVAL", "An indent cannot be approved by the person who raised it", 409);
      if (decision === "REJECT" && (!note || note.length < 5)) throw new DomainError("VALIDATION_FAILED", "Give the reason for rejecting the indent", 400, [{ path: "reason", message: "Required" }]);
      // Above the limit an indent needs two different approvers: the first approval waits on the indent, and the second decides it.
      if (decision === "APPROVE" && i.approvalsRequired === 2 && !i.firstApprovedById) {
        await tx.purchaseIndent.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { firstApprovedById: ctx.userId, firstApprovedAt: new Date() } });
        await this.audit.record(tx, actorOf(ctx), { action: "INDENT_FIRST_APPROVED", entityType: "PurchaseIndent", entityId: id, metadata: { indentNumber: i.indentNumber } });
        return this.indentView(tx, ctx, id);
      }
      if (i.firstApprovedById === ctx.userId) throw new DomainError("SELF_APPROVAL", "The second decision must be by someone other than the first approver", 409);
      await tx.purchaseIndent.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: decision === "APPROVE" ? "APPROVED" : "REJECTED", decidedById: ctx.userId, decidedAt: new Date(), decisionNote: note || null } });
      await this.audit.record(tx, actorOf(ctx), { action: decision === "APPROVE" ? "INDENT_APPROVED" : "INDENT_REJECTED", entityType: "PurchaseIndent", entityId: id, metadata: { indentNumber: i.indentNumber } });
      return this.indentView(tx, ctx, id);
    });
  }

  async cancelIndent(ctx: RequestContext, id: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const i = await this.lockIndent(tx, ctx, id);
      const mine = i.requestedById === ctx.userId;
      if (!mine && !ctx.permissions.has("PURCHASE_ORDER") && !ctx.permissions.has("PURCHASE_APPROVE")) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!["DRAFT", "SUBMITTED", "APPROVED"].includes(i.status)) throw new DomainError("INVALID_STATE", `This indent is already ${i.status.toLowerCase()}`, 409);
      if ((await tx.purchaseIndentItem.count({ where: { tenantId: ctx.tenantId, indentId: id, orderedQuantity: { gt: 0 } } })) > 0) throw new DomainError("INVALID_STATE", "Part of this indent is already on a purchase order; cancel that order first", 409);
      await tx.purchaseIndent.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CANCELLED", cancelledById: ctx.userId, cancelledAt: new Date(), cancelReason: reason } });
      await this.audit.record(tx, actorOf(ctx), { action: "INDENT_CANCELLED", entityType: "PurchaseIndent", entityId: id, metadata: { indentNumber: i.indentNumber } });
      return this.indentView(tx, ctx, id);
    });
  }

  async listIndents(ctx: RequestContext, q: z.infer<typeof listSchema>) {
    const where: Prisma.PurchaseIndentWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status as never } : {}), ...(!this.canSeeAll(ctx) || q.mine ? { requestedById: ctx.userId } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.purchaseIndent.findMany({ where, orderBy: [{ requestedAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
      this.prisma.purchaseIndent.count({ where }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: await Promise.all(rows.map((r) => this.indentView(this.prisma, ctx, r.id))) };
  }

  async getIndent(ctx: RequestContext, id: string) {
    const i = await this.prisma.purchaseIndent.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { requestedById: true } });
    if (!i || (!this.canSeeAll(ctx) && i.requestedById !== ctx.userId)) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.indentView(this.prisma, ctx, id);
  }

  // ───── purchase orders ─────

  private async orderView(db: Db, ctx: RequestContext, id: string) {
    const o = await db.purchaseOrder.findFirstOrThrow({
      where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      include: { supplier: { select: { name: true } }, indent: { select: { indentNumber: true } }, items: { orderBy: { lineNo: "asc" }, include: { medicine: { select: { brandName: true, strength: true } } } }, receipts: { orderBy: { receivedAt: "asc" }, select: { id: true, purchaseNumber: true, receivedAt: true } } },
    });
    const ids = [...new Set([o.createdById, ...(o.issuedById ? [o.issuedById] : []), ...(o.approvedById ? [o.approvedById] : []), ...(o.secondApprovedById ? [o.secondApprovedById] : [])])];
    const users = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return {
      id: o.id, poNumber: o.poNumber, status: o.status, supplierId: o.supplierId, supplier: o.supplier.name, indentNumber: o.indent?.indentNumber ?? null, expectedOn: day(o.expectedOn), notes: o.notes,
      subtotal: fmt(o.subtotal), taxTotal: fmt(o.taxTotal), total: fmt(o.total), createdAt: o.createdAt, createdById: o.createdById, createdBy: users.get(o.createdById) ?? null,
      approvedBy: o.approvedById ? users.get(o.approvedById) ?? null : null, secondApprovedBy: o.secondApprovedById ? users.get(o.secondApprovedById) ?? null : null, approvalsNeeded: await this.approvalsNeeded(db, ctx, new Decimal(o.total.toString())), issuedAt: o.issuedAt, issuedBy: o.issuedById ? users.get(o.issuedById) ?? null : null, closeReason: o.closeReason,
      items: o.items.map((x) => ({ id: x.id, lineNo: x.lineNo, medicineId: x.medicineId, medicine: nameOf(x.medicine), quantity: x.quantity, receivedQuantity: x.receivedQuantity, pendingQuantity: x.quantity - x.receivedQuantity, rate: fmt(x.rate), gstPercent: fmt(x.gstPercent), lineTotal: fmt(x.lineTotal) })),
      receipts: o.receipts.map((r) => ({ id: r.id, purchaseNumber: r.purchaseNumber, receivedAt: r.receivedAt })),
    };
  }

  async createOrder(ctx: RequestContext, input: z.infer<typeof orderSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
      if (!supplier) throw new DomainError("VALIDATION_FAILED", "Supplier not found or inactive", 400, [{ path: "supplierId", message: "Unknown supplier" }]);
      const meds = await tx.medicine.findMany({ where: { tenantId: ctx.tenantId, status: "ACTIVE", id: { in: input.items.map((i) => i.medicineId) } } });
      if (meds.length !== input.items.length) throw new DomainError("VALIDATION_FAILED", "A medicine does not exist or is inactive", 400, [{ path: "items", message: "Unknown medicine" }]);
      const gstOf = new Map(meds.map((m) => [m.id, new Decimal(m.gstPercent.toString())]));
      let indentLines = new Map<string, { id: string; medicineId: string; left: number }>();
      if (input.indentId) {
        const indent = await this.lockIndent(tx, ctx, input.indentId);
        if (indent.status !== "APPROVED") throw new DomainError("INVALID_STATE", "Only an approved indent can be ordered", 409);
        const lines = await tx.purchaseIndentItem.findMany({ where: { tenantId: ctx.tenantId, indentId: indent.id } });
        indentLines = new Map(lines.map((l) => [l.id, { id: l.id, medicineId: l.medicineId, left: l.quantity - l.orderedQuantity }]));
        for (const [n, it] of input.items.entries()) {
          const line = it.indentItemId ? indentLines.get(it.indentItemId) : [...indentLines.values()].find((l) => l.medicineId === it.medicineId);
          if (!line || line.medicineId !== it.medicineId) throw new DomainError("VALIDATION_FAILED", "A line is not on the indent", 400, [{ path: `items.${n}.medicineId`, message: "Not on the indent" }]);
          if (it.quantity > line.left) throw new DomainError("VALIDATION_FAILED", `Only ${line.left} unit(s) of this item are still to be ordered on the indent`, 400, [{ path: `items.${n}.quantity`, message: "More than the indent still needs" }]);
          it.indentItemId = line.id;
        }
      } else if (input.items.some((i) => i.indentItemId)) {
        throw new DomainError("VALIDATION_FAILED", "Name the indent these lines come from", 400, [{ path: "indentId", message: "Required" }]);
      }
      const lines = input.items.map((it) => {
        const gst = it.gstPercent ?? gstOf.get(it.medicineId) ?? new Decimal(0);
        const net = round2(it.rate.times(it.quantity));
        return { ...it, gst, net, tax: round2(net.times(gst).div(100)) };
      });
      const subtotal = lines.reduce((a, l) => a.plus(l.net), new Decimal(0));
      const taxTotal = lines.reduce((a, l) => a.plus(l.tax), new Decimal(0));
      const poNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "PURCHASE_ORDER");
      const o = await tx.purchaseOrder.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, poNumber, supplierId: supplier.id, indentId: input.indentId ?? null, expectedOn: input.expectedOn ? dateOnly(input.expectedOn) : null, notes: input.notes || null, subtotal: subtotal.toFixed(2), taxTotal: taxTotal.toFixed(2), total: subtotal.plus(taxTotal).toFixed(2), createdById: ctx.userId }, select: { id: true } });
      await tx.purchaseOrderItem.createMany({ data: lines.map((l, n) => ({ tenantId: ctx.tenantId, orderId: o.id, lineNo: n + 1, medicineId: l.medicineId, indentItemId: l.indentItemId ?? null, quantity: l.quantity, rate: l.rate.toFixed(2), gstPercent: l.gst.toFixed(2), lineTotal: l.net.plus(l.tax).toFixed(2) })) });
      if (input.indentId) {
        for (const l of lines) await tx.purchaseIndentItem.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: l.indentItemId! } }, data: { orderedQuantity: { increment: l.quantity } } });
        const open = await tx.purchaseIndentItem.findMany({ where: { tenantId: ctx.tenantId, indentId: input.indentId }, select: { quantity: true, orderedQuantity: true } });
        if (open.every((x) => x.orderedQuantity === x.quantity)) await tx.purchaseIndent.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: input.indentId } }, data: { status: "ORDERED" } });
      }
      await this.audit.record(tx, actorOf(ctx), { action: "PURCHASE_ORDER_CREATED", entityType: "PurchaseOrder", entityId: o.id, metadata: { poNumber, supplierId: supplier.id, lines: lines.length, total: fmt(subtotal.plus(taxTotal)), ...(input.indentId ? { indentId: input.indentId } : {}) } });
      return this.orderView(tx, ctx, o.id);
    });
  }

  private async lockOrder(tx: Db, ctx: RequestContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PurchaseOrder" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.purchaseOrder.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
  }

  /** How many people other than the maker must approve an order of this value before it is issued: none, one (the person who issues it), or two (one approves, another issues). */
  private async approvalsNeeded(db: Db, ctx: RequestContext, total: Decimal): Promise<0 | 1 | 2> {
    const first = new Decimal(String(await this.settings.get(db, ctx.tenantId, ctx.facilityId, "PO_APPROVAL_LIMIT")));
    const second = new Decimal(String(await this.settings.get(db, ctx.tenantId, ctx.facilityId, "PO_SECOND_APPROVAL_LIMIT")));
    if (second.gt(0) && total.gt(second)) return 2;
    return first.gt(0) && total.gt(first) ? 1 : 0;
  }

  /**
   * The first approval of an order that needs two (it stays a draft). Someone with purchase-approval rights other than the maker records it; a different person then issues the order,
   * which is the second approval. Orders that need one approval or none are not approved separately: the person who issues them is the approver.
   */
  async approveOrder(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const o = await this.lockOrder(tx, ctx, id);
      if (o.status !== "DRAFT") throw new DomainError("INVALID_STATE", `This order is already ${o.status.toLowerCase().replace("_", " ")}`, 409);
      if ((await this.approvalsNeeded(tx, ctx, new Decimal(o.total.toString()))) !== 2) throw new DomainError("INVALID_STATE", "This order does not need a separate first approval: issue it", 409);
      if (o.approvedById) throw new DomainError("INVALID_STATE", "This order already has its first approval", 409);
      if (o.createdById === ctx.userId) throw new DomainError("SELF_APPROVAL", "An order cannot be approved by the person who made it", 409);
      await tx.purchaseOrder.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { approvedById: ctx.userId, approvedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), { action: "PURCHASE_ORDER_APPROVED", entityType: "PurchaseOrder", entityId: id, metadata: { poNumber: o.poNumber, total: fmt(o.total) } });
      return this.orderView(tx, ctx, id);
    });
  }

  /** Issuing sends the order to the supplier: its lines are fixed from now on. Above the approval limit a person with approval rights other than the maker issues it (above the second limit, after another has approved it). */
  async issueOrder(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const o = await this.lockOrder(tx, ctx, id);
      if (o.status !== "DRAFT") throw new DomainError("INVALID_STATE", `This order is already ${o.status.toLowerCase().replace("_", " ")}`, 409);
      const needed = await this.approvalsNeeded(tx, ctx, new Decimal(o.total.toString()));
      if (needed > 0) {
        if (!ctx.permissions.has("PURCHASE_APPROVE")) throw new DomainError("NEEDS_APPROVAL", `An order of ${fmt(o.total)} must be issued by a person with purchase-approval rights`, 403);
        if (o.createdById === ctx.userId) throw new DomainError("SELF_APPROVAL", "An order above the approval limit cannot be approved by the person who made it", 409);
      }
      if (needed === 2) {
        if (!o.approvedById) throw new DomainError("NEEDS_APPROVAL", "An order of this value needs a first approval before it can be issued", 409);
        if (o.approvedById === ctx.userId) throw new DomainError("SELF_APPROVAL", "The second approval must be by someone other than the first approver", 409);
      }
      const at = new Date();
      await tx.purchaseOrder.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "ISSUED", issuedById: ctx.userId, issuedAt: at, ...(needed === 1 ? { approvedById: ctx.userId, approvedAt: at } : {}), ...(needed === 2 ? { secondApprovedById: ctx.userId, secondApprovedAt: at } : {}) } });
      await this.audit.record(tx, actorOf(ctx), { action: "PURCHASE_ORDER_ISSUED", entityType: "PurchaseOrder", entityId: id, metadata: { poNumber: o.poNumber, total: fmt(o.total), ...(needed > 0 ? { approvals: needed } : {}) } });
      return this.orderView(tx, ctx, id);
    });
  }

  /** Cancelling is possible until something has been received; the quantities go back to the indent. */
  async cancelOrder(ctx: RequestContext, id: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const o = await this.lockOrder(tx, ctx, id);
      if (!["DRAFT", "ISSUED"].includes(o.status)) throw new DomainError("INVALID_STATE", o.status === "PARTIALLY_RECEIVED" ? "Goods have been received against this order: close it instead" : `This order is already ${o.status.toLowerCase()}`, 409);
      const lines = await tx.purchaseOrderItem.findMany({ where: { tenantId: ctx.tenantId, orderId: id } });
      if (lines.some((l) => l.receivedQuantity > 0)) throw new DomainError("INVALID_STATE", "Goods have been received against this order: close it instead", 409);
      await tx.purchaseOrder.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CANCELLED", closedById: ctx.userId, closedAt: new Date(), closeReason: reason } });
      if (o.indentId) {
        for (const l of lines) if (l.indentItemId) await tx.purchaseIndentItem.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: l.indentItemId } }, data: { orderedQuantity: { decrement: l.quantity } } });
        await tx.purchaseIndent.updateMany({ where: { id: o.indentId, tenantId: ctx.tenantId, status: "ORDERED" }, data: { status: "APPROVED" } });
      }
      await this.audit.record(tx, actorOf(ctx), { action: "PURCHASE_ORDER_CANCELLED", entityType: "PurchaseOrder", entityId: id, metadata: { poNumber: o.poNumber } });
      return this.orderView(tx, ctx, id);
    });
  }

  /** Closing short ends an order the supplier cannot finish: what arrived stays in stock, the rest is no longer expected. */
  async closeOrder(ctx: RequestContext, id: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const o = await this.lockOrder(tx, ctx, id);
      if (!["ISSUED", "PARTIALLY_RECEIVED"].includes(o.status)) throw new DomainError("INVALID_STATE", `This order is ${o.status.toLowerCase().replace("_", " ")}`, 409);
      await tx.purchaseOrder.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CLOSED", closedById: ctx.userId, closedAt: new Date(), closeReason: reason } });
      await this.audit.record(tx, actorOf(ctx), { action: "PURCHASE_ORDER_CLOSED", entityType: "PurchaseOrder", entityId: id, metadata: { poNumber: o.poNumber } });
      return this.orderView(tx, ctx, id);
    });
  }

  async listOrders(ctx: RequestContext, q: z.infer<typeof listSchema>) {
    const where: Prisma.PurchaseOrderWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status as never } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: await Promise.all(rows.map((r) => this.orderView(this.prisma, ctx, r.id))) };
  }

  async getOrder(ctx: RequestContext, id: string) {
    const o = await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
    if (!o) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.orderView(this.prisma, ctx, id);
  }
}
