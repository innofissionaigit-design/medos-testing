# Load test and accessibility self-check

## Multi-user load test

Run: `pnpm --filter @medos/api load` (rebuilds, then runs `apps/api/src/load/load-test.ts`; not part of `pnpm test`). Settings: `LOAD_TENANTS` (5 in the run below), `LOAD_USERS` (users of each kind per hospital), `LOAD_DOCTORS` (doctors per hospital), `LOAD_SECONDS`, `LOAD_P95_MS` (budget, default 1500), `LOAD_MIN_RPS`. To run against the restricted database login set `TEST_APP_DATABASE_URL` and `DB_TENANT_CONTEXT=on` (as in the CI step).

**What it does.** Several hospitals each run many simultaneous receptionists and cashiers through the OPD money path in a loop: register a patient, check in, view the queue, search by patient number, create a bill, issue it, collect cash. Then it checks the data for what concurrency breaks.

**Checks after the run (all must pass).** Patient numbers unique per hospital; invoice numbers unique and without gaps; every completed bill fully paid to the paisa; payments add up to the invoices; another hospital's patient and bill are unreachable (404); no 5xx responses; no unexpected responses; slowest p95 within budget.

### Results (2026-10-28, one Windows machine, PostgreSQL 17, API and load generator in the same Node process, 5 hospitals, 10 receptionists and 10 cashiers each = 100 logged-in users, 50 simultaneous loops, 60 s)

| Setup | Requests | Req/s | Complete patient journeys | Slowest p95 | Integrity checks | Result |
|---|---|---|---|---|---|---|
| App as database owner (RLS not enforced) | 6,923 | 105 | 989 | check-in 1,542 ms | all passed | **failed the 1,500 ms budget by 42 ms** |
| App as restricted login, RLS enforced, 5 doctors per hospital | 6,433 | 95 | 919 | check-in 1,200 ms | all passed | passed |
| App as restricted login, RLS enforced, 1 doctor per hospital | 6,475 | 99 | 925 | check-in 1,592 ms | all passed | **failed the budget by 92 ms** |

**After the check-in optimisation (same test, restricted login, same machine, later the same day):**

| Setup | Req/s | Complete journeys | Check-in p50 / p95 | Result |
|---|---|---|---|---|
| 5 doctors per hospital | 92 | 897 | 700 / 1,052 ms (was 1,200 p95) | passed |
| 1 doctor per hospital | 98 | 927 | 892 / 1,163 ms (was 1,592 p95) | **passed** (was a failure) |

What changed (`appointments.service.ts`, `encounters.service.ts`): a walk-in no longer repeats work it has just done in the same transaction (re-reading the practitioner and the patient, cancelling reminders on an appointment created a moment ago), and the queue token is now allocated before the visit number so the facility-wide visit-number row stays locked for fewer statements. Behaviour is unchanged; the full suite (492 tests, including the OPD and IPD certification flows) passes.

A direct before/after measurement of the walk-in endpoint alone (three alternating rounds on a freshly reset database, 5 doctors, owner login): one user went from about 41 ms to about 32 ms per walk-in (median of the rounds); with 5 simultaneous receptionists throughput rose from about 33 to about 59 walk-ins per second and median latency fell from about 135 to about 75 ms; with 10 simultaneous the gain was smaller (about 40 to 48 per second). Single measurements on this machine vary by 20 percent or more, so treat the figures as indicative.

**What this still does not fix.** The whole-system rate stayed at about 95 requests per second (the machine's CPU is the limit), so under 50 simultaneous loops check-in still takes about 0.7 to 0.9 s at the median. The remaining serialisation is the facility's visit-number counter, which is held until the transaction commits; removing it would mean allocating the number outside the transaction, which would allow gaps and was not done.

Smaller run (3 hospitals, 5 users each, 20 s): p95 under 220 ms for every operation, all checks passed.

**What this shows.**
- **Correctness under concurrency held in every run:** no duplicate or skipped patient or invoice numbers, no money mismatch, no cross-hospital leak, no server errors, in both database-login modes.
- **Throughput saturated at about 100 requests per second** on this machine whatever the number of doctors, so the limit here is CPU shared by the API, the load generator and the database, not locking. Latency therefore grows with the number of simultaneous loops.
- **Check-in (walk-in) is the heaviest operation** (median about 0.7 to 0.9 s at this load): it books, checks in, creates the visit and queue entry in one transaction. Funnelling everyone to one doctor made it somewhat slower (p95 1.6 s versus 1.2 s).
- Row-level security costs little: about the same throughput and latency as the owner login.
- The two failures are budget breaches, reported as such. The budget was not changed to make them pass.

**What this does not show.** The test runs on one machine with the generator competing for CPU; each simulated user works continuously (5 to 25 ms pause), far faster than a person, so 50 loops stand for many more real users; requests are in-process HTTP (no network, no TLS, no reverse proxy); one API process, not several instances; only the OPD money path, not pharmacy, IPD, nursing or reports; synthetic data of a few thousand rows added to a database that also holds the 30,000-patient volume test data from `performance.spec.ts`. A staging-scale run with several API instances, a separate database host and a network between them is still needed before sizing production.

## Accessibility self-check

Tool: `apps/web/e2e/a11y-rules.ts` with the Playwright spec `apps/web/e2e/a11y.spec.ts` (every main screen for each of the seeded roles, plus a keyboard check that Tab focus stays inside an open dialog).

**What ran.** The structural rules (language, title, landmark, h1, heading order, alt text, form labels, button and link names, tabindex, duplicate ids, dialog names, table headers) were run in the built-in browser against the live development app, signed in as the pharmacist, on `/dashboard`, `/patients`, `/billing`, `/pharmacy`, `/ipd` and `/reports`. The checker was confirmed to catch a deliberately unlabelled field. It found **one** problem: on `/reports` a section heading jumped from h1 to h3. **Fixed** (it is now an h2).

**What did not run, and why.**
- **Text contrast:** the browser pane's script tool returned empty computed colours, so contrast was not measured. Unverified.
- **Other roles' screens** (receptionist, doctor, nurse, cashier, manager, admin): I had no sign-in for them in the pane. Unverified.
- **The Playwright spec** (`pnpm --filter @medos/web e2e`): it needs Playwright's Chromium, which is not installed here, and installing it is a download I did not make without approval. It has not been run, and it also needs a production web build and the `medos_e2e` database.
- **Keyboard-focus and dialog checks:** not run, for the same reason.

None of this is an accessibility audit: see [reviews/accessibility.md](reviews/accessibility.md) for what a specialist must cover.
