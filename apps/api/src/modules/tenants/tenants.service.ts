import { Injectable } from "@nestjs/common";
import { DomainError, PERMISSIONS, SYSTEM_ROLES } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { PasswordService } from "../auth/password.service";
import { DEFAULT_SEQUENCES } from "../numbering/numbering.service";

const tzSchema = z.string().min(3).max(64).refine((tz) => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}, "Unknown timezone");

export const passwordPolicy = z.string().min(10, "Password must be at least 10 characters").max(256)
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), "Password must contain letters and digits");

export const provisionSchema = z.object({
  tenant: z.object({
    name: z.string().trim().min(2).max(120),
    code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, "lowercase letters, digits, hyphen; 2-32 chars"),
    timezone: tzSchema.default("Asia/Kolkata"),
  }).strict(),
  facility: z.object({
    name: z.string().trim().min(2).max(120),
    code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,15}$/),
    city: z.string().max(80).optional(),
    district: z.string().max(80).optional(),
    state: z.string().max(80).optional(),
  }).strict(),
  admin: z.object({
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/),
    fullName: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().optional(),
    password: passwordPolicy,
  }).strict(),
}).strict();

export const updateTenantSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  timezone: tzSchema.optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "No changes supplied");

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Platform-operator action (CLI only; no HTTP surface in MLP-1).
   * Creates a tenant with its first facility, system roles, number-sequence defaults and an administrator.
   */
  async provision(input: z.infer<typeof provisionSchema>) {
    const passwordHash = await this.passwords.hash(input.admin.password);
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: { name: input.tenant.name, code: input.tenant.code, timezone: input.tenant.timezone } });
      const facility = await tx.facility.create({ data: { tenantId: tenant.id, timezone: input.tenant.timezone, ...input.facility } });

      const roleIds = new Map<string, string>();
      for (const [name, perms] of Object.entries(SYSTEM_ROLES)) {
        const role = await tx.role.create({ data: { tenantId: tenant.id, name, isSystem: true } });
        await tx.rolePermission.createMany({ data: [...new Set(perms)].map((permission) => ({ tenantId: tenant.id, roleId: role.id, permission })) });
        roleIds.set(name, role.id);
      }
      // Tenant administrators also get every permission needed to configure and oversee clinical staff.
      const adminRole = roleIds.get("ADMINISTRATOR") as string;

      const admin = await tx.user.create({
        data: { tenantId: tenant.id, username: input.admin.username, email: input.admin.email ?? null, fullName: input.admin.fullName, passwordHash },
      });
      await tx.userFacility.create({ data: { tenantId: tenant.id, userId: admin.id, facilityId: facility.id } });
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: admin.id, roleId: adminRole } });
      await tx.numberSequenceConfig.createMany({
        data: DEFAULT_SEQUENCES.map((s) => ({ tenantId: tenant.id, facilityId: facility.id, type: s.type, pattern: s.pattern, padding: s.padding, resetPolicy: s.resetPolicy })),
      });
      await this.audit.record(tx, { tenantId: tenant.id, facilityId: facility.id, userId: admin.id }, {
        action: "TENANT_PROVISIONED", entityType: "Tenant", entityId: tenant.id, metadata: { code: tenant.code },
      });
      return { tenantId: tenant.id, facilityId: facility.id, adminUserId: admin.id, permissionsKnown: PERMISSIONS.length };
    });
  }

  async getCurrent(ctx: RequestContext) {
    const t = await this.prisma.tenant.findFirst({
      where: { id: ctx.tenantId },
      select: { id: true, name: true, code: true, status: true, timezone: true, currency: true },
    });
    if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return t;
  }

  async updateCurrent(ctx: RequestContext, input: z.infer<typeof updateTenantSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.tenant.findFirstOrThrow({ where: { id: ctx.tenantId } });
      const t = await tx.tenant.update({ where: { id: ctx.tenantId }, data: input, select: { id: true, name: true, code: true, status: true, timezone: true, currency: true } });
      await this.audit.record(tx, actorOf(ctx), {
        action: "TENANT_UPDATED", entityType: "Tenant", entityId: t.id,
        metadata: { changed: Object.keys(input), previousName: before.name },
      });
      return t;
    });
  }
}
