import { randomBytes, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { admissionScope } from "../../common/data-scope";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { NumberingService } from "../numbering/numbering.service";
import { StockService } from "./stock.service";

const uuid = z.string().uuid();
const MAIN_STORE = "Main store";

export const createLocationSchema = z.object({
  name: z.string().trim().min(2).max(60),
  /** Short code; made from the name when left out. */
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,16}$/, "Use 2 to 16 letters, digits or -").optional(),
}).strict();
export const updateLocationSchema = z.object({ name: z.string().trim().min(2).max(60).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }).strict()
  .refine((v) => v.name !== undefined || v.status !== undefined, "Nothing to change");

/** A place is a location id, or empty for the main store (the pharmacy's own stock). */
export const transferSchema = z.object({
  fromLocationId: uuid.nullish(),
  toLocationId: uuid.nullish(),
  reason: z.string().trim().min(3).max(240),
  /** Two steps: the stock leaves the sender now and reaches the other place only when someone there confirms it (or it is sent back). */
  twoStep: z.boolean().optional(),
  items: z.array(z.object({ batchId: uuid, quantity: z.number().int().min(1).max(1_000_000) }).strict()).min(1).max(50),
}).strict().superRefine((v, c) => {
  const from = v.fromLocationId ?? null, to = v.toLocationId ?? null;
  if (from === to) c.addIssue({ code: "custom", path: ["toLocationId"], message: "Choose two different places" });
  if (new Set(v.items.map((i) => i.batchId)).size !== v.items.length) c.addIssue({ code: "custom", path: ["items"], message: "Each batch can be listed once" });
});
export const closeTransferSchema = z.object({ note: z.string().trim().min(3).max(240).optional() }).strict();
export const cancelTransferSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();
export const transferListSchema = z.object({
  locationId: uuid.optional(),
  status: z.enum(["RECEIVED", "IN_TRANSIT", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
/** A nurse draws a medicine from a ward store for a patient who is admitted. */
export const wardIssueSchema = z.object({
  locationId: uuid, batchId: uuid, quantity: z.number().int().min(1).max(10_000), remarks: z.string().trim().max(240).optional(),
}).strict();

const codeFrom = (name: string): string => {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 8);
  return (base.length >= 2 ? base : `LOC${base}`).slice(0, 8);
};
const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * Stock locations and transfers (docs/stock-transfers.md). The main store is the pharmacy's own stock and keeps working exactly as before (selling, FEFO,
 * reports); a location is a further place in the facility, such as a ward store, that holds stock moved to it by a transfer. A transfer takes stock out of one
 * place and puts the same stock into the other in one transaction (immediate), or in two steps with the stock in transit between them. Nurses draw medicines
 * for admitted patients from a ward store, which bills the admission. Every movement is in a ledger.
 */
@Injectable()
export class StockLocationsService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService,
    private readonly stock: StockService, private readonly idempotency: IdempotencyService,
  ) {}

  // ───── locations ─────

  async list(ctx: RequestContext) {
    const [rows, totals, onTheWay] = await Promise.all([
      this.prisma.stockLocation.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, orderBy: [{ status: "asc" }, { name: "asc" }], select: { id: true, name: true, code: true, status: true, createdAt: true } }),
      this.prisma.stockLocationBalance.groupBy({ by: ["locationId"], where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, quantity: { gt: 0 } }, _sum: { quantity: true }, _count: { _all: true } }),
      this.prisma.stockTransfer.groupBy({ by: ["toLocationId"], where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "IN_TRANSIT", toLocationId: { not: null } }, _count: { _all: true } }),
    ]);
    const by = new Map(totals.map((t) => [t.locationId, t]));
    const incoming = new Map(onTheWay.map((t) => [t.toLocationId, t._count._all]));
    return rows.map((r) => ({ ...r, units: by.get(r.id)?._sum.quantity ?? 0, batches: by.get(r.id)?._count._all ?? 0, transfersOnTheWay: incoming.get(r.id) ?? 0 }));
  }

  async create(ctx: RequestContext, input: z.infer<typeof createLocationSchema>) {
    const clash = await this.prisma.stockLocation.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, name: { equals: input.name, mode: "insensitive" } }, select: { id: true } });
    if (clash) throw new DomainError("CONFLICT", "A location with this name already exists", 409);
    let code = input.code ?? codeFrom(input.name);
    if (!input.code) {
      for (let i = 0; i < 6 && (await this.prisma.stockLocation.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, code }, select: { id: true } })); i++) code = `${codeFrom(input.name).slice(0, 6)}-${randomBytes(1).toString("hex").toUpperCase()}`;
    } else if (await this.prisma.stockLocation.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, code }, select: { id: true } })) {
      throw new DomainError("CONFLICT", "A location with this code already exists", 409);
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const made = await tx.stockLocation.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, name: input.name, code, createdById: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_LOCATION_CREATED", entityType: "StockLocation", entityId: made.id, metadata: { name: input.name, code } });
      return made;
    });
    return (await this.list(ctx)).find((l) => l.id === row.id);
  }

  async update(ctx: RequestContext, locationId: string, input: z.infer<typeof updateLocationSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const loc = await tx.stockLocation.findFirst({ where: { id: locationId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!loc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (input.name !== undefined && input.name.toLowerCase() !== loc.name.toLowerCase()) {
        const clash = await tx.stockLocation.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, name: { equals: input.name, mode: "insensitive" }, id: { not: loc.id } }, select: { id: true } });
        if (clash) throw new DomainError("CONFLICT", "A location with this name already exists", 409);
      }
      if (input.status === "INACTIVE" && loc.status === "ACTIVE") {
        const held = await tx.stockLocationBalance.aggregate({ where: { tenantId: ctx.tenantId, locationId: loc.id }, _sum: { quantity: true } });
        if ((held._sum.quantity ?? 0) > 0) throw new DomainError("LOCATION_HAS_STOCK", `This location still holds ${held._sum.quantity} unit(s). Move the stock out before making it inactive`, 409, { units: held._sum.quantity });
        const open = await tx.stockTransfer.count({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "IN_TRANSIT", OR: [{ fromLocationId: loc.id }, { toLocationId: loc.id }] } });
        if (open > 0) throw new DomainError("LOCATION_HAS_STOCK", `${open} transfer(s) to or from this location are still on the way. Receive or send them back first`, 409, { transfers: open });
      }
      await tx.stockLocation.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: loc.id } }, data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.status !== undefined ? { status: input.status } : {}) } });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_LOCATION_UPDATED", entityType: "StockLocation", entityId: loc.id, metadata: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.status !== undefined ? { status: input.status, from: loc.status } : {}) } });
    });
    return (await this.list(ctx)).find((l) => l.id === locationId);
  }

  /** What a location holds now, batch by batch, soonest expiry first. */
  async stockOf(ctx: RequestContext, locationId: string) {
    const loc = await this.prisma.stockLocation.findFirst({ where: { id: locationId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, name: true, code: true, status: true } });
    if (!loc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.stockLocationBalance.findMany({
      where: { tenantId: ctx.tenantId, locationId, quantity: { gt: 0 } }, take: 500,
      select: { quantity: true, batch: { select: { id: true, batchNo: true, expiryDate: true, status: true, sellingPrice: true, medicine: { select: { id: true, brandName: true, genericName: true, strength: true, dosageForm: true } } } } },
    });
    const items = rows.map((r) => ({
      batchId: r.batch.id, medicineId: r.batch.medicine.id, brandName: r.batch.medicine.brandName, genericName: r.batch.medicine.genericName, strength: r.batch.medicine.strength, dosageForm: r.batch.medicine.dosageForm,
      batchNo: r.batch.batchNo, expiryDate: r.batch.expiryDate.toISOString().slice(0, 10), batchStatus: r.batch.status, sellingPrice: new Decimal(r.batch.sellingPrice.toString()).toFixed(2), quantity: r.quantity,
    })).sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.brandName.localeCompare(b.brandName) || a.batchNo.localeCompare(b.batchNo));
    return { location: loc, units: items.reduce((n, i) => n + i.quantity, 0), items };
  }

  // ───── transfers ─────

  async transfer(ctx: RequestContext, input: z.infer<typeof transferSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for stock transfers", 400);
    return this.idempotency.run(ctx.tenantId, "STOCK_TRANSFER", key, input, async (tx) => {
      const fromId = input.fromLocationId ?? null, toId = input.toLocationId ?? null;
      const twoStep = input.twoStep === true;
      const places = new Map<string, { id: string; name: string; status: string }>();
      for (const lid of [fromId, toId]) {
        if (!lid) continue;
        const loc = await tx.stockLocation.findFirst({ where: { id: lid, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, name: true, status: true } });
        if (!loc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        places.set(lid, loc);
      }
      const to = toId ? places.get(toId)! : null;
      if (to && to.status !== "ACTIVE") throw new DomainError("INVALID_STATE", `${to.name} is not in use. Make it active before moving stock into it`, 409);

      const items = [...input.items].sort((a, b) => a.batchId.localeCompare(b.batchId));
      const batchIds = items.map((i) => i.batchId);
      const batches = await tx.medicineBatch.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, id: { in: batchIds } }, select: { id: true, medicineId: true, batchNo: true, expiryDate: true, status: true } });
      if (batches.length !== batchIds.length) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const batch = new Map(batches.map((b) => [b.id, b]));
      // Expired or blocked stock can be brought back to the main store (to be written off), but never sent out to a location where it could be used.
      if (toId) {
        const today = await this.stock.today(tx, ctx);
        for (const b of batches) {
          if (b.status !== "ACTIVE") throw new DomainError("INVALID_STATE", `Batch ${b.batchNo} is blocked and cannot be moved into a location`, 409);
          if (b.expiryDate < today) throw new DomainError("INVALID_STATE", `Batch ${b.batchNo} has expired and cannot be moved into a location`, 409);
        }
      }

      // Locks are always taken in the same order (main store rows, then location rows, each by id) so transfers can never deadlock one another.
      const mainInvolved = fromId === null || (toId === null && !twoStep);
      if (mainInvolved) await this.lockMain(tx, ctx, batchIds);
      const locationIds = [fromId, twoStep ? null : toId].filter((x): x is string => x !== null).sort();
      if (toId && !twoStep) await tx.stockLocationBalance.createMany({ data: items.map((i) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, locationId: toId, batchId: i.batchId, medicineId: batch.get(i.batchId)!.medicineId, quantity: 0 })), skipDuplicates: true });
      const held = await this.lockLocationRows(tx, ctx, locationIds, batchIds);

      const transferNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "STOCK_TRANSFER");
      const row = await tx.stockTransfer.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, transferNumber, fromLocationId: fromId, toLocationId: toId, reason: input.reason, status: twoStep ? "IN_TRANSIT" : "RECEIVED", createdById: ctx.userId }, select: { id: true } });
      const fromName = fromId ? places.get(fromId)!.name : MAIN_STORE, toName = toId ? places.get(toId)!.name : MAIN_STORE;
      const note = `Transfer ${transferNumber}: ${fromName} to ${toName}${twoStep ? " (sent, not yet received)" : ""}. ${input.reason}`;
      for (const i of items) {
        const b = batch.get(i.batchId)!;
        await tx.stockTransferItem.create({ data: { tenantId: ctx.tenantId, transferId: row.id, batchId: b.id, medicineId: b.medicineId, quantity: i.quantity } });
        if (fromId === null) await this.stock.move(tx, ctx, { batchId: b.id, medicineId: b.medicineId, type: "TRANSFER", direction: "OUT", quantity: i.quantity, sourceType: "StockTransfer", sourceId: row.id, reason: note });
        else await this.moveInLocation(tx, ctx, { locationId: fromId, batchId: b.id, medicineId: b.medicineId, batchNo: b.batchNo, direction: "OUT", quantity: i.quantity, transferId: row.id, current: held.get(`${fromId}:${b.id}`) ?? 0, place: fromName });
        if (twoStep) continue;
        if (toId === null) await this.stock.move(tx, ctx, { batchId: b.id, medicineId: b.medicineId, type: "TRANSFER", direction: "IN", quantity: i.quantity, sourceType: "StockTransfer", sourceId: row.id, reason: note });
        else await this.moveInLocation(tx, ctx, { locationId: toId, batchId: b.id, medicineId: b.medicineId, batchNo: b.batchNo, direction: "IN", quantity: i.quantity, transferId: row.id, current: held.get(`${toId}:${b.id}`) ?? 0, place: toName });
      }
      await this.audit.record(tx, actorOf(ctx), {
        action: twoStep ? "STOCK_TRANSFER_SENT" : "STOCK_TRANSFERRED", entityType: "StockTransfer", entityId: row.id,
        metadata: { transferNumber, from: fromName, to: toName, batches: items.length, units: items.reduce((n, i) => n + i.quantity, 0), reason: input.reason, twoStep },
      });
      return (await this.views(tx, ctx, { id: row.id })).items[0]!;
    });
  }

  /** The other place confirms that the stock arrived: it now counts there. */
  async receive(ctx: RequestContext, transferId: string, input: z.infer<typeof closeTransferSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required to receive a transfer", 400);
    return this.idempotency.run(ctx.tenantId, `STOCK_TRANSFER_RECEIVE:${transferId}`, key, input, async (tx) => {
      const t = await this.lockInTransit(tx, ctx, transferId);
      const toId = t.toLocationId;
      const to = toId ? await tx.stockLocation.findFirstOrThrow({ where: { id: toId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, name: true, status: true } }) : null;
      if (to && to.status !== "ACTIVE") throw new DomainError("INVALID_STATE", `${to.name} is not in use, so it cannot receive stock. Make it active, or send the transfer back`, 409);
      const items = [...t.items].sort((a, b) => a.batchId.localeCompare(b.batchId));
      const batchIds = items.map((i) => i.batchId);
      const batchNo = new Map((await tx.medicineBatch.findMany({ where: { tenantId: ctx.tenantId, id: { in: batchIds } }, select: { id: true, batchNo: true } })).map((b) => [b.id, b.batchNo]));
      if (toId === null) await this.lockMain(tx, ctx, batchIds);
      if (toId) await tx.stockLocationBalance.createMany({ data: items.map((i) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, locationId: toId, batchId: i.batchId, medicineId: i.medicineId, quantity: 0 })), skipDuplicates: true });
      const held = await this.lockLocationRows(tx, ctx, toId ? [toId] : [], batchIds);
      const note = `Transfer ${t.transferNumber} received. ${t.reason}`;
      for (const i of items) {
        if (toId === null) await this.stock.move(tx, ctx, { batchId: i.batchId, medicineId: i.medicineId, type: "TRANSFER", direction: "IN", quantity: i.quantity, sourceType: "StockTransfer", sourceId: t.id, reason: note });
        else await this.moveInLocation(tx, ctx, { locationId: toId, batchId: i.batchId, medicineId: i.medicineId, batchNo: batchNo.get(i.batchId) ?? "", direction: "IN", quantity: i.quantity, transferId: t.id, current: held.get(`${toId}:${i.batchId}`) ?? 0, place: to?.name ?? MAIN_STORE });
      }
      await tx.stockTransfer.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: t.id } }, data: { status: "RECEIVED", receivedAt: new Date(), receivedById: ctx.userId, closeNote: input.note ?? null } });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_TRANSFER_RECEIVED", entityType: "StockTransfer", entityId: t.id, metadata: { transferNumber: t.transferNumber, units: items.reduce((n, i) => n + i.quantity, 0) } });
      return (await this.views(tx, ctx, { id: t.id })).items[0]!;
    });
  }

  /** The stock did not arrive or is refused: it goes back to the place it was sent from. */
  async cancel(ctx: RequestContext, transferId: string, input: z.infer<typeof cancelTransferSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required to send a transfer back", 400);
    return this.idempotency.run(ctx.tenantId, `STOCK_TRANSFER_CANCEL:${transferId}`, key, input, async (tx) => {
      const t = await this.lockInTransit(tx, ctx, transferId);
      const fromId = t.fromLocationId;
      const from = fromId ? await tx.stockLocation.findFirstOrThrow({ where: { id: fromId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, name: true } }) : null;
      const items = [...t.items].sort((a, b) => a.batchId.localeCompare(b.batchId));
      const batchIds = items.map((i) => i.batchId);
      const batchNo = new Map((await tx.medicineBatch.findMany({ where: { tenantId: ctx.tenantId, id: { in: batchIds } }, select: { id: true, batchNo: true } })).map((b) => [b.id, b.batchNo]));
      if (fromId === null) await this.lockMain(tx, ctx, batchIds);
      const held = await this.lockLocationRows(tx, ctx, fromId ? [fromId] : [], batchIds);
      const note = `Transfer ${t.transferNumber} sent back. ${input.reason}`;
      for (const i of items) {
        if (fromId === null) await this.stock.move(tx, ctx, { batchId: i.batchId, medicineId: i.medicineId, type: "TRANSFER", direction: "IN", quantity: i.quantity, sourceType: "StockTransfer", sourceId: t.id, reason: note });
        else await this.moveInLocation(tx, ctx, { locationId: fromId, batchId: i.batchId, medicineId: i.medicineId, batchNo: batchNo.get(i.batchId) ?? "", direction: "IN", quantity: i.quantity, transferId: t.id, current: held.get(`${fromId}:${i.batchId}`) ?? 0, place: from?.name ?? MAIN_STORE });
      }
      await tx.stockTransfer.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: t.id } }, data: { status: "CANCELLED", receivedAt: new Date(), receivedById: ctx.userId, closeNote: input.reason } });
      await this.audit.record(tx, actorOf(ctx), { action: "STOCK_TRANSFER_CANCELLED", entityType: "StockTransfer", entityId: t.id, metadata: { transferNumber: t.transferNumber, units: items.reduce((n, i) => n + i.quantity, 0), reason: input.reason } });
      return (await this.views(tx, ctx, { id: t.id })).items[0]!;
    });
  }

  private async lockInTransit(tx: Db, ctx: RequestContext, transferId: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "StockTransfer" WHERE id = ${transferId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const t = await tx.stockTransfer.findFirstOrThrow({ where: { id: transferId, tenantId: ctx.tenantId }, include: { items: { select: { batchId: true, medicineId: true, quantity: true } } } });
    if (t.status !== "IN_TRANSIT") throw new DomainError("TRANSFER_NOT_IN_TRANSIT", `This transfer is already ${t.status === "RECEIVED" ? "received" : "sent back"}`, 409);
    return t;
  }

  private async lockMain(tx: Db, ctx: RequestContext, batchIds: string[]) {
    await tx.$queryRaw`SELECT "batchId" FROM "StockBalance" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND "batchId" = ANY(${batchIds}::uuid[]) ORDER BY "batchId" FOR UPDATE`;
  }

  /** Locks the given locations' balance rows for the batches (ordered by location then batch) and returns what they hold. */
  private async lockLocationRows(tx: Db, ctx: RequestContext, locationIds: string[], batchIds: string[]) {
    const held = new Map<string, number>();
    if (locationIds.length === 0) return held;
    const rows = await tx.$queryRaw<{ locationId: string; batchId: string; quantity: number }[]>`
      SELECT "locationId", "batchId", quantity FROM "StockLocationBalance"
      WHERE "tenantId" = ${ctx.tenantId}::uuid AND "locationId" = ANY(${[...locationIds].sort()}::uuid[]) AND "batchId" = ANY(${batchIds}::uuid[])
      ORDER BY "locationId", "batchId" FOR UPDATE`;
    for (const r of rows) held.set(`${r.locationId}:${r.batchId}`, r.quantity);
    return held;
  }

  /** One movement in a location: the balance row is already locked by the caller; its quantity is `current`. Caused by a transfer, or by an issue to a patient. */
  private async moveInLocation(tx: Db, ctx: RequestContext, m: { locationId: string; batchId: string; medicineId: string; batchNo: string; direction: "IN" | "OUT"; quantity: number; transferId?: string; issueId?: string; current: number; place: string }) {
    const next = m.direction === "IN" ? m.current + m.quantity : m.current - m.quantity;
    if (next < 0) throw new DomainError("INSUFFICIENT_STOCK", `Only ${m.current} unit${m.current === 1 ? "" : "s"} of batch ${m.batchNo} ${m.current === 1 ? "is" : "are"} in ${m.place}`, 409, { available: m.current, requested: m.quantity });
    await tx.stockLocationBalance.updateMany({ where: { tenantId: ctx.tenantId, locationId: m.locationId, batchId: m.batchId }, data: { quantity: next } });
    await tx.stockLocationLedger.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, locationId: m.locationId, batchId: m.batchId, medicineId: m.medicineId, direction: m.direction, quantity: m.quantity, balanceAfter: next, transferId: m.transferId ?? null, issueId: m.issueId ?? null, userId: ctx.userId } });
  }

  async listTransfers(ctx: RequestContext, q: z.infer<typeof transferListSchema>) {
    return this.views(this.prisma, ctx, { locationId: q.locationId, status: q.status, page: q.page, pageSize: q.pageSize });
  }

  private async views(db: Db | PrismaService, ctx: RequestContext, f: { id?: string; locationId?: string | undefined; status?: "RECEIVED" | "IN_TRANSIT" | "CANCELLED" | undefined; page?: number; pageSize?: number }) {
    const where = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(f.id ? { id: f.id } : {}), ...(f.status ? { status: f.status } : {}),
      ...(f.locationId ? { OR: [{ fromLocationId: f.locationId }, { toLocationId: f.locationId }] } : {}),
    };
    const page = f.page ?? 1, pageSize = f.pageSize ?? 25;
    const [rows, total] = await Promise.all([
      db.stockTransfer.findMany({
        where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize,
        select: {
          id: true, transferNumber: true, reason: true, status: true, receivedAt: true, receivedById: true, closeNote: true, createdAt: true, createdById: true,
          from: { select: { id: true, name: true } }, to: { select: { id: true, name: true } },
          items: { select: { batchId: true, quantity: true, batch: { select: { batchNo: true, expiryDate: true, medicine: { select: { brandName: true, genericName: true, strength: true } } } } } },
        },
      }),
      db.stockTransfer.count({ where }),
    ]);
    const users = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.flatMap((r) => [r.createdById, ...(r.receivedById ? [r.receivedById] : [])]))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return {
      total, page, pageSize,
      items: rows.map((r) => ({
        id: r.id, transferNumber: r.transferNumber, reason: r.reason, status: r.status, at: r.createdAt, by: users.get(r.createdById) ?? null,
        closedAt: r.receivedAt, closedBy: r.receivedById ? users.get(r.receivedById) ?? null : null, closeNote: r.closeNote,
        from: r.from ? { id: r.from.id, name: r.from.name } : { id: null, name: MAIN_STORE }, to: r.to ? { id: r.to.id, name: r.to.name } : { id: null, name: MAIN_STORE },
        units: r.items.reduce((n, i) => n + i.quantity, 0),
        items: r.items.map((i) => ({ batchId: i.batchId, medicine: i.batch.medicine.brandName, generic: i.batch.medicine.genericName, strength: i.batch.medicine.strength, batchNo: i.batch.batchNo, expiryDate: i.batch.expiryDate.toISOString().slice(0, 10), quantity: i.quantity })),
      })),
    };
  }

  // ───── ward store use by nurses ─────

  /**
   * A nurse draws a medicine from a ward store for an admitted patient. The stock leaves the location's ledger and the admission is charged the batch's selling
   * price (medicine prices include GST), all in one step. Only an active location, an unexpired and unblocked batch, and an admission that is still open and
   * has no final bill are allowed. A retry with the same Idempotency-Key does not draw twice.
   */
  async issueToPatient(ctx: RequestContext, admissionId: string, input: z.infer<typeof wardIssueSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required to draw from a ward store", 400);
    return this.idempotency.run(ctx.tenantId, "WARD_STORE_ISSUE", key, { admissionId, ...input }, async (tx) => {
      const adm = await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, select: { id: true, patientId: true, status: true, finalInvoiceId: true } });
      if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "This patient is not admitted", 409);
      if (adm.finalInvoiceId) throw new DomainError("INVALID_STATE", "The final bill has already been issued; medicines can no longer be added to this admission", 409);
      const loc = await tx.stockLocation.findFirst({ where: { id: input.locationId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, name: true, status: true } });
      if (!loc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (loc.status !== "ACTIVE") throw new DomainError("INVALID_STATE", `${loc.name} is not in use`, 409);
      const b = await tx.medicineBatch.findFirst({ where: { id: input.batchId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, medicineId: true, batchNo: true, expiryDate: true, status: true, sellingPrice: true, medicine: { select: { brandName: true, strength: true } } } });
      if (!b) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const today = await this.stock.today(tx, ctx);
      if (b.status !== "ACTIVE") throw new DomainError("INVALID_STATE", `Batch ${b.batchNo} is blocked and cannot be used`, 409);
      if (b.expiryDate < today) throw new DomainError("INVALID_STATE", `Batch ${b.batchNo} has expired and cannot be used`, 409);
      const held = await this.lockLocationRows(tx, ctx, [loc.id], [b.id]);
      const issueId = randomUUID();
      await this.moveInLocation(tx, ctx, { locationId: loc.id, batchId: b.id, medicineId: b.medicineId, batchNo: b.batchNo, direction: "OUT", quantity: input.quantity, issueId, current: held.get(`${loc.id}:${b.id}`) ?? 0, place: loc.name });
      const label = `${b.medicine.brandName} ${b.medicine.strength ?? ""}`.trim();
      const charge = await tx.charge.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId: adm.id, type: "MEDICINE", description: `${label} x${input.quantity} (${loc.name})`,
          quantity: String(input.quantity), unitPrice: round2(new Decimal(b.sellingPrice.toString())).toFixed(2), taxPercent: "0", sourceKey: `WARDISSUE:${issueId}`, chargedById: ctx.userId,
        },
        select: { id: true },
      });
      await tx.stockLocationIssue.create({ data: { id: issueId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, locationId: loc.id, batchId: b.id, medicineId: b.medicineId, quantity: input.quantity, admissionId: adm.id, patientId: adm.patientId, chargeId: charge.id, remarks: input.remarks ?? null, issuedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "WARD_STORE_ISSUED", entityType: "StockLocationIssue", entityId: issueId, metadata: { admissionId: adm.id, locationId: loc.id, batchId: b.id, quantity: input.quantity, chargeId: charge.id } });
      return (await this.issueViews(tx, ctx, { id: issueId }))[0]!;
    });
  }

  async issuesOf(ctx: RequestContext, admissionId: string) {
    const adm = await this.prisma.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, select: { id: true } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.issueViews(this.prisma, ctx, { admissionId });
  }

  private async issueViews(db: Db | PrismaService, ctx: RequestContext, f: { id?: string; admissionId?: string }) {
    const rows = await db.stockLocationIssue.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(f.id ? { id: f.id } : {}), ...(f.admissionId ? { admissionId: f.admissionId } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200,
      select: { id: true, quantity: true, remarks: true, createdAt: true, issuedById: true, chargeId: true, location: { select: { id: true, name: true } }, batch: { select: { batchNo: true, sellingPrice: true, medicine: { select: { brandName: true, strength: true } } } } },
    });
    const users = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.issuedById))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id, at: r.createdAt, location: r.location.name, locationId: r.location.id, medicine: `${r.batch.medicine.brandName} ${r.batch.medicine.strength ?? ""}`.trim(), batchNo: r.batch.batchNo, quantity: r.quantity,
      unitPrice: new Decimal(r.batch.sellingPrice.toString()).toFixed(2), amount: round2(new Decimal(r.batch.sellingPrice.toString()).times(r.quantity)).toFixed(2), remarks: r.remarks, by: users.get(r.issuedById) ?? null,
    }));
  }
}
