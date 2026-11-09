import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DomainError, type Permission } from "@medos/shared";
import { createHash } from "node:crypto";
import * as jwt from "jsonwebtoken";
import { CONFIG, type AppConfig } from "./config";
import { resolveDataScope } from "./data-scope";
import { IS_PUBLIC, REQUIRED_ANY_PERMISSIONS, REQUIRED_PERMISSIONS } from "./http";
import { ipAllowed } from "./ip-allow";
import { logJson } from "./logger";
import { PrismaService } from "./prisma.service";
import { tenantScope } from "./tenant-scope";
import type { AuthedRequest } from "./request-context";

/** API keys start with this; a person's access token is a JWT and never does. */
export const API_KEY_PREFIX = "mdk_";
export const hashApiKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** `sid` is the session the token belongs to (the refresh-token family): it is alive only while that family has an unused, unexpired refresh token. */
export interface AccessClaims { sub: string; tid: string; fid: string; sid: string; typ: "access" }

/**
 * Global guard. For every non-public route it:
 *  1. verifies the access token (HS256 only),
 *  2. re-reads user/tenant/facility state from the database so deactivation, role changes and
 *     facility revocation take effect immediately,
 *  3. builds the authoritative RequestContext,
 *  4. enforces required permissions.
 * Unauthenticated and invalid-token failures are indistinguishable to the client.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const targets = [ec.getHandler(), ec.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ec.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers["authorization"];
    const raw = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!raw) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
    if (raw.startsWith(API_KEY_PREFIX)) return this.authenticateKey(req, raw, ec);

    let claims: AccessClaims;
    try {
      const decoded = jwt.verify(raw, this.config.JWT_ACCESS_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
      if (decoded["typ"] !== "access" || typeof decoded.sub !== "string" || typeof decoded["tid"] !== "string" || typeof decoded["fid"] !== "string" || typeof decoded["sid"] !== "string") {
        throw new Error("bad claims");
      }
      claims = { sub: decoded.sub, tid: decoded["tid"] as string, fid: decoded["fid"] as string, sid: decoded["sid"] as string, typ: "access" };
    } catch {
      throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
    }

    // The tenant comes from the verified token, never from the request body or query. Everything below, starting with the
    // lookup that re-checks the user, runs under it: a token naming a hospital that does not own the user finds nothing.
    tenantScope.bind(claims.tid);
    const user = await this.prisma.user.findFirst({
      where: {
        id: claims.sub,
        tenantId: claims.tid,
        status: "ACTIVE",
        tenant: { status: "ACTIVE" },
        // The session must still be alive: signing out, a password reset or change, a refresh-token reuse alarm or the session running out ends it at once, not
        // when the access token's own 15 minutes are up. (Rotating the refresh token keeps the session: the family always holds the newest unused one.)
        tokens: { some: { familyId: claims.sid, tenantId: claims.tid, revokedAt: null, expiresAt: { gt: new Date() } } },
      },
      select: {
        facilities: { where: { facilityId: claims.fid, tenantId: claims.tid, facility: { status: "ACTIVE" } }, select: { facilityId: true } },
        roles: { select: { role: { select: { permissions: { select: { permission: true } } } } } },
        practitioners: { where: { tenantId: claims.tid, facilityId: claims.fid, status: "ACTIVE" }, select: { id: true } },
        departments: { select: { departmentId: true } },
      },
    });
    if (!user) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
    if (user.facilities.length === 0) throw new DomainError("UNAUTHORIZED_FACILITY", "No access to this facility", 403);

    const permissions = new Set<Permission>();
    for (const ur of user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission as Permission);

    const requestId = req.requestId ?? "unknown";
    const dataScope = resolveDataScope(permissions, user.practitioners.map((p) => p.id), user.departments.map((d) => d.departmentId));
    req.ctx = { tenantId: claims.tid, facilityId: claims.fid, userId: claims.sub, permissions, requestId, dataScope };
    this.enforce(permissions, ec);
    return true;
  }

  /**
   * An API client presenting its key (docs/integration-api.md). The key is looked up by its hash, which names the hospital; from then on everything runs
   * under that hospital's scope. The client, its hidden user, the hospital and the facility are all re-read on every request, so revoking, expiring or
   * deactivating any of them takes effect immediately. Every failure looks the same to the caller.
   */
  private async authenticateKey(req: AuthedRequest, raw: string, ec: ExecutionContext): Promise<boolean> {
    const found = await tenantScope.system("api key: find the hospital that issued a key", () =>
      this.prisma.$queryRaw<{ tenant_id: string; client_id: string }[]>`SELECT tenant_id::text AS tenant_id, client_id::text AS client_id FROM medos_resolve_api_key(${hashApiKey(raw)})`);
    const hit = found[0];
    if (!hit) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
    tenantScope.bind(hit.tenant_id);
    const now = new Date();
    const client = await this.prisma.apiClient.findFirst({
      where: {
        id: hit.client_id, tenantId: hit.tenant_id, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        facility: { status: "ACTIVE" },
        user: { status: "ACTIVE", isService: true, tenant: { status: "ACTIVE" } },
      },
      select: { id: true, facilityId: true, userId: true, lastUsedAt: true, allowedIps: true, user: { select: { roles: { select: { role: { select: { permissions: { select: { permission: true } } } } } } } } },
    });
    if (!client) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
    // A key limited to some addresses is refused from anywhere else, with the same answer as any other bad key (the log says why).
    if (!ipAllowed(req.ip, client.allowedIps)) {
      logJson("warn", "api_key_ip_refused", { clientId: client.id, tenantId: hit.tenant_id, requestId: req.requestId ?? "unknown" });
      throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
    }
    const permissions = new Set<Permission>();
    for (const ur of client.user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission as Permission);
    req.ctx = { tenantId: hit.tenant_id, facilityId: client.facilityId, userId: client.userId, permissions, requestId: req.requestId ?? "unknown", dataScope: { kind: "ALL" }, apiClientId: client.id };
    // "Last used" is a convenience for admins: written at most once a minute per client, not on every request.
    if (!client.lastUsedAt || now.getTime() - client.lastUsedAt.getTime() > 60_000) {
      await this.prisma.apiClient.updateMany({ where: { id: client.id, tenantId: hit.tenant_id }, data: { lastUsedAt: now } });
    }
    this.enforce(permissions, ec);
    return true;
  }

  private enforce(permissions: ReadonlySet<Permission>, ec: ExecutionContext): void {
    const targets = [ec.getHandler(), ec.getClass()];
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS, targets) ?? [];
    for (const p of required) {
      if (!permissions.has(p)) throw new DomainError("FORBIDDEN", "You do not have permission to perform this action", 403);
    }
    const anyOf = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_ANY_PERMISSIONS, targets);
    if (anyOf?.length && !anyOf.some((p) => permissions.has(p))) {
      throw new DomainError("FORBIDDEN", "You do not have permission to perform this action", 403);
    }
  }
}
