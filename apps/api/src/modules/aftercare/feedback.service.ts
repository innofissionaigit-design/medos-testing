import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { NumberingService } from "../numbering/numbering.service";
import { SettingsService } from "../settings/settings.service";

const uuid = z.string().uuid();

export const feedbackSchema = z.object({
  /** A call on a review task is the usual source: the patient and stay come from the task, never from the request. */
  taskId: uuid.optional(), admissionId: uuid.optional(), patientId: uuid.optional(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
  channel: z.enum(["PHONE", "IN_PERSON", "FORM"]).default("PHONE"),
}).strict().refine((v) => v.taskId || v.admissionId || v.patientId, { path: ["patientId"], message: "Say whose feedback this is" });
export const feedbackListSchema = z.object({ maxRating: z.coerce.number().int().min(1).max(5).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict();

export const complaintSchema = z.object({
  patientId: uuid.optional(), feedbackId: uuid.optional(), taskId: uuid.optional(),
  category: z.string().trim().min(2).max(60),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  description: z.string().trim().min(10).max(2000),
}).strict();
export const complaintListSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "ACTIVE", "ALL"]).default("ACTIVE"),
  mine: z.enum(["0", "1"]).default("0"),
  overdue: z.enum(["0", "1"]).default("0"),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const assignComplaintSchema = z.object({ ownerId: uuid }).strict();
export const complaintNoteSchema = z.object({ note: z.string().trim().min(2).max(1000) }).strict();
export const resolveComplaintSchema = z.object({ resolution: z.string().trim().min(10).max(1000) }).strict();
export const reopenComplaintSchema = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
export const escalateComplaintSchema = z.object({ reason: z.string().trim().min(5).max(300), toUserId: uuid.optional() }).strict();
export const closeComplaintSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

/** What patients say about their care, and the complaints followed to a written resolution (docs/aftercare.md). Feedback and notes are never edited. */
@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService, private readonly settings: SettingsService) {}

  // ───── feedback ─────

  async record(ctx: RequestContext, input: z.infer<typeof feedbackSchema>) {
    return this.prisma.$transaction(async (tx) => {
      let patientId = input.patientId ?? null, admissionId = input.admissionId ?? null;
      const taskId = input.taskId ?? null;
      if (taskId) {
        const t = await tx.aftercareTask.findFirst({ where: { id: taskId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { patientId: true, admissionId: true } });
        if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        patientId = t.patientId; admissionId = t.admissionId;
      } else if (admissionId) {
        const a = await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { patientId: true } });
        if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        patientId = a.patientId;
      } else {
        const p = await tx.patient.findFirst({ where: { id: patientId!, tenantId: ctx.tenantId }, select: { id: true } });
        if (!p) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      }
      const f = await tx.patientFeedback.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: patientId!, admissionId, taskId, rating: input.rating, comment: input.comment || null, channel: input.channel, recordedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "FEEDBACK_RECORDED", entityType: "PatientFeedback", entityId: f.id, metadata: { rating: input.rating, channel: input.channel } });
      return { id: f.id, rating: f.rating, channel: f.channel, recordedAt: f.recordedAt };
    });
  }

  async listFeedback(ctx: RequestContext, q: z.infer<typeof feedbackListSchema>) {
    const where: Prisma.PatientFeedbackWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.maxRating ? { rating: { lte: q.maxRating } } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.patientFeedback.findMany({ where, orderBy: [{ recordedAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { patient: { select: { firstName: true, lastName: true } }, complaints: { select: { complaintNumber: true } } } }),
      this.prisma.patientFeedback.count({ where }),
    ]);
    const users = await this.names(this.prisma, ctx, rows.map((r) => r.recordedById));
    return { items: rows.map((r) => ({ id: r.id, patientId: r.patientId, patient: [r.patient.firstName, r.patient.lastName].filter(Boolean).join(" "), rating: r.rating, comment: r.comment, channel: r.channel, recordedAt: r.recordedAt, recordedBy: users.get(r.recordedById) ?? null, complaints: r.complaints.map((c) => c.complaintNumber) })), total, page: q.page, pageSize: q.pageSize };
  }

  // ───── complaints ─────

  async create(ctx: RequestContext, input: z.infer<typeof complaintSchema>) {
    return this.prisma.$transaction(async (tx) => {
      let patientId = input.patientId ?? null;
      if (input.taskId) {
        const t = await tx.aftercareTask.findFirst({ where: { id: input.taskId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { patientId: true } });
        if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        patientId = t.patientId;
      }
      if (input.feedbackId) {
        const f = await tx.patientFeedback.findFirst({ where: { id: input.feedbackId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { patientId: true } });
        if (!f) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        patientId = f.patientId;
      }
      if (patientId && !input.taskId && !input.feedbackId) {
        const p = await tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true } });
        if (!p) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      }
      const complaintNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "COMPLAINT");
      const hours = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, input.severity === "HIGH" ? "COMPLAINT_HOURS_HIGH" : input.severity === "LOW" ? "COMPLAINT_HOURS_LOW" : "COMPLAINT_HOURS_MEDIUM");
      const created = new Date();
      const c = await tx.complaint.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, complaintNumber, createdAt: created, dueAt: new Date(created.getTime() + hours * 3_600_000), patientId, feedbackId: input.feedbackId ?? null, taskId: input.taskId ?? null, category: input.category, severity: input.severity, description: input.description, createdById: ctx.userId } });
      await tx.complaintNote.create({ data: { tenantId: ctx.tenantId, complaintId: c.id, kind: "RAISED", note: "Complaint recorded", byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "COMPLAINT_RAISED", entityType: "Complaint", entityId: c.id, metadata: { complaintNumber, category: input.category, severity: input.severity } });
      return this.view(tx, ctx, c.id);
    });
  }

  async list(ctx: RequestContext, q: z.infer<typeof complaintListSchema>) {
    const where: Prisma.ComplaintWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId,
      ...(q.status === "ALL" ? {} : q.status === "ACTIVE" ? { status: { in: ["OPEN", "IN_PROGRESS"] } } : { status: q.status }),
      ...(q.mine === "1" ? { OR: [{ ownerId: ctx.userId }, { escalatedToId: ctx.userId }] } : {}),
      ...(q.overdue === "1" ? { status: { in: ["OPEN", "IN_PROGRESS"] as ("OPEN" | "IN_PROGRESS")[] }, dueAt: { lt: new Date() } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.complaint.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { patient: { select: { firstName: true, lastName: true } } } }),
      this.prisma.complaint.count({ where }),
    ]);
    const users = await this.names(this.prisma, ctx, rows.map((r) => r.ownerId));
    const now = Date.now();
    return {
      items: rows.map((r) => ({
        id: r.id, complaintNumber: r.complaintNumber, category: r.category, severity: r.severity, status: r.status, createdAt: r.createdAt, dueAt: r.dueAt, overdue: (r.status === "OPEN" || r.status === "IN_PROGRESS") && r.dueAt.getTime() < now, escalated: r.escalatedAt !== null,
        ageDays: Math.floor(((r.resolvedAt?.getTime() ?? now) - r.createdAt.getTime()) / 86_400_000),
        patient: r.patient ? [r.patient.firstName, r.patient.lastName].filter(Boolean).join(" ") : null, ownerId: r.ownerId, owner: r.ownerId ? users.get(r.ownerId) ?? null : null,
      })),
      total, page: q.page, pageSize: q.pageSize,
    };
  }

  async get(ctx: RequestContext, id: string) { return this.view(this.prisma, ctx, id); }

  /** The owner is whoever follows the complaint up. Handing it over is a note in its history. */
  async assign(ctx: RequestContext, id: string, input: z.infer<typeof assignComplaintSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (c.status === "CLOSED") throw new DomainError("INVALID_STATE", "This complaint is closed", 409);
      const u = await tx.user.findFirst({ where: { id: input.ownerId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { fullName: true } });
      if (!u) throw new DomainError("VALIDATION_FAILED", "That person cannot be given this complaint", 400, [{ path: "ownerId", message: "Not an active user" }]);
      await tx.complaint.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { ownerId: input.ownerId } });
      await tx.complaintNote.create({ data: { tenantId: ctx.tenantId, complaintId: id, kind: "ASSIGNED", note: `Given to ${u.fullName}`, byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "COMPLAINT_ASSIGNED", entityType: "Complaint", entityId: id, metadata: { ownerId: input.ownerId } });
      return this.view(tx, ctx, id);
    });
  }

  async addNote(ctx: RequestContext, id: string, input: z.infer<typeof complaintNoteSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (c.status === "CLOSED") throw new DomainError("INVALID_STATE", "This complaint is closed", 409);
      await tx.complaintNote.create({ data: { tenantId: ctx.tenantId, complaintId: id, kind: "NOTE", note: input.note, byId: ctx.userId } });
      return this.view(tx, ctx, id);
    });
  }

  /** Taking the complaint up: it becomes yours and moves to in progress. */
  async start(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (c.status !== "OPEN") throw new DomainError("INVALID_STATE", `This complaint is already ${c.status.toLowerCase().replace("_", " ")}`, 409);
      await tx.complaint.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "IN_PROGRESS", ownerId: c.ownerId ?? ctx.userId } });
      await tx.complaintNote.create({ data: { tenantId: ctx.tenantId, complaintId: id, kind: "STATUS", note: "Taken up", byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "COMPLAINT_STARTED", entityType: "Complaint", entityId: id, metadata: {} });
      return this.view(tx, ctx, id);
    });
  }

  async resolve(ctx: RequestContext, id: string, input: z.infer<typeof resolveComplaintSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (!["OPEN", "IN_PROGRESS"].includes(c.status)) throw new DomainError("INVALID_STATE", `This complaint is already ${c.status.toLowerCase().replace("_", " ")}`, 409);
      await tx.complaint.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "RESOLVED", resolution: input.resolution, resolvedById: ctx.userId, resolvedAt: new Date(), ownerId: c.ownerId ?? ctx.userId } });
      await tx.complaintNote.create({ data: { tenantId: ctx.tenantId, complaintId: id, kind: "STATUS", note: `Resolved: ${input.resolution}`.slice(0, 1000), byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "COMPLAINT_RESOLVED", entityType: "Complaint", entityId: id, metadata: {} });
      return this.view(tx, ctx, id);
    });
  }

  /** The patient has been told the outcome; the complaint is finished. A different person from the one who resolved it may close it. */
  async close(ctx: RequestContext, id: string, input: z.infer<typeof closeComplaintSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (c.status !== "RESOLVED") throw new DomainError("INVALID_STATE", c.status === "CLOSED" ? "This complaint is already closed" : "Resolve the complaint before closing it", 409);
      await tx.complaint.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CLOSED", closedAt: new Date() } });
      await tx.complaintNote.create({ data: { tenantId: ctx.tenantId, complaintId: id, kind: "STATUS", note: input.note ? `Closed: ${input.note}` : "Closed", byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "COMPLAINT_CLOSED", entityType: "Complaint", entityId: id, metadata: {} });
      return this.view(tx, ctx, id);
    });
  }

  /** The patient is not satisfied with the outcome: back to in progress, with the reason on record. */
  async reopen(ctx: RequestContext, id: string, input: z.infer<typeof reopenComplaintSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (c.status !== "RESOLVED") throw new DomainError("INVALID_STATE", c.status === "CLOSED" ? "A closed complaint cannot be reopened; raise a new one" : "Only a resolved complaint can be reopened", 409);
      await tx.complaint.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "IN_PROGRESS", resolution: null, resolvedById: null, resolvedAt: null } });
      await tx.complaintNote.create({ data: { tenantId: ctx.tenantId, complaintId: id, kind: "STATUS", note: `Reopened: ${input.reason}`, byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "COMPLAINT_REOPENED", entityType: "Complaint", entityId: id, metadata: {} });
      return this.view(tx, ctx, id);
    });
  }

  /**
   * Sends a complaint up to a manager: by hand with a reason, or by the worker when it passes its deadline. It stays with its owner; the manager sees it on their list.
   * Done once; the history says who, why and to whom.
   */
  async escalate(ctx: RequestContext, id: string, input: z.infer<typeof escalateComplaintSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (!["OPEN", "IN_PROGRESS"].includes(c.status)) throw new DomainError("INVALID_STATE", "Only an open complaint can be escalated", 409);
      if (c.escalatedAt) throw new DomainError("INVALID_STATE", "This complaint has already been escalated", 409);
      if (input.toUserId) {
        const u = await tx.user.findFirst({ where: { id: input.toUserId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
        if (!u) throw new DomainError("VALIDATION_FAILED", "That person cannot be given this complaint", 400, [{ path: "toUserId", message: "Not an active user" }]);
      }
      await this.escalateIn(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId, requestId: ctx.requestId }, c.id, input.toUserId ?? null, input.reason);
      return this.view(tx, ctx, id);
    });
  }

  /** The escalation itself, inside the caller's transaction (also used by the worker, with no user). Returns false if nobody could be found to send it to. */
  async escalateIn(tx: Db, actor: { tenantId: string; facilityId: string; userId: string | null; requestId?: string | null }, complaintId: string, toUserId: string | null, reason: string): Promise<boolean> {
    let to = toUserId;
    if (!to) {
      for (const role of ["MANAGER", "ADMINISTRATOR"]) {
        const u = await tx.user.findFirst({ where: { tenantId: actor.tenantId, status: "ACTIVE", roles: { some: { role: { name: role } } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
        if (u) { to = u.id; break; }
      }
    }
    if (!to) return false;
    const who = await tx.user.findFirstOrThrow({ where: { id: to, tenantId: actor.tenantId }, select: { fullName: true } });
    await tx.complaint.update({ where: { tenantId_id: { tenantId: actor.tenantId, id: complaintId } }, data: { escalatedAt: new Date(), escalatedToId: to, escalationReason: reason } });
    await tx.complaintNote.create({ data: { tenantId: actor.tenantId, complaintId, kind: "ESCALATED", note: `Sent up to ${who.fullName}: ${reason}`.slice(0, 1000), byId: actor.userId ?? to } });
    await this.audit.record(tx, actor, { action: "COMPLAINT_ESCALATED", entityType: "Complaint", entityId: complaintId, metadata: { toUserId: to, automatic: actor.userId === null } });
    return true;
  }

  private async lock(tx: Db, ctx: RequestContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Complaint" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.complaint.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
  }

  private async names(db: Db | PrismaService, ctx: RequestContext, ids: (string | null)[]) {
    const list = [...new Set(ids.filter((i): i is string => !!i))];
    if (list.length === 0) return new Map<string, string>();
    return new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: list } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
  }

  private async view(db: Db | PrismaService, ctx: RequestContext, id: string) {
    const c = await db.complaint.findFirst({
      where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      include: { patient: { select: { firstName: true, lastName: true, mobile: true } }, notes: { orderBy: { at: "asc" } }, feedback: { select: { rating: true, comment: true } } },
    });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const users = await this.names(db, ctx, [c.ownerId, c.escalatedToId, c.createdById, c.resolvedById, ...c.notes.map((n) => n.byId)]);
    return {
      id: c.id, complaintNumber: c.complaintNumber, category: c.category, severity: c.severity, status: c.status, description: c.description, resolution: c.resolution,
      patientId: c.patientId, patient: c.patient ? [c.patient.firstName, c.patient.lastName].filter(Boolean).join(" ") : null, mobile: c.patient?.mobile ?? null,
      ownerId: c.ownerId, owner: c.ownerId ? users.get(c.ownerId) ?? null : null, createdAt: c.createdAt, dueAt: c.dueAt, overdue: (c.status === "OPEN" || c.status === "IN_PROGRESS") && c.dueAt.getTime() < Date.now(),
      escalatedAt: c.escalatedAt, escalatedTo: c.escalatedToId ? users.get(c.escalatedToId) ?? null : null, escalationReason: c.escalationReason, createdBy: users.get(c.createdById) ?? null,
      resolvedAt: c.resolvedAt, resolvedBy: c.resolvedById ? users.get(c.resolvedById) ?? null : null, closedAt: c.closedAt, feedback: c.feedback,
      notes: c.notes.map((n) => ({ kind: n.kind, note: n.note, at: n.at, by: users.get(n.byId) ?? null })),
    };
  }
}
