import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

const text = (max: number) => z.string().trim().max(max);

export const requestSchema = z.object({
  kind: z.enum(["CLEANING", "MAINTENANCE", "WASTE", "LINEN", "OTHER"]),
  priority: z.enum(["ROUTINE", "URGENT"]).default("ROUTINE"),
  location: text(120).min(2),
  description: text(300).optional(),
}).strict();
export const doneSchema = z.object({ note: text(300).optional() }).strict();
export const cancelSchema = z.object({ reason: text(300).min(5) }).strict();
export const listSchema = z.object({ show: z.enum(["OPEN", "ALL"]).default("OPEN") }).strict();

/**
 * Housekeeping and maintenance requests for any area (docs/housekeeping.md), beside the bed turnover after a discharge. Anyone who may ask (nurses, reception, managers)
 * raises a request for a place and a job; housekeeping sees every request, starts it and marks it done. A request names no patient: the same rule as bed turnover.
 * Each step is recorded once with who and when, and a finished request never changes.
 */
@Injectable()
export class HousekeepingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private manages(ctx: RequestContext): boolean { return ctx.permissions.has("HOUSEKEEPING_MANAGE"); }

  /** Housekeeping staff see every request of the facility; a person who may only ask sees their own. */
  async list(ctx: RequestContext, q: z.infer<typeof listSchema>) {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const where: Prisma.HousekeepingRequestWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(this.manages(ctx) ? {} : { requestedById: ctx.userId }),
      ...(q.show === "OPEN" ? { OR: [{ status: { in: ["OPEN", "IN_PROGRESS"] } }, { doneAt: { gte: since } }, { cancelledAt: { gte: since } }] } : {}),
    };
    const rows = await this.prisma.housekeepingRequest.findMany({ where, orderBy: [{ requestedAt: "desc" }, { id: "asc" }], take: 200 });
    const ids = [...new Set(rows.flatMap((r) => [r.requestedById, r.startedById, r.doneById].filter((x): x is string => !!x)))];
    const names = new Map((ids.length ? await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
    const rank = { URGENT: 0, ROUTINE: 1 } as const;
    return rows
      .map((r) => ({
        id: r.id, kind: r.kind, priority: r.priority, location: r.location, description: r.description, status: r.status,
        requestedAt: r.requestedAt, requestedBy: names.get(r.requestedById) ?? null, startedAt: r.startedAt, startedBy: r.startedById ? names.get(r.startedById) ?? null : null,
        doneAt: r.doneAt, doneBy: r.doneById ? names.get(r.doneById) ?? null : null, doneNote: r.doneNote, cancelledAt: r.cancelledAt, cancelReason: r.cancelReason,
        minutesToDone: r.doneAt ? Math.round((r.doneAt.getTime() - r.requestedAt.getTime()) / 60_000) : null,
      }))
      .sort((a, b) => Number(["DONE", "CANCELLED"].includes(a.status)) - Number(["DONE", "CANCELLED"].includes(b.status)) || rank[a.priority] - rank[b.priority] || a.requestedAt.getTime() - b.requestedAt.getTime());
  }

  async create(ctx: RequestContext, input: z.infer<typeof requestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.housekeepingRequest.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, kind: input.kind, priority: input.priority, location: input.location, description: input.description || null, requestedById: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "HOUSEKEEPING_REQUESTED", entityType: "HousekeepingRequest", entityId: r.id, metadata: { kind: input.kind, priority: input.priority } });
      return { id: r.id, status: "OPEN" as const };
    });
  }

  private async lock(tx: Db, ctx: RequestContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "HousekeepingRequest" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.housekeepingRequest.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
  }

  async start(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, ctx, id);
      if (r.status !== "OPEN") throw new DomainError("INVALID_STATE", `This request is already ${r.status.toLowerCase().replace("_", " ")}`, 409);
      await tx.housekeepingRequest.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "IN_PROGRESS", startedById: ctx.userId, startedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), { action: "HOUSEKEEPING_STARTED", entityType: "HousekeepingRequest", entityId: id, metadata: { kind: r.kind } });
      return { id, status: "IN_PROGRESS" as const };
    });
  }

  async done(ctx: RequestContext, id: string, input: z.infer<typeof doneSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, ctx, id);
      if (r.status !== "IN_PROGRESS") throw new DomainError("INVALID_STATE", r.status === "OPEN" ? "Start the request before marking it done" : `This request is already ${r.status.toLowerCase().replace("_", " ")}`, 409);
      await tx.housekeepingRequest.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "DONE", doneById: ctx.userId, doneAt: new Date(), doneNote: input.note || null } });
      await this.audit.record(tx, actorOf(ctx), { action: "HOUSEKEEPING_DONE", entityType: "HousekeepingRequest", entityId: id, metadata: { kind: r.kind } });
      return { id, status: "DONE" as const };
    });
  }

  /** The person who asked can withdraw their request until it is done; housekeeping managers can cancel any open one. A reason is kept. */
  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof cancelSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, ctx, id);
      if (!this.manages(ctx) && r.requestedById !== ctx.userId) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!["OPEN", "IN_PROGRESS"].includes(r.status)) throw new DomainError("INVALID_STATE", `This request is already ${r.status.toLowerCase().replace("_", " ")}`, 409);
      await tx.housekeepingRequest.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CANCELLED", cancelledById: ctx.userId, cancelledAt: new Date(), cancelReason: input.reason } });
      await this.audit.record(tx, actorOf(ctx), { action: "HOUSEKEEPING_CANCELLED", entityType: "HousekeepingRequest", entityId: id, metadata: { kind: r.kind } });
      return { id, status: "CANCELLED" as const };
    });
  }
}
