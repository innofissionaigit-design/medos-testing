# Testing the MedOS API

Three ways to check the API, from fastest to most thorough. None of them needs you to edit source code.

| What | Command or tool | Time | Changes data? |
|---|---|---|---|
| Postman collection (26 read-only requests) | Postman, or `node scripts/api-health/run-collection.mjs` | seconds | No |
| API health probe (sign-in, every read route, five workflows, website relay) | `node scripts/api-health/probe.mjs` | about 1 minute | Yes: a few synthetic records, see `docs/api-health-report.md` |
| Automated test suite (unit, integration, E2E) | `pnpm test` | several minutes | Only in the separate `medos_test` database |

## 1. Postman

1. Start the database and the API (`scripts\db-up.ps1`, then `scripts\dev-api.ps1`). Check <http://localhost:4000/api/v1/health> answers 200.
2. In Postman choose **Import** and add both files from `docs/postman/`:
   * `medos.postman_collection.json`
   * `medos.local.postman_environment.json`
3. Select the **MedOS local** environment (top right). Paste the demo password (`SEED_PASSWORD` in your `.env`) into the `password` value of the environment. It is a *secret* variable and is never written into the collection. Do not share an environment you have filled in.
4. Open the collection and press **Run**, keep the order, and press **Run MedOS API (local)**. Or send **Authentication → 2. Login** once and then any request by hand.
5. The login script stores the Bearer token in the collection variable `accessToken`; the collection's Authorization tab uses it for every request. The token lasts 15 minutes: run **7. Refresh token** (or Login again) when requests start returning 401.
6. The **Admin only** folder is role-aware: each request reads who is signed in and expects what that role is allowed. Reception gets `403 FORBIDDEN` on all three (green, expected); Cashier gets 200 on the two reports and 403 on OCR settings; Administrator gets 200 on all three. Change `identifier` in the environment to try each. If Login answers "choose a facility", copy a facility id into `facilityId` and run **2b**.
7. Login is limited to 10 attempts per minute from one address. If you see 429 `RATE_LIMITED`, wait a minute.

Always call the API directly on port 4000. The website's `/api/proxy/*` route is for the browser only.

### Command-line run with Newman (Postman's own engine)

Newman runs the same collection with the real Postman script sandbox, no desktop app needed. Install it somewhere outside the project (`npm install newman`), then:

```bash
newman run docs/postman/medos.postman_collection.json -e docs/postman/medos.local.postman_environment.json --env-var "password=<SEED_PASSWORD>" --folder Authentication --folder Patients --folder Appointments --folder "OPD queue" --folder Admissions --folder Billing
newman run docs/postman/medos.postman_collection.json -e docs/postman/medos.local.postman_environment.json --env-var "password=<SEED_PASSWORD>" --env-var identifier=admin --folder Authentication --folder "Admin only"
```

**Verified in the real Postman Desktop app (2026-10-30, reported by the project owner):** the updated collection was imported as "MedOS API (local) Copy 2" and run with the **MedOS local** environment. Result: 32 tests passed, 0 failed, 0 skipped, 0 errors, 4.304 seconds. Login, token refresh, logout, patient search and patient details all passed.

Checked on 2026-10-30 with Newman 6.2.1 against the local API: Reception run 22 requests and 23 assertions, 0 failed; Admin run 8 requests and 9 assertions, 0 failed. Step **2b** is skipped (not sent) unless `facilityId` is filled in, so no `400` appears. Running a single folder, such as Patients, with no Login first also works: the collection signs in by itself.

The collection's pre-request script (it runs before every request) does two things so the usual red results do not happen: it signs in again when the token is missing or within 30 seconds of expiring (needs `password` in the environment), and it picks a patient when `patientId` is empty. The Login test requires a 200; a 401 or 429 is a failure.

### Reading the result

Every request has a test. A green test means the status was 2xx and the answer had the expected shape. Expected results for a healthy system: **26 passed, 0 failed**, and 2b skipped (not needed).

* 401 `UNAUTHENTICATED`: the `password` in the environment is empty or wrong (the collection signs in again by itself when it has the password), or the wrong environment is selected.
* 403 `FORBIDDEN`: the signed-in role lacks the permission. In the **Admin only** folder a 403 is the expected, green answer for Reception (and for Cashier on OCR settings). A 403 anywhere else is a real problem.
* 404 on a patient request: the demo hospital has no patient whose name matches "DEMO", so none could be picked. Run **Patients → Search patients** with another search, or set `patientId` by hand.
* 429 `RATE_LIMITED`: login is limited to 10 tries a minute; wait a minute.

## 2. The scripts (no Postman needed)

Both read `.env` for `SEED_PASSWORD`, talk to `http://localhost:4000`, and never print passwords, tokens or patient data.

```bash
node scripts/api-health/run-collection.mjs
node scripts/api-health/probe.mjs
```

Wait a minute between runs (the login limit). Results are also written as JSON into your temp folder (set `API_HEALTH_OUT` to choose another folder).

Healthy output:

```
collection run: 26 passed, 0 failed, 1 skipped of 27 requests
auth: 9/9 pass
GET routes: 123 {"SKIPPED":9,"PASS":112,"FORBIDDEN_ALL_ROLES":1,"STATE_REFUSAL":1}
flow Patients: 5/5 pass ...
website: 21/21 pass
```

`FORBIDDEN_ALL_ROLES` is `/booking/patients`, which only an integration key may call. `STATE_REFUSAL` is a route that correctly answers 409 for a record in the wrong state. `SKIPPED` routes need data the demo does not have; the automated suite covers them. Any `FAIL` is a real problem.

The probe creates synthetic records on every run (patient first name `Zzprobe`). See "What the run left behind" in `docs/api-health-report.md` for what stays and why.

## 3. Automated suite

The tests use a real PostgreSQL database named `medos_test`, never the dev data. Start PostgreSQL (`scripts\db-up.ps1`) and run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` prepares the test database, applies every migration, and runs the API tests against the real database (no mocks for the OPD and IPD end-to-end flows), then the web tests. The browser tests (Playwright) are separate: `pnpm --filter @medos/web e2e`.

### Last full run (2026-10-31): `pnpm test` exit code 0 (798 tests, 797 passed, 0 failed, 1 skipped)

| Package | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|
| API | 777 | 776 | 0 | 1 |
| Web | 14 | 14 | 0 | 0 |
| Shared | 7 | 7 | 0 | 0 |

The one skipped API test is the backup and restore test, which needs `PG_BIN` set to a PostgreSQL `bin` folder. Run on its own with `PG_BIN` set it passes (6 of 6, none skipped). `pnpm lint`, `pnpm typecheck` and `pnpm build` also exit 0.

Two problems found on the way, both fixed:

* An earlier run failed two assertions because Reception was allowed to raise the final IPD bill. That now needs the permission `IPD_FINAL_BILL` (Cashier and Administrator only), and a new test checks that Reception, nurse, pharmacist and doctor are refused.
* `row-level security … many simultaneous requests` sometimes returned a 500 (Prisma `P1001`, the database not accepting a burst of new connections in time; no data was returned). The API now opens its connection pool at startup. That spec passed 60 of 60 repeated runs afterwards.

Stop the API before running `pnpm test` (it rebuilds the Prisma client, which the running API holds open), and start it again afterwards.

### Reading the result

* The API run ends with Node's summary: `# tests N`, `# pass N`, `# fail 0`. Any `fail` above zero is a real failure; the failing test's name and message are printed above the summary.
* The command exits with code 0 only when everything passed (`echo $?` on bash, `$LASTEXITCODE` on PowerShell).
* If you see "Can't reach database server", PostgreSQL is not running; start it and run again. Do not stop Node processes while the suite is running.
