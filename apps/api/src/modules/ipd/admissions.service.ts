import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { RegistrationFeeService } from "../patients/registration-fee.service";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { admissionScope } from "../../common/data-scope";
import { chartPatientIds } from "../patients/patient-links";
import { fmt } from "../billing/billing.domain";
import { EncountersService } from "../encounters/encounters.service";
import { NumberingService } from "../numbering/numbering.service";

const uuid = z.string().uuid();

export const admitSchema = z.object({
  patientId: uuid, consultantId: uuid, bedId: uuid, departmentId: uuid.optional(),
  reason: z.string().trim().min(3).max(300).optional(),
}).strict();
export const transferSchema = z.object({ toBedId: uuid, reason: z.string().trim().min(3).max(240) }).strict();
export const cancelAdmissionSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();
export const listAdmissionsSchema = z.object({
  status: z.enum(["ADMITTED", "DISCHARGED", "CANCELLED"]).default("ADMITTED"), wardId: uuid.optional(), patientId: uuid.optional(),
  q: z.string().trim().min(2).max(60).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const VIEW = {
  id: true, admissionNumber: true, status: true, admittedAt: true, dischargedAt: true, reason: true, encounterId: true, patientId: true, consultantId: true, departmentId: true, version: true, cancelReason: true,
  patient: { select: { firstName: true, lastName: true, gender: true, identifiers: { where: { type: "MRN" as const }, select: { value: true } } } },
  consultant: { select: { displayName: true } }, department: { select: { name: true } },
  assignments: { where: { releasedAt: null }, select: { bedId: true, assignedAt: true, bed: { select: { code: true, ward: { select: { id: true, name: true } }, room: { select: { name: true } } } } } },
} satisfies Prisma.AdmissionSelect;
type Row = Prisma.AdmissionGetPayload<{ select: typeof VIEW }>;

export function toAdmissionView(a: Row, now = Date.now()) {
  const cur = a.assignments[0];
  const end = a.dischargedAt?.getTime() ?? now;
  return {
    id: a.id, admissionNumber: a.admissionNumber, status: a.status, admittedAt: a.admittedAt, dischargedAt: a.dischargedAt, reason: a.reason, encounterId: a.encounterId, patientId: a.patientId, version: a.version, cancelReason: a.cancelReason,
    patientName: [a.patient.firstName, a.patient.lastName].filter(Boolean).join(" "), gender: a.patient.gender, mrn: a.patient.identifiers[0]?.value ?? null,
    consultantId: a.consultantId, consultantName: a.consultant.displayName, departmentName: a.department?.name ?? null,
    bed: cur ? { bedId: cur.bedId, code: cur.bed.code, ward: cur.bed.ward.name, wardId: cur.bed.ward.id, room: cur.bed.room.name, since: cur.assignedAt } : null,
    lengthOfStayDays: Math.max(0, Math.floor((end - a.admittedAt.getTime()) / 86_400_000)),
  };
}

@Injectable()
export class AdmissionsService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService,
    private readonly encounters: EncountersService, private readonly idempotency: IdempotencyService, private readonly registrationFee: RegistrationFeeService,
  ) {}

  // ───── admit ─────

  /** Opens the IPD encounter and admission, and allocates the bed, atomically. The bed row is locked for the whole transaction. */
  async admit(ctx: RequestContext, input: z.infer<typeof admitSchema>, key: string | undefined) {
    return this.idempotency.run(ctx.tenantId, "ADMIT", key, input, async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
      // A patient whose registration fee is still pending is admitted once it is collected or exempted at Reception.
      if (patient) await this.registrationFee.gate(tx, ctx, patient.id);
      if (!patient) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
      const consultant = await tx.practitioner.findFirst({ where: { id: input.consultantId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, departmentId: true } });
      if (!consultant) throw new DomainError("VALIDATION_FAILED", "Consultant not found or inactive at this facility", 400, [{ path: "consultantId", message: "Unknown consultant" }]);
      let departmentId = consultant.departmentId;
      if (input.departmentId) {
        const d = await tx.department.findFirst({ where: { id: input.departmentId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true } });
        if (!d) throw new DomainError("VALIDATION_FAILED", "Department not found or inactive", 400, [{ path: "departmentId", message: "Unknown department" }]);
        departmentId = d.id;
      }
      const existing = await tx.admission.findFirst({ where: { tenantId: ctx.tenantId, patientId: input.patientId, status: "ADMITTED" }, select: { admissionNumber: true } });
      if (existing) throw new DomainError("CONFLICT", `This patient is already admitted (${existing.admissionNumber})`, 409);

      const bed = await this.lockBed(tx, ctx, input.bedId);
      this.assertAllocatable(bed);

      const admissionNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "ADMISSION");
      const encounter = await tx.encounter.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, encounterNumber: admissionNumber, type: "IPD", practitionerId: consultant.id, departmentId, createdById: ctx.userId },
      });
      const admission = await tx.admission.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, encounterId: encounter.id, admissionNumber, consultantId: consultant.id, departmentId, reason: input.reason ?? null, createdById: ctx.userId },
      });
      await this.openAssignment(tx, ctx, admission.id, bed, null, new Date());
      await this.audit.record(tx, actorOf(ctx), { action: "ENCOUNTER_OPENED", entityType: "Encounter", entityId: encounter.id, metadata: { type: "IPD", encounterNumber: admissionNumber } });
      await this.audit.record(tx, actorOf(ctx), { action: "ADMISSION_CREATED", entityType: "Admission", entityId: admission.id, metadata: { admissionNumber, bedId: bed.id, consultantId: consultant.id } });
      return this.view(tx, ctx, admission.id);
    });
  }

  // ───── transfer ─────

  /** Moves the patient to another bed, closing the current assignment and opening a new one so the full path is preserved. */
  async transfer(ctx: RequestContext, admissionId: string, input: z.infer<typeof transferSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, status: true } });
      if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "Only current admissions can be transferred", 409);
      const current = await tx.bedAssignment.findFirst({ where: { tenantId: ctx.tenantId, admissionId, releasedAt: null } });
      if (!current) throw new DomainError("INVALID_STATE", "This admission has no current bed", 409);
      if (current.bedId === input.toBedId) throw new DomainError("VALIDATION_FAILED", "The patient is already in this bed", 400);

      // Lock both beds in a fixed order so two crossing transfers cannot deadlock.
      const [first, second] = [current.bedId, input.toBedId].sort();
      await this.lockBed(tx, ctx, first as string);
      await this.lockBed(tx, ctx, second as string);
      const target = await tx.bed.findFirstOrThrow({ where: { id: input.toBedId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      this.assertAllocatable(target);

      const now = new Date();
      const closed = await tx.bedAssignment.updateMany({ where: { id: current.id, tenantId: ctx.tenantId, releasedAt: null }, data: { releasedAt: now } });
      if (closed.count !== 1) throw new DomainError("INVALID_STATE", "The admission was changed by someone else", 409);
      await tx.bed.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: current.bedId } }, data: { status: "CLEANING", version: { increment: 1 } } });
      await this.openAssignment(tx, ctx, admissionId, target, input.reason, now);
      await this.audit.record(tx, actorOf(ctx), { action: "BED_TRANSFERRED", entityType: "Admission", entityId: admissionId, metadata: { fromBedId: current.bedId, toBedId: target.id, reason: input.reason } });
      return this.view(tx, ctx, admissionId);
    });
  }

  // ───── cancel ─────

  async cancel(ctx: RequestContext, admissionId: string, input: z.infer<typeof cancelAdmissionSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "Only current admissions can be cancelled", 409);
      if ((await tx.charge.count({ where: { tenantId: ctx.tenantId, admissionId, status: { not: "VOIDED" } } })) > 0) {
        throw new DomainError("INVALID_STATE", "This admission already has charges. Discharge the patient instead of cancelling.", 409);
      }
      await this.releaseBed(tx, ctx, admissionId, "AVAILABLE", new Date());
      await tx.admission.updateMany({ where: { id: admissionId, tenantId: ctx.tenantId, status: "ADMITTED" }, data: { status: "CANCELLED", cancelReason: input.reason, version: { increment: 1 } } });
      await this.encounters.transition(tx, ctx, adm.encounterId, "CANCELLED", input.reason);
      await this.audit.record(tx, actorOf(ctx), { action: "ADMISSION_CANCELLED", entityType: "Admission", entityId: admissionId, metadata: { reason: input.reason } });
      return this.view(tx, ctx, admissionId);
    });
  }

  // ───── reads ─────

  async list(ctx: RequestContext, q: z.infer<typeof listAdmissionsSchema>) {
    const where: Prisma.AdmissionWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: q.status, AND: [admissionScope(ctx)],
      ...(q.patientId ? { patientId: { in: (await chartPatientIds(this.prisma, ctx.tenantId, q.patientId)) ?? [q.patientId] } } : {}),
      ...(q.wardId ? { assignments: { some: { releasedAt: null, bed: { wardId: q.wardId } } } } : {}),
      ...(q.q ? { OR: [{ admissionNumber: { contains: q.q, mode: "insensitive" } }, { patient: { searchName: { contains: q.q.toLowerCase() } } }, { patient: { identifiers: { some: { value: { contains: q.q, mode: "insensitive" } } } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.admission.findMany({ where, select: VIEW, orderBy: { admittedAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.admission.count({ where }),
    ]);
    const now = Date.now();
    return { items: rows.map((r) => toAdmissionView(r, now)), total };
  }

  async get(ctx: RequestContext, id: string) {
    const a = await this.prisma.admission.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, select: { id: true } });
    if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return { ...(await this.view(this.prisma, ctx, id)), bedHistory: await this.bedHistory(this.prisma, ctx, id) };
  }

  /** The complete path: e.g. Ward A -> ICU -> Ward B, with times and the rate in force. */
  async bedHistory(db: Db, ctx: RequestContext, admissionId: string) {
    const rows = await db.bedAssignment.findMany({
      where: { tenantId: ctx.tenantId, admissionId }, orderBy: { assignedAt: "asc" },
      select: { id: true, assignedAt: true, releasedAt: true, reason: true, dailyRate: true, assignedById: true, bed: { select: { code: true, ward: { select: { name: true } }, room: { select: { name: true } } } } },
    });
    return rows.map((r) => ({ id: r.id, bedCode: r.bed.code, ward: r.bed.ward.name, room: r.bed.room.name, assignedAt: r.assignedAt, releasedAt: r.releasedAt, reason: r.reason, dailyRate: fmt(r.dailyRate), assignedById: r.assignedById }));
  }

  // ───── used by discharge ─────

  /** Closes the open assignment and moves the bed to the given status. */
  async releaseBed(tx: Db, ctx: RequestContext, admissionId: string, to: "CLEANING" | "AVAILABLE", at: Date): Promise<void> {
    const current = await tx.bedAssignment.findFirst({ where: { tenantId: ctx.tenantId, admissionId, releasedAt: null } });
    if (!current) return;
    await this.lockBed(tx, ctx, current.bedId);
    const closed = await tx.bedAssignment.updateMany({ where: { id: current.id, tenantId: ctx.tenantId, releasedAt: null }, data: { releasedAt: at } });
    if (closed.count !== 1) throw new DomainError("INVALID_STATE", "The admission was changed by someone else", 409);
    await tx.bed.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: current.bedId } }, data: { status: to, version: { increment: 1 } } });
  }

  // ───── internals ─────

  private async lockBed(tx: Db, ctx: RequestContext, bedId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Bed" WHERE id = ${bedId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.bed.findFirstOrThrow({ where: { id: bedId, tenantId: ctx.tenantId } });
  }

  private assertAllocatable(bed: { code: string; status: string; active: string }): void {
    if (bed.active !== "ACTIVE") throw new DomainError("BED_NOT_AVAILABLE", `Bed ${bed.code} is not in service`, 409);
    if (bed.status !== "AVAILABLE") throw new DomainError("BED_NOT_AVAILABLE", `Bed ${bed.code} is ${bed.status.toLowerCase()} and cannot be allocated`, 409, { status: bed.status });
  }

  private async openAssignment(tx: Db, ctx: RequestContext, admissionId: string, bed: { id: string; dailyRate: Prisma.Decimal }, reason: string | null | undefined, at: Date): Promise<void> {
    await tx.bedAssignment.create({
      data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, bedId: bed.id, assignedAt: at, reason: reason ?? null, dailyRate: bed.dailyRate.toFixed(2), assignedById: ctx.userId },
    });
    await tx.bed.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: bed.id } }, data: { status: "OCCUPIED", version: { increment: 1 } } });
  }

  async view(db: Db, ctx: RequestContext, id: string) {
    const a = await db.admission.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW });
    return toAdmissionView(a);
  }
}
