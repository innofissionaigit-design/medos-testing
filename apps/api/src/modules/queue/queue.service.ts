import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { visitScope } from "../../common/data-scope";
import { dateOnly, localDateStr } from "../../common/time";
import { EncountersService } from "../encounters/encounters.service";

export type QueueStatusName = "WAITING" | "CALLED" | "IN_CONSULTATION" | "COMPLETED" | "SKIPPED" | "CANCELLED";
export type QueueAction = "call" | "recall" | "start" | "complete" | "skip" | "requeue" | "cancel";

/** Single source of truth for queue transitions (mirrored by a database trigger). */
export const QUEUE_TRANSITIONS: Record<QueueStatusName, readonly QueueStatusName[]> = {
  WAITING: ["CALLED", "SKIPPED", "CANCELLED", "IN_CONSULTATION"],
  CALLED: ["IN_CONSULTATION", "WAITING", "SKIPPED", "CANCELLED"],
  SKIPPED: ["WAITING", "CANCELLED"],
  IN_CONSULTATION: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

const ACTIONS: Record<QueueAction, { to: QueueStatusName; from: QueueStatusName[]; strict: boolean }> = {
  call: { to: "CALLED", from: ["WAITING"], strict: false },
  recall: { to: "WAITING", from: ["CALLED"], strict: false },
  start: { to: "IN_CONSULTATION", from: ["WAITING", "CALLED"], strict: false },
  complete: { to: "COMPLETED", from: ["IN_CONSULTATION"], strict: false },
  skip: { to: "SKIPPED", from: ["WAITING", "CALLED"], strict: true },
  requeue: { to: "WAITING", from: ["SKIPPED"], strict: true },
  cancel: { to: "CANCELLED", from: ["WAITING", "CALLED", "SKIPPED"], strict: true },
};

export const queueListSchema = z.object({
  practitionerId: z.string().uuid().optional(),
  status: z.enum(["WAITING", "CALLED", "IN_CONSULTATION", "COMPLETED", "SKIPPED", "CANCELLED"]).optional(),
}).strict();
export const cancelQueueSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();
export const priorityQueueSchema = z.object({ priority: z.enum(["NORMAL", "PRIORITY", "EMERGENCY"]) }).strict();
export const callNextSchema = z.object({ practitionerId: z.string().uuid().optional() }).strict();
export const doctorViewSchema = z.object({ practitionerId: z.string().uuid().optional() }).strict();

const VIEW = {
  id: true, tokenNumber: true, tokenDate: true, priority: true, status: true, checkedInAt: true, calledAt: true, consultationStartedAt: true,
  completedAt: true, encounterId: true, patientId: true, practitionerId: true, departmentId: true, appointmentId: true, version: true,
  patient: { select: { firstName: true, lastName: true, gender: true, identifiers: { where: { type: "MRN" as const }, select: { value: true } } } },
  practitioner: { select: { displayName: true, userId: true } },
  department: { select: { name: true } },
} satisfies Prisma.QueueEntrySelect;
type Row = Prisma.QueueEntryGetPayload<{ select: typeof VIEW }>;

export function toQueueView(q: Row, now = Date.now()) {
  const { patient, practitioner, department, ...rest } = q;
  const waiting = q.status === "WAITING" || q.status === "CALLED";
  return {
    ...rest,
    tokenDate: q.tokenDate.toISOString().slice(0, 10),
    patientName: [patient.firstName, patient.lastName].filter(Boolean).join(" "),
    gender: patient.gender, mrn: patient.identifiers[0]?.value ?? null,
    practitionerName: practitioner.displayName, departmentName: department?.name ?? null,
    waitingMinutes: waiting ? Math.max(0, Math.floor((now - q.checkedInAt.getTime()) / 60_000)) : null,
  };
}

const ORDER: Prisma.QueueEntryOrderByWithRelationInput[] = [{ priority: "desc" }, { checkedInAt: "asc" }, { tokenNumber: "asc" }];

@Injectable()
export class QueueService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly encounters: EncountersService) {}

  private async today(db: Db, ctx: RequestContext): Promise<Date> {
    const f = await db.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    return dateOnly(localDateStr(new Date(), f.timezone));
  }

  async list(ctx: RequestContext, q: z.infer<typeof queueListSchema>) {
    const tokenDate = await this.today(this.prisma, ctx);
    const rows = await this.prisma.queueEntry.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, OR: [{ tokenDate }, { status: "IN_CONSULTATION", tokenDate: { lt: tokenDate } }], AND: [visitScope(ctx)], ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}), ...(q.status ? { status: q.status } : {}) },
      select: VIEW, orderBy: ORDER, take: 500,
    });
    const now = Date.now();
    const active = (r: Row) => r.status === "WAITING" || r.status === "CALLED" || r.status === "IN_CONSULTATION";
    return [...rows.filter(active), ...rows.filter((r) => !active(r))].map((r) => toQueueView(r, now));
  }

  /** The doctor's own screen: current patient, next patient, and the waiting / completed lists. */
  async doctorView(ctx: RequestContext, practitionerId: string | undefined) {
    const tokenDate = await this.today(this.prisma, ctx);
    const practitioner = await this.prisma.practitioner.findFirst({
      where: {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE",
        ...(practitionerId ? { id: practitionerId } : { userId: ctx.userId }),
      },
      select: { id: true, displayName: true, userId: true, departmentId: true },
    });
    if (!practitioner) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const sc = ctx.dataScope;
    if (sc.kind === "DOCTOR" && !sc.practitionerIds.includes(practitioner.id)) throw new DomainError("FORBIDDEN", "You can only view your own queue", 403);
    if (sc.kind === "DEPARTMENT" && !(practitioner.departmentId && sc.departmentIds.includes(practitioner.departmentId))) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (practitioner.userId !== ctx.userId && !ctx.permissions.has("QUEUE_MANAGE")) throw new DomainError("FORBIDDEN", "You can only view your own queue", 403);

    const rows = await this.prisma.queueEntry.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId: practitioner.id, OR: [{ tokenDate }, { status: "IN_CONSULTATION", tokenDate: { lt: tokenDate } }] }, select: VIEW, orderBy: ORDER, take: 500,
    });
    const now = Date.now();
    const views = rows.map((r) => toQueueView(r, now));
    const waiting = views.filter((v) => v.status === "WAITING" || v.status === "CALLED");
    return {
      practitioner: { id: practitioner.id, displayName: practitioner.displayName },
      current: views.find((v) => v.status === "IN_CONSULTATION") ?? null,
      next: waiting.find((v) => v.status === "CALLED") ?? waiting[0] ?? null,
      waiting,
      skipped: views.filter((v) => v.status === "SKIPPED"),
      completed: views.filter((v) => v.status === "COMPLETED").sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0)),
    };
  }

  async act(ctx: RequestContext, id: string, action: QueueAction, reason?: string) {
    const rule = ACTIONS[action];
    return this.prisma.$transaction(async (tx) => {
      const entry = await tx.queueEntry.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, status: true, encounterId: true, appointmentId: true, practitioner: { select: { userId: true } } } });
      if (!entry) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      this.authorize(ctx, entry.practitioner.userId, rule.strict);
      const from = entry.status as QueueStatusName;
      if (!rule.from.includes(from)) throw new DomainError("INVALID_STATE", `A ${from.replace("_", " ").toLowerCase()} patient cannot be ${action === "complete" ? "completed" : action === "start" ? "started" : action + "ed"}`, 409);

      const now = new Date();
      const data: Prisma.QueueEntryUpdateManyMutationInput = { status: rule.to, version: { increment: 1 } };
      if (action === "call") data.calledAt = now;
      if (action === "recall" || action === "requeue") data.calledAt = null;
      if (action === "start") data.consultationStartedAt = now;
      if (action === "complete") data.completedAt = now;
      try {
        const res = await tx.queueEntry.updateMany({ where: { id, tenantId: ctx.tenantId, status: from }, data });
        if (res.count !== 1) throw new DomainError("INVALID_STATE", "The queue entry was changed by someone else", 409);
      } catch (e) {
        // The only unique constraint a status update can trip is "one active consultation per practitioner".
        const duplicate = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
        if (duplicate || (e instanceof Error && e.message.includes("QueueEntry_one_active_consultation"))) {
          throw new DomainError("INVALID_STATE", "This doctor is already in consultation with another patient", 409);
        }
        throw e;
      }

      if (entry.appointmentId) await this.syncAppointment(tx, ctx, entry.appointmentId, action, reason);
      if (action === "complete") {
        const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId: entry.encounterId, kind: "CONSULTATION" }, select: { status: true } });
        if (doc?.status === "DRAFT") throw new DomainError("INVALID_STATE", "Sign the consultation before completing the visit", 409);
        // Prescriptions are signed together with the consultation, and a completed visit can no longer be signed: an unsigned draft would never reach the pharmacy.
        const draftRx = await tx.medicationOrder.findFirst({ where: { tenantId: ctx.tenantId, encounterId: entry.encounterId, status: "DRAFT" }, select: { id: true } });
        if (draftRx) throw new DomainError("INVALID_STATE", "Sign the consultation to send the prescription to the pharmacy before completing the visit", 409);
        await this.encounters.transition(tx, ctx, entry.encounterId, "COMPLETED");
      }
      if (action === "cancel") await this.encounters.transition(tx, ctx, entry.encounterId, "CANCELLED", reason);
      await this.audit.record(tx, actorOf(ctx), { action: `QUEUE_${action.toUpperCase()}`, entityType: "QueueEntry", entityId: id, metadata: { from, to: rule.to, ...(reason ? { reason } : {}) } });
      return toQueueView(await tx.queueEntry.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW }));
    });
  }

  async setPriority(ctx: RequestContext, id: string, priority: "NORMAL" | "PRIORITY" | "EMERGENCY") {
    return this.prisma.$transaction(async (tx) => {
      const entry = await tx.queueEntry.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!entry) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!ctx.permissions.has("QUEUE_MANAGE")) {
        // Without queue management a person may only change the priority of patients waiting for themselves.
        const owner = await tx.practitioner.findFirst({ where: { id: entry.practitionerId, tenantId: ctx.tenantId }, select: { userId: true } });
        this.authorize(ctx, owner?.userId ?? null, false);
      }
      if (entry.status !== "WAITING" && entry.status !== "CALLED") throw new DomainError("INVALID_STATE", "Priority can only be changed while the patient is waiting", 409);
      await tx.queueEntry.updateMany({ where: { id, tenantId: ctx.tenantId, status: { in: ["WAITING", "CALLED"] } }, data: { priority, version: { increment: 1 } } });
      await this.audit.record(tx, actorOf(ctx), { action: "QUEUE_PRIORITY_CHANGED", entityType: "QueueEntry", entityId: id, metadata: { from: entry.priority, to: priority } });
      return toQueueView(await tx.queueEntry.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW }));
    });
  }

  /** Atomically calls the next waiting patient (emergency first, then priority, then arrival order). */
  async callNext(ctx: RequestContext, practitionerId: string | undefined) {
    return this.prisma.$transaction(async (tx) => {
      const practitioner = await tx.practitioner.findFirst({
        where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", ...(practitionerId ? { id: practitionerId } : { userId: ctx.userId }) },
        select: { id: true, userId: true },
      });
      if (!practitioner) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      this.authorize(ctx, practitioner.userId, false);
      const tokenDate = await this.today(tx, ctx);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "QueueEntry" SET status = 'CALLED', "calledAt" = now(), version = version + 1, "updatedAt" = now()
        WHERE id = (
          SELECT id FROM "QueueEntry"
          WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND "practitionerId" = ${practitioner.id}::uuid
            AND "tokenDate" = ${tokenDate}::date AND status = 'WAITING'
          ORDER BY priority DESC, "checkedInAt" ASC, "tokenNumber" ASC
          FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id`;
      const picked = rows[0];
      if (!picked) return null;
      await this.audit.record(tx, actorOf(ctx), { action: "QUEUE_CALL", entityType: "QueueEntry", entityId: picked.id, metadata: { from: "WAITING", to: "CALLED", callNext: true } });
      return toQueueView(await tx.queueEntry.findFirstOrThrow({ where: { id: picked.id, tenantId: ctx.tenantId }, select: VIEW }));
    });
  }

  // ───── internals ─────

  /** Doctors act on their own queue; staff with QUEUE_MANAGE act on any. `strict` actions need QUEUE_MANAGE. */
  private authorize(ctx: RequestContext, practitionerUserId: string | null, strict: boolean): void {
    if (ctx.permissions.has("QUEUE_MANAGE")) return;
    if (!strict && practitionerUserId === ctx.userId) return;
    throw new DomainError("FORBIDDEN", "You do not have permission to perform this action", 403);
  }

  private async syncAppointment(tx: Db, ctx: RequestContext, appointmentId: string, action: QueueAction, reason?: string): Promise<void> {
    const where = { id: appointmentId, tenantId: ctx.tenantId };
    if (action === "start") await tx.appointment.updateMany({ where: { ...where, status: "WAITING" }, data: { status: "IN_CONSULTATION", version: { increment: 1 } } });
    if (action === "complete") await tx.appointment.updateMany({ where: { ...where, status: "IN_CONSULTATION" }, data: { status: "COMPLETED", version: { increment: 1 } } });
    if (action === "cancel") await tx.appointment.updateMany({ where: { ...where, status: { in: ["CHECKED_IN", "WAITING"] } }, data: { status: "CANCELLED", cancelReason: reason ?? null, version: { increment: 1 } } });
  }
}
