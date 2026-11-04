import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { admissionScope } from "../../common/data-scope";
import { linkedIdsByPatient } from "../patients/patient-links";
import { dateOnly, formatHm, zonedToUtc } from "../../common/time";

const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true }).transform((s) => new Date(s));

export const noteSchema = z.object({ note: z.string().trim().min(3).max(4000) }).strict();
export const errorReasonSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();
export const taskSchema = z.object({
  type: z.enum(["VITALS", "MEDICATION", "OTHER"]).default("OTHER"), title: z.string().trim().min(3).max(160), dueAt: instant, assignedToId: uuid.optional(),
}).strict();
export const taskCloseSchema = z.object({ note: z.string().trim().min(3).max(300).optional() }).strict();
export const taskCancelSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();
export const ioSchema = z.object({
  direction: z.enum(["INTAKE", "OUTPUT"]),
  category: z.enum(["ORAL", "IV", "OTHER_INTAKE", "URINE", "DRAIN", "VOMIT", "OTHER_OUTPUT"]),
  amount: z.number().positive().max(20_000).refine((n) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9, "At most one decimal place"),
  recordedAt: instant.optional(),
}).strict().superRefine((v, c) => {
  const ok = v.direction === "INTAKE" ? ["ORAL", "IV", "OTHER_INTAKE"] : ["URINE", "DRAIN", "VOMIT", "OTHER_OUTPUT"];
  if (!ok.includes(v.category)) c.addIssue({ code: "custom", path: ["category"], message: `${v.category} is not a valid ${v.direction.toLowerCase()} type` });
});
export const ioTotalsSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => dateOnly(s).toISOString().slice(0, 10) === s, "Invalid date") }).strict();
export const worklistSchema = z.object({ wardId: uuid.optional() }).strict();

/** Vitals are "due" when nothing has been recorded for this long (minutes). */
export const VITALS_INTERVAL_MIN = 240;
/** Nursing shifts as local start minutes; the I/O day runs 06:00 to 06:00. */
const SHIFTS = [{ name: "MORNING", from: 6 * 60, to: 14 * 60 }, { name: "EVENING", from: 14 * 60, to: 22 * 60 }, { name: "NIGHT", from: 22 * 60, to: 30 * 60 }] as const;

@Injectable()
export class NursingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async admission(db: Db, ctx: RequestContext, id: string, mustBeCurrent: boolean) {
    const a = await db.admission.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] } });
    if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (mustBeCurrent && a.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "The patient is no longer admitted", 409);
    return a;
  }

  private async names(db: Db, ctx: RequestContext, ids: (string | null)[]): Promise<Map<string, string>> {
    const real = [...new Set(ids.filter((x): x is string => !!x))];
    if (!real.length) return new Map();
    return new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: real } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
  }

  // ───────────── notes ─────────────

  async addNote(ctx: RequestContext, admissionId: string, input: z.infer<typeof noteSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.admission(tx, ctx, admissionId, true);
      const n = await tx.nursingNote.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId, encounterId: adm.encounterId, authorId: ctx.userId, note: input.note } });
      await this.audit.record(tx, actorOf(ctx), { action: "NURSING_NOTE_ADDED", entityType: "NursingNote", entityId: n.id, metadata: { admissionId } });
      return this.noteView(tx, ctx, n.id);
    });
  }

  /** Corrections are additive: a new note that points at the original, which stays exactly as written. */
  async addAddendum(ctx: RequestContext, noteId: string, input: z.infer<typeof noteSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const orig = await tx.nursingNote.findFirst({ where: { id: noteId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!orig) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await this.admission(tx, ctx, orig.admissionId, true);
      if (orig.addendumOfId) throw new DomainError("INVALID_STATE", "Add the addendum to the original note", 409);
      const n = await tx.nursingNote.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: orig.patientId, admissionId: orig.admissionId, encounterId: orig.encounterId, authorId: ctx.userId, note: input.note, addendumOfId: orig.id } });
      await this.audit.record(tx, actorOf(ctx), { action: "NURSING_NOTE_ADDENDUM", entityType: "NursingNote", entityId: n.id, metadata: { admissionId: orig.admissionId, originalNoteId: orig.id } });
      return this.noteView(tx, ctx, n.id);
    });
  }

  async noteInError(ctx: RequestContext, noteId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const n = await tx.nursingNote.findFirst({ where: { id: noteId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!n) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (n.authorId !== ctx.userId && !ctx.permissions.has("ADMISSION_DISCHARGE")) throw new DomainError("FORBIDDEN", "Only the author or a doctor can mark a note as entered in error", 403);
      if (n.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This note is already marked as an error", 409);
      const res = await tx.nursingNote.updateMany({ where: { id: noteId, tenantId: ctx.tenantId, status: "ACTIVE" }, data: { status: "ENTERED_IN_ERROR", errorReason: reason, errorById: ctx.userId, errorAt: new Date() } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The note was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "NURSING_NOTE_ENTERED_IN_ERROR", entityType: "NursingNote", entityId: noteId, metadata: { admissionId: n.admissionId, reason } });
      return this.noteView(tx, ctx, noteId);
    });
  }

  /** Chronological history, original notes with their addenda grouped beneath. */
  async listNotes(ctx: RequestContext, admissionId: string, includeErrors: boolean) {
    await this.admission(this.prisma, ctx, admissionId, false);
    const rows = await this.prisma.nursingNote.findMany({ where: { tenantId: ctx.tenantId, admissionId, ...(includeErrors ? {} : { status: "ACTIVE" }) }, orderBy: { createdAt: "asc" } });
    const names = await this.names(this.prisma, ctx, rows.map((r) => r.authorId));
    const view = (n: (typeof rows)[number]) => ({ id: n.id, note: n.note, status: n.status, authorId: n.authorId, authorName: names.get(n.authorId) ?? null, createdAt: n.createdAt, addendumOfId: n.addendumOfId, errorReason: n.errorReason });
    return rows.filter((r) => !r.addendumOfId).map((r) => ({ ...view(r), addenda: rows.filter((a) => a.addendumOfId === r.id).map(view) }));
  }

  private async noteView(db: Db, ctx: RequestContext, id: string) {
    const n = await db.nursingNote.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
    const names = await this.names(db, ctx, [n.authorId]);
    return { id: n.id, note: n.note, status: n.status, authorId: n.authorId, authorName: names.get(n.authorId) ?? null, createdAt: n.createdAt, addendumOfId: n.addendumOfId };
  }

  // ───────────── tasks ─────────────

  async createTask(ctx: RequestContext, admissionId: string, input: z.infer<typeof taskSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.admission(tx, ctx, admissionId, true);
      if (input.assignedToId) {
        const u = await tx.user.findFirst({ where: { id: input.assignedToId, tenantId: ctx.tenantId, status: "ACTIVE", facilities: { some: { facilityId: ctx.facilityId } } }, select: { id: true } });
        if (!u) throw new DomainError("VALIDATION_FAILED", "The assignee is not an active user at this facility", 400, [{ path: "assignedToId", message: "Unknown user" }]);
      }
      const t = await tx.nursingTask.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId, assignedToId: input.assignedToId ?? null, type: input.type, title: input.title, dueAt: input.dueAt, createdById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "NURSING_TASK_CREATED", entityType: "NursingTask", entityId: t.id, metadata: { admissionId, type: input.type } });
      return t;
    });
  }

  async closeTask(ctx: RequestContext, taskId: string, status: "DONE" | "CANCELLED", note: string | undefined) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.nursingTask.findFirst({ where: { id: taskId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (t.status !== "PENDING") throw new DomainError("INVALID_STATE", `This task is already ${t.status.toLowerCase()}`, 409);
      const res = await tx.nursingTask.updateMany({ where: { id: taskId, tenantId: ctx.tenantId, status: "PENDING" }, data: { status, completedById: ctx.userId, completedAt: new Date(), closeNote: note ?? null } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The task was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: `NURSING_TASK_${status}`, entityType: "NursingTask", entityId: taskId, metadata: { admissionId: t.admissionId } });
      return tx.nursingTask.findFirstOrThrow({ where: { id: taskId, tenantId: ctx.tenantId } });
    });
  }

  async listTasks(ctx: RequestContext, admissionId: string) {
    await this.admission(this.prisma, ctx, admissionId, false);
    return this.prisma.nursingTask.findMany({ where: { tenantId: ctx.tenantId, admissionId }, orderBy: [{ status: "asc" }, { dueAt: "asc" }], take: 200 });
  }

  // ───────────── intake / output ─────────────

  async recordIo(ctx: RequestContext, admissionId: string, input: z.infer<typeof ioSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.admission(tx, ctx, admissionId, true);
      const now = new Date();
      const at = input.recordedAt ?? now;
      if (at.getTime() > now.getTime() + 5 * 60_000) throw new DomainError("VALIDATION_FAILED", "A reading cannot be recorded in the future", 400);
      if (at.getTime() < adm.admittedAt.getTime()) throw new DomainError("VALIDATION_FAILED", "A reading cannot be dated before the admission", 400);
      const r = await tx.intakeOutput.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId, direction: input.direction, category: input.category, amount: input.amount.toFixed(1), recordedAt: at, recordedById: ctx.userId },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "INTAKE_OUTPUT_RECORDED", entityType: "IntakeOutput", entityId: r.id, metadata: { admissionId, direction: input.direction, category: input.category } });
      return { ...r, amount: r.amount.toFixed(1) };
    });
  }

  async ioInError(ctx: RequestContext, id: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.intakeOutput.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (r.status !== "FINAL") throw new DomainError("INVALID_STATE", "This entry is already marked as an error", 409);
      const res = await tx.intakeOutput.updateMany({ where: { id, tenantId: ctx.tenantId, status: "FINAL" }, data: { status: "ENTERED_IN_ERROR", errorReason: reason, errorById: ctx.userId, errorAt: new Date() } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The entry was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "INTAKE_OUTPUT_ENTERED_IN_ERROR", entityType: "IntakeOutput", entityId: id, metadata: { admissionId: r.admissionId, reason } });
      const u = await tx.intakeOutput.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
      return { ...u, amount: u.amount.toFixed(1) };
    });
  }

  async listIo(ctx: RequestContext, admissionId: string) {
    await this.admission(this.prisma, ctx, admissionId, false);
    const rows = await this.prisma.intakeOutput.findMany({ where: { tenantId: ctx.tenantId, admissionId }, orderBy: { recordedAt: "desc" }, take: 500 });
    return rows.map((r) => ({ ...r, amount: r.amount.toFixed(1) }));
  }

  /** Totals for the I/O day (06:00 to 06:00 facility time) and for each nursing shift inside it. */
  async ioTotals(ctx: RequestContext, admissionId: string, date: string) {
    await this.admission(this.prisma, ctx, admissionId, false);
    const tz = (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
    const windowStart = zonedToUtc(date, 6 * 60, tz);
    const windowEnd = zonedToUtc(date, 30 * 60, tz);
    const rows = await this.prisma.intakeOutput.findMany({ where: { tenantId: ctx.tenantId, admissionId, status: "FINAL", recordedAt: { gte: windowStart, lt: windowEnd } }, select: { direction: true, category: true, amount: true, recordedAt: true } });
    const sum = (list: typeof rows, dir: "INTAKE" | "OUTPUT") => list.filter((r) => r.direction === dir).reduce((a, r) => a.plus(r.amount.toString()), new Decimal(0));
    const block = (list: typeof rows) => {
      const intake = sum(list, "INTAKE");
      const output = sum(list, "OUTPUT");
      const byCategory: Record<string, string> = {};
      for (const r of list) byCategory[r.category] = new Decimal(byCategory[r.category] ?? 0).plus(r.amount.toString()).toFixed(1);
      return { intake: intake.toFixed(1), output: output.toFixed(1), balance: intake.minus(output).toFixed(1), byCategory };
    };
    return {
      date, unit: "ml", window: { from: windowStart, to: windowEnd }, daily: block(rows),
      shifts: SHIFTS.map((s) => {
        const from = zonedToUtc(date, s.from, tz);
        const to = zonedToUtc(date, s.to, tz);
        return { shift: s.name, from, to, label: `${formatHm(s.from % 1440)}-${formatHm(s.to % 1440)}`, ...block(rows.filter((r) => r.recordedAt >= from && r.recordedAt < to)) };
      }),
    };
  }

  // ───────────── worklist ─────────────

  /** One screen for the nurse: every current patient with bed, doctor, open tasks, medication due/overdue and vitals due. */
  async worklist(ctx: RequestContext, wardId: string | undefined) {
    const now = Date.now();
    const adms = await this.prisma.admission.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ADMITTED", ...(wardId ? { assignments: { some: { releasedAt: null, bed: { wardId } } } } : {}) },
      select: {
        id: true, admissionNumber: true, admittedAt: true, encounterId: true, patientId: true,
        patient: { select: { firstName: true, lastName: true, gender: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } },
        consultant: { select: { displayName: true } },
        assignments: { where: { releasedAt: null }, select: { bed: { select: { code: true, ward: { select: { id: true, name: true } } } } } },
      },
      orderBy: { admittedAt: "asc" }, take: 300,
    });
    const admIds = adms.map((a) => a.id);
    const encIds = adms.map((a) => a.encounterId);
    const chart = await linkedIdsByPatient(this.prisma, ctx.tenantId, [...new Set(adms.map((a) => a.patientId))]);
    const [tasks, dueMar, lastVitals, allergies] = await Promise.all([
      this.prisma.nursingTask.findMany({ where: { tenantId: ctx.tenantId, admissionId: { in: admIds }, status: "PENDING" }, orderBy: { dueAt: "asc" }, select: { id: true, admissionId: true, type: true, title: true, dueAt: true, assignedToId: true } }),
      this.prisma.medicationAdministration.groupBy({ by: ["admissionId"], where: { tenantId: ctx.tenantId, admissionId: { in: admIds }, status: "DUE", scheduledAt: { lte: new Date(now + 60 * 60_000) }, item: { status: "ACTIVE" } }, _count: { _all: true }, _min: { scheduledAt: true } }),
      this.prisma.observation.groupBy({ by: ["encounterId"], where: { tenantId: ctx.tenantId, encounterId: { in: encIds }, status: "FINAL" }, _max: { recordedAt: true } }),
      this.prisma.allergy.groupBy({ by: ["patientId"], where: { tenantId: ctx.tenantId, patientId: { in: [...chart.values()].flat() }, status: "ACTIVE" }, _count: { _all: true } }),
    ]);
    const overdueRows = await this.prisma.medicationAdministration.groupBy({ by: ["admissionId"], where: { tenantId: ctx.tenantId, admissionId: { in: admIds }, status: "DUE", scheduledAt: { lt: new Date(now - 30 * 60_000) }, item: { status: "ACTIVE" } }, _count: { _all: true } });
    return adms.map((a) => {
      const bed = a.assignments[0]?.bed;
      const due = dueMar.find((d) => d.admissionId === a.id);
      const lastV = lastVitals.find((v) => v.encounterId === a.encounterId)?._max.recordedAt ?? null;
      const myTasks = tasks.filter((t) => t.admissionId === a.id);
      return {
        admissionId: a.id, admissionNumber: a.admissionNumber, patientId: a.patientId, encounterId: a.encounterId,
        patientName: [a.patient.firstName, a.patient.lastName].filter(Boolean).join(" "), gender: a.patient.gender, mrn: a.patient.identifiers[0]?.value ?? null,
        bed: bed?.code ?? null, ward: bed?.ward.name ?? null, wardId: bed?.ward.id ?? null, doctor: a.consultant.displayName, admittedAt: a.admittedAt,
        hasAllergies: allergies.some((x) => (chart.get(a.patientId) ?? [a.patientId]).includes(x.patientId)),
        pendingTasks: myTasks.length, overdueTasks: myTasks.filter((t) => t.dueAt.getTime() < now).length, tasks: myTasks.slice(0, 5),
        medicationDue: due?._count._all ?? 0, medicationOverdue: overdueRows.find((o) => o.admissionId === a.id)?._count._all ?? 0, nextMedicationAt: due?._min.scheduledAt ?? null,
        lastVitalsAt: lastV, vitalsDue: !lastV || now - lastV.getTime() > VITALS_INTERVAL_MIN * 60_000,
      };
    }).sort((x, y) => (y.medicationOverdue - x.medicationOverdue) || (y.overdueTasks - x.overdueTasks) || ((x.bed ?? "").localeCompare(y.bed ?? "")));
  }
}

export type WorklistRow = Awaited<ReturnType<NursingService["worklist"]>>[number];
