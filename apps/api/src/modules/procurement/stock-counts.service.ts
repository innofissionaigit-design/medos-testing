import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt } from "../billing/billing.domain";
import { NumberingService } from "../numbering/numbering.service";
import { StockLocationsService } from "../pharmacy/stock-locations.service";
import { StockService } from "../pharmacy/stock.service";

const uuid = z.string().uuid();
const MAIN_STORE = "Main store";

export const startCountSchema = z.object({ locationId: uuid.nullish(), note: z.string().trim().max(500).optional() }).strict();
export const enterCountsSchema = z.object({
  items: z.array(z.object({ itemId: uuid, countedQuantity: z.number().int().min(0).max(1_000_000), reason: z.string().trim().max(240).optional() }).strict()).min(1).max(500),
}).strict();
export const decisionSchema = z.object({ reason: z.string().trim().min(5).max(300) }).strict();
export const approveCountSchema = z.object({ note: z.string().trim().max(300).optional() }).strict();
export const countListSchema = z.object({
  status: z.enum(["OPEN", "SUBMITTED", "APPROVED", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

/**
 * Physical stock counts (docs/procurement.md). A count of the main store or of one location starts by recording what the system holds, batch by batch. The counters enter what
 * they find (and why, wherever it differs); once every batch is counted it is submitted, and someone other than the person who started it approves. Approval posts each
 * difference as a stock adjustment in the ledger (by the amount, so stock that moved during the count stays right) and nothing else changes. A count is never deleted.
 */
@Injectable()
export class StockCountsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService, private readonly stock: StockService, private readonly locations: StockLocationsService) {}

  private async view(db: Db | PrismaService, ctx: RequestContext, id: string) {
    const c = await db.stockCount.findFirstOrThrow({
      where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      include: { location: { select: { name: true } }, items: { include: { batch: { select: { batchNo: true, expiryDate: true, purchasePrice: true, medicine: { select: { brandName: true, strength: true } } } } } } },
    });
    const users = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set([c.startedById, ...(c.decidedById ? [c.decidedById] : [])])] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const items = c.items.map((i) => {
      const diff = i.countedQuantity === null ? null : i.countedQuantity - i.systemQuantity;
      return {
        id: i.id, batchId: i.batchId, medicine: `${i.batch.medicine.brandName} ${i.batch.medicine.strength ?? ""}`.trim(), batchNo: i.batch.batchNo, expiryDate: i.batch.expiryDate.toISOString().slice(0, 10),
        systemQuantity: i.systemQuantity, countedQuantity: i.countedQuantity, difference: diff, reason: i.reason, differenceValue: diff === null ? null : fmt(new Decimal(i.batch.purchasePrice.toString()).times(diff)),
      };
    }).sort((a, b) => a.medicine.localeCompare(b.medicine) || a.batchNo.localeCompare(b.batchNo));
    const counted = items.filter((i) => i.countedQuantity !== null);
    const different = counted.filter((i) => i.difference !== 0);
    return {
      id: c.id, countNumber: c.countNumber, status: c.status, location: c.location?.name ?? MAIN_STORE, locationId: c.locationId, note: c.note,
      startedAt: c.startedAt, startedById: c.startedById, startedBy: users.get(c.startedById) ?? null, submittedAt: c.submittedAt, decidedBy: c.decidedById ? users.get(c.decidedById) ?? null : null, decisionNote: c.decisionNote,
      lines: items.length, counted: counted.length, withDifference: different.length,
      valueOfDifferences: fmt(different.reduce((a, i) => a.plus(i.differenceValue ?? 0), new Decimal(0))),
      items,
    };
  }

  async start(ctx: RequestContext, input: z.infer<typeof startCountSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const locationId = input.locationId ?? null;
      if (locationId) {
        const loc = await tx.stockLocation.findFirst({ where: { id: locationId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
        if (!loc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      }
      const open = await tx.stockCount.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, locationId, status: { in: ["OPEN", "SUBMITTED"] } }, select: { countNumber: true } });
      if (open) throw new DomainError("CONFLICT", `Count ${open.countNumber} of this place is still open: finish or cancel it first`, 409);
      const held = locationId
        ? (await tx.stockLocationBalance.findMany({ where: { tenantId: ctx.tenantId, locationId, quantity: { gt: 0 } }, select: { batchId: true, medicineId: true, quantity: true } }))
        : (await tx.stockBalance.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, quantity: { gt: 0 } }, select: { batchId: true, medicineId: true, quantity: true } }));
      if (held.length === 0) throw new DomainError("INVALID_STATE", "There is no stock here to count", 409);
      const countNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "STOCK_COUNT");
      const c = await tx.stockCount.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, countNumber, locationId, note: input.note || null, startedById: ctx.userId }, select: { id: true } });
      await tx.stockCountItem.createMany({ data: held.map((h) => ({ tenantId: ctx.tenantId, countId: c.id, batchId: h.batchId, medicineId: h.medicineId, systemQuantity: h.quantity })) });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_COUNT_STARTED", entityType: "StockCount", entityId: c.id, metadata: { countNumber, locationId, lines: held.length } });
      return this.view(tx, ctx, c.id);
    });
  }

  async list(ctx: RequestContext, q: z.infer<typeof countListSchema>) {
    const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.stockCount.findMany({ where, orderBy: [{ startedAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
      this.prisma.stockCount.count({ where }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: await Promise.all(rows.map((r) => this.view(this.prisma, ctx, r.id))) };
  }

  async get(ctx: RequestContext, id: string) {
    const c = await this.prisma.stockCount.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.view(this.prisma, ctx, id);
  }

  private async lock(tx: Db, ctx: RequestContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "StockCount" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.stockCount.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, include: { items: { include: { batch: { select: { batchNo: true } } } } } });
  }

  /** The counters enter what they found. Wherever it differs from what the system held, a reason (5+ characters) is needed. Counts can be corrected until submitted. */
  async enter(ctx: RequestContext, id: string, input: z.infer<typeof enterCountsSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (c.status !== "OPEN") throw new DomainError("INVALID_STATE", "The counts can only be entered while the count is open", 409);
      const byId = new Map(c.items.map((i) => [i.id, i]));
      for (const e of input.items) {
        const line = byId.get(e.itemId);
        if (!line) throw new DomainError("VALIDATION_FAILED", "A line is not on this count", 400, [{ path: "items", message: "Not on the count" }]);
        if (e.countedQuantity !== line.systemQuantity && (e.reason ?? "").length < 5) throw new DomainError("VALIDATION_FAILED", `Batch ${line.batch.batchNo} differs from the system: say why (at least 5 characters)`, 400, [{ path: "items", message: "Reason required" }]);
        await tx.stockCountItem.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: line.id } }, data: { countedQuantity: e.countedQuantity, reason: e.countedQuantity === line.systemQuantity ? null : e.reason ?? null } });
      }
      return this.view(tx, ctx, id);
    });
  }

  async submit(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (c.status !== "OPEN") throw new DomainError("INVALID_STATE", "Only an open count can be submitted", 409);
      if (c.startedById !== ctx.userId && !ctx.permissions.has("STOCK_COUNT")) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const left = c.items.filter((i) => i.countedQuantity === null).length;
      if (left > 0) throw new DomainError("INVALID_STATE", `${left} batch(es) have not been counted yet`, 409, { uncounted: left });
      await tx.stockCount.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "SUBMITTED", submittedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_COUNT_SUBMITTED", entityType: "StockCount", entityId: id, metadata: { countNumber: c.countNumber, differences: c.items.filter((i) => i.countedQuantity !== i.systemQuantity).length } });
      return this.view(tx, ctx, id);
    });
  }

  /** Approval by someone other than the person who started the count posts every difference to the ledger as an adjustment. */
  async approve(ctx: RequestContext, id: string, input: z.infer<typeof approveCountSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (c.status !== "SUBMITTED") throw new DomainError("INVALID_STATE", "Only a submitted count can be approved", 409);
      if (c.startedById === ctx.userId) throw new DomainError("SELF_APPROVAL", "A count cannot be approved by the person who started it", 409);
      const loc = c.locationId ? await tx.stockLocation.findFirstOrThrow({ where: { id: c.locationId, tenantId: ctx.tenantId }, select: { name: true } }) : null;
      let posted = 0; let removed = 0; let added = 0;
      // Fixed order (batch id) so two approvals touching the same batches can never deadlock.
      for (const i of [...c.items].sort((a, b) => a.batchId.localeCompare(b.batchId))) {
        const diff = (i.countedQuantity ?? i.systemQuantity) - i.systemQuantity;
        if (diff === 0) continue;
        const direction = diff > 0 ? "IN" : "OUT";
        const quantity = Math.abs(diff);
        try {
          if (c.locationId) await this.locations.postCountDifference(tx, ctx, { locationId: c.locationId, batchId: i.batchId, medicineId: i.medicineId, batchNo: i.batch.batchNo, direction, quantity, countId: c.id, place: loc!.name });
          else await this.stock.move(tx, ctx, { batchId: i.batchId, medicineId: i.medicineId, type: "ADJUSTMENT", direction, quantity, sourceType: "STOCK_COUNT", sourceId: c.id, reason: `Stock count ${c.countNumber}: ${i.reason ?? "difference found"}`.slice(0, 240) });
        } catch (e) {
          if (e instanceof DomainError && e.code === "INSUFFICIENT_STOCK") throw new DomainError("INSUFFICIENT_STOCK", `Batch ${i.batch.batchNo}: the stock has moved since the count and ${quantity} unit(s) can no longer be removed. Cancel this count and count again`, 409);
          throw e;
        }
        posted += 1; if (direction === "OUT") removed += quantity; else added += quantity;
      }
      await tx.stockCount.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "APPROVED", decidedById: ctx.userId, decidedAt: new Date(), decisionNote: input.note || null } });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_COUNT_APPROVED", entityType: "StockCount", entityId: id, metadata: { countNumber: c.countNumber, adjustments: posted, unitsRemoved: removed, unitsAdded: added } });
      return this.view(tx, ctx, id);
    });
  }

  /** An open or submitted count is dropped with a reason; nothing was posted, nothing changes. */
  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof decisionSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (!["OPEN", "SUBMITTED"].includes(c.status)) throw new DomainError("INVALID_STATE", `This count is already ${c.status.toLowerCase()}`, 409);
      await tx.stockCount.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CANCELLED", decidedById: ctx.userId, decidedAt: new Date(), decisionNote: input.reason } });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_COUNT_CANCELLED", entityType: "StockCount", entityId: id, metadata: { countNumber: c.countNumber } });
      return this.view(tx, ctx, id);
    });
  }
}
