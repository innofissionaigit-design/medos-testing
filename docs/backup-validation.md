# Backup validation status

Last updated 2026-10-28. Three groups: **passed** (executed here, with the result), **blocked** (cannot be run here, and why), **needs your servers** (must be validated by you, with the commands to do it).

## 1. Passed (executed on the development machine, Windows, PostgreSQL 17)

| Test | Result |
|---|---|
| Encryption format: round-trip at every chunk boundary, tamper, truncation, extension, reordering, wrong key, key rotation (`backup.unit.spec.ts`, 10 tests) | passed |
| Backup, restore, restore drill against a real database (`backup.integration.spec.ts`, 6 tests): encrypted artifact, refuses unencrypted, refuses the restricted login, refuses existing database, tampered backup leaves nothing behind, drill passes and cleans up, damaged backup never passes | passed |
| Point-in-time recovery rehearsal on a scratch cluster (`pitr.spec.ts`; also `db-backup pitr-rehearsal`): recovered 80 rows / 11000.00 to just before a dropped table | passed, ~53 s |
| Real encrypted backup of `medos_dev`, then drill (4 checks), then `status` | passed |
| Upload hook with a local-copy command: success exit 0; failing command exit 3, `status` unhealthy, healthy again after a good backup | passed |
| `BACKUP_ALERT_COMMAND` fires on a failed off-host copy (message in `BACKUP_ALERT_MESSAGE`) | passed |
| Windows Task Scheduler: three tasks registered; the backup and status tasks were started through the scheduler and finished with result 0 | passed (the weekly drill task was registered but not yet run by the scheduler) |
| Full API suite including all of the above | 491 / 491 passed |

## 2. Blocked (cannot be run here)

| Item | Why blocked | What unblocks it |
|---|---|---|
| `scripts/backup.ps1`, `scripts/restore.ps1`, `scripts/restore-test.ps1` | PowerShell script execution is disabled on this machine; the policy is intentionally unchanged and not bypassed. (The same steps are covered by `db-backup`, which was run.) | Run `restore-test.ps1` once on a machine whose policy allows scripts |
| Local S3 test with MinIO | The official MinIO downloads (`dl.min.io`) now return **410 Gone**: the open-source MinIO server and client are archived and unmaintained. Mirrors are not an official source, so nothing was downloaded. | Choose another S3-compatible test target (see the note in the hand-off message), or test against your staging bucket |
| A real S3 upload | No S3-compatible server or client is available locally | As above |

## 3. Needs validation on your servers (not run anywhere)

These were written but never executed; the Linux behaviour is **untested**.

### 3a. Linux archive and restore commands used by the PITR rehearsal

The rehearsal builds `archive_command` / `restore_command` strings for Linux (`test ! -f ... && cp ...`). A unit test checks only the text. Run the real rehearsal on a Linux host:

```bash
export PG_BIN=/usr/lib/postgresql/17/bin     # adjust to your install
cd /opt/medos/apps/api
node dist/cli/db-backup.js pitr-rehearsal
echo "exit: $?"                              # expect: POINT-IN-TIME RECOVERY REHEARSAL PASSED, exit 0
```

(Run it as a non-root user such as `postgres`; `initdb` refuses to run as root.)

### 3b. cron

```bash
crontab -T ops/schedule/medos-backup.cron 2>/dev/null || echo "crontab -T not supported; install and check below"
crontab ops/schedule/medos-backup.cron && crontab -l
# run each job once by hand with the same environment the cron line uses
set -a; . /etc/medos/backup.env; set +a; cd /opt/medos/apps/api
node dist/cli/db-backup.js status; echo "exit: $?"
node dist/cli/db-backup.js backup; echo "exit: $?"
node dist/cli/db-backup.js drill;  echo "exit: $?"
tail -n 20 /var/log/medos/backup.log
```

Expected: exit 0 each time; `backup_completed`, then `RESTORE DRILL PASSED`. Next morning check the log has the 02:00 entry.

### 3c. systemd

```bash
systemd-analyze verify /etc/systemd/system/medos-backup@.service /etc/systemd/system/medos-backup-*.timer
systemd-analyze calendar "*-*-* 02:00:00" "Sun *-*-* 03:30:00" "*:0/30"      # shows the next run times
sudo systemctl start medos-backup@status.service; systemctl status medos-backup@status.service --no-pager
journalctl -u medos-backup@status --since "10 min ago" --no-pager
sudo systemctl start medos-backup@backup.service; echo "exit: $?"
systemctl list-timers 'medos-backup-*'
```

Expected: no verify warnings, the three next-run times as scheduled, services finish "status=0/SUCCESS", timers listed.

### 3d. Off-host bucket, WAL archiving, volume encryption, key escrow

Follow [backup-runbook.md](backup-runbook.md) sections 1 to 3 in **staging first**; its verification steps and the section 5 checklist are the pass criteria. Nothing there has been run.

### 3e. Alert delivery to a person

Run `BACKUP_ALERT_COMMAND` with a real mail or chat script, then deliberately make one backup fail (wrong `BACKUP_UPLOAD_COMMAND`) and confirm a human receives the message.

### 3f. Recovery time

Time a full restore on a database the size of staging or production data. The development database restores in about 6 seconds; that figure says nothing about production.
