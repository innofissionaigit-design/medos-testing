import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { archiveSettings, pitrRehearsal, restoreSettings } from "./pitr";

describe("point-in-time recovery settings", () => {
  it("builds archive and restore commands that are safe to put in postgresql.conf", () => {
    const w = archiveSettings("C:\\wal archive", "win32");
    assert.match(w, /archive_mode = on/);
    assert.match(w, /archive_command = 'copy \/Y "%p" "C:\\\\wal archive\\\\%f"'/);
    const l = archiveSettings("/var/wal", "linux");
    assert.match(l, /test ! -f ''\/var\/wal\/%f'' && cp ''%p'' ''\/var\/wal\/%f'''/, "never overwrites an archived segment");
    const r = restoreSettings("/var/wal", "2026-10-28 10:00:00+00", "linux");
    assert.match(r, /recovery_target_time = '2026-10-28 10:00:00\+00'/);
    assert.match(r, /recovery_target_action = 'promote'/);
  });
});

describe("point-in-time recovery rehearsal on a scratch cluster", async () => {
  const bin = process.env["PG_BIN"];
  const exe = (n: string): string => resolve(bin ?? "", process.platform === "win32" ? `${n}.exe` : n);
  if (!bin || !["initdb", "pg_ctl", "pg_basebackup"].every((t) => existsSync(exe(t)))) {
    if (process.env["CI"]) it("PostgreSQL server tools are available in CI", () => { assert.fail("set PG_BIN to the PostgreSQL bin directory"); });
    else it("skipped: set PG_BIN to a PostgreSQL bin directory with initdb, pg_ctl and pg_basebackup", { skip: true }, () => undefined);
    return;
  }
  it("recovers the data to the moment before a table was dropped", { timeout: 240_000 }, async () => {
    const r = await pitrRehearsal({ pgBin: bin });
    assert.equal(r.ok, true, JSON.stringify(r.steps.filter((s) => !s.ok)));
  });
});
