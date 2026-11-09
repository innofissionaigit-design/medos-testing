import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { keyIdOf } from "./backup/crypto";
import { loadKeys } from "./backup/keys";
import { BackupUploadError, backupStatus, createBackup, restoreBackup, runDrill } from "./backup/service";
import { parseDatabaseUrl, run } from "./backup/pgtools";
import { pitrRehearsal } from "./backup/pitr";

/**
 * Database backups, restores and restore drills (docs/backup.md). Run with the OWNER database login.
 *
 *   node dist/cli/db-backup.js backup  [--out DIR] [--keep N] [--allow-unencrypted]
 *   node dist/cli/db-backup.js restore --file BACKUP --database NEWNAME
 *   node dist/cli/db-backup.js drill   [--out DIR] [--file BACKUP] [--keep-scratch]
 *   node dist/cli/db-backup.js status  [--out DIR] [--max-backup-age-hours 26] [--max-drill-age-days 8]
 *   node dist/cli/db-backup.js keygen
 *   node dist/cli/db-backup.js pitr-rehearsal [--port 54400]   (throwaway cluster; needs initdb, pg_ctl, pg_basebackup in PG_BIN)
 *
 * Environment: DATABASE_URL (owner login), BACKUP_DIR (default ./.local/backups), BACKUP_KEEP (default 14), BACKUP_ENCRYPTION_KEY or
 * BACKUP_KEYRING_FILE, BACKUP_UPLOAD_COMMAND (e.g. `aws s3 cp {file} s3://bucket/medos/`), PG_BIN (directory of the PostgreSQL client programs).
 * BACKUP_ALERT_COMMAND runs (text in the BACKUP_ALERT_MESSAGE variable) when a backup or drill fails or `status` is unhealthy.
 * Exit codes: 0 ok; 1 failed or unhealthy; 2 bad usage or configuration; 3 backup written but the off-host copy failed.
 */
function arg(name: string, args: string[]): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const flag = (name: string, args: string[]): boolean => args.includes(`--${name}`);

/**
 * Raises an alert through BACKUP_ALERT_COMMAND (e.g. a mail or chat webhook script). The text arrives in the BACKUP_ALERT_MESSAGE
 * environment variable, never inside the command line, so it cannot inject shell syntax. An alert that cannot be sent is reported, not hidden.
 */
async function alert(msg: string): Promise<void> {
  const cmd = process.env["BACKUP_ALERT_COMMAND"];
  if (!cmd) return;
  const r = await run(cmd, [], { ...process.env, BACKUP_ALERT_MESSAGE: `MedOS backup: ${msg}`.slice(0, 1000) }, { shell: true });
  if (r.code !== 0) process.stderr.write(`The alert command failed (exit ${r.code})\n`);
}
const fail = async (code: number, msg: string): Promise<never> => { process.stderr.write(`${msg}\n`); if (code === 1 || code === 3) await alert(msg); process.exit(code); };

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const outDir = resolve(arg("out", args) ?? process.env["BACKUP_DIR"] ?? "./.local/backups");
  const pgBin = process.env["PG_BIN"];

  if (cmd === "keygen") {
    const key = randomBytes(32);
    process.stderr.write("Store this key in your secrets manager AND keep a second copy somewhere other than the backups: without it every encrypted backup is unreadable.\n");
    process.stdout.write(`BACKUP_ENCRYPTION_KEY=${key.toString("base64")}\n`);
    process.stderr.write(`Key fingerprint (not secret, shown in each backup's manifest): ${keyIdOf(key)}\n`);
    return;
  }

  if (cmd === "pitr-rehearsal") {
    const r = await pitrRehearsal({ pgBin, ...(arg("port", args) ? { port: Number(arg("port", args)) } : {}) });
    for (const s of r.steps) process.stdout.write(`${s.ok ? "PASS" : "FAIL"}  ${s.name}  ${s.detail}\n`);
    process.stdout.write(`\n${r.ok ? "POINT-IN-TIME RECOVERY REHEARSAL PASSED" : "POINT-IN-TIME RECOVERY REHEARSAL FAILED"} (${r.seconds}s)\n`);
    process.exit(r.ok ? 0 : 1);
  }

  const databaseUrl = process.env["DATABASE_URL"];
  if (!cmd || !["backup", "restore", "drill", "status"].includes(cmd)) return fail(2, "Usage: db-backup <backup|restore|drill|status|keygen> (see the header of apps/api/src/cli/db-backup.ts)");
  if (!databaseUrl) return fail(2, "DATABASE_URL is not set (use the OWNER login)");
  const keys = loadKeys();

  if (cmd === "backup") {
    try {
      const m = await createBackup({
        databaseUrl, outDir, keep: Number(arg("keep", args) ?? process.env["BACKUP_KEEP"] ?? 14), keys, allowUnencrypted: flag("allow-unencrypted", args),
        uploadCommand: process.env["BACKUP_UPLOAD_COMMAND"], pgBin,
      });
      process.stdout.write(`Backup written: ${resolve(outDir, m.file)} (${(m.sizeBytes / 1048576).toFixed(2)} MB, ${m.encrypted ? `encrypted, key ${m.keyId}` : "NOT encrypted"}, sha256 ${m.sha256.slice(0, 12)}...)\n`);
    } catch (e) {
      if (e instanceof BackupUploadError) return fail(3, `${e.message}. The local backup is valid: ${e.manifest.file}`);
      return fail(1, `Backup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (cmd === "restore") {
    const file = arg("file", args);
    const database = arg("database", args);
    if (!file || !database) return fail(2, "Usage: db-backup restore --file BACKUP --database NEWNAME");
    try {
      const r = await restoreBackup({ file: resolve(file), database, databaseUrl, keys, pgBin });
      process.stdout.write(`Restored into database '${r.database}' in ${r.seconds}s. Privileges were re-applied.\n`);
    } catch (e) {
      return fail(1, `Restore failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (cmd === "drill") {
    try {
      const r = await runDrill({ databaseUrl, outDir, keys, pgBin, file: arg("file", args) ? resolve(arg("file", args)!) : undefined, keepScratch: flag("keep-scratch", args) });
      for (const c of r.checks) process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}\n`);
      process.stdout.write(`\n${r.ok ? "RESTORE DRILL PASSED" : "RESTORE DRILL FAILED"} (backup ${r.backup}, ${r.seconds}s)\n`);
      if (!r.ok) await alert(`restore drill FAILED for ${r.backup}: ${r.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
      process.exit(r.ok ? 0 : 1);
    } catch (e) {
      return fail(1, `Drill failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (cmd === "status") {
    const s = backupStatus({
      outDir, database: parseDatabaseUrl(databaseUrl).database,
      maxBackupAgeHours: Number(arg("max-backup-age-hours", args) ?? 26), maxDrillAgeDays: Number(arg("max-drill-age-days", args) ?? 8),
    });
    process.stdout.write(`${s.ok ? "OK" : "UNHEALTHY"}\n`);
    if (s.lastBackup) process.stdout.write(`last backup: ${s.lastBackup.at} ${s.lastBackup.file} (${s.lastBackup.encrypted ? "encrypted" : "not encrypted"}, off-host: ${s.lastBackup.uploaded === null ? "not configured" : s.lastBackup.uploaded ? "yes" : "FAILED"})\n`);
    if (s.lastDrill) process.stdout.write(`last restore drill: ${s.lastDrill.at} ${s.lastDrill.ok ? "passed" : "FAILED"} in ${s.lastDrill.seconds}s\n`);
    for (const p of s.problems) process.stdout.write(`PROBLEM: ${p}\n`);
    if (!s.ok) await alert(`backups unhealthy: ${s.problems.join("; ")}`);
    process.exit(s.ok ? 0 : 1);
  }
}

main().catch((e: unknown) => fail(1, `db-backup failed: ${e instanceof Error ? e.message : String(e)}`));
