import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/),
}).strict();
export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "No changes supplied");

const practitionerBase = {
  displayName: z.string().trim().min(2).max(120),
  specialty: z.string().trim().max(80).nullable(),
  registrationNo: z.string().trim().max(40).nullable(),
  departmentId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
};
export const createPractitionerSchema = z.object(practitionerBase).partial({ specialty: true, registrationNo: true, departmentId: true, userId: true }).strict();
export const updatePractitionerSchema = z.object({ ...practitionerBase, status: z.enum(["ACTIVE", "INACTIVE"]) }).partial().strict()
  .refine((v) => Object.keys(v).length > 0, "No changes supplied");
export const listMasterSchema = z.object({
  includeInactive: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  departmentId: z.string().uuid().optional(),
}).strict();

const DEPT = { id: true, name: true, code: true, status: true } as const;
const PRAC = { id: true, displayName: true, specialty: true, registrationNo: true, departmentId: true, userId: true, status: true, scheduleSet: true } as const;

@Injectable()
export class MastersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  // ───── departments ─────
  async listDepartments(ctx: RequestContext, includeInactive: boolean) {
    const canSeeInactive = includeInactive && ctx.permissions.has("ADMIN_MASTERS");
    return this.prisma.department.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(canSeeInactive ? {} : { status: "ACTIVE" }) },
      select: DEPT, orderBy: { name: "asc" },
    });
  }

  async createDepartment(ctx: RequestContext, input: z.infer<typeof createDepartmentSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.department.create({ data: { ...input, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: DEPT });
      await this.audit.record(tx, actorOf(ctx), { action: "DEPARTMENT_CREATED", entityType: "Department", entityId: d.id, metadata: { code: d.code } });
      return d;
    });
  }

  async updateDepartment(ctx: RequestContext, id: string, input: z.infer<typeof updateDepartmentSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.department.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (input.status === "INACTIVE" && existing.status === "ACTIVE") {
        // A department that still has working doctors would hide them from its own lists; move or switch them off first.
        const doctors = await tx.practitioner.count({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, departmentId: id, status: "ACTIVE" } });
        if (doctors > 0) throw new DomainError("INVALID_STATE", `${doctors} doctor${doctors === 1 ? ' still works' : 's still work'} in this department. Move them to another department or switch them off first.`, 409, { doctors });
      }
      const d = await tx.department.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: input, select: DEPT });
      await this.audit.record(tx, actorOf(ctx), { action: "DEPARTMENT_UPDATED", entityType: "Department", entityId: id, metadata: { changed: Object.keys(input) } });
      return d;
    });
  }

  // ───── practitioners ─────
  async listPractitioners(ctx: RequestContext, q: z.infer<typeof listMasterSchema>) {
    const canSeeInactive = q.includeInactive && ctx.permissions.has("ADMIN_MASTERS");
    return this.prisma.practitioner.findMany({
      where: {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId,
        ...(canSeeInactive ? {} : { status: "ACTIVE" }),
        ...(q.departmentId ? { departmentId: q.departmentId } : {}),
      },
      select: PRAC, orderBy: { displayName: "asc" },
    });
  }

  async createPractitioner(ctx: RequestContext, input: z.infer<typeof createPractitionerSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertLinks(tx, ctx, input.departmentId ?? null, input.userId ?? null, null);
      const p = await tx.practitioner.create({
        data: { ...input, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: PRAC,
      });
      await this.audit.record(tx, actorOf(ctx), { action: "PRACTITIONER_CREATED", entityType: "Practitioner", entityId: p.id, metadata: { userId: p.userId } });
      return p;
    });
  }

  async updatePractitioner(ctx: RequestContext, id: string, input: z.infer<typeof updatePractitionerSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.practitioner.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await this.assertLinks(tx, ctx, input.departmentId ?? null, input.userId ?? null, id);
      const p = await tx.practitioner.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: input, select: PRAC });
      // Switching a doctor off does not cancel anything. Tell the administrator how many booked visits are still waiting for this doctor.
      const upcomingBooked = input.status === "INACTIVE" && existing.status === "ACTIVE"
        ? await tx.appointment.count({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, practitionerId: id, status: "BOOKED", startAt: { gte: new Date() } } })
        : 0;
      await this.audit.record(tx, actorOf(ctx), { action: "PRACTITIONER_UPDATED", entityType: "Practitioner", entityId: id, metadata: { changed: Object.keys(input), ...(upcomingBooked > 0 ? { upcomingBooked } : {}) } });
      return { ...p, upcomingBooked };
    });
  }

  /** Link targets must live in the caller's tenant/facility; failures look like plain validation errors. */
  private async assertLinks(tx: Db, ctx: RequestContext, departmentId: string | null, userId: string | null, practitionerId: string | null): Promise<void> {
    if (departmentId) {
      const d = await tx.department.findFirst({ where: { id: departmentId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } });
      if (!d) throw new DomainError("VALIDATION_FAILED", "Department not found or inactive", 400);
    }
    if (userId) {
      const u = await tx.user.findFirst({ where: { id: userId, tenantId: ctx.tenantId, status: "ACTIVE", facilities: { some: { facilityId: ctx.facilityId } } } });
      if (!u) throw new DomainError("VALIDATION_FAILED", "User not found, inactive, or without access to this facility", 400);
      const taken = await tx.practitioner.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId, ...(practitionerId ? { NOT: { id: practitionerId } } : {}) }, select: { id: true } });
      if (taken) throw new DomainError("CONFLICT", "This staff login is already a doctor at this facility", 409, [{ path: "userId", message: "Already linked to a doctor" }]);
    }
  }
}
