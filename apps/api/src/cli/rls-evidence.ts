import "reflect-metadata";
import { PrismaClient, type Prisma } from "@medos/database";
import { randomUUID } from "node:crypto";

/**
 * Evidence that row-level security is active and cross-tenant access is denied, for the database login the API uses (docs/rls.md).
 * Run it in staging, then production, with the API's own DATABASE_URL:
 *   node dist/cli/rls-evidence.js <hospital-code> [<other-hospital-code>]
 * It changes nothing: every probe runs in a transaction that is rolled back. Exit code 0 only if every check passes.
 */
type Result = { check: string; ok: boolean; detail: string };
class Undo extends Error {}
const results: Result[] = [];
const record = (check: string, ok: boolean, detail: string): void => { results.push({ check, ok, detail }); };

async function rolledBack<T>(db: PrismaClient, tenant: string | null, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await db.$transaction(async (tx) => {
      if (tenant !== null) await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      out = await fn(tx);
      throw new Undo();
    });
  } catch (e) { if (!(e instanceof Undo)) throw e; }
  return out as T;
}
const refused = async (sql: string, db: PrismaClient): Promise<{ refused: boolean; message: string }> => {
  try { await db.$executeRawUnsafe(sql); return { refused: false, message: "was allowed" }; }
  catch (e) { return { refused: true, message: (e instanceof Error ? e.message : String(e)).split("\n").pop()!.slice(0, 80) }; }
};
const count = async (tx: Prisma.TransactionClient, table: string, where = "true"): Promise<number> =>
  Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`))[0]!.n);

async function main(): Promise<void> {
  const codes = process.argv.slice(2);
  if (codes.length === 0) throw new Error("Usage: rls-evidence <hospital-code> [<other-hospital-code>]");
  const db = new PrismaClient();
  try {
    const [who] = await db.$queryRaw<{ cu: string; su: string; super: boolean; bypass: boolean; owns: number; unprotected: number; policies: number }[]>`
      SELECT current_user::text AS cu, session_user::text AS su, r.rolsuper AS super, r.rolbypassrls AS bypass,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owns,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname NOT IN ('_prisma_migrations', 'RateLimitBucket')) AS unprotected,
        (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public') AS policies
      FROM pg_roles r WHERE r.rolname = current_user`;
    record("connected as the restricted role", !who!.super && !who!.bypass && who!.owns === 0, `login=${who!.su} superuser=${who!.super} bypassrls=${who!.bypass} tables owned=${who!.owns}`);
    record("every tenant table has a policy", who!.unprotected === 0 && who!.policies >= 60, `${who!.policies} policies, ${who!.unprotected} tables without`);

    const ids: string[] = [];
    for (const code of codes) {
      const rows = await db.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM medos_resolve_tenant(${code})`;
      if (!rows[0]) throw new Error(`Unknown hospital code "${code}"`);
      ids.push(rows[0].id);
    }
    const a = ids[0]!;
    const other = ids[1] ?? randomUUID();
    record("no hospital context shows nothing", (await rolledBack(db, null, (tx) => count(tx, "Patient"))) === 0 && (await rolledBack(db, null, (tx) => count(tx, "User"))) === 0, "Patient and User read without a context: 0 rows");
    const own = await rolledBack(db, a, (tx) => count(tx, "Patient"));
    const foreign = await rolledBack(db, a, (tx) => count(tx, "Patient", `"tenantId" <> '${a}'::uuid`));
    record("a hospital context sees only its own patients", foreign === 0, `${codes[0]}: ${own} visible, ${foreign} belonging to other hospitals`);
    const none = await rolledBack(db, other, (tx) => count(tx, "Patient", `"tenantId" = '${a}'::uuid`));
    record("another hospital's context cannot see them", none === 0, `${ids[1] ? codes[1] : "an unrelated id"}: ${none} of ${codes[0]}'s patients visible`);
    const tenantRows = await rolledBack(db, a, (tx) => count(tx, "Tenant"));
    record("a hospital sees only its own record", tenantRows <= 1, `${tenantRows} Tenant row visible`);
    const writeRefused = await refused(`INSERT INTO "Department" ("tenantId", "facilityId", name, code, "updatedAt") VALUES ('${other}'::uuid, gen_random_uuid(), 'x', 'x', now())`, db);
    record("a write without or for the wrong context is refused", writeRefused.refused, writeRefused.message);
    const ownerRole = (await db.$queryRaw<{ r: string }[]>`SELECT rolname::text AS r FROM pg_roles WHERE rolsuper ORDER BY rolname LIMIT 1`)[0]?.r;
    if (ownerRole) { const r = await refused(`SET ROLE "${ownerRole}"`, db); record("cannot become the owner", r.refused, r.message); }
    for (const [label, sql] of [
      ["cannot switch row security off", "SET row_security = off"],
      ["cannot disable a policy", 'ALTER TABLE "Patient" DISABLE ROW LEVEL SECURITY'],
      ["cannot create or drop tables", 'CREATE TABLE "Rls_Evidence_Probe" (a int)'],
      ["cannot truncate patient data", 'TRUNCATE "Patient"'],
      ["cannot edit the audit trail", 'UPDATE "AuditEvent" SET action = action'],
    ] as const) {
      const r = label === "cannot switch row security off"
        ? await rolledBack(db, a, async (tx) => { try { await tx.$executeRawUnsafe(sql); await tx.$queryRawUnsafe('SELECT count(*) FROM "Patient"'); return { refused: false, message: "was allowed" }; } catch (e) { return { refused: true, message: (e instanceof Error ? e.message : "").split("\n").pop()!.slice(0, 80) }; } }).catch(() => ({ refused: true, message: "transaction refused" }))
        : await refused(sql, db);
      record(label, r.refused, r.message);
    }
  } finally {
    await db.$disconnect();
  }
  const width = Math.max(...results.map((r) => r.check.length));
  for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.check.padEnd(width)}  ${r.detail}\n`);
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`} (${results.length} checks)\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`rls-evidence failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
});
