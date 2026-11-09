# MedOS

Multi-tenant Hospital Management System for small and medium hospitals in India. Current target: **MLP-1**.

**Status: release candidate for review — see [`docs/certification.md`](docs/certification.md) for exactly what was verified and what was not.** Not approved for production use with real patient data until the open items in that report are closed and a clinical, legal and security review has been done.

## Read first
- [`CLAUDE.md`](CLAUDE.md) — mandatory project policy
- [`docs/product/mlp1.md`](docs/product/mlp1.md) — MLP-1 specification, acceptance criteria, spec gaps
- [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md) — architecture
- [`docs/modules.md`](docs/modules.md) — every module: purpose, permissions, audit events, state rules
- [`docs/adr/`](docs/adr) — architecture decisions (001–009)
- [`docs/certification.md`](docs/certification.md) — E2E certification, test evidence, known limitations
- [`docs/deployment.md`](docs/deployment.md) — Docker, migrations, seed, backup/restore
- [`docs/backlog.md`](docs/backlog.md) — deferred work
- [`docs/dependencies/licenses.md`](docs/dependencies/licenses.md) — licensing policy and audit

## Layout
```
apps/api        NestJS API (/api/v1), Prisma, 400+ integration tests against a real PostgreSQL
apps/web        Next.js UI (BFF: tokens stay in httpOnly cookies), Playwright browser tests
packages/shared permissions, error codes, money helpers
packages/database  Prisma schema + SQL migrations (triggers, constraints)
scripts         db-up, backup/restore, e2e-prepare, license audit
docker          api and web images; docker-compose.yml at the root
```

## Run it locally (Windows dev setup used so far; Docker instructions in docs/deployment.md)
```powershell
pnpm install
.\scripts\db-up.ps1                      # local PostgreSQL on 127.0.0.1:54329 (medos_dev, medos_test)
$env:DATABASE_URL='postgresql://medos@127.0.0.1:54329/medos_dev'
pnpm db:migrate
$env:SEED_PASSWORD='<choose one>'; pnpm db:seed     # demo hospital "demo-hospital": 1,000 synthetic patients etc.
pnpm --filter @medos/api build
.\scripts\dev-api.ps1                    # API on :4000
pnpm --filter @medos/web dev             # UI on :3000  (sign in: hospital code demo-hospital, user reception1 / doctor1 / nurse1 / cashier1 / pharmacist1 / manager1 / admin)
```

## Checks
```powershell
pnpm lint; pnpm typecheck; pnpm test; pnpm build; pnpm licenses:audit
pnpm --filter @medos/web e2e             # browser tests (needs Chromium: pnpm exec playwright install chromium)
.\scripts\restore-test.ps1               # backup → restore → verify drill
```

## Stage history
Stages 0–43 of the build plan are recorded in `docs/backlog.md` and `docs/certification.md`.
