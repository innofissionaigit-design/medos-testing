# REMINDER — deliberately deferred work

Things we agreed to postpone. Nothing here blocks local development and testing. Revisit before any hospital pilot or deployment.
Last reviewed 2026-10-29. "Done" means built and tested in the development environment; what still needs a person, a service or an account is marked **yours**.

## Deployment
- **Docker images and `docker-compose.yml`**: reviewed and fixed (the non-root user could not run `pnpm` for the migration job; the API port was open to the network; uploads had no writable volume), extended (readiness checks, start-up ordering, log rotation, files volume, an optional HTTPS proxy profile, a secrets overlay) and now **built and started by CI** (`docker` and `docker-proxy` jobs in `ci.yml`). **Still never built or run by a person: there is no working Docker engine on the dev machine (WSL2 is not installed).** The first green CI run is the first real evidence; expect small fixes. See `docs/deployment.md`.
- **GitHub Actions** (`ci.yml`, new `release.yml`): written and checked to be valid YAML, but **have never run**. CI now also fails on any high-severity production advisory.
- **HTTPS / reverse proxy**: a Caddy profile is written (automatic certificate, HTTP→HTTPS redirect, HSTS, replaces `X-Forwarded-For` with the real client address). **Yours:** a domain, DNS pointing at the host, ports 80 and 443 open. Untested until CI or a first deployment.
- **Secrets**: the API reads `DATABASE_URL`, `JWT_ACCESS_SECRET` and the S3 keys from files (`*_FILE`), and `docker-compose.secrets.yml` wires Docker secrets. **Yours:** the secrets manager itself (or protected `secrets/` files), and generating and rotating the secrets.
- **Log shipping**: logs are JSON on stdout and rotated locally. **Yours:** the destination (Loki, CloudWatch, …) and the collector; nothing is shipped yet.
- **Health-check wiring**: done (containers check the ready endpoint; dependants wait for healthy).
- **Environment separation** (CLAUDE.md §50): `deploy/staging.env.example` and `deploy/production.env.example`, and `APP_ENV` start-up checks that refuse development secrets, a `*_dev`/`*_test` database, localhost or `http://` origins and a disabled rate limit (tested). **Yours:** actually creating separate staging and production hosts, databases, buckets and domains.
- **Approved production releases** (CLAUDE.md §52): `release.yml` builds the images and moves the `:staging` and `:production` tags through GitHub environments. **Yours, and not optional:** create the `staging` and `production` environments with required reviewers, and protect `main` (steps in `docs/deployment.md`). Until you do, nothing enforces the approval.

## Security and platform hardening
- **PostgreSQL row-level security**: built and verified in development (`docs/rls.md`, ADR-010). **Staging and production are not switched on**; the procedure and its evidence step are in `docs/deployment.md`.
- **Shared rate limiter**: done, shared through PostgreSQL (no Redis needed). The web app's refresh single-flight cache is still per web instance: use sticky sessions or a shared cache when scaling the web tier.
- **NestJS 11**: done, together with Express 5, Next.js 15.5.28 (it fixed a critical remote-code-execution advisory) and zod 4. `pnpm audit` reports no known vulnerabilities, down from 7.
- **Argon2id**: done ([ADR-011](docs/adr/011-argon2id.md)). Existing accounts keep working and are upgraded the next time each person signs in.
- **S3-compatible file storage**: the driver is done (`docs/storage.md`) and tested against a fake S3 server and through the API, **not against a real bucket**. **Yours:** the bucket and its access policy, one real upload and download check, and moving any files already on disk.
- **PDF fonts**: done. English, Bengali and Hindi print from embedded Noto Sans fonts (`apps/api/assets/fonts/`, with licence texts and checksums). They are under the SIL Open Font License, which is not on the project's allow-list: added with the project owner's approval; **counsel should confirm the licence**.
- **Translation coverage:** Bengali and Hindi cover menus, headings, buttons, labels, table headings, tabs, statuses and select options (about 600 strings). Sentences built from data (e.g. "Currently 5 Oct with Dr X"), server error messages and print documents are still English. Have a native speaker review the wording before a pilot.
- **Virus scanning of uploads**: built for a ClamAV daemon (`CLAMAV_HOST`), tested against a stand-in for clamd, not a real ClamAV. **Yours:** run clamd with its signature updates, and set `CLAMAV_HOST`.

## Backups and recovery
Tooling now exists (`db-backup`, runbook, schedule templates: `docs/backup.md`, `docs/backup-runbook.md`, `ops/schedule/`; results in `docs/backup-validation.md`). Still yours:
- **Point-in-time recovery** on the real database (WAL archiving or the managed provider's PITR), enabled and rehearsed.
- **Encryption at rest** of the database volume, and an off-host backup destination.
- **Installing the schedules** and the alert command, and reading the first restore-drill result.

## External reviews (not engineering decisions)
Briefs for every reviewer are ready in `docs/reviews/` (what exists, known gaps, questions, expected output). **No review has been done**: each still needs an independent qualified person, and none of their sign-offs exists.
- **Clinical-safety review** (allergy matching, dose/frequency rules, amendment workflow) — `docs/reviews/clinical-safety.md`.
- **GST / tax review** (per-line tax, MRP-inclusive medicine pricing, rounding) — spec gap G6 — `docs/reviews/gst-tax.md`. Engineering added HSN/SAC capture on invoice lines; CGST/SGST split, round-off and e-invoicing are not built; every provisional rule is in `docs/reviews/pending-decisions.md`.
- **Data-protection / legal review** (India DPDP Act 2023, record retention, consent, patient documents) — spec gap G14 — `docs/reviews/data-protection.md`. Engineering added consent records, reminder opt-out/opt-in and a data-request log with screens (`docs/privacy.md`); retention, erasure tooling, notice management and breach tooling are not built; no compliance is claimed.
- **Penetration test** (`docs/reviews/penetration-test.md`) and an **accessibility audit** (`docs/reviews/accessibility.md`; automated self-check partly run).
- **Load test:** a multi-user, multi-hospital test now exists (`pnpm --filter @medos/api load`, results in `docs/load-test.md`): integrity held, but it was one machine and two of three runs missed the 1.5 s budget on check-in. A staging-scale run with several API instances is still needed.

## Product ideas parked in `docs/backlog.md`
Advance payments/deposits, patient merge tool, bulk import, CSV import, MLP-2+ items.
