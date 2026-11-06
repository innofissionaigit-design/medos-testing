import { Injectable } from "@nestjs/common";
import { DomainError, type Permission } from "@medos/shared";
import type { NotificationType } from "@medos/database";
import { Observable } from "rxjs";
import { z } from "zod";
import { paginationSchema } from "../../common/http";
import type { Db } from "../../common/prisma.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";

export const listNotificationsSchema = paginationSchema.extend({ unread: z.enum(["true", "false"]).optional() }).strict();

export interface NotifyInput {
  tenantId: string;
  facilityId: string;
  type: NotificationType;
  /** What it points at (for the link on the screen), for example "Encounter" or "Invoice". */
  entityType: string;
  entityId?: string | null;
  /** The same event never notifies the same person twice: for example "CRITICAL_LAB_RESULT:<result id>:<version>". */
  dedupeKey?: string;
}

export interface NotificationView { id: string; type: NotificationType; entityType: string; entityId: string | null; createdAt: Date; readAt: Date | null }
export interface StreamEvent { type: "notify" | "ping"; data: { unread?: number; latestId?: string | null } }

const POLL_MS = 3_000;
const HEARTBEAT_MS = 25_000;
/** A stream is closed after this long and the browser reconnects, which also re-checks the session (access tokens are short-lived). */
const MAX_STREAM_MS = 10 * 60_000;
const MAX_STREAMS_PER_USER = 5;
const KEEP_READ_DAYS = 90;

/**
 * In-app notifications (docs/notifications.md). A notification is a short pointer to a record, written in the same transaction as the event that causes it.
 * It holds no patient name and no clinical text. Each person reads only their own, for the facility they are working in.
 */
@Injectable()
export class NotificationsService {
  private readonly streams = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  // ───── raising notifications (called by other modules inside their own transaction) ─────

  /** Active staff of the facility who hold at least one of the permissions. API clients (bots) and inactive people never receive notifications. */
  async recipientsWith(db: Db, tenantId: string, facilityId: string, permissions: Permission[]): Promise<string[]> {
    const rows = await db.user.findMany({
      where: {
        tenantId, status: "ACTIVE", isService: false,
        facilities: { some: { facilityId } },
        roles: { some: { role: { permissions: { some: { permission: { in: permissions } } } } } },
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** The login of the doctor responsible for a visit, if that doctor has one. */
  async doctorOfEncounter(db: Db, tenantId: string, encounterId: string | null | undefined): Promise<string | null> {
    if (!encounterId) return null;
    const e = await db.encounter.findFirst({ where: { id: encounterId, tenantId }, select: { practitioner: { select: { userId: true } } } });
    return e?.practitioner?.userId ?? null;
  }

  /** The login behind a doctor record. */
  async doctorUser(db: Db, tenantId: string, practitionerId: string): Promise<string | null> {
    const p = await db.practitioner.findFirst({ where: { id: practitionerId, tenantId }, select: { userId: true } });
    return p?.userId ?? null;
  }

  /** A critical lab or radiology result: tells the doctor of the visit, once for each version of the report. */
  async criticalResult(db: Db, at: { tenantId: string; facilityId: string }, kind: "LAB" | "RAD", testOrderId: string, entityId: string, version: number): Promise<number> {
    const order = await db.testOrder.findFirst({ where: { id: testOrderId, tenantId: at.tenantId }, select: { encounterId: true } });
    const doctor = await this.doctorOfEncounter(db, at.tenantId, order?.encounterId);
    if (!doctor) return 0;
    const type: NotificationType = kind === "LAB" ? "CRITICAL_LAB_RESULT" : "CRITICAL_RAD_FINDING";
    return this.notify(db, [doctor], { ...at, type, entityType: kind === "LAB" ? "LabResult" : "RadStudy", entityId, dedupeKey: `${type}:${entityId}:${version}` });
  }

  /** Notifies each person once. Returns how many were new (a repeat of the same event adds none). */
  async notify(db: Db, recipientUserIds: readonly string[], n: NotifyInput): Promise<number> {
    const ids = [...new Set(recipientUserIds)];
    if (ids.length === 0) return 0;
    const res = await db.notification.createMany({
      data: ids.map((recipientUserId) => ({ tenantId: n.tenantId, facilityId: n.facilityId, recipientUserId, type: n.type, entityType: n.entityType, entityId: n.entityId ?? null, dedupeKey: n.dedupeKey ?? null })),
      skipDuplicates: true,
    });
    return res.count;
  }

  /** Notifies everyone in the facility who holds one of the permissions. */
  async notifyPermission(db: Db, permissions: Permission[], n: NotifyInput): Promise<number> {
    return this.notify(db, await this.recipientsWith(db, n.tenantId, n.facilityId, permissions), n);
  }

  // ───── reading (each person, their own) ─────

  async list(ctx: RequestContext, q: z.infer<typeof listNotificationsSchema>) {
    const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, recipientUserId: ctx.userId, ...(q.unread === "true" ? { readAt: null } : {}) };
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, type: true, entityType: true, entityId: true, createdAt: true, readAt: true } }),
      this.prisma.notification.count({ where }),
      this.unreadCount(ctx),
    ]);
    // Keeping the table small: this person's read notifications older than 90 days are removed (a few at a time, no one else's).
    void this.prisma.notification.deleteMany({ where: { tenantId: ctx.tenantId, recipientUserId: ctx.userId, readAt: { lt: new Date(Date.now() - KEEP_READ_DAYS * 86_400_000) } } }).catch(() => undefined);
    return { items: items as NotificationView[], total, unread };
  }

  async unreadCount(ctx: RequestContext): Promise<number> {
    return this.prisma.notification.count({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, recipientUserId: ctx.userId, readAt: null } });
  }

  /** Marks one of the caller's own notifications read. Someone else's, or a made-up id, is "not found". */
  async markRead(ctx: RequestContext, notificationId: string): Promise<{ unread: number }> {
    const mine = { id: notificationId, tenantId: ctx.tenantId, recipientUserId: ctx.userId };
    const found = await this.prisma.notification.findFirst({ where: mine, select: { id: true } });
    if (!found) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    await this.prisma.notification.updateMany({ where: { ...mine, readAt: null }, data: { readAt: new Date() } });
    return { unread: await this.unreadCount(ctx) };
  }

  async markAllRead(ctx: RequestContext): Promise<{ unread: number }> {
    await this.prisma.notification.updateMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, recipientUserId: ctx.userId, readAt: null }, data: { readAt: new Date() } });
    return { unread: await this.unreadCount(ctx) };
  }

  // ───── the live channel ─────

  /**
   * A server-sent-events stream for the signed-in person: it says "something changed" (the unread count and the newest id) and the browser then fetches the list.
   * It looks at the caller's own notifications every few seconds inside this request, so it needs no extra database connection or software and works the same
   * behind several API servers. The table stays the source of truth: if the stream drops, the browser falls back to asking now and then.
   */
  stream(ctx: RequestContext): Observable<{ type: string; data: StreamEvent["data"] }> {
    const open = this.streams.get(ctx.userId) ?? 0;
    if (open >= MAX_STREAMS_PER_USER) throw new DomainError("RATE_LIMITED", "Too many open connections for this user", 429);
    this.streams.set(ctx.userId, open + 1);
    return new Observable((sub) => {
      let last = "";
      let busy = false;
      const look = async (): Promise<void> => {
        if (busy) return;
        busy = true;
        try {
          const state = await tenantScope.run(ctx.tenantId, async () => {
            const person = await this.prisma.user.findFirst({ where: { id: ctx.userId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
            if (!person) return null;
            const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, recipientUserId: ctx.userId };
            const [unread, newest] = await Promise.all([this.prisma.notification.count({ where: { ...where, readAt: null } }), this.prisma.notification.findFirst({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } })]);
            return { unread, latestId: newest?.id ?? null };
          });
          if (!state) { sub.complete(); return; }
          const key = `${state.unread}:${state.latestId}`;
          if (key !== last) { last = key; sub.next({ type: "notify", data: state }); }
        } catch {
          /* a failed look is tried again on the next tick; the browser also falls back to asking */
        } finally {
          busy = false;
        }
      };
      void look();
      const poll = setInterval(() => void look(), POLL_MS);
      const beat = setInterval(() => sub.next({ type: "ping", data: {} }), HEARTBEAT_MS);
      const stop = setTimeout(() => sub.complete(), MAX_STREAM_MS);
      return () => {
        clearInterval(poll); clearInterval(beat); clearTimeout(stop);
        const n = (this.streams.get(ctx.userId) ?? 1) - 1;
        if (n <= 0) this.streams.delete(ctx.userId); else this.streams.set(ctx.userId, n);
      };
    });
  }
}
