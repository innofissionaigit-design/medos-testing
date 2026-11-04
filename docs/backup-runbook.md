# Backup runbook: staging and production

**Status: instructions only. None of these steps has been run against staging or production.** Do them in staging first, keep the evidence (command output) of every verification, then repeat in production with the owner's written approval. Nothing here needs production credentials until you run it yourself.

Values in `<angle brackets>` are yours to choose. Replace `ap-south-1` with your region. Commands are examples for AWS; the same ideas apply to other providers.

## 0. Prerequisites

- A backup host (a small Linux VM, not the web or database host) with: Node 22, the repository built (`pnpm build`), PostgreSQL client tools of the **same major version** as the server (`pg_dump --version`), and network access to the database and the bucket.
- The **owner** database login (never `medos_app`). Create a dedicated owner-level login for backups if you prefer, and keep its password only in the backup host's secrets file.
- A secrets file `/etc/medos/backup.env`, mode `600`, owned by the `medos` service user, holding `DATABASE_URL`, `BACKUP_ENCRYPTION_KEY`, `BACKUP_DIR`, `PG_BIN`, `BACKUP_UPLOAD_COMMAND`, `BACKUP_ALERT_COMMAND`.
- The encryption key escrowed **outside** the bucket and the backup host (password manager vault with two named holders). Losing it makes every backup unreadable.
- A change ticket and a rollback owner for each environment.

## 1. Bucket (off-host storage)

Use a separate cloud account or at least a separate bucket policy from the application's. Staging and production get **different** buckets and keys.

```bash
B=medos-prod-backups-<unique>
aws s3api create-bucket --bucket $B --region ap-south-1 --create-bucket-configuration LocationConstraint=ap-south-1 --object-lock-enabled-for-bucket
aws s3api put-public-access-block --bucket $B --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket $B --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket $B --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"<kms-key-arn>"}}]}'
aws s3api put-object-lock-configuration --bucket $B --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":35}}}'
aws s3api put-bucket-lifecycle-configuration --bucket $B --lifecycle-configuration '{"Rules":[{"ID":"expire","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":90},"NoncurrentVersionExpiration":{"NoncurrentDays":90}}]}'
```

Least-privilege writer for the backup host (no delete, no overwrite of history): allow `s3:PutObject`, `s3:ListBucket`, `s3:GetBucketLocation` on the bucket only. Restores use a different identity that can `s3:GetObject`.

Hook (in `/etc/medos/backup.env`):

```
BACKUP_UPLOAD_COMMAND=aws s3 cp {file} s3://<bucket>/medos/ --only-show-errors
```

The backup files are already encrypted by MedOS (AES-256-GCM) before upload; the bucket's own encryption is a second layer.

**Verify:** (a) `aws s3api get-public-access-block --bucket $B` shows all four true; (b) `aws s3api get-bucket-versioning --bucket $B` shows `Enabled`; (c) run one backup (`node dist/cli/db-backup.js backup`), exit code `0`, then `aws s3 ls s3://$B/medos/` lists the `.dump.enc`; (d) with the writer identity, `aws s3 rm s3://$B/medos/<file>` is **denied**; (e) download the object with the restore identity and `node dist/cli/db-backup.js restore --file <it> --database medos_check` succeeds; (f) a failed upload (temporarily wrong bucket name) gives exit code `3` and fires `BACKUP_ALERT_COMMAND`.

## 2. WAL archiving (point-in-time recovery)

### 2a. Managed database (RDS / Cloud SQL / Azure): preferred

Turn on the provider's automated backups with point-in-time restore and set retention (35 days is the usual maximum on RDS). Nothing to install.

**Verify:** the console shows "latest restorable time" within minutes of now; perform a **restore to a point in time into a new instance** (never over the live one), connect with the owner login, run `packages/database/ops/rls-grants.sql` only if the provider restore did not keep grants (a snapshot restore keeps them), then `node dist/cli/rls-evidence.js`. Record the time taken: that is your recovery time.

### 2b. Self-managed PostgreSQL

Use pgBackRest (archives WAL and takes base backups to the bucket, encrypted). Install it on the database host and on any restore host.

`/etc/pgbackrest/pgbackrest.conf`:

```
[global]
repo1-type=s3
repo1-s3-bucket=<wal-bucket>
repo1-s3-endpoint=s3.ap-south-1.amazonaws.com
repo1-s3-region=ap-south-1
repo1-path=/pgbackrest
repo1-retention-full=4
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<long random passphrase, escrowed like the backup key>
process-max=2
[medos]
pg1-path=/var/lib/postgresql/17/main
```

`postgresql.conf` (restart required):

```
wal_level = replica
archive_mode = on
archive_command = 'pgbackrest --stanza=medos archive-push %p'
archive_timeout = 60
```

Then, as the `postgres` user: `pgbackrest --stanza=medos stanza-create`, `pgbackrest --stanza=medos check`, `pgbackrest --stanza=medos backup --type=full`. Schedule a weekly full and daily differential (`--type=diff`).

**Verify:** (a) `SELECT archived_count, failed_count, last_failed_time FROM pg_stat_archiver;` shows `failed_count` not increasing; (b) `SELECT pg_switch_wal();` then `pgbackrest --stanza=medos info` shows the new WAL range; (c) `pgbackrest --stanza=medos check` exits 0; (d) **rehearse a recovery on a separate server**: `pgbackrest --stanza=medos --delta --type=time --target="<UTC time just before a test change>" --target-action=promote restore`, start it, confirm the data is as of that time and `SELECT pg_is_in_recovery()` is `f`.

Alert on archive failure: a monitor that fails when `pg_stat_archiver.failed_count` increases or `last_archived_time` is older than 10 minutes. (Not yet built into `status`; see the backlog.)

**Rollback:** set `archive_mode = off` and restart; the database is unaffected, you lose only PITR.

## 3. Volume encryption

### 3a. Managed database

Encryption is chosen at creation. `aws rds describe-db-instances --db-instance-identifier <id> --query 'DBInstances[0].StorageEncrypted'` must print `true`. If it is `false`: take a snapshot, `aws rds copy-db-snapshot --kms-key-id <key> ...` (the copy is encrypted), restore the copy as a new instance, switch the application over in a planned window, keep the old instance until verified.

### 3b. Self-managed on cloud VMs

New volume: `aws ec2 create-volume --encrypted --kms-key-id <key> ...`. Existing unencrypted volume: snapshot it, `aws ec2 copy-snapshot --encrypted --kms-key-id <key> ...`, create a volume from the copy, stop PostgreSQL, swap the volumes in a maintenance window.

**Verify:** `aws ec2 describe-volumes --volume-ids <id> --query 'Volumes[0].Encrypted'` prints `true`.

### 3c. Self-managed on your own hardware (LUKS)

```bash
cryptsetup luksFormat /dev/<disk>
cryptsetup open /dev/<disk> pgdata
mkfs.ext4 /dev/mapper/pgdata && mount /dev/mapper/pgdata /var/lib/postgresql
```

Escrow the LUKS header and passphrase. **Verify:** `lsblk -f` shows `crypto_LUKS` for the disk and `cryptsetup status pgdata` reports `cipher: aes-xts-plain64`.

Also encrypt the **backup host's** disk (it holds recent backups before upload) and the disk that holds `BACKUP_DIR`.

## 4. Install the schedules (Linux)

```bash
sudo install -d -o medos -g medos /var/log/medos /etc/medos
sudo cp ops/schedule/medos-backup@.service ops/schedule/medos-backup-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now medos-backup-backup.timer medos-backup-drill.timer medos-backup-status.timer
systemctl list-timers 'medos-backup-*'
```

(Or use `ops/schedule/medos-backup.cron` instead of the timers, not both.) Validation commands are in [backup-validation.md](backup-validation.md).

## 5. Acceptance checklist (keep the output as evidence)

| # | Check | Evidence |
|---|---|---|
| 1 | Backup runs on the schedule | `journalctl -u medos-backup@backup` shows `backup_completed` last night |
| 2 | Backup file is off-host and encrypted | bucket listing, and the file starts with `MEDOSBK1` |
| 3 | Writer identity cannot delete | denied delete output |
| 4 | Restore drill passes weekly | `RESTORE DRILL PASSED`, 4 checks |
| 5 | `status` is healthy and alerts reach a person | `OK`; one deliberate failure produced a message |
| 6 | PITR recovery rehearsal on a separate server | recovered data as of the chosen time |
| 7 | Archive failures monitored | `pg_stat_archiver` alert tested |
| 8 | Volume encryption | `Encrypted=true` / `StorageEncrypted=true` / `crypto_LUKS` |
| 9 | Key escrow tested | a second person decrypted a backup using only the escrowed key |
| 10 | Recovery time recorded | minutes from "start restore" to "app reads data" |

## 6. Approvals

Production changes (archiving restart, volume swap, bucket creation, schedule install) each need your explicit go-ahead, a maintenance window where a restart or swap is involved, and the rollback owner named. Do not reuse staging credentials in production.
