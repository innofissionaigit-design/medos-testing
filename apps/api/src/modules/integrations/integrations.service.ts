import { Injectable } from "@nestjs/common";
import { DomainError, type Permission } from "@medos/shared";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { hashApiKey, API_KEY_PREFIX } from "../../common/auth.guard";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { parseAllowList } from "../../common/ip-allow";

/**
 * What an API client may be given. This list is the whole menu: nothing financial, clinical or administrative can be granted to a key, however the
 * request is phrased. Every client can also read the doctors, free times and the bookings it made (APPOINTMENT_READ).
 */
export const ABILITIES = {
  FIND_PATIENTS: { label: "Find a patient by mobile number (first name, initial, age and gender only)", permissions: ["BOOKING_PATIENT_LOOKUP"] },
  REGISTER_PATIENTS: { label: "Register a new patient (name, gender, age, mobile)", permissions: ["BOOKING_PATIENT_REGISTER"] },
  BOOK_APPOINTMENTS: { label: "Book, move and cancel the appointments it made", permissions: ["APPOINTMENT_CREATE", "APPOINTMENT_UPDATE", "APPOINTMENT_CANCEL"] },
} as const satisfies Record<string, { label: string; permissions: readonly Permission[] }>;
export type Ability = keyof typeof ABILITIES;
const ABILITY_KEYS = Object.keys(ABILITIES) as [Ability, ...Ability[]];

export const createClientSchema = z.object({
  name: z.string().trim().min(2).max(60),
  abilities: z.array(z.enum(ABILITY_KEYS)).min(1).max(ABILITY_KEYS.length).refine((a) => new Set(a).size === a.length, "Duplicate ability"),
  /** The key stops working after this many days; omit for a key that does not expire. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  /** Addresses or ranges (for example 203.0.113.7 or 203.0.113.0/24) the key may be used from; leave out or empty for from anywhere. */
  allowedIps: z.array(z.string().trim().min(2).max(60)).max(20).optional(),
}).strict().superRefine((v, c) => {
  const r = parseAllowList(v.allowedIps ?? []);
  if (!r.ok) c.addIssue({ code: "custom", path: ["allowedIps"], message: r.message });
});
export const allowedIpsSchema = z.object({ allowedIps: z.array(z.string().trim().min(2).max(60)).max(20) }).strict().superRefine((v, c) => {
  const r = parseAllowList(v.allowedIps);
  if (!r.ok) c.addIssue({ code: "custom", path: ["allowedIps"], message: r.message });
});
export const revokeClientSchema = z.object({ reason: z.string().trim().min(5).max(240) }).strict();

const VIEW = { id: true, name: true, keyPrefix: true, abilities: true, allowedIps: true, status: true, expiresAt: true, lastUsedAt: true, createdAt: true, revokedAt: true, revokeReason: true, facilityId: true } as const;

const tidyIps = (raw: string[] | undefined): string[] => { const r = parseAllowList(raw ?? []); return r.ok ? r.entries : []; };

/**
 * API clients (docs/integration-api.md): keys for outside systems and bots. Creating one makes a hidden service user and a role holding only the chosen
 * abilities, then shows the key exactly once. Only a hash is kept.
 */
@Injectable()
export class IntegrationsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  abilities() {
    return ABILITY_KEYS.map((key) => ({ key, label: ABILITIES[key].label }));
  }

  async list(ctx: RequestContext) {
    const rows = await this.prisma.apiClient.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: VIEW, orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
    return rows.map((r) => ({ ...r, expired: r.status === "ACTIVE" && !!r.expiresAt && r.expiresAt.getTime() <= Date.now() }));
  }

  async create(ctx: RequestContext, input: z.infer<typeof createClientSchema>) {
    const key = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const permissions = [...new Set<Permission>(["APPOINTMENT_READ", ...input.abilities.flatMap((a): readonly Permission[] => ABILITIES[a].permissions)])];
    const client = await this.prisma.$transaction(async (tx) => {
      if (await tx.apiClient.findFirst({ where: { tenantId: ctx.tenantId, name: input.name }, select: { id: true } })) {
        throw new DomainError("CONFLICT", "An integration with this name already exists", 409);
      }
      const suffix = randomBytes(3).toString("hex");
      const role = await tx.role.create({ data: { tenantId: ctx.tenantId, name: `Integration: ${input.name} (${suffix})`, isSystem: false } });
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ tenantId: ctx.tenantId, roleId: role.id, permission })) });
      // The hidden user can never sign in: its password hash is not a valid hash of anything, and the sign-in code refuses service users anyway.
      const user = await tx.user.create({
        data: { tenantId: ctx.tenantId, username: `svc-${suffix}-${randomBytes(3).toString("hex")}`, fullName: `${input.name} (integration)`, passwordHash: "!service-account", isService: true },
      });
      await tx.userRole.create({ data: { tenantId: ctx.tenantId, userId: user.id, roleId: role.id } });
      await tx.userFacility.create({ data: { tenantId: ctx.tenantId, userId: user.id, facilityId: ctx.facilityId } });
      const c = await tx.apiClient.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: user.id, roleId: role.id, name: input.name, keyPrefix: key.slice(0, 12), keyHash: hashApiKey(key),
          abilities: input.abilities, allowedIps: tidyIps(input.allowedIps), expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null, createdById: ctx.userId,
        },
        select: VIEW,
      });
      await this.audit.record(tx, actorOf(ctx), { action: "API_CLIENT_CREATED", entityType: "ApiClient", entityId: c.id, metadata: { name: input.name, abilities: input.abilities, allowedIps: c.allowedIps, expiresAt: c.expiresAt?.toISOString() ?? null } });
      return c;
    });
    // The key is returned here and nowhere else: it cannot be shown again.
    return { client, apiKey: key };
  }

  /** Changes where a key may be used from. An empty list means from anywhere. */
  async setAllowedIps(ctx: RequestContext, id: string, input: z.infer<typeof allowedIpsSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.apiClient.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const allowedIps = tidyIps(input.allowedIps);
      await tx.apiClient.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { allowedIps } });
      await this.audit.record(tx, actorOf(ctx), { action: "API_CLIENT_IPS_CHANGED", entityType: "ApiClient", entityId: id, metadata: { name: c.name, from: c.allowedIps, to: allowedIps } });
      return tx.apiClient.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW });
    });
  }

  async revoke(ctx: RequestContext, id: string, input: z.infer<typeof revokeClientSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.apiClient.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (c.status === "REVOKED") throw new DomainError("INVALID_STATE", "This integration is already revoked", 409);
      const now = new Date();
      await tx.apiClient.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "REVOKED", revokedAt: now, revokedById: ctx.userId, revokeReason: input.reason } });
      await tx.user.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: c.userId } }, data: { status: "INACTIVE" } });
      await this.audit.record(tx, actorOf(ctx), { action: "API_CLIENT_REVOKED", entityType: "ApiClient", entityId: id, metadata: { name: c.name, reason: input.reason } });
      return tx.apiClient.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW });
    });
  }
}
