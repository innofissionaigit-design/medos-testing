# Backups and restore drills

Tool: `apps/api/src/cli/db-backup.ts` (`pnpm --filter @medos/api backup <command>` after a build). Run it with the **owner** database login, never the restricted `medos_app` login (a dump taken as `medos_app` would be partial because of row-level security; the tool refuses).

| Command | What it does |
|---|---|
| `backup` | Consistent snapshot dump, verified, encrypted (AES-256-GCM), manifest + checksum, retention, optional off-host copy |
| `restore --file F --database NEW` | Verifies checksum, decrypts, restores into a **new** database (never overwrites), re-applies privileges |
| `drill` | Restores the newest backup into a scratch database, checks it, drops it, records the result |
| `status` | Exit 0 healthy / 1 unhealthy, for monitoring |
| `keygen` | Prints a new `BACKUP_ENCRYPTION_KEY` |

## Configuration (environment only; nothing secret on command lines or in git)

- `DATABASE_URL` owner login. `BACKUP_DIR` (default `./.local/backups`). `BACKUP_KEEP` (default 14). `PG_BIN` directory of the PostgreSQL client tools (must match the server major version).
- `BACKUP_ENCRYPTION_KEY` (base64, 32 bytes) or `BACKUP_KEYRING_FILE` (`{"current":"q4","keys":{"q3":"…","q4":"…"}}`) for rotation: new backups use `current`; old ones stay restorable while their key remains in the file.
- `BACKUP_UPLOAD_COMMAND` runs after each backup with `{file}` replaced, e.g. `aws s3 cp {file} s3://bucket/medos/` (use a bucket with versioning/object lock and a separate account).
- Without a key the tool refuses to back up unless `--allow-unencrypted` is given.

**Keep the key somewhere other than where the backups live.** A backup without its key is unreadable. The key's fingerprint (not secret) is in each manifest.

## Exit codes

0 ok · 1 failed or unhealthy · 2 usage/configuration · 3 backup written but the off-host copy failed (the local backup is valid; `status` reports unhealthy).

## What is verified

Encrypted file format (`MEDOSBK1`): any changed, truncated, extended or reordered byte is rejected; the wrong or missing key is reported by fingerprint. A restore checks the sha256, restores, re-grants privileges (`packages/database/ops/rls-grants.sql`), and a drill additionally compares row counts and totals against the backup, confirms the audit trail is still append-only, and confirms the row-level-security state is identical. Tests: `backup.unit.spec.ts`, `backup.integration.spec.ts` (needs the PostgreSQL client tools; skipped locally if missing, required in CI).

## Status

`status --max-backup-age-hours 26 --max-drill-age-days 8` is unhealthy when there is no backup or drill, the newest backup is too old, the off-host copy failed, or the last drill failed or is too old. State is kept in `BACKUP_DIR/status.json`.

## Point-in-time recovery (PITR)

A nightly dump can lose up to a day. PITR keeps every change (WAL) so the database can be rebuilt to any moment, e.g. just before a wrong bulk update.

**Rehearse it any time, safely:** `db-backup pitr-rehearsal` builds a throwaway cluster in a temp folder on port 54400 (never your real database), turns on archiving, takes a base backup, writes data, "makes a mistake" (drops the table), then recovers to the moment before it and checks the rows. Test: `pitr.spec.ts`. Last result: passed (about 50 s).

**Production (self-managed server)** in `postgresql.conf`:

```
wal_level = replica
archive_mode = on
archive_timeout = 60
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'   # or your object-store uploader (wal-g, pgBackRest)
```

Use a different disk or host for `/archive`, and encrypt it the same way as backups. Take a base backup regularly (`pg_basebackup -D DIR -X stream -c fast`) and keep archived WAL from the oldest base backup you want to restore from.

**Recover** (on a new server, with the service stopped): copy a base backup into an empty data directory, create an empty `recovery.signal` file, add to `postgresql.conf`

```
restore_command = 'cp /archive/%f %p'
recovery_target_time = '2026-10-28 10:15:00+00'
recovery_target_action = 'promote'
```

start the server, wait until `SELECT pg_is_in_recovery()` is `f`, check the data, then re-apply privileges (`packages/database/ops/rls-grants.sql`) only if the cluster was rebuilt from a logical dump (a base backup keeps them).

**Managed PostgreSQL (RDS, Cloud SQL, Azure):** turn on the provider's point-in-time restore instead; the concepts and the drill checks are the same. This repository cannot verify a provider's setting; confirm it in the provider console and rehearse a restore.

Limits: PITR restores the whole cluster, not one hospital. A restore to a time loses everything after it. Archiving is not enabled on the dev database; it is only rehearsed on the scratch cluster.

## Scheduling and alerts

Templates are in `ops/schedule/`: `medos-backup.cron`, systemd (`medos-backup@.service` plus three timers: backup nightly 02:00, drill Sundays 03:30, status every 30 minutes) and `windows-task-scheduler.md`. Put the secrets in a file only the service account can read (`/etc/medos/backup.env`). Run the three jobs on the **database host or a backup host with owner access**, not on the web servers.

**Alerts:** set `BACKUP_ALERT_COMMAND` to a script that sends mail, SMS or a chat message. It runs when a backup fails, the off-host copy fails (exit 3), a drill fails, or `status` is unhealthy; the text is in the `BACKUP_ALERT_MESSAGE` environment variable (never in the command line). Also have your monitoring read the exit code of the `status` job: a job that silently stops running is caught by the "no recent backup" rule, which is why `status` runs on its own schedule.

Verified: the alert command fires on a failed off-host copy; `status` turns unhealthy and back to healthy after a good backup. Windows Task Scheduler was run for real on the development machine: three tasks (backup 02:00 daily, drill Sunday 03:30, status every 30 minutes) calling a launcher that reads the key from a git-ignored file; the backup and status tasks were started through the scheduler and finished with result 0. The cron and systemd files were written but not run (no Linux host here).

## Where things stand

Test status (passed / blocked / needs your servers): [backup-validation.md](backup-validation.md). Staging and production setup steps: [backup-runbook.md](backup-runbook.md).

## Not covered

An automated check that the PITR archive is keeping up (`pg_stat_archiver` failures), backup-size anomaly alerts, and per-hospital restore. See `docs/backlog.md`.
