import { Injectable } from "@nestjs/common";
import { DomainError, PERMISSIONS } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { PasswordService } from "../auth/password.service";
import { passwordPolicy } from "../tenants/tenants.service";

const uuids = z.array(z.string().uuid()).min(1).max(50);

export const createUserSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/),
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().optional(),
  password: passwordPolicy,
  roleIds: uuids,
  facilityIds: uuids,
}).strict();

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "No changes supplied");

export const setRolesSchema = z.object({ roleIds: uuids }).strict();
export const setFacilitiesSchema = z.object({ facilityIds: uuids }).strict();
/** Departments a user belongs to. Empty means not limited by department (docs/data-access.md). */
export const setDepartmentsSchema = z.object({ departmentIds: z.array(z.string().uuid()).max(50) }).strict();
export const resetPasswordSchema = z.object({ password: passwordPolicy }).strict();
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordPolicy }).strict();
export const listUsersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(60).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
}).strict();

export const createRoleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  permissions: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
}).strict();
export const setPermissionsSchema = z.object({ permissions: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length) }).strict();

const USER_SELECT = {
  id: true, username: true, email: true, fullName: true, status: true, createdAt: true,
  roles: { select: { role: { select: { id: true, name: true } } } },
  facilities: { select: { facility: { select: { id: true, name: true, code: true } } } },
  departments: { select: { department: { select: { id: true, name: true, code: true } } } },
} as const;

function shape(u: { roles: { role: { id: string; name: string } }[]; facilities: { facility: { id: string; name: string; code: string } }[]; departments: { department: { id: string; name: string; code: string } }[] } & Record<string, unknown>) {
  const { roles, facilities, departments, ...rest } = u;
  return { ...rest, roles: roles.map((r) => r.role), facilities: facilities.map((f) => f.facility), departments: departments.map((d) => d.department) };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async create(ctx: RequestContext, input: z.infer<typeof createUserSchema>) {
    const passwordHash = await this.passwords.hash(input.password);
    return this.prisma.$transaction(async (tx) => {
      const roleIds = [...new Set(input.roleIds)];
      const facilityIds = [...new Set(input.facilityIds)];
      await this.assertRolesAndFacilities(tx, ctx.tenantId, roleIds, facilityIds);
      const u = await tx.user.create({
        data: { tenantId: ctx.tenantId, username: input.username, email: input.email ?? null, fullName: input.fullName, passwordHash },
      });
      await tx.userRole.createMany({ data: roleIds.map((roleId) => ({ tenantId: ctx.tenantId, userId: u.id, roleId })) });
      await tx.userFacility.createMany({ data: facilityIds.map((facilityId) => ({ tenantId: ctx.tenantId, userId: u.id, facilityId })) });
      await this.audit.record(tx, actorOf(ctx), { action: "USER_CREATED", entityType: "User", entityId: u.id, metadata: { roleIds, facilityIds } });
      return shape(await tx.user.findFirstOrThrow({ where: { id: u.id, tenantId: ctx.tenantId }, select: USER_SELECT }));
    });
  }

  async list(ctx: RequestContext, q: z.infer<typeof listUsersSchema>) {
    const where = {
      tenantId: ctx.tenantId,
      isService: false, // API clients have a hidden user; they are managed under Integrations, not here
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ fullName: { contains: q.q, mode: "insensitive" as const } }, { username: { contains: q.q.toLowerCase() } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: USER_SELECT, orderBy: { fullName: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.user.count({ where }),
    ]);
    return { items: items.map(shape), total };
  }

  async get(ctx: RequestContext, id: string) {
    const u = await this.prisma.user.findFirst({ where: { id, tenantId: ctx.tenantId }, select: USER_SELECT });
    if (!u) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return shape(u);
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof updateUserSchema>) {
    if (id === ctx.userId && input.status === "INACTIVE") {
      throw new DomainError("SELF_MODIFICATION_FORBIDDEN", "You cannot deactivate your own account", 409);
    }
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await tx.user.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: input });
      const deactivated = input.status === "INACTIVE" && existing.status === "ACTIVE";
      if (deactivated) await tx.refreshToken.updateMany({ where: { tenantId: ctx.tenantId, userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), {
        action: deactivated ? "USER_DEACTIVATED" : "USER_UPDATED", entityType: "User", entityId: id, metadata: { changed: Object.keys(input) },
      });
      return shape(await tx.user.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: USER_SELECT }));
    });
  }

  async setRoles(ctx: RequestContext, id: string, input: z.infer<typeof setRolesSchema>) {
    if (id === ctx.userId) throw new DomainError("SELF_MODIFICATION_FORBIDDEN", "You cannot change your own roles", 409);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({ where: { id, tenantId: ctx.tenantId }, select: { roles: { select: { roleId: true } } } });
      if (!user) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const roleIds = [...new Set(input.roleIds)];
      await this.assertRolesAndFacilities(tx, ctx.tenantId, roleIds, []);
      await tx.userRole.deleteMany({ where: { tenantId: ctx.tenantId, userId: id } });
      await tx.userRole.createMany({ data: roleIds.map((roleId) => ({ tenantId: ctx.tenantId, userId: id, roleId })) });
      await this.audit.record(tx, actorOf(ctx), {
        action: "USER_ROLES_CHANGED", entityType: "User", entityId: id,
        metadata: { before: user.roles.map((r) => r.roleId), after: roleIds },
      });
      return shape(await tx.user.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: USER_SELECT }));
    });
  }

  async setFacilities(ctx: RequestContext, id: string, input: z.infer<typeof setFacilitiesSchema>) {
    if (id === ctx.userId) throw new DomainError("SELF_MODIFICATION_FORBIDDEN", "You cannot change your own facility access", 409);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({ where: { id, tenantId: ctx.tenantId }, select: { facilities: { select: { facilityId: true } } } });
      if (!user) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const facilityIds = [...new Set(input.facilityIds)];
      await this.assertRolesAndFacilities(tx, ctx.tenantId, [], facilityIds);
      await tx.userFacility.deleteMany({ where: { tenantId: ctx.tenantId, userId: id } });
      await tx.userFacility.createMany({ data: facilityIds.map((facilityId) => ({ tenantId: ctx.tenantId, userId: id, facilityId })) });
      const removed = user.facilities.map((f) => f.facilityId).filter((f) => !facilityIds.includes(f));
      if (removed.length) {
        await tx.refreshToken.updateMany({ where: { tenantId: ctx.tenantId, userId: id, facilityId: { in: removed }, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await this.audit.record(tx, actorOf(ctx), {
        action: "USER_FACILITIES_CHANGED", entityType: "User", entityId: id,
        metadata: { before: user.facilities.map((f) => f.facilityId), after: facilityIds },
      });
      return shape(await tx.user.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: USER_SELECT }));
    });
  }

  /** Which departments a user belongs to. A user with departments sees only their data; a doctor is limited to their own patients regardless (docs/data-access.md). */
  async setDepartments(ctx: RequestContext, id: string, input: z.infer<typeof setDepartmentsSchema>) {
    if (id === ctx.userId) throw new DomainError("SELF_MODIFICATION_FORBIDDEN", "You cannot change your own department access", 409);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({ where: { id, tenantId: ctx.tenantId }, select: { departments: { select: { departmentId: true } } } });
      if (!user) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const departmentIds = [...new Set(input.departmentIds)];
      const found = await tx.department.count({ where: { tenantId: ctx.tenantId, id: { in: departmentIds }, status: "ACTIVE" } });
      if (found !== departmentIds.length) throw new DomainError("VALIDATION_FAILED", "One or more departments do not exist or are inactive", 400);
      await tx.userDepartment.deleteMany({ where: { tenantId: ctx.tenantId, userId: id } });
      if (departmentIds.length) await tx.userDepartment.createMany({ data: departmentIds.map((departmentId) => ({ tenantId: ctx.tenantId, userId: id, departmentId })) });
      await this.audit.record(tx, actorOf(ctx), {
        action: "USER_DEPARTMENTS_CHANGED", entityType: "User", entityId: id,
        metadata: { before: user.departments.map((d) => d.departmentId), after: departmentIds },
      });
      return shape(await tx.user.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: USER_SELECT }));
    });
  }

  async resetPassword(ctx: RequestContext, id: string, input: z.infer<typeof resetPasswordSchema>): Promise<void> {
    if (id === ctx.userId) throw new DomainError("SELF_MODIFICATION_FORBIDDEN", "Use the change-password flow for your own account", 409);
    const passwordHash = await this.passwords.hash(input.password);
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await tx.user.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
      await tx.refreshToken.updateMany({ where: { tenantId: ctx.tenantId, userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), { action: "PASSWORD_RESET", entityType: "User", entityId: id });
    });
  }

  async changeOwnPassword(ctx: RequestContext, input: z.infer<typeof changePasswordSchema>): Promise<void> {
    const user = await this.prisma.user.findFirstOrThrow({ where: { id: ctx.userId, tenantId: ctx.tenantId } });
    if (!(await this.passwords.verify(input.currentPassword, user.passwordHash))) {
      throw new DomainError("INVALID_CREDENTIALS", "Current password is incorrect", 400);
    }
    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: ctx.userId } }, data: { passwordHash } });
      await tx.refreshToken.updateMany({ where: { tenantId: ctx.tenantId, userId: ctx.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), { action: "PASSWORD_CHANGED", entityType: "User", entityId: ctx.userId });
    });
  }

  // ───── roles ─────

  async listRoles(ctx: RequestContext) {
    const roles = await this.prisma.role.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, name: true, isSystem: true, permissions: { select: { permission: true } } },
      orderBy: { name: "asc" },
    });
    return roles.map((r) => ({ id: r.id, name: r.name, isSystem: r.isSystem, permissions: r.permissions.map((p) => p.permission).sort() }));
  }

  async createRole(ctx: RequestContext, input: z.infer<typeof createRoleSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.create({ data: { tenantId: ctx.tenantId, name: input.name } });
      const permissions = [...new Set(input.permissions)];
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ tenantId: ctx.tenantId, roleId: role.id, permission })) });
      await this.audit.record(tx, actorOf(ctx), { action: "ROLE_CREATED", entityType: "Role", entityId: role.id, metadata: { name: role.name, permissions } });
      return { id: role.id, name: role.name, isSystem: false, permissions: permissions.sort() };
    });
  }

  async setRolePermissions(ctx: RequestContext, roleId: string, input: z.infer<typeof setPermissionsSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findFirst({ where: { id: roleId, tenantId: ctx.tenantId }, include: { permissions: true } });
      if (!role) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (role.isSystem) throw new DomainError("INVALID_STATE", "System roles cannot be modified; create a custom role instead", 409);
      const permissions = [...new Set(input.permissions)];
      await tx.rolePermission.deleteMany({ where: { tenantId: ctx.tenantId, roleId } });
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ tenantId: ctx.tenantId, roleId, permission })) });
      await this.audit.record(tx, actorOf(ctx), {
        action: "ROLE_PERMISSIONS_CHANGED", entityType: "Role", entityId: roleId,
        metadata: { before: role.permissions.map((p) => p.permission).sort(), after: permissions.sort() },
      });
      return { id: role.id, name: role.name, isSystem: false, permissions };
    });
  }

  private async assertRolesAndFacilities(tx: Db, tenantId: string, roleIds: string[], facilityIds: string[]): Promise<void> {
    if (roleIds.length) {
      const n = await tx.role.count({ where: { tenantId, id: { in: roleIds } } });
      if (n !== roleIds.length) throw new DomainError("VALIDATION_FAILED", "One or more roles do not exist", 400);
    }
    if (facilityIds.length) {
      const n = await tx.facility.count({ where: { tenantId, id: { in: facilityIds }, status: "ACTIVE" } });
      if (n !== facilityIds.length) throw new DomainError("VALIDATION_FAILED", "One or more facilities do not exist or are inactive", 400);
    }
  }
}
