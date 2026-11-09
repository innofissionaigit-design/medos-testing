import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { Ctx, paginate, parse, RequirePermissions } from "../../common/http";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(80).optional(),
  entityId: z.string().trim().max(80).optional(),
  actorUserId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}).strict();

/** Read-only. There is deliberately no write/update/delete route for audit events. */
@Controller("audit-events")
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @RequirePermissions("AUDIT_READ")
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(querySchema, query);
    const where = {
      tenantId: ctx.tenantId,
      OR: [{ facilityId: ctx.facilityId }, { facilityId: null }],
      ...(q.action ? { action: q.action } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        select: { id: true, action: true, entityType: true, entityId: true, actorUserId: true, facilityId: true, requestId: true, metadata: true, createdAt: true },
      }),
      this.prisma.auditEvent.count({ where }),
    ]);
    // Show who acted by name; tenant-scoped so an id from elsewhere can never resolve.
    const actorIds = [...new Set(items.flatMap((e) => (e.actorUserId ? [e.actorUserId] : [])))];
    const users = actorIds.length ? await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: actorIds } }, select: { id: true, fullName: true, username: true } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return paginate(items.map((e) => ({ ...e, actorName: e.actorUserId ? byId.get(e.actorUserId)?.fullName ?? null : null, actorUsername: e.actorUserId ? byId.get(e.actorUserId)?.username ?? null : null })), total, q.page, q.pageSize);
  }

  /** Staff of this tenant, for the audit "user" filter. Names only; no roles, contact details or status. */
  @RequirePermissions("AUDIT_READ")
  @Get("actors")
  async actors(@Ctx() ctx: RequestContext) {
    const users = await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, fullName: true, username: true }, orderBy: { fullName: "asc" }, take: 1000 });
    return { data: users };
  }
}
