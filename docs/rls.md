# PostgreSQL row-level security (RLS)

Defence in depth for tenant isolation (spec gap G5). Today isolation relies on tenant-scoped queries, composite foreign keys, same-tenant
triggers and the id-sweep test. RLS adds a second, database-enforced layer: a connection acting for one hospital cannot read or write
another hospital's rows even if a query forgets its tenant filter.

**Status: all four phases done for development; staging and production are not switched yet.** The API can run on the restricted `medos_app` login with `DB_TENANT_CONTEXT=on` (verified below);
the code default is still `off` and the owner login until each environment is switched (see "Switching an environment").

| Phase | What | State |
|---|---|---|
| 1 | Restricted role `medos_app`, least-privilege grants, a tenant policy on every tenant table, rollback script, RLS tests | **done** |
| 2 | Tenant context set per request and per transaction (fail closed); explicit paths for login, token refresh, reminder worker, seed and provisioning | **done** |
| 3 | Switch the API to the `medos_app` login; startup check; isolation and escalation checks over a real login; performance; evidence tool | **done for development** (staging and production: runbook below, not done) |
| 4 | ADR ([ADR-010](adr/010-row-level-security.md)), deployment runbook and rollback ([`deployment.md`](deployment.md)), restore procedure, CI, certification and backlog | **done** |

## Roles

| Role | Used by | Rights |
|---|---|---|
| owner (`medos` locally; the migration user elsewhere) | `prisma migrate`, seed and provisioning tools, operators | owns the tables; not subject to policies. **Its URL must never be in the API's environment** once phase 3 is done |
| `medos_app` | the API | data changes only: SELECT/INSERT/UPDATE/DELETE. No DDL, TRUNCATE, REFERENCES or TRIGGER; nothing on `_prisma_migrations`; the audit trail is append-only; not superuser, not BYPASSRLS, owns nothing, member of no role |

`medos_app` is created **without login**. Enabling it is an operations step so no password is ever in git:

```sql
ALTER ROLE medos_app LOGIN PASSWORD '<generated secret>';   -- run as the owner, once per environment
```

## Policies

- Every table with a `tenantId` column (61 today, after the privacy tables were added in migration 20261029100000) has policy `tenant_isolation`:
  `USING ("tenantId" = (SELECT medos_current_tenant()))` and the same `WITH CHECK`.
- `"Tenant"` has `tenant_self` (a hospital sees only its own record).
- `"RateLimitBucket"` is the only exemption: it holds hashed tokens and addresses, not tenant data.
- **Tenant context** is the transaction-local setting `app.tenant_id`, read by `medos_current_tenant()`. Unset or empty means no tenant:
  no rows are visible and no row can be written. A malformed value raises an error. Both fail closed.
- `ENABLE` without `FORCE`: the owner keeps seeing every tenant, so data migrations never silently touch zero rows. Safety rests on
  `medos_app` never owning a table; a test checks that.

### Adding a tenant table

Every migration that creates a table with a `tenantId` must end with `SELECT medos_enable_tenant_rls('"NewTable"');`. A test
(`apps/api/src/common/rls.spec.ts`) fails if any tenant table is left without the policy.

## Findings of the phase 1 audit (dev database, 2026-10-28)

- 61 of 63 tables now carry `tenantId uuid NOT NULL`; the others are `Tenant` and `RateLimitBucket`.
- 28 foreign keys do not include `tenantId`. All 28 are covered by a `medos_same_scope` trigger that rejects a link to another
  tenant's row. Under RLS the trigger's parent lookup is filtered too, so a foreign parent is simply "not found".
- Unique indexes that do not include `tenantId` are all on random UUIDs, a token hash or a global counter: none can reveal another
  hospital's data. `RefreshToken.tokenHash` is looked up before the tenant is known, so token refresh needs an explicit path (phase 2).
- Known limit: code that can run arbitrary SQL in the app's session could call `set_config('app.tenant_id', ...)`. The defence is to
  keep tenant context in one place in the API (phase 2) and never build SQL from strings.

## How the tenant context works (phase 2)

`apps/api/src/common/tenant-scope.ts` and `prisma.service.ts`. With `DB_TENANT_CONTEXT=on`:

- A **scope** travels with the work (AsyncLocalStorage). It is opened per HTTP request *after* body parsing, and `AuthGuard` binds the
  tenant from the **verified token** before its first lookup. A body, query or header value is never used.
- Every query then runs on a connection whose transaction first executes `set_config('app.tenant_id', <tenant>, true)`: interactive
  transactions do it as their first statement, a single query outside a transaction is wrapped in a short one, raw SQL likewise.
  The `true` makes it transaction-local, so a pooled connection never carries a tenant into the next request (tested on one reused connection).
- A query with **no scope is refused in the application** (`TenantContextMissingError`, logged as `tenant_context_missing` with the
  caller) before it reaches the database, and the database would return nothing anyway (fail closed twice).
- Prisma queries are lazy; the scope helpers start a returned query inside the scope so it cannot start later without one.

### The explicit paths that have no tenant

| Path | How it works | What it can learn |
|---|---|---|
| Login | `medos_resolve_tenant(code)` (SECURITY DEFINER, executable only by `medos_app`), then everything runs under that hospital | a hospital's id and status |
| Token refresh, logout | `medos_resolve_refresh_token(hash)`, then under the issuing hospital; the caller must already hold the token | the issuing hospital's id |
| Reminder worker | `medos_tenants_with_due_reminders(now)` lists hospitals, then each is served under its own scope | hospital ids with reminders due |
| Health check, rate limiter | explicit `tenantScope.system(...)`: they touch no hospital data | nothing: a system scope reads no table rows |
| Seed, provisioning (CLI) | `tenantScope.owner(...)` and the **owner** `DATABASE_URL` (never the API's restricted login) | everything, by design: operator tools |
| Tests | the harness has its own owner connection; the app under test is the one that is restricted | - |

`system` and `owner` are scopes, not holes: under a restricted login a system scope reads zero rows (tested), and the owner scope only
changes anything when `DB_SESSION_ROLE` is emulating a restricted role in development or tests. A real `medos_app` login cannot become the owner.

## Configuration

| Variable | Meaning |
|---|---|
| `DB_TENANT_CONTEXT` | `off` (default until phase 3) or `on`. Must be `on` for any restricted-role `DATABASE_URL` |
| `DB_SESSION_ROLE` | development and tests only: act as this role in every transaction (`SET LOCAL ROLE`) to prove the policies are respected without a second login. Refused unless the context is on, refused in production, must be a plain role name |

Run the whole API suite with enforcement on:

```powershell
$env:DB_TENANT_CONTEXT='on'; $env:DB_SESSION_ROLE='medos_app'; node --test --test-concurrency=1 "dist-test/**/*.spec.js"
```

## Deployment order (phase 2 and later)

1. Apply migrations first (`20261028170000_rls_system_paths` adds the functions the login, refresh and worker code now call, even while the context is off).
2. Then deploy the API. Deploying the code before the migration makes login fail.
3. `DB_TENANT_CONTEXT` stays `off` until phase 3.

## Switching an environment to the restricted login (phase 3)

Do staging first, run the evidence tool, and only then production. Each step has a way back (see Rollback).

1. **Migrations**, as the owner: `prisma migrate deploy` (roles, policies, functions).
2. **Give the role a login**, as the owner, once per cluster, with a generated secret kept in your secrets store:
   `ALTER ROLE medos_app LOGIN PASSWORD '<generated secret>';` (and `GRANT CONNECT ON DATABASE <db> TO medos_app;` if your database revokes CONNECT from PUBLIC).
3. **Evidence before the switch**: `DATABASE_URL=<medos_app url> node dist/cli/rls-evidence.js <hospital-code> [<other-hospital-code>]`
   must print `ALL CHECKS PASSED`.
4. **Configure the API**: `DATABASE_URL` = the `medos_app` URL and `DB_TENANT_CONTEXT=on`. The owner URL stays with the migration job and the
   seed/provisioning tools only: **never in the API's environment**.
5. **Start the API.** It verifies its own login at startup (log event `db_role_verified`) and refuses to start if the login is a superuser,
   BYPASSRLS or an owner of tables while the context is on, if the context is off while the login is restricted, if a tenant table has no policy,
   or if the context functions are missing.
6. Smoke test (sign in, a patient search, a bill, the pharmacy queue) and watch the logs for `tenant_context_missing` and `reminder_worker_failed`.
7. Run `rls-evidence` again from the running environment and keep its output as the record.

Local PostgreSQL here uses trust authentication, so a password is not checked locally; staging and production must use real authentication.

### The evidence tool

`node dist/cli/rls-evidence.js <hospital-code> [<other-hospital-code>]` (read-only: every probe is rolled back). It reports PASS or FAIL for:
the login is restricted; every tenant table has a policy; no context shows nothing; a hospital sees only its own patients; another hospital's
context cannot see them; a write for the wrong context is refused; cannot become the owner, switch row security off, disable a policy, create or
drop tables, truncate patient data, or edit the audit trail. Exit code 0 only if everything passes.

### Performance

`apps/api/src/common/rls.bench.spec.ts` prints median and 95th-percentile latency for a representative workload in whichever mode runs. See the
results table under "Evidence (phase 3)".

## The id sweep (tenant isolation test)
`apps/api/src/common/tenant-sweep.spec.ts` is the application-level check. A user of a new hospital who holds **every** permission (and is a practitioner, with handwritten prescriptions and the fee reasons switched on) tries every route of every controller that takes an id in its path, about 255 routes, against **real ids** of other hospitals' records: one or two from each of the ~107 tables that have a `tenantId`, taken from whatever the test database holds (about 55,000 requests). Random ids prove nothing, since they are "not found" whether or not a route checks the hospital.

It asserts that no request succeeds or crashes, that every read route answers 404, and that every write route is **driven to its lookup** and answers 404. A write route has to pass input validation first, so the test learns a valid body for each route from the validation errors (with a few starting bodies for routes with configured reasons or unions). A route it cannot drive must be listed with a reason and the module test that covers it (today only the AI draft route and the two patient-app routes). A new route that cannot be driven fails the test until someone decides.

Real defects it found and that are fixed: schedule and availability of an unknown practitioner answered 400 instead of 404; `GET /admissions/:id/intake-output/totals?date=garbage` answered 500; settling a registration fee for another hospital's patient answered 409 instead of 404.

## Where things are

| What | Where |
|---|---|
| Migrations (role, privileges, policies, functions) | `packages/database/prisma/schema/migrations/20261028150000_rls_roles_and_policies`, `20261028170000_rls_system_paths` |
| Re-grant script (after a restore) | `packages/database/ops/rls-grants.sql`, kept equal to the migrations by `apps/api/src/common/rls.grants.spec.ts` |
| Rollback scripts (not Prisma migrations, never automatic) | `packages/database/rollback/` |
| Tenant scope and database layer | `apps/api/src/common/tenant-scope.ts`, `prisma.service.ts` |
| Evidence tool | `apps/api/src/cli/rls-evidence.ts` |
| Tests | `apps/api/src/common/rls.spec.ts` (policies and role), `rls.paths.spec.ts` (tenant context, exception paths), `rls.login.spec.ts` (real login), `rls.grants.spec.ts`, `rls.bench.spec.ts` |

## Backups, restores and CI

- **Restore.** Backups use `--no-owner --no-privileges`. A restored database keeps its policies and data, but loses every grant: `medos_app` could read nothing and
  the login functions would be open to everyone (confirmed in a rehearsal on the dev data). Run `packages/database/ops/rls-grants.sql` as the owner after every
  restore; `scripts/restore.ps1` does, and `scripts/restore-test.ps1` compares the restored state with the source (`scripts/sql/rls-state.sql`). After the
  re-grant the rehearsal passed all 13 `rls-evidence` checks. The two PowerShell scripts could not be run here (script execution is disabled); the commands they run were.
- **Tests on a fresh machine.** `pnpm test` first runs `apps/api/scripts/prepare-test-db.mjs`, which now also enables the `medos_app` login on a local or CI test
  database, with a generated secret in the git-ignored `.local/app-db.env` (or `APP_DB_PASSWORD`). On any other server it does nothing and prints why; enable the login
  yourself and set `TEST_APP_DATABASE_URL`.
- **CI.** After `pnpm test`, the workflow runs the API suite again with the application on the restricted login and `DB_TENANT_CONTEXT=on`. The workflow has not been
  run on a real CI server.

## Rollback

1. Point the API back at the owner `DATABASE_URL`, set `DB_TENANT_CONTEXT=off`, and restart it (skip if the environment has not been switched). This alone
   restores the previous behaviour; the migrations can stay. The startup check accepts exactly this pairing.
2. Phase 2 (only if the code is reverted to before phase 2): `psql -f packages/database/rollback/20261028170000_rls_system_paths.down.sql`, then
   `prisma migrate resolve --rolled-back 20261028170000_rls_system_paths`. Keeping the functions is harmless.
3. As the owner: `psql -f packages/database/rollback/20261028150000_rls_roles_and_policies.down.sql`
   (drops every policy, disables RLS, drops the helper functions, the role and its privileges).
4. `prisma migrate resolve --rolled-back 20261028150000_rls_roles_and_policies`

The migration is idempotent, so it can be re-applied afterwards. Both directions were run against the test database: before, 60 tables
with RLS and the role present; after rollback, none; after re-applying, 60 again.

## Evidence (phase 1)

`apps/api/src/common/rls.spec.ts` (9 tests, rolled-back transactions, two real hospitals):
role attributes and privileges; policy on every tenant table; reads (own rows only, raw SQL, no or empty context sees nothing);
malformed context is an error; insert, update, delete and move-to-another-tenant refused; cross-tenant links refused; append-only audit
trail; the role cannot disable RLS, create objects, truncate, or read `_prisma_migrations`; context never leaks through a reused
pooled connection (one connection, 9 sequential and 24 concurrent requests across tenants).

## Evidence (phase 2)

- Whole API suite, default mode: 452 of 452. Whole suite with `DB_TENANT_CONTEXT=on DB_SESSION_ROLE=medos_app`: 462 of 462
  (the 452 plus `apps/api/src/common/rls.paths.spec.ts`, 10 tests).
- Control: with a non-existent session role nothing passes; with `medos_app` the patient suite passes (27). The role switch is on every query.
- `rls.paths.spec.ts`: configuration guards; every way of querying is refused without a scope; a scope reads only its hospital (single,
  transaction, raw, by exact foreign id); the tenant-less scope reads no rows but can call the narrow functions; provisioning is refused to a hospital
  scope and to the tenant-less scope; a validly signed token naming another hospital is refused (401); 40 simultaneous requests from two hospitals
  never mix data; login (unknown, wrong password and inactive hospital answered alike; failure audited under the right hospital); refresh rotation,
  reuse detection and logout; the reminder worker under enforcement.
- Live system (default mode): sign-in, authenticated call, refresh rotation, refusal of a reused token, logout, unknown hospital refused.

## Evidence (phase 3, development environment, 2026-10-28)

**Setup.** `medos_app` has a login on the dev and test databases (generated secret in the git-ignored `.local/app-db.env`; local PostgreSQL uses trust
authentication, so the password is not checked here). The dev API runs on it with `DB_TENANT_CONTEXT=on`. At startup it logs
`db_role_verified: role=medos_app superuser=false bypassRls=false ownsTables=false restricted=true tenantContext=on emulated=false tablesWithoutPolicy=0`.

**Tests**

| Run | Result |
|---|---|
| Whole API suite, app on the **real restricted login**, context on | 470 of 470 |
| Whole API suite, owner login, context off (the rollback configuration) | 470 of 470 |
| `rls.login.spec.ts` (7 tests over a real `medos_app` session) | 7 of 7 |

`rls.login.spec.ts`: the session itself is `medos_app`; **24 escalation attempts are refused** (become the owner by `SET ROLE` or `SET SESSION AUTHORIZATION`,
`ALTER ROLE ... BYPASSRLS/SUPERUSER`, `CREATE ROLE`, create/drop/truncate tables, disable or drop a policy, create a policy, run the policy helper,
read `_prisma_migrations` and `pg_authid`, `COPY ... TO PROGRAM`, `pg_read_file`, `CREATE EXTENSION`, `ALTER SYSTEM`, create a SECURITY DEFINER function,
change or drop the context functions, edit or delete audit events), and a non-owner `GRANT` changes nothing; turning `row_security` off errors instead of bypassing;
a hospital's transaction sees only its rows, no or empty context sees nothing, a malformed context is an error, and a plain statement on another connection sees
nothing; cross-hospital insert, update, delete, move and link are refused; the narrow functions return only what they promise; one real connection reused
for 9 sequential and 30 concurrent requests across hospitals never leaks a tenant; and the API's startup check refuses an owner login with the context on,
a restricted login with the context off, and accepts the three valid pairings.

**Evidence tool**, as the restricted login against the dev data (`node dist/cli/rls-evidence.js demo-hospital`): ALL CHECKS PASSED (13 checks) -
restricted login; 60 policies and no unprotected table; no context shows nothing; the demo hospital sees its 1,023 patients and 0 belonging to others; another
context sees none of them; a wrong-context write is refused; cannot become the owner, switch row security off, disable a policy, create or drop tables,
truncate patient data, or edit the audit trail.

**Live system.** After the switch: 22 calls across 7 roles (admin, reception, doctor, nurse, cashier, pharmacist, manager) all returned 200 with the expected
data (for example 1,023 patients, 75 invoices, 14 admissions, 100 stock lines); a session signed in before the switch kept working; the web dashboard and
pharmacy queue render; no `tenant_context_missing`, no 5xx and nothing on stderr.

**Performance** (`rls.bench.spec.ts`, two runs per setting, milliseconds, median / 95th percentile):

| Operation | Owner login, context off | Real restricted login, context on |
|---|---|---|
| GET patient by id | 5.6-7.7 / 7.5-10.1 | 8.7-9.7 / 10.5-12.4 |
| GET patient search (name) | 7.6-8.5 / 8.8-10.4 | 10.3-10.5 / 12.6-15.8 |
| GET session (`/auth/me`) | 7.3-7.9 / 10.1 | 9.0 / 11.6-11.9 |
| POST register patient (transaction) | 15.1-17.5 / 19.9-21.9 | 15.8-16.8 / 22.0-22.6 |
| 60 simultaneous reads, total time | 2.75-2.84 s | 2.75-2.76 s |

A single read outside a transaction costs about 2-3 ms more (it is wrapped in a short transaction that sets the tenant); writes, which already run in a
transaction, are unchanged within noise. A modest overhead on a workload dominated by the application's own work.

## Not done, and limits

- **Staging and production were not touched.** There is no staging environment here, so the runbook above has been exercised only on the development environment
  and the test database. Run it in staging and keep the `rls-evidence` output before production.
- Local PostgreSQL uses trust authentication: the password path is untested here.
- Code that can run arbitrary SQL in the API's own session could still set `app.tenant_id` itself; the setting is only written in `prisma.service.ts`, and the code
  never builds SQL from strings, but there is no automated check for that yet.
- No load test with many hospitals or many API instances; no review by a database administrator.

**Dev rollback.** Copy `.local/api.dev.env.owner` over `.local/api.dev.env` and restart the API (owner login, context off).
