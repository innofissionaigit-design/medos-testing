import { availableParallelism } from "node:os";
import { Inject, Injectable } from "@nestjs/common";
import { Prisma, PrismaClient } from "@medos/database";
import { afterCommit } from "./after-commit";
import { CONFIG, type AppConfig } from "./config";
import { logJson } from "./logger";
import { tenantScope } from "./tenant-scope";

/** Transaction client or the root client; both expose the model delegates. */
export type Db = Prisma.TransactionClient;

/** Thrown, and logged, when code reaches the database with no tenant scope while row-level security context is on. */
export class TenantContextMissingError extends Error {
  constructor() {
    super("Database access without a tenant scope");
    this.name = "TenantContextMissingError";
  }
}

const RAW = ["$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"] as const;
type RawName = (typeof RAW)[number];
type TxOptions = { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel };
type Scope = { tenantId?: string; system?: string; owner?: boolean };

/** All state and logic live here, so the exposed PrismaService type is exactly a PrismaClient (no extra members). */
class DbCore {
  readonly base: PrismaClient;
  readonly scoped: PrismaClient;
  private readonly on: boolean;
  private readonly sessionRole: string | undefined;

  constructor(config: AppConfig) {
    // Interactive transactions queue for a pooled connection under load; give them room instead of failing at 2s/5s.
    this.base = new PrismaClient({ datasourceUrl: config.DATABASE_URL, transactionOptions: { maxWait: 15_000, timeout: 30_000 } });
    this.on = config.DB_TENANT_CONTEXT === "on";
    this.sessionRole = config.DB_SESSION_ROLE;
    this.scoped = this.on ? this.extend() : this.base;
  }

  /** The scope of the current work, or a refusal. */
  private requireScope(): Scope {
    const s = tenantScope.current();
    if (!s.tenantId && !s.system && !s.owner) {
      logJson("error", "tenant_context_missing", { where: (new Error().stack ?? "").split("\n").slice(3, 9).map((l) => l.trim()) });
      throw new TenantContextMissingError();
    }
    return s;
  }

  /** The statements that must run first in the transaction. */
  private entry(scope: Scope, c: Prisma.TransactionClient | PrismaClient): Prisma.PrismaPromise<unknown>[] {
    const pre: Prisma.PrismaPromise<unknown>[] = [];
    // DB_SESSION_ROLE only emulates a restricted login in development and tests; the owner scope stands for the owner connection.
    if (this.sessionRole && !scope.owner) pre.push(c.$executeRawUnsafe(`SET LOCAL ROLE "${this.sessionRole}"`));
    if (scope.tenantId) pre.push(c.$queryRaw`SELECT set_config('app.tenant_id', ${scope.tenantId}, true)`);
    return pre;
  }

  private extend(): PrismaClient {
    const run = async ({ args, query }: { args: unknown; query: (a: unknown) => Prisma.PrismaPromise<unknown> }): Promise<unknown> => {
      const pre = this.entry(this.requireScope(), this.base);
      if (pre.length === 0) return query(args);
      const out = await this.base.$transaction([...pre, query(args)]);
      return out[out.length - 1];
    };
    return this.base.$extends({ query: { $allModels: { $allOperations: run } } }) as unknown as PrismaClient;
  }

  /**
   * Startup check (docs/rls.md): the database login and the settings must agree, or the API refuses to start.
   *  - DB_TENANT_CONTEXT=on needs the restricted login: not a superuser, not BYPASSRLS, owns no table (otherwise the policies
   *    would silently not apply), every tenant table must carry its policy, and the context functions must exist.
   *  - The restricted login with the context off would return nothing for every query, so that is refused too.
   *  - DB_SESSION_ROLE (development and tests) emulates the restricted role from an owner login, so the login itself is not judged.
   */
  /**
   * Opens the pool's connections before the first request. Without this, a burst of simultaneous requests makes the pool open
   * many new connections at once; when the database accepts them slowly the driver gives up after its connect timeout (P1001)
   * and those requests fail. Best-effort: it reads no data and a failure here never stops the API starting.
   */
  async warm(): Promise<void> {
    const size = Math.min(availableParallelism() * 2 + 1, 20);
    const outcome = await Promise.allSettled(Array.from({ length: size }, () => this.base.$queryRaw`SELECT pg_sleep(0.1)`));
    const failed = outcome.filter((o) => o.status === "rejected").length;
    if (failed > 0) logJson("warn", "db_pool_warmup_partial", { requested: size, failed });
  }

  async verify(): Promise<void> {
    const rows = await this.base.$queryRaw<{ user: string; superuser: boolean; bypass: boolean; owns: number; unprotected: number; functions: boolean }[]>`
      SELECT current_user::text AS "user", r.rolsuper AS superuser, r.rolbypassrls AS bypass,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owns,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname NOT IN ('_prisma_migrations', 'RateLimitBucket')) AS unprotected,
        (to_regproc('medos_current_tenant') IS NOT NULL AND to_regproc('medos_resolve_tenant') IS NOT NULL) AS functions
      FROM pg_roles r WHERE r.rolname = current_user`;
    const r = rows[0];
    if (!r) throw new Error("Cannot read the database login's attributes");
    const restricted = !r.superuser && !r.bypass && r.owns === 0;
    const emulated = this.sessionRole !== undefined;
    logJson("info", "db_role_verified", {
      role: r.user, superuser: r.superuser, bypassRls: r.bypass, ownsTables: r.owns > 0, restricted,
      tenantContext: this.on ? "on" : "off", emulated, tablesWithoutPolicy: r.unprotected,
    });
    if (this.on && !emulated && !restricted) {
      throw new Error(`DB_TENANT_CONTEXT=on needs the restricted database login, but "${r.user}" is ${r.superuser ? "a superuser" : r.bypass ? "a BYPASSRLS role" : "an owner of tables"}: its queries would ignore the policies`);
    }
    if (!this.on && restricted) {
      throw new Error(`The database login "${r.user}" is the restricted role: it needs DB_TENANT_CONTEXT=on, otherwise every query returns nothing`);
    }
    if (this.on && !r.functions) throw new Error("The row-level security functions are missing: apply the database migrations first");
    if (this.on && r.unprotected > 0) throw new Error(`${r.unprotected} table(s) have no row-level security policy: apply the database migrations first`);
  }

  /** Work registered with afterCommit() while the transaction runs is fired once it has committed, and dropped if it rolls back. */
  async transaction(arg: unknown, options?: TxOptions): Promise<unknown> {
    if (!this.on) return afterCommit.around(() => (this.base.$transaction as (a: unknown, o?: TxOptions) => Promise<unknown>)(arg, options));
    if (typeof arg !== "function") throw new Error("Batch transactions are not supported while the tenant context is on");
    const scope = this.requireScope();
    return afterCommit.around(() => this.base.$transaction(async (tx) => {
      for (const stmt of this.entry(scope, tx)) await stmt;
      return (arg as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
    }, options));
  }

  raw(name: RawName, args: unknown[]): unknown {
    if (!this.on) return (this.base[name] as (...a: unknown[]) => unknown)(...args);
    return this.transaction((tx: Prisma.TransactionClient) => (tx[name] as (...a: unknown[]) => Promise<unknown>)(...args));
  }
}

/**
 * The application's database client. It looks like a PrismaClient to the services.
 *
 * With DB_TENANT_CONTEXT=on (docs/rls.md) every query runs on a connection whose transaction carries the tenant:
 *   - interactive transactions set it as their first statement,
 *   - a single query outside a transaction is wrapped in a short one that sets it first,
 *   - raw queries are wrapped the same way.
 * The setting is transaction-local (set_config(..., true)): it cannot outlive the transaction, so a pooled connection never
 * carries one request's tenant into another. The tenant comes from tenantScope (the verified session, or code that has just
 * proven which hospital it serves), never from a request value. A query with no scope is refused before it reaches the database.
 *
 * With DB_TENANT_CONTEXT=off the client is used exactly as before.
 */
@Injectable()
// The class is used through the merged interface below (full PrismaClient API, supplied by the Proxy).
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PrismaService {
  constructor(@Inject(CONFIG) config: AppConfig) {
    const core = new DbCore(config);
    return new Proxy(this, {
      get: (target, prop, receiver): unknown => {
        if (prop === "onModuleInit") return async () => { await core.base.$connect(); await core.verify(); await core.warm(); };
        if (prop === "onModuleDestroy") return () => core.base.$disconnect();
        if (prop === "$transaction") return (arg: unknown, options?: TxOptions) => core.transaction(arg, options);
        if (typeof prop === "string" && (RAW as readonly string[]).includes(prop)) return (...a: unknown[]) => core.raw(prop as RawName, a);
        if (typeof prop === "symbol" || prop === "then" || prop === "constructor") return Reflect.get(target, prop, receiver);
        const v = (core.scoped as unknown as Record<string, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(core.scoped) : v;
      },
    });
  }
}

// The class is used through this merged type: services see the full PrismaClient API; the Proxy supplies it, and Nest finds the
// lifecycle hooks through it too.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface PrismaService extends PrismaClient {
  onModuleInit(): Promise<void>;
  onModuleDestroy(): Promise<void>;
}
