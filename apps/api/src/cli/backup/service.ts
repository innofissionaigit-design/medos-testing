import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Prisma, PrismaClient } from "@medos/database";
import { logJson } from "../../common/logger";
import { decryptFile, encryptFile, isEncrypted, type Keyring } from "./crypto";
import type { KeyConfig } from "./keys";
import { assertPlainName, parseDatabaseUrl, pgBinary, pgEnv, psql, run, type Conn } from "./pgtools";

/**
 * Backups, restores and restore drills (docs/deployment.md, docs/backup.md). Everything here talks to PostgreSQL through the
 * standard client programs, never puts a password on a command line, and treats a backup as complete only once its manifest exists.
 */
const root = (): string => process.env["MEDOS_REPO_ROOT"] ?? resolve(__dirname, "../../../../..");
const sqlFile = (name: string): string => join(root(), "scripts", "sql", name);
const GRANTS_SQL = (): string => join(root(), "packages", "database", "ops", "rls-grants.sql");

export interface Manifest {
  version: 1;
  database: string;
  createdAt: string;
  /** File name of the backup artifact, next to this manifest. */
  file: string;
  sizeBytes: number;
  /** SHA-256 of the artifact exactly as stored (the ciphertext when encrypted). */
  sha256: string;
  encrypted: boolean;
  /** Non-secret fingerprint of the key that opens it. */
  keyId: string | null;
  pgDumpVersion: string;
  serverVersion: string;
  /** Row counts and money/stock totals taken from the SAME snapshot as the dump, for the restore drill to compare. */
  counts: Record<string, string>;
  /** Row-level security state at backup time (scripts/sql/rls-state.sql). */
  rlsState: string;
  seconds: number;
}

export interface DrillCheck { name: string; ok: boolean; detail: string }
export interface DrillResult { ok: boolean; backup: string; scratch: string; seconds: number; checks: DrillCheck[]; at: string }
interface Entry { lastBackup?: { at: string; file: string; sizeBytes: number; encrypted: boolean; uploaded: boolean | null }; lastDrill?: DrillResult }
interface StatusFile { databases: Record<string, Entry> }

const stampOf = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((res, rej) => createReadStream(path).on("data", (c) => h.update(c)).on("end", () => res()).on("error", rej));
  return h.digest("hex");
}

const readJson = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; } };
function writeAtomic(path: string, data: string): void {
  writeFileSync(`${path}.tmp`, data, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

// ───────────────────────── status file ─────────────────────────

const statusPath = (outDir: string): string => join(outDir, "status.json");
function updateStatus(outDir: string, database: string, fn: (e: Entry) => void): void {
  const s = readJson<StatusFile>(statusPath(outDir)) ?? { databases: {} };
  const e = s.databases[database] ?? {};
  fn(e);
  s.databases[database] = e;
  writeAtomic(statusPath(outDir), JSON.stringify(s, null, 2));
}

export interface StatusReport { ok: boolean; problems: string[]; lastBackup: Entry["lastBackup"] | null; lastDrill: DrillResult | null }

/** For a monitor: fails if the newest backup or the newest successful drill is too old, or the last drill failed. */
export function backupStatus(opts: { outDir: string; database: string; maxBackupAgeHours: number; maxDrillAgeDays: number; now?: Date }): StatusReport {
  const now = (opts.now ?? new Date()).getTime();
  const e = readJson<StatusFile>(statusPath(opts.outDir))?.databases[opts.database];
  const problems: string[] = [];
  if (!e?.lastBackup) problems.push("no backup has been recorded");
  else {
    const hours = (now - Date.parse(e.lastBackup.at)) / 3_600_000;
    if (hours > opts.maxBackupAgeHours) problems.push(`the newest backup is ${hours.toFixed(1)} hours old (limit ${opts.maxBackupAgeHours})`);
    if (e.lastBackup.uploaded === false) problems.push("the newest backup was NOT copied off the host");
  }
  if (!e?.lastDrill) problems.push("no restore drill has been recorded");
  else {
    const days = (now - Date.parse(e.lastDrill.at)) / 86_400_000;
    if (!e.lastDrill.ok) problems.push(`the last restore drill FAILED (${e.lastDrill.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")})`);
    if (days > opts.maxDrillAgeDays) problems.push(`the last restore drill is ${days.toFixed(1)} days old (limit ${opts.maxDrillAgeDays})`);
  }
  return { ok: problems.length === 0, problems, lastBackup: e?.lastBackup ?? null, lastDrill: e?.lastDrill ?? null };
}

// ───────────────────────── retention ─────────────────────────

export function listManifests(outDir: string, database: string): Manifest[] {
  if (!existsSync(outDir)) return [];
  const re = new RegExp(`^${database}-\\d{8}T\\d{6}Z\\.manifest\\.json$`);
  return readdirSync(outDir).filter((f) => re.test(f)).map((f) => readJson<Manifest>(join(outDir, f))).filter((m): m is Manifest => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keeps the newest `keep` backups; never touches anything that is not a backup of this database. Returns what it removed. */
export function applyRetention(outDir: string, database: string, keep: number): string[] {
  const removed: string[] = [];
  for (const m of listManifests(outDir, database).slice(Math.max(1, keep))) {
    rmSync(join(outDir, m.file), { force: true });
    rmSync(join(outDir, m.file.replace(/\.dump(\.enc)?$/, ".manifest.json")), { force: true });
    removed.push(m.file);
  }
  return removed;
}

// ───────────────────────── backup ─────────────────────────

export interface BackupOptions {
  databaseUrl: string; outDir: string; keep: number; keys: KeyConfig; allowUnencrypted: boolean; uploadCommand?: string | undefined; pgBin?: string | undefined; now?: Date;
}

async function assertPrivileged(conn: Conn, bin: string | undefined): Promise<void> {
  const r = await psql(conn, bin, conn.database, ["-tA", "-c", `select (r.rolsuper or r.rolbypassrls or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relowner = r.oid))::text from pg_roles r where r.rolname = current_user`]);
  if (r.code !== 0) throw new Error(`Cannot connect to the database: ${r.stderr.trim().split("\n").pop()}`);
  if (r.stdout.trim() !== "true") throw new Error(`Backups need the OWNER database login: "${conn.user}" is the restricted application role, which row-level security would show only part of (docs/rls.md)`);
}

async function assertToolsMatchServer(conn: Conn, bin: string | undefined): Promise<{ dump: string; server: string }> {
  const v = await run(pgBinary("pg_dump", bin), ["--version"], process.env);
  if (v.code !== 0) throw new Error("pg_dump is not available: install the PostgreSQL client tools or set PG_BIN");
  const dump = v.stdout.trim();
  const dumpMajor = Number(/(\d+)(?:\.\d+)?\s*(?:\(|$)/.exec(dump)?.[1] ?? /(\d+)/.exec(dump)?.[1]);
  const s = await psql(conn, bin, conn.database, ["-tA", "-c", "show server_version_num"]);
  const num = Number(s.stdout.trim());
  if (!Number.isFinite(num)) throw new Error("Cannot read the server version");
  if (dumpMajor < Math.floor(num / 10000)) throw new Error(`pg_dump ${dumpMajor} is older than the server (${Math.floor(num / 10000)}): use matching client tools`);
  return { dump, server: String(num) };
}

export async function createBackup(opts: BackupOptions): Promise<Manifest> {
  const started = Date.now();
  const conn = parseDatabaseUrl(opts.databaseUrl);
  const database = assertPlainName(conn.database);
  if (!opts.keys.current && !opts.allowUnencrypted) {
    throw new Error("No backup encryption key is configured (BACKUP_ENCRYPTION_KEY or BACKUP_KEYRING_FILE). Refusing to write an unencrypted backup; use --allow-unencrypted only for development data.");
  }
  mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });
  await assertPrivileged(conn, opts.pgBin);
  const versions = await assertToolsMatchServer(conn, opts.pgBin);
  const stamp = stampOf(opts.now ?? new Date());
  const base = `${database}-${stamp}`;
  const final = `${base}.dump${opts.keys.current ? ".enc" : ""}`;
  const part = join(opts.outDir, `${base}.dump.part`);
  const encPart = join(opts.outDir, `${final}.part`);
  logJson("info", "backup_started", { database, encrypted: Boolean(opts.keys.current) });

  const prisma = new PrismaClient({ datasourceUrl: opts.databaseUrl });
  let counts: Record<string, string> = {};
  let rlsState = "";
  try {
    // Counts and dump from ONE snapshot, so the drill can later compare a restore with exactly what was backed up.
    await prisma.$transaction(async (tx) => {
      const [snap] = await tx.$queryRaw<{ s: string }[]>`SELECT pg_export_snapshot() AS s`;
      const rows = await tx.$queryRawUnsafe<{ t: string; count: bigint | number | string }[]>(readFileSync(sqlFile("verify-counts.sql"), "utf8"));
      counts = Object.fromEntries(rows.map((r) => [r.t, String(Number(r.count))]));
      const rls = await tx.$queryRawUnsafe<Record<string, string>[]>(readFileSync(sqlFile("rls-state.sql"), "utf8"));
      rlsState = String(Object.values(rls[0] ?? {})[0] ?? "");
      const d = await run(pgBinary("pg_dump", opts.pgBin), ["-Fc", "-Z", "6", "--no-owner", "--no-privileges", `--snapshot=${snap!.s}`, "-f", part, database], pgEnv(conn));
      if (d.code !== 0) throw new Error(`pg_dump failed: ${d.stderr.trim().split("\n").slice(-3).join(" ")}`);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 60_000, timeout: 6 * 3_600_000 });
  } catch (e) {
    rmSync(part, { force: true });
    logJson("error", "backup_failed", { database, step: "dump", error: e instanceof Error ? e.message.slice(0, 300) : "unknown" });
    throw e;
  } finally {
    await prisma.$disconnect();
  }

  try {
    // A backup that cannot be read back is not a backup: list its table of contents before anything else.
    const list = await run(pgBinary("pg_restore", opts.pgBin), ["--list", part], process.env);
    if (list.code !== 0) throw new Error("The dump could not be read back (pg_restore --list failed)");
    let artifact = part;
    let keyId: string | null = null;
    if (opts.keys.current) {
      keyId = (await encryptFile(part, encPart, opts.keys.current.key)).keyId;
      rmSync(part, { force: true });
      artifact = encPart;
    }
    renameSync(artifact, join(opts.outDir, final));
    const path = join(opts.outDir, final);
    const manifest: Manifest = {
      version: 1, database, createdAt: (opts.now ?? new Date()).toISOString(), file: final, sizeBytes: statSync(path).size, sha256: await sha256File(path),
      encrypted: keyId !== null, keyId, pgDumpVersion: versions.dump, serverVersion: versions.server, counts, rlsState, seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    writeAtomic(join(opts.outDir, `${base}.manifest.json`), JSON.stringify(manifest, null, 2)); // the manifest marks the backup complete
    let uploaded: boolean | null = null;
    if (opts.uploadCommand) uploaded = await upload(opts.uploadCommand, [path, join(opts.outDir, `${base}.manifest.json`)]);
    updateStatus(opts.outDir, database, (e) => { e.lastBackup = { at: manifest.createdAt, file: final, sizeBytes: manifest.sizeBytes, encrypted: manifest.encrypted, uploaded }; });
    const removed = applyRetention(opts.outDir, database, opts.keep);
    logJson("info", "backup_completed", { database, file: final, sizeBytes: manifest.sizeBytes, encrypted: manifest.encrypted, uploaded, retentionRemoved: removed.length, seconds: manifest.seconds });
    if (uploaded === false) throw new BackupUploadError(manifest);
    return manifest;
  } catch (e) {
    rmSync(part, { force: true }); rmSync(encPart, { force: true });
    if (!(e instanceof BackupUploadError)) logJson("error", "backup_failed", { database, step: "finish", error: e instanceof Error ? e.message.slice(0, 300) : "unknown" });
    throw e;
  }
}

/** The local backup exists and is valid, but the copy off the host failed: reported distinctly (exit code 3). */
export class BackupUploadError extends Error {
  constructor(readonly manifest: Manifest) { super("The backup was written locally but the off-host upload command failed"); this.name = "BackupUploadError"; }
}

/** Runs the operator's upload command (BACKUP_UPLOAD_COMMAND) once per file; {file} is replaced by the quoted path. */
async function upload(template: string, files: string[]): Promise<boolean> {
  for (const f of files) {
    if (!/^[A-Za-z0-9_./:\\ -]+$/.test(f)) throw new Error("Refusing to run the upload command: unexpected characters in the backup path");
    const r = await run(template.split("{file}").join(`"${f}"`), [], process.env, { shell: true });
    if (r.code !== 0) { logJson("error", "backup_upload_failed", { file: f.split(/[\\/]/).pop(), code: r.code }); return false; }
  }
  logJson("info", "backup_uploaded", { files: files.length });
  return true;
}

// ───────────────────────── restore ─────────────────────────

export interface RestoreOptions { file: string; database: string; databaseUrl: string; keys: { ring: Keyring }; pgBin?: string | undefined }

export function manifestFor(file: string): Manifest {
  const m = readJson<Manifest>(file.replace(/\.dump(\.enc)?$/, ".manifest.json"));
  if (!m) throw new Error("The backup has no manifest next to it, so it cannot be verified: it is incomplete or was not made by this tool");
  return m;
}

/** Restores into a NEW database (never overwrites one), verifying the checksum first and re-applying the row-level security privileges after. */
export async function restoreBackup(opts: RestoreOptions): Promise<{ database: string; seconds: number; manifest: Manifest }> {
  const started = Date.now();
  const conn = parseDatabaseUrl(opts.databaseUrl);
  const target = assertPlainName(opts.database);
  if (!existsSync(opts.file)) throw new Error(`Backup file not found: ${opts.file}`);
  const manifest = manifestFor(opts.file);
  if ((await sha256File(opts.file)) !== manifest.sha256) throw new Error("Checksum mismatch: the backup is corrupt or was modified");
  const exists = await psql(conn, opts.pgBin, "postgres", ["-tA", "-c", `select 1 from pg_database where datname = '${target}'`]);
  if (exists.code !== 0) throw new Error(`Cannot connect to the database server: ${exists.stderr.trim().split("\n").pop()}`);
  if (exists.stdout.trim()) throw new Error(`Database "${target}" already exists. Restore into a new name, then switch over deliberately.`);

  const tmp = mkdtempSync(join(tmpdir(), "medos-restore-"));
  let created = false;
  try {
    let dump = opts.file;
    if (await isEncrypted(opts.file)) {
      dump = join(tmp, "backup.dump");
      await decryptFile(opts.file, dump, opts.keys.ring);
    }
    const c = await psql(conn, opts.pgBin, "postgres", ["-c", `CREATE DATABASE "${target}"`]);
    if (c.code !== 0) throw new Error(`Could not create database: ${c.stderr.trim()}`);
    created = true;
    const r = await run(pgBinary("pg_restore", opts.pgBin), ["--no-owner", "--no-privileges", "--exit-on-error", "-d", target, dump], pgEnv(conn, target));
    if (r.code !== 0) throw new Error(`pg_restore failed: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
    // Backups omit privileges (--no-privileges), so a restored database has the policies but none of the grants: put them back.
    const g = await psql(conn, opts.pgBin, target, ["-f", GRANTS_SQL()]);
    if (g.code !== 0) throw new Error(`Re-applying the row-level security privileges failed: ${g.stderr.trim()}`);
    created = false;
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    logJson("info", "restore_completed", { database: target, from: manifest.file, seconds });
    return { database: target, seconds, manifest };
  } catch (e) {
    if (created) await psql(conn, opts.pgBin, "postgres", ["-c", `DROP DATABASE IF EXISTS "${target}"`]); // never leave a half-restored database behind
    throw e;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ───────────────────────── restore drill ─────────────────────────

export interface DrillOptions { databaseUrl: string; outDir: string; keys: { ring: Keyring }; pgBin?: string | undefined; file?: string | undefined; keepScratch?: boolean; now?: Date }

/**
 * Proves the newest backup can actually be restored: checksum, decryption, restore into a scratch database, the same row counts
 * and totals as at backup time, the append-only audit trigger still blocking edits, and the same row-level security state.
 */
export async function runDrill(opts: DrillOptions): Promise<DrillResult> {
  const started = Date.now();
  const conn = parseDatabaseUrl(opts.databaseUrl);
  const database = assertPlainName(conn.database);
  const now = opts.now ?? new Date();
  const manifest = opts.file ? manifestFor(opts.file) : listManifests(opts.outDir, database)[0];
  if (!manifest) throw new Error(`There is no backup of "${database}" in ${opts.outDir} to drill`);
  const scratch = assertPlainName(`${database.slice(0, 28)}_drill_${stampOf(now).slice(0, 13).replace("T", "")}`);
  const checks: DrillCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };
  logJson("info", "restore_drill_started", { database, backup: manifest.file, scratch });
  try {
    await psql(conn, opts.pgBin, "postgres", ["-c", `DROP DATABASE IF EXISTS "${scratch}"`]);
    const r = await restoreBackup({ file: join(opts.outDir, manifest.file), database: scratch, databaseUrl: opts.databaseUrl, keys: opts.keys, pgBin: opts.pgBin });
    check("checksum, decryption and restore", true, `${manifest.encrypted ? "encrypted, key " + manifest.keyId : "not encrypted"}; restored in ${r.seconds}s`);

    const counts = await psql(conn, opts.pgBin, scratch, ["-tA", "-F", "|", "-f", sqlFile("verify-counts.sql")]);
    const got = Object.fromEntries(counts.stdout.trim().split("\n").filter(Boolean).map((l) => { const [t, ...v] = l.split("|"); return [t!, String(Number(v.join("|")))]; }));
    const diffs = Object.keys({ ...manifest.counts, ...got }).filter((k) => manifest.counts[k] !== got[k]).map((k) => `${k}: backup ${manifest.counts[k] ?? "-"}, restored ${got[k] ?? "-"}`);
    check("row counts and totals match the backup", diffs.length === 0, diffs.length === 0 ? `${Object.keys(got).length} figures identical` : diffs.join("; "));

    const tamper = await psql(conn, opts.pgBin, scratch, ["-f", sqlFile("tamper-check.sql")], { PGOPTIONS: "-c client_min_messages=notice" });
    check("audit trail is still append-only", /APPEND_ONLY_OK/.test(tamper.stdout + tamper.stderr), /APPEND_ONLY_OK/.test(tamper.stdout + tamper.stderr) ? "an edit was refused" : (tamper.stderr.trim().split("\n").pop() ?? "the trigger is missing"));

    const rls = (await psql(conn, opts.pgBin, scratch, ["-tA", "-f", sqlFile("rls-state.sql")])).stdout.trim();
    check("row-level security state matches the backup", rls === manifest.rlsState, rls === manifest.rlsState ? rls : `backup ${manifest.rlsState}, restored ${rls}`);
  } catch (e) {
    check("drill completed", false, e instanceof Error ? e.message.slice(0, 300) : "unknown error");
  } finally {
    if (!opts.keepScratch) await psql(conn, opts.pgBin, "postgres", ["-c", `DROP DATABASE IF EXISTS "${scratch}"`]);
  }
  const result: DrillResult = { ok: checks.every((c) => c.ok), backup: manifest.file, scratch, seconds: Math.round((Date.now() - started) / 100) / 10, checks, at: now.toISOString() };
  updateStatus(opts.outDir, database, (e) => { e.lastDrill = result; });
  logJson(result.ok ? "info" : "error", result.ok ? "restore_drill_passed" : "restore_drill_failed", { database, backup: manifest.file, seconds: result.seconds, failed: checks.filter((c) => !c.ok).map((c) => c.name) });
  return result;
}
