import { after, before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { PrismaClient, type Prisma } from "@medos/database";
import { registerPatient, startApp, type TestApp, type TestTenant } from "../test/harness";

/**
 * Row-level security (phase 1). The test connection is the owner, which is exempt from policies, so each test steps into the
 * restricted role inside a transaction (SET LOCAL ROLE medos_app) and sets the tenant the way the application will in phase 2
 * (set_config(..., true), transaction-local). Every transaction is rolled back: these tests never change data.
 * Phase 3 repeats the important checks over a real login as medos_app.
 */
type Tx = Prisma.TransactionClient;
class Undo extends Error {}

describe("row-level security: restricted role and tenant isolation policies", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let deptA: string;
  let deptB: string;
  let patientsA: string[];
  let patientsB: string[];

  /** Runs fn as medos_app with the given tenant context (null = none set), then always rolls back. */
  async function asApp<T>(tenant: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    let out: T | undefined;
    try {
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE medos_app");
        if (tenant !== null) await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
        out = await fn(tx);
        throw new Undo();
      });
    } catch (e) {
      if (!(e instanceof Undo)) throw e;
    }
    return out as T;
  }
  const count = async (tx: Tx, table: string): Promise<number> => Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("rls-a");
    b = await t.makeTenant("rls-b");
    const ra = await t.makeUser(a, ["RECEPTIONIST"]);
    const rb = await t.makeUser(b, ["RECEPTIONIST"]);
    patientsA = [(await registerPatient(t, ra.token)).id, (await registerPatient(t, ra.token)).id];
    patientsB = [(await registerPatient(t, rb.token)).id];
    deptA = (await t.prisma.department.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, name: "RLS Dept A", code: "RLSA" } })).id;
    deptB = (await t.prisma.department.create({ data: { tenantId: b.tenantId, facilityId: b.facilityId, name: "RLS Dept B", code: "RLSB" } })).id;
  });
  after(async () => { await t.close(); });

  // ───────────────────────── the role itself ─────────────────────────
  it("the application role is not a superuser, owner, bypass or login role, and holds only data privileges", async () => {
    const [role] = await t.prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolcanlogin: boolean; oid: number }[]>`
      SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin, oid FROM pg_roles WHERE rolname = 'medos_app'`;
    assert.ok(role, "medos_app exists");
    assert.deepEqual([role.rolsuper, role.rolbypassrls, role.rolcreaterole, role.rolcreatedb, role.rolreplication], [false, false, false, false, false]);
    // Whether the role can log in depends on the environment (an operations step, docs/rls.md); what must hold everywhere is that the
    // migration itself never enables a login or carries a password.
    const sql = readFileSync(resolve(__dirname, "../../../../packages/database/prisma/schema/migrations/20261028150000_rls_roles_and_policies/migration.sql"), "utf8");
    assert.match(sql, /CREATE ROLE medos_app NOLOGIN/);
    const statements = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join(" ").replace(/NOLOGIN/g, "");
    assert.equal(/PASSWORD|LOGIN/i.test(statements), false, "no login and no password in git");
    assert.equal(typeof role.rolcanlogin, "boolean");
    const owned = await t.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'medos_app')`;
    assert.equal(owned[0]!.n, 0, "owns nothing, so row-level security can never be waived by ownership");
    const member = await t.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'medos_app')`;
    assert.equal(member[0]!.n, 0, "belongs to no other role");

    const bad = await t.prisma.$queryRaw<{ tbl: string; priv: string }[]>`
      SELECT c.relname AS tbl, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND has_table_privilege('medos_app', c.oid, p.priv)`;
    assert.deepEqual(bad, [], "no TRUNCATE, REFERENCES or TRIGGER anywhere");
    const priv = async (table: string, p: string): Promise<boolean> => (await t.prisma.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT has_table_privilege('medos_app', '"${table}"', '${p}') AS ok`))[0]!.ok;
    assert.equal(await priv("_prisma_migrations", "SELECT"), false, "cannot even read the migration history");
    assert.deepEqual([await priv("AuditEvent", "SELECT"), await priv("AuditEvent", "INSERT"), await priv("AuditEvent", "UPDATE"), await priv("AuditEvent", "DELETE")], [true, true, false, false], "the audit trail is append-only");
    assert.equal(await priv("Patient", "UPDATE"), true);
    const schema = await t.prisma.$queryRaw<{ ok: boolean }[]>`SELECT has_schema_privilege('medos_app', 'public', 'CREATE') AS ok`;
    assert.equal(schema[0]!.ok, false, "cannot create objects");
    const fn = await t.prisma.$queryRaw<{ ok: boolean }[]>`SELECT has_function_privilege('medos_app', 'medos_enable_tenant_rls(regclass)', 'EXECUTE') AS ok`;
    assert.equal(fn[0]!.ok, false, "cannot run the policy helper");
  });

  it("every tenant table has the isolation policy, a missed table is caught here, and only RateLimitBucket is exempt", async () => {
    const rows = await t.prisma.$queryRaw<{ tbl: string; rls: boolean; policy: string | null; qual: string | null; chk: string | null }[]>`
      SELECT c.relname AS tbl, c.relrowsecurity AS rls, p.policyname AS policy, p.qual, p.with_check AS chk
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`;
    const hasTenantId = new Set((await t.prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenantId'`).map((r) => r.t));
    assert.ok(hasTenantId.size >= 59);
    const exempt: string[] = [];
    for (const tbl of [...new Set(rows.map((r) => r.tbl))].sort()) {
      const mine = rows.filter((r) => r.tbl === tbl);
      const covered = mine[0]!.rls && mine.some((r) => r.policy === (tbl === "Tenant" ? "tenant_self" : "tenant_isolation") && /medos_current_tenant/.test(r.qual ?? "") && /medos_current_tenant/.test(r.chk ?? ""));
      if (!covered) exempt.push(tbl);
      else if (tbl !== "Tenant") assert.ok(hasTenantId.has(tbl), `${tbl} has a tenant policy but no tenantId column`);
    }
    assert.deepEqual(exempt, ["RateLimitBucket"], "a table with a tenantId and no policy fails here: call medos_enable_tenant_rls() in its migration");
    for (const tbl of hasTenantId) assert.ok(rows.some((r) => r.tbl === tbl && r.rls), `${tbl} must have row-level security enabled`);
  });

  // ───────────────────────── reads ─────────────────────────
  it("reads: a tenant sees only its own rows, including raw SQL; no or empty context sees nothing", async () => {
    assert.deepEqual(await asApp(a.tenantId, async (tx) => (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Patient" ORDER BY id`).map((r) => r.id)), [...patientsA].sort());
    assert.deepEqual(await asApp(b.tenantId, async (tx) => (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Patient"`).map((r) => r.id)), patientsB);
    assert.equal(await asApp(a.tenantId, async (tx) => (await tx.$queryRaw<unknown[]>`SELECT 1 FROM "Patient" WHERE id = ${patientsB[0]!}::uuid`).length), 0, "a foreign id by exact key is invisible");
    assert.equal(await asApp(a.tenantId, async (tx) => (await tx.patient.findUnique({ where: { id: patientsB[0]! } }))), null, "Prisma lookups too");
    assert.deepEqual(await asApp(a.tenantId, async (tx) => (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Tenant"`).map((r) => r.id)), [a.tenantId], "a tenant sees only itself");
    for (const table of ["Patient", "User", "Facility", "Department", "AuditEvent", "Tenant"]) {
      assert.equal(await asApp(null, (tx) => count(tx, table)), 0, `${table}: no context shows nothing`);
      assert.equal(await asApp("", (tx) => count(tx, table)), 0, `${table}: an empty context shows nothing`);
    }
    const tenantsSeen = await asApp(a.tenantId, async (tx) => (await tx.$queryRaw<{ t: string }[]>`SELECT DISTINCT "tenantId"::text AS t FROM "AuditEvent"`).map((r) => r.t));
    assert.deepEqual(tenantsSeen, [a.tenantId]);
  });

  it("fails closed: a malformed tenant value is an error, never 'all rows'", async () => {
    await assert.rejects(asApp("not-a-uuid", (tx) => count(tx, "Patient")), /uuid/i);
    await assert.rejects(asApp("' OR '1'='1", (tx) => count(tx, "Patient")), /uuid/i);
  });

  // ───────────────────────── writes ─────────────────────────
  it("writes: insert, update and delete across tenants are refused or touch nothing", async () => {
    const ins = (tx: Tx, tenantId: string, facilityId: string, code: string) =>
      tx.$executeRaw`INSERT INTO "Department" ("tenantId", "facilityId", name, code, "updatedAt") VALUES (${tenantId}::uuid, ${facilityId}::uuid, 'X', ${code}, now())`;
    assert.equal(await asApp(a.tenantId, (tx) => ins(tx, a.tenantId, a.facilityId, "OWN1")), 1, "its own tenant works");
    await assert.rejects(asApp(a.tenantId, (tx) => ins(tx, b.tenantId, b.facilityId, "FOREIGN1")), /row-level security/i, "inserting into another tenant is refused");
    await assert.rejects(asApp(null, (tx) => ins(tx, a.tenantId, a.facilityId, "NOCTX")), /row-level security/i, "no context: refused");
    await assert.rejects(asApp("", (tx) => ins(tx, a.tenantId, a.facilityId, "NOCTX2")), /row-level security/i, "empty context: refused");
    assert.equal(await asApp(a.tenantId, (tx) => tx.$executeRaw`UPDATE "Department" SET name = 'hijacked' WHERE id = ${deptB}::uuid`), 0, "updating another tenant's row changes nothing");
    assert.equal(await asApp(a.tenantId, (tx) => tx.$executeRaw`DELETE FROM "Department" WHERE id = ${deptB}::uuid`), 0, "deleting another tenant's row changes nothing");
    assert.equal(await asApp(a.tenantId, (tx) => tx.$executeRaw`UPDATE "Tenant" SET name = 'hijacked' WHERE id = ${b.tenantId}::uuid`), 0, "nor another tenant's own record");
    await assert.rejects(asApp(a.tenantId, (tx) => tx.$executeRaw`UPDATE "Department" SET "tenantId" = ${b.tenantId}::uuid WHERE id = ${deptA}::uuid`), /row-level security/i, "a row cannot be moved into another tenant");
    const still = await t.prisma.department.findUniqueOrThrow({ where: { id: deptB } });
    assert.equal(still.name, "RLS Dept B", "the other tenant's data is untouched");
  });

  it("a row of one tenant cannot be linked to another tenant's record", async () => {
    await assert.rejects(
      asApp(a.tenantId, (tx) => tx.$executeRaw`INSERT INTO "Practitioner" ("tenantId", "facilityId", "departmentId", "displayName", "updatedAt") VALUES (${a.tenantId}::uuid, ${a.facilityId}::uuid, ${deptB}::uuid, 'Dr Cross', now())`),
      /Invalid reference|violates/i,
    );
    assert.equal(await asApp(a.tenantId, (tx) => tx.$executeRaw`INSERT INTO "Practitioner" ("tenantId", "facilityId", "departmentId", "displayName", "updatedAt") VALUES (${a.tenantId}::uuid, ${a.facilityId}::uuid, ${deptA}::uuid, 'Dr Own', now())`), 1);
  });

  it("the audit trail: own events can be appended, never changed or removed, never seen across tenants", async () => {
    assert.equal(await asApp(a.tenantId, (tx) => tx.$executeRaw`INSERT INTO "AuditEvent" ("tenantId", action, "entityType", metadata) VALUES (${a.tenantId}::uuid, 'RLS_TEST', 'Test', '{}'::jsonb)`), 1);
    await assert.rejects(asApp(b.tenantId, (tx) => tx.$executeRaw`INSERT INTO "AuditEvent" ("tenantId", action, "entityType", metadata) VALUES (${a.tenantId}::uuid, 'RLS_TEST', 'Test', '{}'::jsonb)`), /row-level security/i);
    await assert.rejects(asApp(a.tenantId, (tx) => tx.$executeRaw`UPDATE "AuditEvent" SET action = 'EDITED'`), /permission denied/i);
    await assert.rejects(asApp(a.tenantId, (tx) => tx.$executeRaw`DELETE FROM "AuditEvent"`), /permission denied/i);
  });

  // ───────────────────────── bypass attempts ─────────────────────────
  it("the role cannot switch policies off, change the schema, or read restricted tables", async () => {
    await assert.rejects(asApp(a.tenantId, async (tx) => { await tx.$executeRawUnsafe("SET LOCAL row_security = off"); return count(tx, "Patient"); }), /row-level security/i, "row_security=off errors instead of bypassing");
    for (const sql of [
      'CREATE TABLE "Rls_Evil" (a int)',
      'TRUNCATE "Patient"',
      'ALTER TABLE "Patient" DISABLE ROW LEVEL SECURITY',
      'DROP POLICY tenant_isolation ON "Patient"',
      'CREATE POLICY allow_all ON "Patient" USING (true)',
      'ALTER TABLE "Patient" NO FORCE ROW LEVEL SECURITY',
      'SELECT medos_enable_tenant_rls(\'"Patient"\')',
      'SELECT 1 FROM "_prisma_migrations"',
      "ALTER ROLE medos_app BYPASSRLS",
      // Switching back to the owner is not tested here: this connection's session user is the owner, which may always switch
      // roles. A real login as medos_app cannot (it belongs to no role, see the first test); phase 3 proves it over that login.
    ]) {
      await assert.rejects(asApp(a.tenantId, (tx) => tx.$executeRawUnsafe(sql)), /permission denied|must be owner|must be superuser|not permitted|cannot|permission/i, sql);
    }
  });

  // ───────────────────────── pooled connections ─────────────────────────
  it("tenant context never leaks through a reused pooled connection", async () => {
    const url = new URL(process.env["DATABASE_URL"]!);
    url.searchParams.set("connection_limit", "1");
    const one = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      const pid = async (): Promise<number> => (await one.$queryRaw<{ p: number }[]>`SELECT pg_backend_pid() AS p`)[0]!.p;
      const connection = await pid();
      const seen = async (ctx: string | null): Promise<{ patients: number; pid: number; setting: string | null }> =>
        one.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL ROLE medos_app");
          if (ctx !== null) await tx.$queryRaw`SELECT set_config('app.tenant_id', ${ctx}, true)`;
          const [row] = await tx.$queryRaw<{ n: bigint; p: number; s: string | null }[]>`SELECT (SELECT count(*) FROM "Patient") AS n, pg_backend_pid() AS p, current_setting('app.tenant_id', true) AS s`;
          return { patients: Number(row!.n), pid: row!.p, setting: row!.s };
        });
      const order: (string | null)[] = [a.tenantId, null, b.tenantId, null, a.tenantId, "", b.tenantId, a.tenantId, null];
      for (const ctx of order) {
        const r = await seen(ctx);
        assert.equal(r.pid, connection, "the very same database connection served every request");
        const expected = ctx === a.tenantId ? patientsA.length : ctx === b.tenantId ? patientsB.length : 0;
        assert.equal(r.patients, expected, `context ${ctx === a.tenantId ? "A" : ctx === b.tenantId ? "B" : "none"} saw ${r.patients}`);
      }
      const after = (await one.$queryRaw<{ s: string | null; cu: string; su: string }[]>`SELECT current_setting('app.tenant_id', true) AS s, current_user::text AS cu, session_user::text AS su`)[0]!;
      assert.ok(!after.s, "nothing is left on the connection after the transaction");
      assert.equal(after.cu, after.su, "and the role switch ended with the transaction (the connection is back to its own login)");
      // Concurrent callers interleave on one connection without ever seeing each other's tenant.
      const results = await Promise.all(Array.from({ length: 24 }, (_, i) => seen(i % 3 === 0 ? a.tenantId : i % 3 === 1 ? b.tenantId : null)));
      results.forEach((r, i) => assert.equal(r.patients, i % 3 === 0 ? patientsA.length : i % 3 === 1 ? patientsB.length : 0, `request ${i}`));
    } finally {
      await one.$disconnect();
    }
  });
});
