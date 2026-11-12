import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type Server } from "node:net";
import { archiveSettings, freePort, isPortFree, pitrRehearsal, restoreSettings } from "./pitr";

const hold = (port: number): Promise<Server | null> => new Promise((r) => { const s = createServer(); s.once("error", () => r(null)); s.listen(port, "127.0.0.1", () => r(s)); });
const release = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

describe("point-in-time recovery: choosing a port", () => {
  it("freePort gives a port that can really be used, and isPortFree notices when it is taken", async () => {
    const port = await freePort();
    assert.ok(port > 0 && port < 65536);
    assert.equal(await isPortFree(port), true);
    const holder = await hold(port);
    assert.ok(holder, "the port could be taken");
    assert.equal(await isPortFree(port), false, "a taken port is reported as not free");
    await release(holder);
    assert.equal(await isPortFree(port), true, "free again once released");
  });

  it("refuses at once, with a clear message, when the port asked for is taken (it does not wait through server timeouts)", async () => {
    const port = await freePort();
    const holder = await hold(port);
    assert.ok(holder);
    try {
      const started = Date.now();
      const r = await pitrRehearsal({ pgBin: process.env["PG_BIN"], port });
      assert.equal(r.ok, false);
      assert.match(r.steps.map((s) => s.detail).join(" "), new RegExp(`Port ${port} is already in use`));
      // Waiting through the server's timeouts would take over two minutes; the limit is generous so a busy machine does not trip it.
      assert.ok(Date.now() - started < 60_000, "it failed quickly");
    } finally { await release(holder); }
  });
});

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

  // The old rehearsal always used port 54400, which on Windows is also an everyday outgoing-connection port, so a busy test run could be
  // holding it and the scratch server then failed to start. It now takes a free port, so this must pass whatever holds 54400.
  it("still recovers when the old fixed port 54400 is taken by something else", { timeout: 240_000 }, async () => {
    const holder = await hold(54400);
    try {
      const r = await pitrRehearsal({ pgBin: bin });
      assert.equal(r.ok, true, JSON.stringify(r.steps.filter((s) => !s.ok)));
    } finally { if (holder) await release(holder); }
  });
});
