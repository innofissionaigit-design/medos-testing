import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run, type RunResult } from "./pgtools";

export interface PitrStep { name: string; ok: boolean; detail: string }
export interface PitrResult { ok: boolean; steps: PitrStep[]; seconds: number }

type Tool = "initdb" | "pg_ctl" | "pg_basebackup" | "psql";

/** The settings that make a server archive its WAL; the same lines belong in production (docs/backup.md). */
export function archiveSettings(archiveDir: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === "win32";
  const cmd = win ? `copy /Y "%p" "${archiveDir}\\%f"` : `test ! -f '${archiveDir}/%f' && cp '%p' '${archiveDir}/%f'`;
  return `wal_level = replica\narchive_mode = on\narchive_timeout = 60\narchive_command = '${cmd.replace(/\\/g, "\\\\").replace(/'/g, "''")}'\n`;
}

export function restoreSettings(archiveDir: string, targetTime: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === "win32";
  const cmd = win ? `copy /Y "${archiveDir}\\%f" "%p"` : `cp '${archiveDir}/%f' '%p'`;
  return `restore_command = '${cmd.replace(/\\/g, "\\\\").replace(/'/g, "''")}'\nrecovery_target_time = '${targetTime}'\nrecovery_target_action = 'promote'\nrecovery_target_inclusive = true\n`;
}

/**
 * Proves point-in-time recovery end to end on a throwaway cluster (never the real database): archive WAL, take a base backup,
 * keep writing, simulate a mistake, then rebuild the data as it was just before the mistake.
 */
/** True when nothing is listening on, or holding, this local port right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolveP) => {
    const s = createServer();
    s.once("error", () => resolveP(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolveP(true)));
  });
}

/**
 * Asks the operating system for a local port nobody is using. A fixed port is not safe: on Windows the range from 49152 up is also what
 * the system hands to every outgoing connection, so a long test run can be holding any given port (such as 54400) at the moment the
 * scratch server needs it, and then the server cannot start.
 */
export function freePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => (port > 0 ? resolveP(port) : reject(new Error("The system did not give a free port"))));
    });
  });
}

export async function pitrRehearsal(opts: { pgBin?: string | undefined; port?: number; keepDir?: boolean }): Promise<PitrResult> {
  const started = Date.now();
  const steps: PitrStep[] = [];
  const bin = (t: Tool): string => resolve(opts.pgBin ?? "", process.platform === "win32" ? `${t}.exe` : t);
  const root = mkdtempSync(join(tmpdir(), "medos-pitr-"));
  const primary = join(root, "primary"); const base = join(root, "base"); const restored = join(root, "restored"); const archive = join(root, "archive");
  mkdirSync(archive);
  // Unless a port is asked for (--port), take one that is free right now. PGCONNECT_TIMEOUT makes a stalled connection fail in seconds
  // instead of waiting for ever.
  const port = opts.port ?? (await freePort());
  const env = { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "medos", PGCONNECT_TIMEOUT: "10" } as NodeJS.ProcessEnv;
  const rec = (name: string, r: boolean, detail = ""): boolean => { steps.push({ name, ok: r, detail }); return r; };
  const must = (r: RunResult, what: string): RunResult => { if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`); return r; };
  const sql = async (q: string, db = "pitr"): Promise<string> => must(await run(bin("psql"), ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-d", db, "-c", q], env), `SQL ${q.slice(0, 40)}`).stdout.trim();
  const start = async (dir: string, log: string): Promise<void> => { must(await run(bin("pg_ctl"), ["-D", dir, "-l", join(root, log), "-w", "-t", "120", "start"], env, { detached: true }), "start server"); };
  const stop = async (dir: string): Promise<void> => { await run(bin("pg_ctl"), ["-D", dir, "-m", "fast", "-w", "stop"], env); };
  const initCluster = async (): Promise<void> => {
    must(await run(bin("initdb"), ["-D", primary, "-U", "medos", "-A", "trust", "-E", "UTF8"], env), "initdb");
    appendFileSync(join(primary, "postgresql.conf"), `port = ${port}\nlisten_addresses = '127.0.0.1'\n${archiveSettings(archive)}`);
  };

  try {
    if (!(await isPortFree(port))) throw new Error(`Port ${port} is already in use on this machine; pick another with --port, or leave it out to let the system choose`);
    await initCluster();
    await start(primary, "primary.log");
    await sql("CREATE DATABASE pitr", "postgres");
    await sql("CREATE TABLE payments (id serial PRIMARY KEY, amount numeric(12,2) NOT NULL, note text)");
    await sql("INSERT INTO payments(amount, note) SELECT 100, 'before-base-backup' FROM generate_series(1,50)");
    rec("server running with WAL archiving on", (await sql("SHOW archive_mode")) === "on");

    must(await run(bin("pg_basebackup"), ["-D", base, "-c", "fast", "-X", "stream", "-U", "medos", "-h", "127.0.0.1", "-p", String(port)], env), "pg_basebackup");
    rec("base backup taken", existsSync(join(base, "PG_VERSION")));

    await sql("INSERT INTO payments(amount, note) SELECT 200, 'after-base-backup' FROM generate_series(1,30)");
    const target = await sql("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'");
    await sql("SELECT pg_sleep(1.5)");
    await sql("DELETE FROM payments");
    await sql("DROP TABLE payments");
    await sql("SELECT pg_switch_wal()");
    let archived = 0;
    for (let i = 0; i < 60 && archived < 2; i++) {
      archived = readdirSync(archive).filter((f) => /^[0-9A-F]{24}$/.test(f)).length;
      if (archived < 2) await sql("SELECT pg_sleep(1)");
    }
    rec("WAL segments reach the archive", archived >= 2, `${archived} segment(s) archived`);
    rec("the mistake happened (table dropped)", (await sql("SELECT to_regclass('public.payments') IS NULL")) === "t");
    await stop(primary);

    cpSync(base, restored, { recursive: true });
    writeFileSync(join(restored, "recovery.signal"), "");
    appendFileSync(join(restored, "postgresql.conf"), `\nport = ${port}\nlisten_addresses = '127.0.0.1'\n${restoreSettings(archive, target)}`);
    await start(restored, "restored.log");
    for (let i = 0; i < 60 && (await sql("SELECT pg_is_in_recovery()", "postgres")) === "t"; i++) await sql("SELECT pg_sleep(1)", "postgres");
    const rows = await sql("SELECT count(*) || '/' || coalesce(sum(amount),0) FROM payments");
    rec("recovered to just before the mistake", rows === "80/11000.00", `rows/total = ${rows} (expected 80/11000.00: 50 before the base backup + 30 after, nothing deleted)`);
    rec("recovered server is writable", (await sql("INSERT INTO payments(amount, note) VALUES (1,'post-recovery') RETURNING id")) !== "");
  } catch (e) {
    rec("rehearsal completed", false, e instanceof Error ? e.message : String(e));
  } finally {
    // Cleanup must never hide the real result: the tools may be missing, or the server may never have started.
    await stop(restored).catch(() => undefined); await stop(primary).catch(() => undefined);
    if (!opts.keepDir) rmSync(root, { recursive: true, force: true });
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), steps, seconds: Math.round((Date.now() - started) / 100) / 10 };
}
