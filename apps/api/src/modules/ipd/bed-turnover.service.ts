import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

/** Where a vacated bed stands: vacated (cleaning not started), cleaning, or ready for the next patient. */
export type TurnoverStage = "VACATED" | "CLEANING" | "READY";
export const turnoverStage = (t: { cleaningStartedAt: Date | null; readyAt: Date | null }): TurnoverStage => (t.readyAt ? "READY" : t.cleaningStartedAt ? "CLEANING" : "VACATED");

/**
 * Closes the open turnover of a bed that was marked available some other way (a nurse's "Mark clean" on the bed board), so the turnover and the bed
 * never disagree. A step that was skipped is recorded at the same moment, by the same person.
 */
export async function closeTurnoverForBed(tx: Db, ctx: RequestContext, bedId: string, at: Date): Promise<void> {
  const open = await tx.bedTurnover.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, bedId, readyAt: null } });
  for (const t of open) {
    await tx.bedTurnover.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id: t.id } },
      data: { ...(t.cleaningStartedAt ? {} : { cleaningStartedAt: at, cleaningStartedById: ctx.userId }), readyAt: at, readyById: ctx.userId },
    });
  }
}

/**
 * Bed turnover after a discharge (docs/discharge-stages.md): vacated -> cleaning -> ready. Housekeeping sees the beds to turn around (never the patients),
 * starts the cleaning and marks the bed ready; ready makes the bed available again. Each step is recorded once, with who and when.
 */
@Injectable()
export class BedTurnoverService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Beds still being turned around, oldest first, and those made ready in the last 24 hours. Bed, ward and room only: no patient details. */
  async list(ctx: RequestContext) {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const rows = await this.prisma.bedTurnover.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, OR: [{ readyAt: null }, { readyAt: { gte: since } }] },
      orderBy: [{ vacatedAt: "asc" }, { id: "asc" }], take: 200,
      select: { id: true, vacatedAt: true, cleaningStartedAt: true, cleaningStartedById: true, readyAt: true, readyById: true, autoReady: true, bed: { select: { code: true, ward: { select: { name: true } }, room: { select: { name: true } } } } },
    });
    const ids = [...new Set(rows.flatMap((r) => [r.cleaningStartedById, r.readyById]).filter((x): x is string => !!x))];
    const names = new Map((ids.length ? await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id, bed: r.bed.code, ward: r.bed.ward.name, room: r.bed.room.name, stage: turnoverStage(r), autoReady: r.autoReady,
      vacatedAt: r.vacatedAt, cleaningStartedAt: r.cleaningStartedAt, cleaningStartedBy: r.cleaningStartedById ? names.get(r.cleaningStartedById) ?? null : null,
      readyAt: r.readyAt, readyBy: r.readyById ? names.get(r.readyById) ?? null : null,
      minutesToReady: r.readyAt ? Math.round((r.readyAt.getTime() - r.vacatedAt.getTime()) / 60_000) : null,
    }));
  }

  async startCleaning(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, ctx, id);
      if (t.readyAt) throw new DomainError("INVALID_STATE", "This bed is already ready", 409);
      if (t.cleaningStartedAt) throw new DomainError("INVALID_STATE", "Cleaning has already started", 409);
      const at = new Date();
      await tx.bedTurnover.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { cleaningStartedAt: at, cleaningStartedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "BED_CLEANING_STARTED", entityType: "Bed", entityId: t.bedId, metadata: { turnoverId: id } });
      return { id, stage: "CLEANING" as const, cleaningStartedAt: at };
    });
  }

  /** Marks the bed ready: the turnover is complete and the bed becomes available (unless someone has meanwhile put it under maintenance). */
  async markReady(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, ctx, id);
      if (t.readyAt) throw new DomainError("INVALID_STATE", "This bed is already ready", 409);
      if (!t.cleaningStartedAt) throw new DomainError("INVALID_STATE", "Start the cleaning first: vacated, cleaning, then ready", 409);
      const bed = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM "Bed" WHERE id = ${t.bedId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid FOR UPDATE`;
      const at = new Date();
      await tx.bedTurnover.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { readyAt: at, readyById: ctx.userId } });
      const from = bed[0]?.status ?? null;
      if (from === "CLEANING") {
        await tx.bed.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: t.bedId } }, data: { status: "AVAILABLE", version: { increment: 1 } } });
        await this.audit.record(tx, actorOf(ctx), { action: "BED_STATUS_CHANGED", entityType: "Bed", entityId: t.bedId, metadata: { from, to: "AVAILABLE", reason: "Bed turnover: ready" } });
      }
      const minutes = Math.round((at.getTime() - t.vacatedAt.getTime()) / 60_000);
      await this.audit.record(tx, actorOf(ctx), { action: "BED_TURNOVER_READY", entityType: "Bed", entityId: t.bedId, metadata: { turnoverId: id, minutesToReady: minutes, bedStatus: from === "CLEANING" ? "AVAILABLE" : from } });
      return { id, stage: "READY" as const, readyAt: at, minutesToReady: minutes, bedStatus: from === "CLEANING" ? "AVAILABLE" : from };
    });
  }

  private async lock(tx: Db, ctx: RequestContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "BedTurnover" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.bedTurnover.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
  }
}
