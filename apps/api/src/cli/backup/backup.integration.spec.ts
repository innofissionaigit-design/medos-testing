import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyIdOf } from "./crypto";
import type { KeyConfig } from "./keys";
import { createBackup, listManifests, restoreBackup, runDrill, backupStatus } from "./service";
import { parseDatabaseUrl, pgBinary, pgEnv, run } from "./pgtools";

const ownerUrl = process.env["TEST_DATABASE_URL"] ?? "postgresql://medos@127.0.0.1:54329/medos_test";
const pgBin = process.env["PG_BIN"];

/** The client tools are needed; on a machine without them the suite says so and skips, but in CI it must run. */
async function toolsProblem(): Promise<string | null> {
  try {
    const r = await run(pgBinary("pg_dump", pgBin), ["--version"], process.env);
    return r.code === 0 ? null : `pg_dump failed: ${r.stderr}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe("backup, restore and restore drill against a real database", async () => {
  const problem = await toolsProblem();
  if (problem) {
    if (process.env["CI"]) it("PostgreSQL client tools are available in CI", () => { assert.fail(problem); });
    else it("skipped: PostgreSQL client tools not found (set PG_BIN)", { skip: problem }, () => undefined);
    return;
  }

  const conn = parseDatabaseUrl(ownerUrl);
  const key = randomBytes(32);
  const keys: KeyConfig = { current: { id: keyIdOf(key), key }, ring: new Map([[keyIdOf(key), key]]) };
  let dir: string;
  const dropped: string[] = [];
  const dropDb = async (name: string): Promise<void> => {
    await run(pgBinary("psql", pgBin), ["-X", "-q", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`], pgEnv(conn, "postgres"));
  };
  const dbExists = async (name: string): Promise<boolean> => {
    const r = await run(pgBinary("psql", pgBin), ["-X", "-At", "-d", "postgres", "-c", `SELECT 1 FROM pg_database WHERE datname='${name}'`], pgEnv(conn, "postgres"));
    return r.stdout.trim() === "1";
  };
  const opts = (): Parameters<typeof createBackup>[0] => ({ databaseUrl: ownerUrl, outDir: dir, keep: 5, keys, allowUnencrypted: false, pgBin });

  before(() => { dir = mkdtempSync(join(tmpdir(), "medos-bk-")); });
  after(async () => {
    for (const d of dropped) await dropDb(d);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes an encrypted, verified backup with a manifest and no readable data", async () => {
    const m = await createBackup(opts());
    assert.equal(m.encrypted, true);
    assert.equal(m.keyId, keyIdOf(key));
    assert.match(m.file, /\.dump\.enc$/);
    const bytes = readFileSync(join(dir, m.file));
    assert.equal(bytes.subarray(0, 8).toString(), "MEDOSBK1");
    assert.equal(bytes.includes(Buffer.from("PGDMP")), false, "no pg_dump header is visible");
    assert.equal(listManifests(dir, conn.database).length >= 1, true);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp") || f.includes(".part")), [], "no temporary files left");
    const s = backupStatus({ outDir: dir, database: conn.database, maxBackupAgeHours: 1, maxDrillAgeDays: 7 });
    assert.equal(s.lastBackup?.file, m.file);
  });

  it("refuses an unencrypted backup unless explicitly allowed", async () => {
    await assert.rejects(createBackup({ ...opts(), keys: { current: null, ring: new Map() } }), /encryption key|unencrypted/i);
    assert.equal(listManifests(dir, conn.database).filter((x) => !x.encrypted).length, 0);
  });

  it("refuses to run with the restricted application login", async () => {
    const appUrl = process.env["TEST_APP_DATABASE_URL"];
    if (!appUrl) return;
    await assert.rejects(createBackup({ ...opts(), databaseUrl: appUrl }), /owner|restricted|medos_app/i);
  });

  it("restores into a new database, re-applies privileges, and refuses an existing one", async () => {
    const m = listManifests(dir, conn.database)[0]!;
    const target = `medos_bk_restore_${randomBytes(3).toString("hex")}`;
    dropped.push(target);
    const r = await restoreBackup({ file: join(dir, m.file), database: target, databaseUrl: ownerUrl, keys, pgBin });
    assert.equal(r.database, target);
    assert.equal(await dbExists(target), true);
    await assert.rejects(restoreBackup({ file: join(dir, m.file), database: target, databaseUrl: ownerUrl, keys, pgBin }), /already exists/i);
    await assert.rejects(restoreBackup({ file: join(dir, m.file), database: conn.database, databaseUrl: ownerUrl, keys, pgBin }), /already exists/i);
    await assert.rejects(restoreBackup({ file: join(dir, m.file), database: 'x"; DROP DATABASE y; --', databaseUrl: ownerUrl, keys, pgBin }), /must be 1-50/);
  });

  it("refuses a restore when the key is missing or the backup was modified, and leaves no database behind", async () => {
    const m = listManifests(dir, conn.database)[0]!;
    const noKey = `medos_bk_nokey_${randomBytes(3).toString("hex")}`;
    dropped.push(noKey);
    await assert.rejects(restoreBackup({ file: join(dir, m.file), database: noKey, databaseUrl: ownerUrl, keys: { ring: new Map() }, pgBin }), /needs key/);
    assert.equal(await dbExists(noKey), false);

    const copy = join(dir, "tampered");
    const { mkdirSync, copyFileSync } = await import("node:fs");
    mkdirSync(copy);
    copyFileSync(join(dir, m.file), join(copy, m.file));
    copyFileSync(join(dir, m.file.replace(/\.dump\.enc$/, ".manifest.json")), join(copy, m.file.replace(/\.dump\.enc$/, ".manifest.json")));
    const bytes = readFileSync(join(copy, m.file));
    bytes.writeUInt8(bytes.readUInt8(100) ^ 1, 100);
    writeFileSync(join(copy, m.file), bytes);
    const bad = `medos_bk_bad_${randomBytes(3).toString("hex")}`;
    dropped.push(bad);
    await assert.rejects(restoreBackup({ file: join(copy, m.file), database: bad, databaseUrl: ownerUrl, keys, pgBin }), /checksum|sha256|modified|authentication/i);
    assert.equal(await dbExists(bad), false);
  });

  it("restore drill passes on a good backup, cleans up, and fails on a damaged one", async () => {
    const before = (await run(pgBinary("psql", pgBin), ["-X", "-At", "-d", "postgres", "-c", "SELECT count(*) FROM pg_database WHERE datname LIKE '%_drill_%'"], pgEnv(conn, "postgres"))).stdout.trim();
    const r = await runDrill({ databaseUrl: ownerUrl, outDir: dir, keys, pgBin });
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.ok(r.checks.length >= 4);
    const after = (await run(pgBinary("psql", pgBin), ["-X", "-At", "-d", "postgres", "-c", "SELECT count(*) FROM pg_database WHERE datname LIKE '%_drill_%'"], pgEnv(conn, "postgres"))).stdout.trim();
    assert.equal(after, before, "the scratch database is dropped");
    assert.equal(backupStatus({ outDir: dir, database: conn.database, maxBackupAgeHours: 1, maxDrillAgeDays: 7 }).lastDrill?.ok, true);

    const m = listManifests(dir, conn.database)[0]!;
    const bytes = readFileSync(join(dir, m.file));
    const path = join(dir, m.file);
    writeFileSync(path, Buffer.concat([bytes.subarray(0, 200), Buffer.from([bytes.readUInt8(200) ^ 1]), bytes.subarray(201)]));
    const bad = await runDrill({ databaseUrl: ownerUrl, outDir: dir, keys, pgBin }).catch(() => null);
    assert.ok(bad === null || bad.ok === false, "a damaged backup never passes the drill");
    if (bad) assert.equal(backupStatus({ outDir: dir, database: conn.database, maxBackupAgeHours: 1, maxDrillAgeDays: 7 }).ok, false, "and monitoring turns unhealthy");
    assert.equal(existsSync(path), true);
  });
});
