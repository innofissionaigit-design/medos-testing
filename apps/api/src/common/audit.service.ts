import { Injectable } from "@nestjs/common";
import type { Prisma } from "@medos/database";
import type { Db } from "./prisma.service";
import { PrismaService } from "./prisma.service";
import type { RequestContext } from "./request-context";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Targeted change metadata only; never full clinical payloads or secrets. */
  metadata?: Prisma.InputJsonObject;
}

export interface AuditActor {
  tenantId: string;
  facilityId?: string | null;
  userId?: string | null;
  requestId?: string | null;
}

export function actorOf(ctx: RequestContext): AuditActor {
  return { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId, requestId: ctx.requestId };
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Write inside the caller's transaction so the audit row commits atomically with the change. */
  async record(db: Db, actor: AuditActor, e: AuditInput): Promise<void> {
    await db.auditEvent.create({
      data: {
        tenantId: actor.tenantId,
        facilityId: actor.facilityId ?? null,
        actorUserId: actor.userId ?? null,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId ?? null,
        requestId: actor.requestId ?? null,
        metadata: e.metadata ?? {},
      },
    });
  }

  /** For events with no surrounding business transaction (e.g. login failure). */
  async recordStandalone(actor: AuditActor, e: AuditInput): Promise<void> {
    await this.record(this.prisma, actor, e);
  }
}
