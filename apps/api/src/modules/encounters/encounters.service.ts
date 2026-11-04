import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { assertPatientVisible, visitScope } from "../../common/data-scope";
import { chartPatientIds } from "../patients/patient-links";
import { NumberingService } from "../numbering/numbering.service";

export type EncounterStatusName = "ACTIVE" | "COMPLETED" | "CANCELLED";

/** Single source of truth for allowed encounter transitions (mirrored by a database trigger). */
export const ENCOUNTER_TRANSITIONS: Record<EncounterStatusName, readonly EncounterStatusName[]> = {
  ACTIVE: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export const listEncountersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  type: z.enum(["OPD", "IPD"]).optional(),
}).strict();

const VIEW = {
  id: true, encounterNumber: true, type: true, status: true, patientId: true, facilityId: true,
  departmentId: true, practitionerId: true, startedAt: true, endedAt: true,
  department: { select: { name: true } }, practitioner: { select: { displayName: true } },
} satisfies Prisma.EncounterSelect;

export function toEncounterView(e: Prisma.EncounterGetPayload<{ select: typeof VIEW }>) {
  const { department, practitioner, ...rest } = e;
  return { ...rest, departmentName: department?.name ?? null, practitionerName: practitioner?.displayName ?? null };
}

@Injectable()
export class EncountersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService) {}

  /** Opens an OPD encounter inside the caller's transaction (used by check-in and walk-in). */
  async openOpd(tx: Db, ctx: RequestContext, input: { patientId: string; practitionerId: string; departmentId: string | null }, opts: { patientVerified?: boolean } = {}) {
    if (!opts.patientVerified) {
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
      if (!patient) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    }
    const encounterNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "OPD_VISIT");
    const e = await tx.encounter.create({
      data: {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, encounterNumber, type: "OPD",
        practitionerId: input.practitionerId, departmentId: input.departmentId, createdById: ctx.userId,
      },
      select: VIEW,
    });
    await this.audit.record(tx, actorOf(ctx), { action: "ENCOUNTER_OPENED", entityType: "Encounter", entityId: e.id, metadata: { type: "OPD", encounterNumber } });
    return e;
  }

  /** Compare-and-set transition: only succeeds if the encounter is still in the expected state. */
  async transition(tx: Db, ctx: RequestContext, encounterId: string, to: Exclude<EncounterStatusName, "ACTIVE">, reason?: string): Promise<void> {
    const existing = await tx.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { status: true } });
    if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const from = existing.status as EncounterStatusName;
    if (!ENCOUNTER_TRANSITIONS[from].includes(to)) {
      throw new DomainError("INVALID_STATE", `Encounter is ${from.toLowerCase()} and cannot become ${to.toLowerCase()}`, 409);
    }
    const res = await tx.encounter.updateMany({
      where: { id: encounterId, tenantId: ctx.tenantId, status: from },
      data: { status: to, endedAt: new Date(), cancelReason: to === "CANCELLED" ? reason ?? null : null },
    });
    if (res.count !== 1) throw new DomainError("INVALID_STATE", "Encounter was changed by someone else", 409);
    await this.audit.record(tx, actorOf(ctx), { action: `ENCOUNTER_${to}`, entityType: "Encounter", entityId: encounterId, metadata: { from, ...(reason ? { reason } : {}) } });
  }

  /** Throws unless the encounter exists in this tenant/facility and is ACTIVE. Used by clinical writers. */
  async assertActive(tx: Db, ctx: RequestContext, encounterId: string): Promise<{ id: string; patientId: string; type: "OPD" | "IPD"; practitionerId: string | null }> {
    const e = await tx.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, status: true, patientId: true, type: true, practitionerId: true } });
    if (!e) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (e.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This visit is no longer active", 409);
    return e;
  }

  async get(ctx: RequestContext, id: string) {
    const e = await this.prisma.encounter.findFirst({ where: { id, tenantId: ctx.tenantId, AND: [visitScope(ctx)] }, select: VIEW });
    if (!e) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return toEncounterView(e);
  }

  async listForPatient(ctx: RequestContext, patientId: string, q: z.infer<typeof listEncountersSchema>) {
    const ids = await chartPatientIds(this.prisma, ctx.tenantId, patientId);
    if (!ids) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    await assertPatientVisible(this.prisma, ctx, patientId);
    const where: Prisma.EncounterWhereInput = { tenantId: ctx.tenantId, patientId: { in: ids }, AND: [visitScope(ctx)], ...(q.type ? { type: q.type } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.encounter.findMany({ where, select: VIEW, orderBy: { startedAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.encounter.count({ where }),
    ]);
    return { items: rows.map(toEncounterView), total };
  }
}
