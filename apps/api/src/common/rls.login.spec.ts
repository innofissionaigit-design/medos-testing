import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient, type Prisma } from "@medos/database";
import { loadConfig } from "./config";
import { PrismaService } from "./prisma.service";
import { registerPatient, startApp, type TestApp, type TestTenant } from "../test/harness";

/**
 * Row-level security (phase 3): everything here goes over a REAL login as the restricted role medos_app, the way the API will
 * connect, not an emulation from the owner connection. It attacks the role the way a compromised API process would.
 * The login is enabled by an operations step (docs/rls.md); the URL comes from TEST_APP_DATABASE_URL, or is derived from the
 * owner URL with the user swapped and the secret that `pnpm test` generated (see appPassword).
 */
const ownerUrl = process.env["TEST_DATABASE_URL"] ?? "postgresql://medos@127.0.0.1:54329/medos_test";
/** The login's secret: APP_DB_PASSWORD, else the one `pnpm test` generated into .local/app-db.env (git-ignored). */
function appPassword(): string {
  if (process.env["APP_DB_PASSWORD"]) return process.env["APP_DB_PASSWORD"];
  try { return /^APP_DB_PASSWORD=(.+)$/m.exec(readFileSync(resolve(__dirname, "../../../../.local/app-db.env"), "utf8"))?.[1]?.trim() ?? ""; }
  catch { return ""; }
}
function appUrl(): string {
  if (process.env["TEST_APP_DATABASE_URL"]) return process.env["TEST_APP_DATABASE_URL"];
  const u = new URL(ownerUrl);
  u.username = "medos_app";
  u.password = appPassword();
  return u.toString();
}
class Undo extends Error {}

describe("row-level security over the real restricted login (medos_app)", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let app: PrismaClient;
  let patientsA: string[];
  let patientsB: string[];
  let deptB: string;

  /** Runs fn in a transaction with the tenant set the way the API does, then always rolls back. */
  async function asTenant<T>(tenant: string | null, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    let out: T | undefined;
    try {
      await app.$transaction(async (tx) => {
        if (tenant !== null) await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
        out = await fn(tx);
        throw new Undo();
      });
    } catch (e) {
      if (!(e instanceof Undo)) throw e;
    }
    return out as T;
  }
  const denied = /permission denied|must be owner|must be superuser|not permitted|must have|cannot|only roles|no privileges|insufficient privilege/i;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("rlsl-a");
    b = await t.makeTenant("rlsl-b");
    const ra = await t.makeUser(a, ["RECEPTIONIST"]);
    const rb = await t.makeUser(b, ["RECEPTIONIST"]);
    patientsA = [(await registerPatient(t, ra.token)).id, (await registerPatient(t, ra.token)).id];
    patientsB = [(await registerPatient(t, rb.token)).id];
    deptB = (await t.prisma.department.create({ data: { tenantId: b.tenantId, facilityId: b.facilityId, name: "RLSL Dept B", code: "RLSLB" } })).id;
    app = new PrismaClient({ datasourceUrl: appUrl() });
    try { await app.$queryRaw`SELECT 1`; }
    catch (e) { throw new Error(`Cannot log in as medos_app (${e instanceof Error ? e.message.split("\n").pop() : e}). Enable the login first: docs/rls.md`); }
  });
  after(async () => { await app?.$disconnect(); await t.close(); });

  it("the connection really is the restricted role", async () => {
    const [r] = await app.$queryRaw<{ cu: string; su: string; super: boolean; bypass: boolean; role: boolean; db: boolean; repl: boolean }[]>`
      SELECT current_user::text AS cu, session_user::text AS su, r.rolsuper AS super, r.rolbypassrls AS bypass, r.rolcreaterole AS role, r.rolcreatedb AS db, r.rolreplication AS repl
      FROM pg_roles r WHERE r.rolname = current_user`;
    assert.deepEqual([r!.cu, r!.su], ["medos_app", "medos_app"], "the session itself is the restricted role, not an emulation");
    assert.deepEqual([r!.super, r!.bypass, r!.role, r!.db, r!.repl], [false, false, false, false, false]);
  });

  it("it cannot become the owner, switch policies off, or escalate: every attempt is refused", async () => {
    const attempts = [
      "SET ROLE medos",
      "SET SESSION AUTHORIZATION medos",
      "ALTER ROLE medos_app BYPASSRLS",
      "ALTER ROLE medos_app SUPERUSER",
      "CREATE ROLE evil SUPERUSER",
      'CREATE TABLE "Rls_Evil" (a int)',
      'DROP TABLE "Patient"',
      'TRUNCATE "Patient"',
      'ALTER TABLE "Patient" DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE "Patient" NO FORCE ROW LEVEL SECURITY',
      'DROP POLICY tenant_isolation ON "Patient"',
      'CREATE POLICY allow_all ON "Patient" USING (true)',
      "SELECT medos_enable_tenant_rls('\"Patient\"')",
      'SELECT * FROM "_prisma_migrations"',
      "SELECT rolpassword FROM pg_authid",
      "COPY (SELECT 1) TO PROGRAM 'echo escalated'",
      "SELECT pg_read_file('postgresql.conf')",
      "CREATE EXTENSION dblink",
      "ALTER SYSTEM SET row_security = off",
      "CREATE FUNCTION public.evil() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'",
      'ALTER FUNCTION medos_resolve_tenant(text) SECURITY INVOKER',
      'DROP FUNCTION medos_current_tenant()',
      "UPDATE \"AuditEvent\" SET action = 'EDITED'",
      'DELETE FROM "AuditEvent"',
    ];
    for (const sql of attempts) await assert.rejects(app.$executeRawUnsafe(sql), denied, sql);
    // A non-owner's GRANT is not an error in PostgreSQL (it warns and grants nothing), so check that nothing was granted.
    const publicGrants = async (): Promise<number> => Number((await t.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_class c, aclexplode(c.relacl) a WHERE c.relname = 'Patient' AND a.grantee = 0`)[0]!.n);
    const before = await publicGrants();
    await app.$executeRawUnsafe('GRANT ALL ON "Patient" TO PUBLIC');
    await app.$executeRawUnsafe('GRANT ALL ON "Patient" TO medos_app WITH GRANT OPTION');
    assert.equal(await publicGrants(), before, "the GRANT changed nothing");
    const [opt] = await app.$queryRaw<{ ok: boolean }[]>`SELECT has_table_privilege('medos_app', '"Patient"', 'TRUNCATE') AS ok`;
    assert.equal(opt!.ok, false, "and it did not give itself TRUNCATE either");
    // Turning row security off errors out for a role that is subject to policies, it does not bypass them.
    await assert.rejects(asTenant(a.tenantId, async (tx) => { await tx.$executeRawUnsafe("SET LOCAL row_security = off"); return tx.$queryRawUnsafe('SELECT count(*) FROM "Patient"'); }), /row-level security/i);
    // And a table of the audit trail is append-only for it.
    const privs = await app.$queryRaw<{ t: boolean }[]>`SELECT has_table_privilege('medos_app', '"AuditEvent"', 'UPDATE') OR has_table_privilege('medos_app', '"AuditEvent"', 'DELETE') AS t`;
    assert.equal(privs[0]!.t, false);
  });

  it("it sees only the hospital named by the transaction, and nothing without one", async () => {
    assert.deepEqual(await asTenant(a.tenantId, async (tx) => (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Patient" ORDER BY id`).map((r) => r.id)), [...patientsA].sort());
    assert.deepEqual(await asTenant(b.tenantId, async (tx) => (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Patient"`).map((r) => r.id)), patientsB);
    assert.equal(await asTenant(a.tenantId, async (tx) => (await tx.$queryRaw<unknown[]>`SELECT 1 FROM "Patient" WHERE id = ${patientsB[0]!}::uuid`).length), 0);
    assert.deepEqual(await asTenant(a.tenantId, async (tx) => (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Tenant"`).map((r) => r.id)), [a.tenantId]);
    for (const table of ["Patient", "User", "Facility", "Department", "AuditEvent", "Tenant", "RefreshToken", "Invoice"]) {
      const n = async (ctx: string | null) => asTenant(ctx, async (tx) => Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n));
      assert.equal(await n(null), 0, `${table}: no context sees nothing`);
      assert.equal(await n(""), 0, `${table}: an empty context sees nothing`);
    }
    // A plain statement outside any transaction carries no tenant either.
    assert.equal(Number((await app.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Patient"`)[0]!.n), 0, "a separate connection sees nothing");
    await assert.rejects(asTenant("not-a-uuid", async (tx) => tx.$queryRawUnsafe('SELECT count(*) FROM "Patient"')), /uuid/i);
  });

  it("it cannot write into, change, delete from, or link to another hospital", async () => {
    const ins = (tx: Prisma.TransactionClient, tenantId: string, facilityId: string, code: string) =>
      tx.$executeRaw`INSERT INTO "Department" ("tenantId", "facilityId", name, code, "updatedAt") VALUES (${tenantId}::uuid, ${facilityId}::uuid, 'X', ${code}, now())`;
    assert.equal(await asTenant(a.tenantId, (tx) => ins(tx, a.tenantId, a.facilityId, "OWN")), 1);
    await assert.rejects(asTenant(a.tenantId, (tx) => ins(tx, b.tenantId, b.facilityId, "FOREIGN")), /row-level security/i);
    await assert.rejects(asTenant(null, (tx) => ins(tx, a.tenantId, a.facilityId, "NOCTX")), /row-level security/i);
    assert.equal(await asTenant(a.tenantId, (tx) => tx.$executeRaw`UPDATE "Department" SET name = 'hijacked' WHERE id = ${deptB}::uuid`), 0);
    assert.equal(await asTenant(a.tenantId, (tx) => tx.$executeRaw`DELETE FROM "Department" WHERE id = ${deptB}::uuid`), 0);
    assert.equal(await asTenant(a.tenantId, (tx) => tx.$executeRaw`UPDATE "Tenant" SET name = 'hijacked' WHERE id = ${b.tenantId}::uuid`), 0);
    await assert.rejects(asTenant(a.tenantId, (tx) => tx.$executeRaw`INSERT INTO "Practitioner" ("tenantId", "facilityId", "departmentId", "displayName", "updatedAt") VALUES (${a.tenantId}::uuid, ${a.facilityId}::uuid, ${deptB}::uuid, 'Dr Cross', now())`), /Invalid reference|violates/i);
    assert.equal((await t.prisma.department.findUniqueOrThrow({ where: { id: deptB } })).name, "RLSL Dept B", "the other hospital's data is untouched");
  });

  it("the narrow functions work for the restricted login and expose only what they promise", async () => {
    assert.deepEqual(await app.$queryRaw<{ id: string; status: string }[]>`SELECT id::text AS id, status FROM medos_resolve_tenant(${a.code})`, [{ id: a.tenantId, status: "ACTIVE" }]);
    assert.deepEqual(await app.$queryRaw<unknown[]>`SELECT * FROM medos_resolve_tenant(${"nope-" + a.code})`, []);
    const [tok] = await app.$queryRaw<{ t: string | null }[]>`SELECT medos_resolve_refresh_token(${"f".repeat(64)})::text AS t`;
    assert.equal(tok!.t, null);
    assert.ok(Array.isArray(await app.$queryRaw`SELECT medos_tenants_with_due_reminders(now())`));
    assert.equal((await app.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Tenant"`)[0]!.n, 0n, "yet the table itself shows nothing without a context");
  });

  it("tenant context never leaks through a reused pooled connection (one real connection, many requests)", async () => {
    const url = new URL(appUrl());
    url.searchParams.set("connection_limit", "1");
    const one = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      const seen = async (ctx: string | null) => one.$transaction(async (tx) => {
        if (ctx !== null) await tx.$queryRaw`SELECT set_config('app.tenant_id', ${ctx}, true)`;
        const [r] = await tx.$queryRaw<{ n: bigint; p: number }[]>`SELECT (SELECT count(*) FROM "Patient") AS n, pg_backend_pid() AS p`;
        return { n: Number(r!.n), p: r!.p };
      });
      const pid = (await one.$queryRaw<{ p: number }[]>`SELECT pg_backend_pid() AS p`)[0]!.p;
      for (const ctx of [a.tenantId, null, b.tenantId, null, a.tenantId, "", b.tenantId, a.tenantId, null]) {
        const r = await seen(ctx);
        assert.equal(r.p, pid, "the same connection served every request");
        assert.equal(r.n, ctx === a.tenantId ? patientsA.length : ctx === b.tenantId ? patientsB.length : 0);
      }
      const left = (await one.$queryRaw<{ s: string | null }[]>`SELECT current_setting('app.tenant_id', true) AS s`)[0]!.s;
      assert.ok(!left, "nothing is left on the connection after a transaction");
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => seen(i % 3 === 0 ? a.tenantId : i % 3 === 1 ? b.tenantId : null)));
      results.forEach((r, i) => assert.equal(r.n, i % 3 === 0 ? patientsA.length : i % 3 === 1 ? patientsB.length : 0, `request ${i}`));
    } finally {
      await one.$disconnect();
    }
  });

  // ───────────────────────── the API's startup check ─────────────────────────
  it("the API refuses to start when the database login and the settings disagree", async () => {
    const env = { JWT_ACCESS_SECRET: "x".repeat(40), NODE_ENV: "test" };
    const boot = async (url: string, extra: Record<string, string>): Promise<void> => {
      const svc = new PrismaService(loadConfig({ ...env, DATABASE_URL: url, ...extra }));
      try { await svc.onModuleInit(); } finally { await svc.onModuleDestroy(); }
    };
    await assert.rejects(boot(ownerUrl, { DB_TENANT_CONTEXT: "on" }), /restricted database login/, "context on with the owner login: its queries would ignore the policies");
    await assert.rejects(boot(appUrl(), { DB_TENANT_CONTEXT: "off" }), /needs DB_TENANT_CONTEXT=on/, "restricted login with the context off: every query would return nothing");
    await boot(appUrl(), { DB_TENANT_CONTEXT: "on" });
    await boot(ownerUrl, { DB_TENANT_CONTEXT: "off" });
    await boot(ownerUrl, { DB_TENANT_CONTEXT: "on", DB_SESSION_ROLE: "medos_app" });
  });
});
