import { Inject, Injectable } from "@nestjs/common";
import { DomainError, type Permission } from "@medos/shared";
import * as jwt from "jsonwebtoken";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { DataScope } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { PasswordService } from "./password.service";

export const loginSchema = z.object({
  tenantCode: z.string().trim().toLowerCase().min(2).max(32),
  identifier: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(256),
  facilityId: z.string().uuid().optional(),
}).strict();

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) }).strict();
export const switchFacilitySchema = z.object({ refreshToken: z.string().min(20).max(200), facilityId: z.string().uuid() }).strict();

export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number }
export type LoginResult =
  | { status: "AUTHENTICATED"; tokens: TokenPair; facility: { id: string; name: string; code: string } }
  | { status: "FACILITY_SELECTION_REQUIRED"; facilities: { id: string; name: string; code: string }[] };

const INVALID = () => new DomainError("INVALID_CREDENTIALS", "Invalid credentials", 401);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Login starts before any hospital is known: a narrow database function resolves the code, the rest runs under that hospital. */
  private async resolveTenant(code: string): Promise<{ id: string; status: string } | null> {
    const rows = await tenantScope.system("login: resolve hospital code", () =>
      this.prisma.$queryRaw<{ id: string; status: string }[]>`SELECT id::text AS id, status FROM medos_resolve_tenant(${code})`);
    return rows[0] ?? null;
  }

  /** Refresh and logout carry only the token: a narrow database function says which hospital issued it. */
  private async resolveTokenTenant(refreshToken: string): Promise<string | null> {
    const rows = await tenantScope.system("token refresh: resolve issuing hospital", () =>
      this.prisma.$queryRaw<{ tenant_id: string | null }[]>`SELECT medos_resolve_refresh_token(${sha256(refreshToken)})::text AS tenant_id`);
    return rows[0]?.tenant_id ?? null;
  }

  async login(input: z.infer<typeof loginSchema>, requestId: string | undefined): Promise<LoginResult> {
    const tenant = await this.resolveTenant(input.tenantCode);
    if (!tenant) {
      await this.passwords.verifyDummy(input.password);
      throw INVALID();
    }
    return tenantScope.run(tenant.id, () => this.loginInTenant(input, requestId, tenant));
  }

  private async loginInTenant(input: z.infer<typeof loginSchema>, requestId: string | undefined, tenant: { id: string; status: string }): Promise<LoginResult> {
    const user = await this.prisma.user.findFirst({
      where: { tenantId: tenant.id, OR: [{ username: input.identifier }, { email: input.identifier }] },
      include: { facilities: { where: { facility: { status: "ACTIVE" } }, include: { facility: true } } },
    });
    const actor = { tenantId: tenant.id, userId: user?.id ?? null, requestId };

    if (!user || user.isService) {
      await this.passwords.verifyDummy(input.password);
      await this.audit.recordStandalone(actor, { action: "LOGIN_FAILED", entityType: "User", metadata: { reason: "UNKNOWN_USER" } });
      throw INVALID();
    }
    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      await this.passwords.verifyDummy(input.password);
      await this.audit.recordStandalone(actor, { action: "LOGIN_FAILED", entityType: "User", entityId: user.id, metadata: { reason: "LOCKED" } });
      throw INVALID();
    }

    const ok = await this.passwords.verify(input.password, user.passwordHash);
    if (!ok) {
      await this.registerFailure(user.id, tenant.id);
      await this.audit.recordStandalone(actor, { action: "LOGIN_FAILED", entityType: "User", entityId: user.id, metadata: { reason: "BAD_PASSWORD" } });
      throw INVALID();
    }
    if (user.status !== "ACTIVE" || tenant.status !== "ACTIVE") {
      await this.audit.recordStandalone(actor, { action: "LOGIN_FAILED", entityType: "User", entityId: user.id, metadata: { reason: "INACTIVE" } });
      throw INVALID();
    }

    const facilities = user.facilities.map((f) => ({ id: f.facility.id, name: f.facility.name, code: f.facility.code }));
    if (facilities.length === 0) {
      await this.audit.recordStandalone(actor, { action: "LOGIN_FAILED", entityType: "User", entityId: user.id, metadata: { reason: "NO_FACILITY" } });
      throw new DomainError("UNAUTHORIZED_FACILITY", "No facility access assigned", 403);
    }
    const chosen = facilities.length === 1 ? facilities[0] : facilities.find((f) => f.id === input.facilityId);
    if (!chosen && input.facilityId) throw new DomainError("UNAUTHORIZED_FACILITY", "No access to this facility", 403);
    if (!chosen) return { status: "FACILITY_SELECTION_REQUIRED", facilities };

    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    await this.upgradeHash(actor, user.id, tenant.id, user.passwordHash, input.password);
    const tokens = await this.prisma.$transaction(async (tx) => {
      const t = await this.issue(tx, tenant.id, user.id, chosen.id, randomUUID());
      await this.audit.record(tx, { ...actor, facilityId: chosen.id }, { action: "LOGIN_SUCCESS", entityType: "User", entityId: user.id });
      return t.pair;
    });
    return { status: "AUTHENTICATED", tokens, facility: chosen };
  }

  /**
   * Now that the right password is in hand, replace an old-format (scrypt) or weaker hash with a fresh Argon2id one.
   * Sign-in never fails because of this, and the write only applies if the stored hash is still the one that was just
   * checked, so a password changed in the meantime is never overwritten with the old password's hash.
   */
  private async upgradeHash(actor: { tenantId: string; userId: string | null; requestId: string | undefined }, userId: string, tenantId: string, current: string, password: string): Promise<void> {
    if (!this.passwords.needsRehash(current)) return;
    try {
      const next = await this.passwords.hash(password);
      const res = await this.prisma.user.updateMany({ where: { id: userId, tenantId, passwordHash: current }, data: { passwordHash: next } });
      if (res.count === 1) {
        await this.audit.recordStandalone(actor, { action: "PASSWORD_HASH_UPGRADED", entityType: "User", entityId: userId, metadata: { from: current.startsWith("$argon2id$") ? "argon2id-weaker" : "scrypt", to: "argon2id" } });
      }
    } catch (e) {
      logJson("warn", "password_hash_upgrade_failed", { tenantId, userId, errorName: e instanceof Error ? e.name : typeof e });
    }
  }

  async refresh(refreshToken: string, requestId: string | undefined): Promise<TokenPair> {
    const tenantId = await this.resolveTokenTenant(refreshToken);
    if (!tenantId) throw new DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);
    return tenantScope.run(tenantId, () => this.refreshInTenant(refreshToken, requestId));
  }

  private async refreshInTenant(refreshToken: string, requestId: string | undefined): Promise<TokenPair> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (!row) throw new DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);

    if (row.revokedAt) {
      // Reuse of a rotated/revoked token => assume theft; kill the whole family.
      await this.prisma.$transaction(async (tx) => {
        await tx.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        await this.audit.record(tx, { tenantId: row.tenantId, facilityId: row.facilityId, userId: row.userId, requestId }, {
          action: "REFRESH_TOKEN_REUSE_DETECTED", entityType: "User", entityId: row.userId, metadata: { familyId: row.familyId },
        });
      });
      throw new DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);
    }
    if (row.expiresAt <= new Date()) throw new DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);

    const user = await this.prisma.user.findFirst({
      where: { id: row.userId, tenantId: row.tenantId, status: "ACTIVE", tenant: { status: "ACTIVE" } },
      select: { facilities: { where: { facilityId: row.facilityId, facility: { status: "ACTIVE" } }, select: { facilityId: true } } },
    });
    if (!user || user.facilities.length === 0) {
      await this.revokeFamily(row.familyId);
      throw new DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);
    }

    return this.prisma.$transaction(async (tx) => {
      // Atomic claim: only one concurrent refresh can flip revokedAt from null.
      const claimed = await tx.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (claimed.count !== 1) throw new DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);
      const next = await this.issue(tx, row.tenantId, row.userId, row.facilityId, row.familyId);
      await tx.refreshToken.update({ where: { id: row.id }, data: { replacedById: next.id } });
      return next.pair;
    });
  }

  async logout(refreshToken: string, requestId: string | undefined): Promise<void> {
    const tenantId = await this.resolveTokenTenant(refreshToken);
    if (!tenantId) return; // idempotent; do not reveal whether the token existed
    return tenantScope.run(tenantId, () => this.logoutInTenant(refreshToken, requestId));
  }

  private async logoutInTenant(refreshToken: string, requestId: string | undefined): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (!row) return; // idempotent; do not reveal whether the token existed
    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, { tenantId: row.tenantId, facilityId: row.facilityId, userId: row.userId, requestId }, {
        action: "LOGOUT", entityType: "User", entityId: row.userId,
      });
    });
  }

  async switchFacility(userId: string, tenantId: string, input: z.infer<typeof switchFacilitySchema>, requestId: string | undefined): Promise<TokenPair> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(input.refreshToken) } });
    if (!row || row.revokedAt || row.userId !== userId || row.tenantId !== tenantId || row.expiresAt <= new Date()) {
      throw new DomainError("TOKEN_REVOKED", "Session is no longer valid", 401);
    }
    const access = await this.prisma.userFacility.findFirst({
      where: { tenantId, userId, facilityId: input.facilityId, facility: { status: "ACTIVE" } },
    });
    if (!access) throw new DomainError("UNAUTHORIZED_FACILITY", "No access to this facility", 403);

    return this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      const next = await this.issue(tx, tenantId, userId, input.facilityId, randomUUID());
      await this.audit.record(tx, { tenantId, facilityId: input.facilityId, userId, requestId }, {
        action: "FACILITY_SWITCHED", entityType: "User", entityId: userId, metadata: { fromFacilityId: row.facilityId },
      });
      return next.pair;
    });
  }

  async me(tenantId: string, userId: string, facilityId: string, permissions: ReadonlySet<Permission>, dataScope: DataScope) {
    const user = await this.prisma.user.findFirstOrThrow({
      where: { id: userId, tenantId },
      select: {
        id: true, username: true, fullName: true, email: true,
        tenant: { select: { id: true, name: true, code: true, timezone: true, currency: true } },
        facilities: { where: { facility: { status: "ACTIVE" } }, select: { facility: { select: { id: true, name: true, code: true, timezone: true } } } },
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    const scopeDepartments = dataScope.kind === "DEPARTMENT"
      ? await this.prisma.department.findMany({ where: { tenantId, id: { in: [...dataScope.departmentIds] } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : [];
    return {
      id: user.id, username: user.username, fullName: user.fullName, email: user.email,
      dataScope: { kind: dataScope.kind, departments: scopeDepartments },
      tenant: user.tenant,
      facility: user.facilities.map((f) => f.facility).find((f) => f.id === facilityId) ?? null,
      facilities: user.facilities.map((f) => f.facility),
      roles: user.roles.map((r) => r.role.name),
      permissions: [...permissions].sort(),
    };
  }

  async revokeAllForUser(db: Db, tenantId: string, userId: string): Promise<void> {
    await db.refreshToken.updateMany({ where: { tenantId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  private async registerFailure(userId: string, tenantId: string): Promise<void> {
    const updated = await this.prisma.user.update({
      where: { tenantId_id: { tenantId, id: userId } },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (updated.failedLoginCount >= this.config.LOGIN_MAX_FAILURES) {
      await this.prisma.user.update({
        where: { tenantId_id: { tenantId, id: userId } },
        data: { lockedUntil: new Date(Date.now() + this.config.LOGIN_LOCK_SECONDS * 1000), failedLoginCount: 0 },
      });
    }
  }

  private async issue(
    db: Db,
    tenantId: string, userId: string, facilityId: string, familyId: string,
  ): Promise<{ pair: TokenPair; id: string }> {
    const refreshToken = randomBytes(32).toString("base64url");
    const row = await db.refreshToken.create({
      data: {
        tenantId, userId, facilityId, familyId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    });
    const accessToken = jwt.sign({ typ: "access", tid: tenantId, fid: facilityId }, this.config.JWT_ACCESS_SECRET, {
      algorithm: "HS256", subject: userId, expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
    });
    const pair = { accessToken, refreshToken, expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS };
    return { pair, id: row.id };
  }
}
