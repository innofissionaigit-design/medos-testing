import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Prisma } from "@medos/database";
import { startApp, type TestApp } from "../test/harness";

/**
 * packages/database/ops/rls-grants.sql re-applies the privileges after a restore (backups use --no-privileges, docs/rls.md).
 * It must leave exactly the privileges the migrations leave, and it must repair a database whose privileges were stripped.
 */
const script = readFileSync(resolve(__dirname, "../../../../packages/database/ops/rls-grants.sql"), "utf8");
class Undo extends Error {}
type Tx = Prisma.TransactionClient;

/** Everything privilege-related the migrations decide, as comparable text. */
async function snapshot(tx: Tx): Promise<string[]> {
  const rel = await tx.$queryRaw<{ s: string }[]>`
    SELECT c.relkind::text || ' ' || c.relname::text || ' ' || COALESCE(c.relacl::text, '<default>') AS s
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S') ORDER BY c.relname`;
  const fn = await tx.$queryRaw<{ s: string }[]>`
    SELECT p.oid::regprocedure::text || ' ' || COALESCE(p.proacl::text, '<default>') AS s
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'medos\\_%' ORDER BY 1`;
  const def = await tx.$queryRaw<{ s: string }[]>`
    SELECT d.defaclobjtype::text || ' ' || COALESCE(d.defaclacl::text, '') AS s FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname = 'public' ORDER BY 1`;
  const role = await tx.$queryRaw<{ s: string }[]>`
    SELECT rolsuper::text || rolbypassrls::text || rolcreaterole::text || rolcreatedb::text || rolreplication::text AS s FROM pg_roles WHERE rolname = 'medos_app'`;
  const schema = await tx.$queryRaw<{ s: string }[]>`SELECT COALESCE(nspacl::text, '<default>') AS s FROM pg_namespace WHERE nspname = 'public'`;
  return [...rel, ...fn, ...def, ...role, ...schema].map((r) => r.s);
}

describe("privilege re-grant script (after a restore)", () => {
  let t: TestApp;
  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  /** Runs fn inside a transaction that is always rolled back: DDL is transactional in PostgreSQL, so nothing is left changed. */
  async function sandbox(fn: (tx: Tx) => Promise<void>): Promise<void> {
    try {
      await t.prisma.$transaction(async (tx) => { await fn(tx); throw new Undo(); });
    } catch (e) {
      if (!(e instanceof Undo)) throw e;
    }
  }

  it("is a single statement, so psql, Prisma and the tests all run it unchanged", () => {
    assert.equal((script.match(/^DO\s*\$\$/gm) ?? []).length, 1);
    assert.ok(!/PASSWORD|\bLOGIN\b/i.test(script.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join(" ").replace(/NOLOGIN/g, "")), "never sets a login or password");
  });

  it("leaves exactly the privileges the migrations leave (idempotent)", async () => {
    await sandbox(async (tx) => {
      const before = await snapshot(tx);
      await tx.$executeRawUnsafe(script);
      assert.deepEqual(await snapshot(tx), before, "running it on a correct database changes nothing");
      await tx.$executeRawUnsafe(script);
      assert.deepEqual(await snapshot(tx), before, "and again");
    });
  });

  it("repairs a database restored with --no-privileges: no grants, no function restrictions, no default privileges", async () => {
    await sandbox(async (tx) => {
      const expected = await snapshot(tx);
      // What a dump taken with --no-privileges restores to: default ACLs everywhere.
      await tx.$executeRawUnsafe('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medos_app');
      await tx.$executeRawUnsafe('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM medos_app');
      await tx.$executeRawUnsafe('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM medos_app');
      await tx.$executeRawUnsafe('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM medos_app');
      await tx.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION medos_resolve_tenant(text), medos_resolve_refresh_token(text), medos_tenants_with_due_reminders(timestamptz), medos_enable_tenant_rls(regclass) TO PUBLIC');
      await tx.$executeRawUnsafe('REVOKE USAGE ON SCHEMA public FROM medos_app');
      await tx.$executeRawUnsafe('GRANT ALL ON "AuditEvent", "_prisma_migrations" TO medos_app');
      assert.notDeepEqual(await snapshot(tx), expected, "the stripped state differs, so the check below means something");
      const [broken] = await tx.$queryRaw<{ a: boolean; b: boolean }[]>`SELECT has_table_privilege('medos_app', '"Patient"', 'SELECT') AS a, has_function_privilege('public', 'medos_resolve_tenant(text)', 'EXECUTE') AS b`;
      assert.deepEqual([broken!.a, broken!.b], [false, true], "broken as a restore leaves it: no access for the app, the login function open to PUBLIC");

      await tx.$executeRawUnsafe(script);
      assert.deepEqual(await snapshot(tx), expected, "the script restores exactly the migration's privileges");
      const [fixed] = await tx.$queryRaw<{ a: boolean; b: boolean; c: boolean; d: boolean }[]>`
        SELECT has_table_privilege('medos_app', '"Patient"', 'UPDATE') AS a, has_function_privilege('public', 'medos_resolve_tenant(text)', 'EXECUTE') AS b,
               has_table_privilege('medos_app', '"AuditEvent"', 'UPDATE') AS c, has_table_privilege('medos_app', '"_prisma_migrations"', 'SELECT') AS d`;
      assert.deepEqual([fixed!.a, fixed!.b, fixed!.c, fixed!.d], [true, false, false, false]);
    });
  });
});
