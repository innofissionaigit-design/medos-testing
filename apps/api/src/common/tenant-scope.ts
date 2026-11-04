import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * Who the current piece of work is acting for, carried through async code (row-level security, docs/rls.md).
 *
 * A scope is one of:
 *  - tenant:  acting for exactly one hospital. Set from the verified session (AuthGuard), or by code that has just proven which
 *             hospital it is serving (login after resolving the hospital code, the reminder worker per hospital).
 *  - system:  deliberately tenant-less. Only for calls that read nothing but through a narrow SECURITY DEFINER function
 *             (resolving a hospital code or refresh token, listing hospitals with reminders due) or touch no hospital data (health, rate limits).
 *  - owner:   emulates the owner connection (seed, provisioning, test setup). Only meaningful when DB_SESSION_ROLE emulates the
 *             restricted role; a real restricted login cannot become the owner, so it grants nothing in production.
 *
 * Anything else has NO scope, and the database layer refuses to run a query without one (fail closed).
 */
interface Scope { tenantId?: string; system?: string; owner?: boolean }

const store = new AsyncLocalStorage<Scope>();

/**
 * Prisma queries are lazy: they only start when awaited. One returned from a scope helper would start in the CALLER's context,
 * outside the scope, and be refused. Calling .then here starts it inside the scope.
 */
function started<T>(fn: () => T): T {
  const r = fn();
  return (r !== null && typeof r === "object" && typeof (r as { then?: unknown }).then === "function" ? (r as unknown as PromiseLike<unknown>).then((v) => v) : r) as T;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const tenantScope = {
  /** Opens an empty, mutable scope for one HTTP request. AuthGuard fills in the tenant once the session is verified. */
  open<T>(fn: () => T): T {
    return store.run({}, fn);
  },

  /** Runs fn acting for one hospital. */
  run<T>(tenantId: string, fn: () => T): T {
    if (!UUID.test(tenantId)) throw new Error("Invalid tenant id for scope");
    return store.run({ tenantId: tenantId.toLowerCase() }, () => started(fn));
  },

  /** Runs fn as a deliberately tenant-less call; `reason` is for the reader and for logs. */
  system<T>(reason: string, fn: () => T): T {
    return store.run({ system: reason }, () => started(fn));
  },

  /** Runs fn as the owner connection (seed, provisioning, test setup). See the note above: inert against a real restricted login. */
  owner<T>(fn: () => T): T {
    return store.run({ owner: true }, () => started(fn));
  },

  /** Sets the tenant of the open request scope. Only AuthGuard calls this, with a tenant taken from a verified token. */
  bind(tenantId: string): void {
    const s = store.getStore();
    if (!s) throw new Error("No request scope is open");
    if (!UUID.test(tenantId)) throw new Error("Invalid tenant id for scope");
    const id = tenantId.toLowerCase();
    if (s.tenantId && s.tenantId !== id) throw new Error("The request scope already belongs to another tenant");
    s.tenantId = id;
  },

  current(): { tenantId?: string; system?: string; owner?: boolean } {
    return store.getStore() ?? {};
  },
};

/**
 * Opens a request scope. Must be registered AFTER body parsing: stream callbacks of the body parsers can lose async context,
 * so opening it earlier could leave later code (guards, handlers) with no scope at all.
 */
export function tenantScopeMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  tenantScope.open(() => next());
}
