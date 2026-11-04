import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DomainError } from "@medos/shared";
import { createHash } from "node:crypto";
import { API_KEY_PREFIX } from "./auth.guard";
import { CONFIG, type AppConfig } from "./config";
import { RATE_LIMIT, type RateLimitOptions } from "./http";
import { logJson } from "./logger";
import { PrismaService } from "./prisma.service";
import { DatabaseRateLimitStore, MemoryRateLimitStore, type RateLimitStore } from "./rate-limit.store";
import type { AuthedRequest } from "./request-context";

/**
 * Fixed-window limiter keyed by subject + route. Only active on routes decorated with @RateLimit. The subject is the
 * client address, or the session's token on routes that carry one (see RateLimitOptions.by): the web server relays all
 * users from a single address, so an address-only key would make every user share one allowance.
 *
 * Counters live in PostgreSQL by default (RATE_LIMIT_STORE=database), so the limit holds however many API instances run.
 * If the database cannot be reached the request is counted in memory instead: login stays available and still throttled
 * on this instance, and the failure is logged. Per-account lockout in the auth service is database-backed as well.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly memory = new MemoryRateLimitStore();
  private readonly store: RateLimitStore;

  constructor(
    private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: AppConfig,
    prisma: PrismaService,
  ) {
    this.store = config.RATE_LIMIT_STORE === "database" ? new DatabaseRateLimitStore(prisma) : this.memory;
  }

  private async hit(key: string, windowMs: number): Promise<number> {
    try {
      return await this.store.hit(key, windowMs);
    } catch (e) {
      logJson("error", "rate_limit_store_unavailable", { error: e instanceof Error ? e.name : "unknown" });
      return this.memory.hit(key, windowMs);
    }
  }

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const req = ec.switchToHttp().getRequest<AuthedRequest>();
    // Every request that carries an API key counts against that key (docs/integration-api.md), on every route.
    const auth = req.headers["authorization"];
    if (this.config.RATE_LIMIT_ENABLED && typeof auth === "string" && auth.startsWith(`Bearer ${API_KEY_PREFIX}`)) {
      const used = await this.hit(`apikey:${createHash("sha256").update(auth).digest("hex")}`, 60_000);
      if (used > this.config.API_CLIENT_RATE_LIMIT_PER_MINUTE) throw new DomainError("RATE_LIMITED", "Too many requests for this API key. Slow down and retry shortly.", 429);
    }
    const opts = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT, [ec.getHandler(), ec.getClass()]);
    if (!opts || !this.config.RATE_LIMIT_ENABLED) return true;
    const key = `${subjectOf(req, opts.by ?? "ip")}|${req.method}|${req.route?.path ?? ""}`;
    const count = await this.hit(key, opts.windowMs);
    if (count > opts.limit) throw new DomainError("RATE_LIMITED", "Too many requests. Try again later.", 429);
    return true;
  }
}

/** Tokens are hashed so raw tokens never sit in memory or in the database as keys; a request without one falls back to its address. */
function subjectOf(req: AuthedRequest, by: NonNullable<RateLimitOptions["by"]>): string {
  const token = by === "refreshToken" ? (req as AuthedRequest & { body?: { refreshToken?: unknown } }).body?.refreshToken
    : by === "session" ? req.headers["authorization"]
    : undefined;
  if (typeof token === "string" && token.length > 0) return `t:${createHash("sha256").update(token).digest("hex")}`;
  return `ip:${req.ip ?? "unknown"}`;
}
