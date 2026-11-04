# Deployment, backup and recovery

Status of each item is stated honestly: **verified** means it was run in the development environment; **written, not run** means the file exists but this environment could not execute it.

## Environments

| | local | staging | production |
|---|---|---|---|
| `APP_ENV` | `local` (default) | `staging` | `production` |
| PostgreSQL | project cluster on `127.0.0.1:54329` (`scripts/db-up.ps1`) or compose `db` | own instance | **managed PostgreSQL** (recommended) |
| Patient files | `STORAGE_DIR` on disk | own S3-compatible bucket | own S3-compatible bucket |
| Secrets | `.env` (git-ignored) | `secrets/` files or a secrets manager | `secrets/` files or a secrets manager |
| Domain | `localhost` | `staging.<your domain>` | `<your domain>` |
| Compose project | `medos` | `medos-staging` | `medos-production` |
| Settings file | `.env` | `deploy/staging.env` | `deploy/production.env` |
| Data | synthetic seed only | synthetic or anonymised | real; never copied downwards |

Each environment has its own database, bucket, secrets, domain and compose project (so volumes and networks are never shared). Never point staging or local at production data. Templates for the two hosted environments are [`deploy/staging.env.example`](../deploy/staging.env.example) and [`deploy/production.env.example`](../deploy/production.env.example); the real `deploy/*.env` files and the `secrets/` folder are git-ignored and never copied into an image.

**The API enforces this.** With `APP_ENV=staging` or `production` it refuses to start if `NODE_ENV` is not `production`, the JWT secret looks like a placeholder or development secret (`change-me…`, `dev-only…`, `ci-only…`, `…password…`), the database is a `*_dev`, `*_test` or `*_e2e` one or the local development cluster (port 54329), `CORS_ORIGINS` is not made of real `https://` addresses, or the rate limit is switched off. The message names the setting, never its value.

## Configuration

All configuration is environment variables (`.env.example` lists them). The API refuses to start with a missing or short `JWT_ACCESS_SECRET` (< 32 chars) or an invalid `DATABASE_URL`, and names the setting at fault (never its value). A setting left empty counts as not set, which is how Docker passes a variable that is only declared. Do not commit `.env`; do not bake secrets into images.

**Secrets from files.** `DATABASE_URL`, `JWT_ACCESS_SECRET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` can be given as `<NAME>_FILE=/path` instead: the API reads the file (one trailing newline is dropped). Giving a value both ways, or a file that is missing or empty, is an error. This is the Docker and Kubernetes secrets convention and works with any secrets manager that writes files. For Docker Compose, layer `docker-compose.secrets.yml` on the base file and put each secret in its own file under `./secrets/` (the file's header lists them); then `POSTGRES_PASSWORD`, `DATABASE_URL` and `JWT_ACCESS_SECRET` are not in `.env` at all. Use URL-safe characters for the database password (`openssl rand -hex 24`): it is placed inside `DATABASE_URL`.

`TRUST_PROXY` names the peers allowed to report the browser's address in `X-Forwarded-For`: the web server, which relays every browser (`loopback` locally, `uniquelocal` for the compose network). Login attempts are rate-limited per browser address; refresh, logout, facility switch and password change are limited per session, so many users behind one web server never share an allowance. Next.js keeps an `X-Forwarded-For` header that a browser sends itself, so the web app must never face the internet directly: the compose `proxy` profile (Caddy, below) overwrites the header with the real client address. Without a proxy that does this, a client can choose the address its login attempts count against (per-account lockout still applies).

**Password hashing** is Argon2id ([ADR-011](adr/011-argon2id.md)): `ARGON2_MEMORY_KIB` (default 19456) and `ARGON2_PASSES` (default 2) are the OWASP minimum, and production refuses anything weaker. Existing scrypt hashes keep working and are replaced with Argon2id the next time each person signs in.

**Patient files** live on disk (`STORAGE_DRIVER=local`, one API instance only) or in an S3-compatible bucket (`STORAGE_DRIVER=s3`, required once there is more than one instance); see [storage.md](storage.md).

## Database logins and row-level security

The API connects to PostgreSQL as the restricted role **`medos_app`**, and the database itself refuses to show or change another hospital's rows (design: [ADR-010](adr/010-row-level-security.md); procedures, evidence and limits: [`rls.md`](rls.md)). Two logins, never mixed:

| Login | Used by | Variables |
|---|---|---|
| owner | migrations, seed, provisioning tools, backups and restores, operators | `DATABASE_URL` of the migration job and the CLIs only |
| `medos_app` | the API | `DATABASE_URL` of the API, with `DB_TENANT_CONTEXT=on` |

**The owner's URL must never be in the API's environment.** The API checks its own login at startup and refuses to run on a superuser, BYPASSRLS or table-owner login while the context is on, on the restricted login with the context off, or if a tenant table has no policy.

**Order of operations for every release:** 1. apply migrations as the owner; 2. then deploy the API (the code calls database functions the migrations create). Deploying the code first makes sign-in fail.

**First switch of an environment (staging first, then production):**

1. `prisma migrate deploy` as the owner.
2. `ALTER ROLE medos_app LOGIN PASSWORD '<generated secret from your secrets store>';` as the owner, once per database cluster (the migration creates the role without a login so no secret is ever in git).
3. `DATABASE_URL=<medos_app URL> node dist/cli/rls-evidence.js <hospital-code> [<other-hospital-code>]` must print `ALL CHECKS PASSED`.
4. Set the API's `DATABASE_URL` to the `medos_app` URL and `DB_TENANT_CONTEXT=on`; deploy. Watch the log for `db_role_verified` (`restricted: true`) and for `tenant_context_missing` or `reminder_worker_failed`.
5. Smoke test (sign in, patient search, a bill, the pharmacy queue), run `rls-evidence` again from the running environment and keep its output as the record.

**Rollback (any time, no data change):** point the API's `DATABASE_URL` back at the owner login and set `DB_TENANT_CONTEXT=off`, then restart. The migrations can stay. Removing the migrations themselves is a separate, rarely needed step: `packages/database/rollback/` (instructions in `rls.md`).

**Staging and production have not been switched.** Everything above was exercised only on the development environment and a restore rehearsal there; run it in staging, with real password authentication, before production.

## Docker and the compose stack (checked by CI; never run on the development machine)

**Status, stated plainly.** The development machine has no working Docker engine (WSL2 is not installed), so none of this has been built or started by a person. What *has* been checked here: the compose files parse (`docker compose config`), the YAML of both workflows is valid, and the application code the containers run (startup checks, `*_FILE` secrets, health endpoints) is covered by the test suite. The **`docker` and `docker-proxy` jobs in `.github/workflows/ci.yml`** build both images, start the stack, wait for every health check, create a hospital with the provisioning tool, sign in through the web app, check that the API and database are not reachable from outside, and check the HTTPS proxy; they run on every change, so **the first green run of those jobs is the first real evidence**. Treat the Docker files as unproven until you have seen it.

```bash
cp .env.example .env                                    # then set real secrets
docker compose up -d --build --wait                     # local: http://localhost:3000
docker compose --profile proxy up -d --build --wait     # public: HTTPS on SITE_ADDRESS through Caddy
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d --build --wait   # secrets from ./secrets/ files
```

| Service | What it is |
|---|---|
| `db` | PostgreSQL 17 (drop it in production and use managed PostgreSQL), on `127.0.0.1:5432` only |
| `migrate` | one-shot `prisma migrate deploy` from the API image; the API waits for it to finish |
| `api` | NestJS API; ready check `GET /api/v1/health/ready`; on `127.0.0.1:4000` only; patient files in the `medos-files` volume unless `STORAGE_DRIVER=s3` |
| `web` | Next.js app (server side calls the API over the compose network; browsers never reach the API); on `127.0.0.1:3000` unless `WEB_BIND=0.0.0.0` |
| `proxy` (profile `proxy`) | Caddy: HTTPS with an automatic certificate for `SITE_ADDRESS`, HTTP→HTTPS redirect, HSTS, replaces `X-Forwarded-For` with the real client address, 8 MB request limit |

Containers run as the non-root `node` user with all Linux capabilities dropped and `no-new-privileges`; services start only when what they depend on is healthy; logs are rotated (10 MB × 5). For public use point DNS at the host, set `SITE_ADDRESS` and `CORS_ORIGINS`, open ports 80 and 443, and use the `proxy` profile; do not publish `web` or `api` directly. The runtime image is the full build image (simple and correct, but larger than a pruned image); pruning with `pnpm deploy` is a later optimisation.

### Releases and approvals

Nothing deploys on a merge (CLAUDE.md §52). `.github/workflows/release.yml` is started by hand (Actions → release): it builds both images from a commit, pushes them to GitHub's container registry as `…/api:sha-<commit>` and `…/web:sha-<commit>`, then moves the `:staging` tag, and only after approval moves the `:production` tag. The rollout is whatever pulls those tags (`docker compose pull && docker compose up -d` on the host, or your platform's equivalent). This workflow has never run.

**The approval is a GitHub setting that only you can switch on.** Until you do, nothing stops the workflow promoting to production. In the repository: *Settings → Environments*, create **`staging`** (optionally with reviewers) and **`production`** with *Required reviewers* set to the people allowed to approve a production release and *Deployment branches* limited to `main`; and *Settings → Branches* protect `main` (require pull requests and the `ci` checks to pass).

### Logs

Every service writes structured JSON to stdout, and compose rotates it locally. **Shipping logs somewhere is your choice and is not set up**: point your platform's collector (Loki/Promtail, Fluent Bit, Vector, CloudWatch, …) at the containers' stdout. Keep the `requestId` field: it ties a user's error message to one log line.

## Migrations

`pnpm db:migrate` runs `prisma migrate deploy` (non-interactive, safe in CI). Never edit a migration that has been deployed; add a new one. Several migrations contain hand-written SQL (triggers, constraints) that Prisma does not model.

## Seed data (verified)

```powershell
$env:SEED_PASSWORD = '<choose a password>'   # omit to generate one (printed once)
pnpm db:seed
```

Creates one tenant (`demo-hospital`) through the real API: 8 departments, 10 doctors, 12 nurses, 6 other staff, 1,000 patients, 100 booked appointments plus 30 current OPD visits, 20 beds in 2 wards, 12 admissions, 100 medicines with 200 batches, 50 invoices (some paid, some outstanding). Takes ~35 s. Re-running does nothing if the tenant exists. It refuses to run when `NODE_ENV=production`.

## Backup and restore (verified)

```powershell
.\scripts\backup.ps1  -Database medos_dev -OutDir D:\backups      # pg_dump custom format + SHA-256 + readability check
.\scripts\restore.ps1 -File D:\backups\<file>.dump -Database medos_restored   # refuses to overwrite an existing database
.\scripts\restore-test.ps1 -Source medos_dev                       # full drill
```

`restore-test.ps1` backs up, restores into a scratch database, and compares row counts, money totals and stock units for 15 checks, then proves the append-only audit trigger still blocks edits in the restored copy. Last run: **15 checks identical, triggers intact**.

**Restores must re-apply database privileges.** Backups use `--no-owner --no-privileges`, so a restored database keeps its row-level security policies and data but loses every `GRANT`: the API's `medos_app` login could read nothing, and the login functions would be executable by everyone. `restore.ps1` therefore runs `packages/database/ops/rls-grants.sql` (idempotent, run as the owner) after `pg_restore`, and `restore-test.ps1` checks that the restored database shows the same row-level security state as its source (`scripts/sql/rls-state.sql`). Do the same after any restore done by other means (managed-provider snapshots excepted: they keep grants). A rehearsal on the development data (restore, re-grant, `rls-evidence`) passed all 13 checks; the two PowerShell scripts themselves could not be run on this machine (script execution is disabled), so run `restore-test.ps1` once where it is allowed.

**Preferred tooling: `db-backup` (see [backup.md](backup.md)).** Encrypted (AES-256-GCM) backups with manifest, checksum, retention and an off-host upload hook; restore that never overwrites and re-applies privileges; a restore drill that compares the restored copy with the backup; `status` for monitoring and `BACKUP_ALERT_COMMAND` alerts; a point-in-time-recovery rehearsal on a scratch cluster; schedule templates in `ops/schedule/`. The PowerShell scripts above remain as a Windows option.

Still your responsibility in production:

- **Enable PITR on the real database** (WAL archiving settings in backup.md, or the managed provider's point-in-time restore) and rehearse a recovery. Logical dumps alone lose everything since the last dump.
- **Encryption of the database volume**, and a key kept apart from the backups.
- **Install the schedules** and the alert command, and read the first drill result.

## Health and logging

- `GET /api/v1/health` (liveness) and `GET /api/v1/health/ready` (database reachable).
- Logs are structured JSON on stdout with `requestId`, tenant, facility and user ids, route, status and duration. Passwords, tokens and clinical content are never logged. Ship stdout to the platform's log collector (see "Logs" above).
- Container health checks use the ready endpoint, so a service whose database is unreachable is reported unhealthy and its dependants wait.

## Known limitations

- Rate limiting is shared across API instances through PostgreSQL (`RATE_LIMIT_STORE=database`, the default; table `RateLimitBucket`). If the database cannot be reached, a request is counted in memory on that instance and a `rate_limit_store_unavailable` line is logged. The web server's refresh single-flight cache is still per instance: use sticky sessions or a shared cache when scaling the web app.
- Uploaded files are scanned for viruses only when `CLAMAV_HOST` is set (ClamAV daemon over TCP, port `CLAMAV_PORT`, default 3310). With it set, an infected file is refused (`FILE_INFECTED`, audited as `PATIENT_FILE_REJECTED`) and uploads are refused (`SCAN_UNAVAILABLE`) while the scanner is unreachable. Run clamd with its own signature updates (freshclam); MedOS does not manage them. This has been tested against a stand-in for the clamd protocol, not a real ClamAV daemon.
- Row-level security is verified in development only (see "Database logins and row-level security"); staging and production still need the first-switch procedure and its evidence.
- `pnpm audit` reports no known vulnerabilities (NestJS 11, Express 5, Next.js 15.5.28 and zod 4 were upgraded for this; CI fails the build on any high-severity production advisory).
- The S3 driver and the virus scanner have been tested against stand-ins (a small fake S3 server and a fake clamd), not a real bucket or a real ClamAV daemon.
- Production deployment requires explicit approval: there is no auto-deploy, and the approval gate is a GitHub environment setting you must switch on (see "Releases and approvals").
