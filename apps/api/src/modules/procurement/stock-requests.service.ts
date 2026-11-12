import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { NumberingService } from "../numbering/numbering.service";
import { StockLocationsService } from "../pharmacy/stock-locations.service";

const uuid = z.string().uuid();
const qty = z.number().int().min(1).max(1_000_000);
const nameOf = (m: { brandName: string; strength: string | null }) => [m.brandName, m.strength].filter(Boolean).join(" ");

export const stockRequestSchema = z.object({
  locationId: uuid, note: z.string().trim().max(500).optional(),
  items: z.array(z.object({ medicineId: uuid, quantity: qty }).strict()).min(1).max(50),
}).strict().refine((v) => new Set(v.items.map((i) => i.medicineId)).size === v.items.length, { path: ["items"], message: "Each medicine can be listed once" });
export const issueRequestSchema = z.object({ items: z.array(z.object({ requestItemId: uuid, batchId: uuid, quantity: qty }).strict()).min(1).max(50) }).strict();
export const closeRequestSchema = z.object({ reason: z.string().trim().min(5).max(300) }).strict();
export const requestListSchema = z.object({
  status: z.enum(["REQUESTED", "PARTIALLY_ISSUED", "ISSUED", "REJECTED", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

/**
 * A ward, the OT or another store asking the main store for stock (docs/procurement.md). The request says what is needed and where; the store issues it batch by
 * batch with a stock transfer (so the ledgers show exactly what moved), possibly in several goes, or turns it down with a reason. A request is never deleted.
 */
@Injectable()
export class StockRequestsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService, private readonly locations: StockLocationsService, private readonly idempotency: IdempotencyService) {}

  private fulfils(ctx: RequestContext): boolean { return ctx.permissions.has("PHARMACY_ADJUST_STOCK"); }
  private seesAll(ctx: RequestContext): boolean { return this.fulfils(ctx) || ctx.permissions.has("PURCHASE_READ"); }

  private async view(db: Db, ctx: RequestContext, id: string) {
    const r = await db.stockRequest.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { location: { select: { name: true } }, items: { orderBy: { lineNo: "asc" }, include: { medicine: { select: { brandName: true, strength: true } } } } } });
    const users = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set([r.requestedById, ...(r.closedById ? [r.closedById] : [])])] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return {
      id: r.id, requestNumber: r.requestNumber, status: r.status, location: r.location.name, locationId: r.locationId, note: r.note, requestedAt: r.requestedAt, requestedById: r.requestedById, requestedBy: users.get(r.requestedById) ?? null,
      closedBy: r.closedById ? users.get(r.closedById) ?? null : null, closeReason: r.closeReason,
      items: r.items.map((i) => ({ id: i.id, lineNo: i.lineNo, medicineId: i.medicineId, medicine: nameOf(i.medicine), quantity: i.quantity, issuedQuantity: i.issuedQuantity, pendingQuantity: i.quantity - i.issuedQuantity })),
    };
  }

  async create(ctx: RequestContext, input: z.infer<typeof stockRequestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const loc = await tx.stockLocation.findFirst({ where: { id: input.locationId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true } });
      if (!loc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const meds = await tx.medicine.count({ where: { tenantId: ctx.tenantId, status: "ACTIVE", id: { in: input.items.map((i) => i.medicineId) } } });
      if (meds !== input.items.length) throw new DomainError("VALIDATION_FAILED", "A medicine does not exist or is inactive", 400, [{ path: "items", message: "Unknown medicine" }]);
      const requestNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "STOCK_REQUEST");
      const r = await tx.stockRequest.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, requestNumber, locationId: loc.id, note: input.note || null, requestedById: ctx.userId }, select: { id: true } });
      await tx.stockRequestItem.createMany({ data: input.items.map((i, n) => ({ tenantId: ctx.tenantId, requestId: r.id, lineNo: n + 1, medicineId: i.medicineId, quantity: i.quantity })) });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_REQUEST_CREATED", entityType: "StockRequest", entityId: r.id, metadata: { requestNumber, locationId: loc.id, lines: input.items.length } });
      return this.view(tx, ctx, r.id);
    });
  }

  async list(ctx: RequestContext, q: z.infer<typeof requestListSchema>) {
    const where: Prisma.StockRequestWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status } : {}), ...(this.seesAll(ctx) ? {} : { requestedById: ctx.userId }) };
    const [rows, total] = await Promise.all([
      this.prisma.stockRequest.findMany({ where, orderBy: [{ requestedAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
      this.prisma.stockRequest.count({ where }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: await Promise.all(rows.map((r) => this.view(this.prisma, ctx, r.id))) };
  }

  async get(ctx: RequestContext, id: string) {
    const r = await this.prisma.stockRequest.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { requestedById: true } });
    if (!r || (!this.seesAll(ctx) && r.requestedById !== ctx.userId)) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.view(this.prisma, ctx, id);
  }

  private async lock(tx: Db, ctx: RequestContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "StockRequest" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.stockRequest.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, include: { items: true } });
  }

  /**
   * The store issues what it can, batch by batch: the stock moves from the main store to the requesting location in one transfer (same checks as any transfer: no expired
   * or blocked batch, enough in stock), and each line's issued quantity rises. A line can be issued in several goes but never beyond what was asked for.
   */
  async issue(ctx: RequestContext, id: string, input: z.infer<typeof issueRequestSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required to issue a stock request", 400);
    return this.idempotency.run(ctx.tenantId, `STOCK_REQUEST_ISSUE:${id}`, key, input, async (tx) => {
      const r = await this.lock(tx, ctx, id);
      if (!["REQUESTED", "PARTIALLY_ISSUED"].includes(r.status)) throw new DomainError("INVALID_STATE", `This request is already ${r.status.toLowerCase().replace("_", " ")}`, 409);
      const lineOf = new Map(r.items.map((i) => [i.id, i]));
      const asked = new Map<string, number>();
      const byBatch = new Map<string, number>();
      for (const it of input.items) {
        const line = lineOf.get(it.requestItemId);
        if (!line) throw new DomainError("VALIDATION_FAILED", "A line is not on this request", 400, [{ path: "items", message: "Not on the request" }]);
        const batch = await tx.medicineBatch.findFirst({ where: { id: it.batchId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, medicineId: true } });
        if (!batch) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        if (batch.medicineId !== line.medicineId) throw new DomainError("VALIDATION_FAILED", "The batch is of a different medicine than the line asks for", 400, [{ path: "items", message: "Wrong medicine" }]);
        const total = (asked.get(line.id) ?? 0) + it.quantity;
        asked.set(line.id, total);
        if (total > line.quantity - line.issuedQuantity) throw new DomainError("OVER_RECEIPT", `Only ${line.quantity - line.issuedQuantity} unit(s) of this item are still to be issued on the request`, 409, { pending: line.quantity - line.issuedQuantity });
        byBatch.set(it.batchId, (byBatch.get(it.batchId) ?? 0) + it.quantity);
      }
      const moved = await this.locations.transferInTx(tx, ctx, { fromLocationId: null, toLocationId: r.locationId, reason: `Stock request ${r.requestNumber}`, items: [...byBatch.entries()].map(([batchId, quantity]) => ({ batchId, quantity })) });
      for (const [lineId, n] of asked) await tx.stockRequestItem.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: lineId } }, data: { issuedQuantity: { increment: n } } });
      const after = await tx.stockRequestItem.findMany({ where: { tenantId: ctx.tenantId, requestId: id }, select: { quantity: true, issuedQuantity: true } });
      const status = after.every((x) => x.issuedQuantity === x.quantity) ? "ISSUED" : "PARTIALLY_ISSUED";
      await tx.stockRequest.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status } });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_REQUEST_ISSUED", entityType: "StockRequest", entityId: id, metadata: { requestNumber: r.requestNumber, transfer: moved.transferNumber, units: [...asked.values()].reduce((a, b) => a + b, 0), status } });
      return this.view(tx, ctx, id);
    });
  }

  /** The store turns the whole request down (nothing issued yet), with a reason. */
  async reject(ctx: RequestContext, id: string, input: z.infer<typeof closeRequestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, ctx, id);
      if (r.status !== "REQUESTED") throw new DomainError("INVALID_STATE", r.status === "PARTIALLY_ISSUED" ? "Part of this request has been issued: cancel the rest instead" : `This request is already ${r.status.toLowerCase()}`, 409);
      await tx.stockRequest.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "REJECTED", closedById: ctx.userId, closedAt: new Date(), closeReason: input.reason } });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_REQUEST_REJECTED", entityType: "StockRequest", entityId: id, metadata: { requestNumber: r.requestNumber } });
      return this.view(tx, ctx, id);
    });
  }

  /** The requester (or the store) drops what has not been issued. Issued stock stays where it went. */
  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof closeRequestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, ctx, id);
      if (r.requestedById !== ctx.userId && !this.fulfils(ctx)) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!["REQUESTED", "PARTIALLY_ISSUED"].includes(r.status)) throw new DomainError("INVALID_STATE", `This request is already ${r.status.toLowerCase().replace("_", " ")}`, 409);
      await tx.stockRequest.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CANCELLED", closedById: ctx.userId, closedAt: new Date(), closeReason: input.reason } });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_REQUEST_CANCELLED", entityType: "StockRequest", entityId: id, metadata: { requestNumber: r.requestNumber } });
      return this.view(tx, ctx, id);
    });
  }
}
