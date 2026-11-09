import type { PrismaClient } from "@medos/database";
import { tenantScope } from "./tenant-scope";

/** Counts hits per key inside a fixed window and returns the count including this hit. */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<number>;
}

interface Bucket { count: number; resetAt: number }

/** Per-process counters. Used when RATE_LIMIT_STORE=memory (single instance) and as the fallback if the database is unreachable. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  async hit(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    if (this.buckets.size >= 5000) for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    b.count += 1;
    return b.count;
  }
}

/**
 * Counters in PostgreSQL, so every API instance shares one allowance. One atomic upsert per request, timed by the database clock
 * (instance clocks may differ). Only routes marked @RateLimit use it (login, token refresh, password change), so the extra
 * query is on rare, security-sensitive paths. The key holds a hashed token or an address, never patient data.
 */
export class DatabaseRateLimitStore implements RateLimitStore {
  private lastSweep = 0;

  constructor(private readonly prisma: Pick<PrismaClient, "$queryRaw" | "$executeRaw">) {}

  async hit(key: string, windowMs: number): Promise<number> {
    // The limiter runs before anyone is authenticated and holds no hospital data, so it is an explicit system scope.
    return tenantScope.system("rate limit counters: no hospital data", () => this.hitInScope(key, windowMs));
  }

  private async hitInScope(key: string, windowMs: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
      VALUES (${key}, 1, now() + make_interval(secs => ${windowMs}::double precision / 1000))
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimitBucket"."resetAt" <= now() THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
        "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= now() THEN now() + make_interval(secs => ${windowMs}::double precision / 1000) ELSE "RateLimitBucket"."resetAt" END
      RETURNING "count"`;
    void this.sweep();
    return Number(rows[0]?.count ?? 1);
  }

  /** Removes long-expired rows; at most once a minute per process, and a failure here never affects a request. */
  private async sweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    await this.prisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE "resetAt" < now() - interval '1 hour'`.catch(() => undefined);
  }
}
