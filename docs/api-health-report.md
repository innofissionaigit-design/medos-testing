# MedOS API health report

Run on 2026-10-30 against the local system (API `http://localhost:4000/api/v1`, website `http://localhost:3000`) with the demo hospital's synthetic data.

No passwords, tokens or patient information appear in this report: only routes, status codes and counts. The probe's own records are synthetic (see "What the run left behind").

## Result

| Check | Working | Failing | Not run |
|---|---|---|---|
| Sign-in (7 staff roles, bad credentials, no token) | 9 | 0 | 0 |
| Read routes (all 123 GET routes in `docs/api-routes.md`) | 114 | 0 | 9 |
| Workflow steps (Patients, Appointments, OPD queue, Billing, Admissions, bot key) | 36 | 0 | 0 |
| Website to API connection | 21 | 0 | 0 |
| Postman collection run (Bearer token) | 26 | 0 | 1 |

**No API failures were found.** The API and the website are connected correctly; no source change was needed. The 401 answers seen earlier are the intended behaviour (see "Why you get 401").

## Why you get 401

* Every route except `/health`, `/auth/login`, `/auth/refresh`, `/auth/logout` and the patient's prescription link needs `Authorization: Bearer <accessToken>`. No token, a wrong or expired token (they last 15 minutes) or a header not starting with `Bearer ` gives 401 `UNAUTHENTICATED`.
* A wrong password gives 401 `INVALID_CREDENTIALS`; more than 10 login attempts a minute from one address give 429 `RATE_LIMITED` (the probe hit this once when re-run too quickly, and recovered after a minute).
* Port 3000 is the website. Its `/api/proxy/...` relay is for the browser only (it needs the browser's session cookie and a CSRF header, and it deliberately refuses `/auth/*`). Use port 4000 in Postman.
* A staff member who lacks a permission gets 403, not 401 (for example Admin cannot open the OPD queue; Reception cannot open reports).

## 1. Sign-in

| Account | Status | Result |
|---|---|---|
| admin | 200 | ✅ working (signed in) |
| reception1 | 200 | ✅ working (signed in) |
| cashier1 | 200 | ✅ working (signed in) |
| doctor1 | 200 | ✅ working (signed in) |
| pharmacist1 | 200 | ✅ working (signed in) |
| nurse1 | 200 | ✅ working (signed in) |
| manager1 | 200 | ✅ working (signed in) |
| (no token) | 401 | ✅ working (401 expected without a token) |
| (wrong password) | 401 | ✅ working (401 expected for a wrong password) |

## 2. Workflows (synthetic data)

### Patients

| Step | Status | Result |
|---|---|---|
| Register a synthetic patient | 201 | ✅ working |
| Get the patient | 200 | ✅ working |
| Search by mobile | 200 | ✅ working |
| Duplicate is detected | 409 | ✅ working |
| Update the patient | 200 | ✅ working |

### Appointments and OPD queue

| Step | Status | Result |
|---|---|---|
| Consultation-payment status | 200 | ✅ working |
| Book an appointment | 201 | ✅ working |
| Get the appointment | 200 | ✅ working |
| List appointments | 200 | ✅ working |
| Cancel the appointment | 200 | ✅ working |
| Walk-in: check in to the OPD queue | 201 | ✅ working |
| OPD queue list | 200 | ✅ working |
| Queue entry is waiting | 200 | ✅ working |
| Cancel the queue entry (cleanup) | 200 | ✅ working |

### Billing

| Step | Status | Result |
|---|---|---|
| Price list | 200 | ✅ working |
| Create a bill | 201 | ✅ working |
| Issue the bill | 200 | ✅ working |
| Take a cash payment (shift opens by itself) | 201 | ✅ working |
| Get the bill (paid) | 200 | ✅ working |
| Print the receipt | 200 | ✅ working |
| Bills list | 200 | ✅ working |
| Current cash shift | 200 | ✅ working |
| Collections report | 200 | ✅ working |

### Admissions

| Step | Status | Result |
|---|---|---|
| Wards and beds board | 200 | ✅ working |
| Admissions list | 200 | ✅ working |
| Get an admission | 200 | ✅ working |
| Admit the synthetic patient to a free bed | 201 | ✅ working |
| Cancel the admission (cleanup) | 200 | ✅ working |

### Integration API (bot key)

| Step | Status | Result |
|---|---|---|
| Create an integration key (admin) | 201 | ✅ working |
| Key: doctors with free times | 200 | ✅ working |
| Key: find a patient by mobile (none expected) | 200 | ✅ working |
| Key cannot use staff routes | 403 | ✅ working |
| Staff may also use the doctors list (by design) | 200 | ✅ working |
| Staff cannot use the bot-only patient lookup | 403 | ✅ working |
| Revoke the key | 200 | ✅ working |
| A revoked key stops working | 401 | ✅ working |

## 3. Website to API

| Check | Status | Result |
|---|---|---|
| Website login page | 200 | ✅ working |
| Protected page without a session redirects to login | 307 | ✅ working |
| Login without the CSRF header is refused | 403 | ✅ working |
| Login through the website sets a session cookie | 200 | ✅ working |
| Website session endpoint (me) | 200 | ✅ working |
| The relay never exposes the sign-in routes (by design) | 404 | ✅ working |
| Website relays patients | 200 | ✅ working |
| Website relays appointments | 200 | ✅ working |
| Website relays the OPD queue | 200 | ✅ working |
| Website relays admissions | 200 | ✅ working |
| Website relays bills | 200 | ✅ working |
| Website refuses a change without the CSRF header | 403 | ✅ working |
| Website without a session gets 401 from the relay | 401 | ✅ working |
| Page /dashboard opens when signed in | 200 | ✅ working |
| Page /patients opens when signed in | 200 | ✅ working |
| Page /appointments opens when signed in | 200 | ✅ working |
| Page /queue opens when signed in | 200 | ✅ working |
| Page /ipd opens when signed in | 200 | ✅ working |
| Page /billing opens when signed in | 200 | ✅ working |
| Page /pharmacy opens when signed in | 200 | ✅ working |
| Page /reports opens when signed in | 200 | ✅ working |

## 4. Postman collection run

`docs/postman/medos.postman_collection.json` was executed request by request with its own Bearer-token handling (Login saves the token, every later request sends it, test scripts checked the answers). Everyday requests ran as Reception, the Admin-only folder as the administrator.

| Folder | Request | Status | Result |
|---|---|---|---|
| Authentication | 1. Health (no login needed) | 200 | ✅ working |
| Authentication | 2. Login | 200 | ✅ working |
| Authentication | 2b. Login with a facility (only if Login asked you to choose one) | - | ⏭ not needed (only if Login asks to choose a facility) |
| Authentication | 3. Who am I (needs the token) | 200 | ✅ working |
| Authentication | 7. Refresh token | 200 | ✅ working |
| Patients | Search patients | 200 | ✅ working |
| Patients | Get one patient | 200 | ✅ working |
| Patients | Patient's appointments | 200 | ✅ working |
| Patients | Patient's visits | 200 | ✅ working |
| Patients | Registration fee status | 200 | ✅ working |
| Patients | Registration fee settings | 200 | ✅ working |
| Appointments | List appointments | 200 | ✅ working |
| Appointments | Doctors | 200 | ✅ working |
| Appointments | Doctors with free times (bot route, staff may use it) | 200 | ✅ working |
| Appointments | Is the OPD consultation paid first? | 200 | ✅ working |
| OPD queue | OPD queue today | 200 | ✅ working |
| Admissions | Admissions | 200 | ✅ working |
| Admissions | Wards and beds board | 200 | ✅ working |
| Billing | Bills | 200 | ✅ working |
| Billing | Price list | 200 | ✅ working |
| Billing | My current cash shift | 200 | ✅ working |
| Billing | Patient account statement (ledger) | 200 | ✅ working |
| Authentication | 8. Logout (revokes the refresh token) | 204 | ✅ working |
| Admin sign-in | 2. Login | 200 | ✅ working |
| Admin only | Registrations report (today) | 200 | ✅ working |
| Admin only | Collections report (today) | 200 | ✅ working |
| Admin only | OCR connection settings | 200 | ✅ working |

## 5. Every read route

Each route was called with the first seeded role that holds its permission, using real sample ids from the demo data.

| Module | Route | Status | Role | Result |
|---|---|---|---|---|
| admissions | `/admissions/:id/discharge` | 200 | admin | ✅ working |
| admissions | `/admissions/:id/discharge-summary` | 200 | doctor1 | ✅ working |
| admissions | `/admissions/:id/discharge-summary/versions/:version` | - | - | ⏭ not run — needs a sample :version that the demo data does not have |
| admissions | `/admissions` | 200 | admin | ✅ working |
| admissions | `/admissions/:id` | 200 | admin | ✅ working |
| admissions | `/admissions/:id/charges` | 200 | admin | ✅ working |
| admissions | `/admissions/:id/intake-output` | 200 | doctor1 | ✅ working |
| admissions | `/admissions/:id/intake-output/totals` | 200 | doctor1 | ✅ working |
| admissions | `/admissions/:id/mar` | 200 | doctor1 | ✅ working |
| admissions | `/admissions/:id/notes` | 200 | doctor1 | ✅ working |
| admissions | `/admissions/:id/tasks` | 200 | doctor1 | ✅ working |
| advances | `/advances/:id` | - | - | ⏭ not run — needs a sample :id that the demo data does not have |
| appointments | `/appointments` | 200 | admin | ✅ working |
| appointments | `/appointments/:id` | 200 | admin | ✅ working |
| appointments | `/appointments/:id/reminders` | 200 | admin | ✅ working |
| audit-events | `/audit-events/` | 200 | admin | ✅ working |
| audit-events | `/audit-events/actors` | 200 | admin | ✅ working |
| auth | `/auth/me` | 200 | admin | ✅ working |
| beds | `/beds` | 200 | admin | ✅ working |
| beds | `/beds/board` | 200 | admin | ✅ working |
| booking | `/booking/doctors` | 200 | admin | ✅ working |
| booking | `/booking/patients` | 403 | manager1 | ✅ working (limited to a bot key) — no seeded role holds the permission |
| booking-fee | `/booking-fee/config` | 200 | admin | ✅ working |
| charges | `/charges/unbilled` | 200 | admin | ✅ working |
| departments | `/departments` | 200 | admin | ✅ working |
| earnings | `/earnings/rules` | 200 | admin | ✅ working |
| encounters | `/encounters/:id/consultation` | 200 | doctor1 | ✅ working |
| encounters | `/encounters/:id/consultation/versions/:version` | - | - | ⏭ not run — needs a sample :version that the demo data does not have |
| encounters | `/encounters/:id/diagnoses` | 200 | doctor1 | ✅ working |
| encounters | `/encounters/:id/workspace` | 200 | doctor1 | ✅ working |
| encounters | `/encounters/:id` | 200 | admin | ✅ working |
| encounters | `/encounters/:id/follow-ups` | 200 | admin | ✅ working |
| encounters | `/encounters/:id/prescription` | 200 | doctor1 | ✅ working |
| encounters | `/encounters/:id/prescription-shares` | 200 | reception1 | ✅ working |
| encounters | `/encounters/:id/prescription-scans` | 200 | doctor1 | ✅ working |
| encounters | `/encounters/:id/observations` | 200 | doctor1 | ✅ working |
| facilities | `/facilities/` | 200 | admin | ✅ working |
| facilities | `/facilities/:id` | 200 | admin | ✅ working |
| files | `/files/:id/content` | - | - | ⏭ not run — needs a sample :id that the demo data does not have |
| health | `/health/` | 200 | admin | ✅ working |
| health | `/health/ready` | 200 | admin | ✅ working |
| imports | `/imports/:kind` | - | - | ⏭ not run — needs a sample :kind that the demo data does not have |
| integrations | `/integrations/abilities` | 200 | admin | ✅ working |
| integrations | `/integrations/clients` | 200 | admin | ✅ working |
| invoices | `/invoices` | 200 | admin | ✅ working |
| invoices | `/invoices/:id` | 200 | admin | ✅ working |
| mar | `/mar/due` | 200 | doctor1 | ✅ working |
| medicines | `/medicines` | 200 | admin | ✅ working |
| number-sequences | `/number-sequences/` | 200 | admin | ✅ working |
| nursing | `/nursing/worklist` | 200 | doctor1 | ✅ working |
| ocr | `/ocr/config/` | 200 | admin | ✅ working |
| patients | `/patients/:id/advances` | 200 | admin | ✅ working |
| patients | `/patients/:id/allergies` | 200 | admin | ✅ working |
| patients | `/patients/:id/appointments` | 200 | admin | ✅ working |
| patients | `/patients/:id/consultation-payment` | 200 | reception1 | ✅ working |
| patients | `/patients/:id/diagnoses` | 200 | doctor1 | ✅ working |
| patients | `/patients/:patientId/encounters` | 200 | admin | ✅ working |
| patients | `/patients/:id/files` | 200 | admin | ✅ working |
| patients | `/patients/` | 200 | admin | ✅ working |
| patients | `/patients/:id` | 200 | admin | ✅ working |
| patients | `/patients/:id/registration-fee` | 200 | admin | ✅ working |
| patients | `/patients/registration-fee/config` | 200 | reception1 | ✅ working |
| patients | `/patients/:id/consents` | 200 | admin | ✅ working |
| patients | `/patients/:id/ledger` | 200 | admin | ✅ working |
| patients | `/patients/:id/observations` | 200 | doctor1 | ✅ working |
| permissions | `/permissions` | 200 | admin | ✅ working |
| pharmacy | `/pharmacy/batches` | 200 | admin | ✅ working |
| pharmacy | `/pharmacy/batches/:id/ledger` | 200 | admin | ✅ working |
| pharmacy | `/pharmacy/dispenses` | 200 | admin | ✅ working |
| pharmacy | `/pharmacy/dispenses/:id` | 200 | admin | ✅ working |
| pharmacy | `/pharmacy/handwritten` | 200 | pharmacist1 | ✅ working |
| pharmacy | `/pharmacy/medicines/:id/suggest-batches` | 200 | admin | ✅ working |
| pharmacy | `/pharmacy/purchases` | 200 | pharmacist1 | ✅ working |
| pharmacy | `/pharmacy/purchases/:id` | - | - | ⏭ not run — needs a sample :id that the demo data does not have |
| pharmacy | `/pharmacy/queue` | 200 | pharmacist1 | ✅ working |
| pharmacy | `/pharmacy/stock` | 200 | admin | ✅ working |
| pharmacy | `/pharmacy/suppliers` | 200 | admin | ✅ working |
| practitioners | `/practitioners/:id/availability` | 200 | admin | ✅ working |
| practitioners | `/practitioners/:id/schedule` | 200 | admin | ✅ working |
| practitioners | `/practitioners` | 200 | admin | ✅ working |
| prescription-scans | `/prescription-scans/config` | 200 | doctor1 | ✅ working |
| prescription-templates | `/prescription-templates/` | 200 | doctor1 | ✅ working |
| print | `/print/advance-receipts/:id` | - | - | ⏭ not run — needs a sample :id that the demo data does not have |
| print | `/print/discharge-summaries/:admissionId` | 200 | doctor1 | ✅ working |
| print | `/print/invoices/:id` | 200 | admin | ✅ working |
| print | `/print/patient-labels/:patientId` | 200 | admin | ✅ working |
| print | `/print/prescriptions/:encounterId` | 409 | nurse1 | ✅ working (refuses, as designed) — INVALID_STATE: the sample record is not in the state this route needs (expected) |
| print | `/print/receipts/:id` | 200 | admin | ✅ working |
| privacy | `/privacy/requests` | 200 | admin | ✅ working |
| public | `/public/prescriptions/:token` | - | - | ⏭ not run — needs a sample :token that the demo data does not have |
| queue | `/queue/` | 200 | admin | ✅ working |
| queue | `/queue/doctor` | 200 | doctor1 | ✅ working |
| receipts | `/receipts/:id` | 200 | admin | ✅ working |
| reports | `/reports/booking-fee-skips` | 200 | admin | ✅ working |
| reports | `/reports/bookings/by-doctor` | 200 | admin | ✅ working |
| reports | `/reports/bookings/my` | 200 | doctor1 | ✅ working |
| reports | `/reports/cashier-shifts` | 200 | admin | ✅ working |
| reports | `/reports/collections` | 200 | admin | ✅ working |
| reports | `/reports/ipd/admissions-discharges` | 200 | admin | ✅ working |
| reports | `/reports/ipd/bed-occupancy` | 200 | admin | ✅ working |
| reports | `/reports/ipd/current-admissions` | 200 | admin | ✅ working |
| reports | `/reports/opd/by-department` | 200 | admin | ✅ working |
| reports | `/reports/opd/by-doctor` | 200 | admin | ✅ working |
| reports | `/reports/opd/daily` | 200 | admin | ✅ working |
| reports | `/reports/outstanding-invoices` | 200 | admin | ✅ working |
| reports | `/reports/pharmacy/low-stock` | 200 | admin | ✅ working |
| reports | `/reports/pharmacy/near-expiry` | 200 | admin | ✅ working |
| reports | `/reports/pharmacy/sales` | 200 | admin | ✅ working |
| reports | `/reports/pharmacy/stock` | 200 | admin | ✅ working |
| reports | `/reports/pharmacy/stock-movement` | 200 | admin | ✅ working |
| reports | `/reports/registrations` | 200 | admin | ✅ working |
| roles | `/roles` | 200 | admin | ✅ working |
| rooms | `/rooms` | 200 | admin | ✅ working |
| services | `/services` | 200 | admin | ✅ working |
| settings | `/settings/` | 200 | admin | ✅ working |
| settings | `/settings/features` | 200 | admin | ✅ working |
| shifts | `/shifts` | 200 | reception1 | ✅ working |
| shifts | `/shifts/:id` | - | - | ⏭ not run — needs a sample :id that the demo data does not have |
| shifts | `/shifts/current` | 200 | reception1 | ✅ working |
| tenants | `/tenants/current` | 200 | admin | ✅ working |
| users | `/users` | 200 | admin | ✅ working |
| users | `/users/:id` | 200 | admin | ✅ working |
| wards | `/wards` | 200 | admin | ✅ working |

Routes marked "not run" need a record the demo data does not contain (an advance deposit, a stored file, a version of a signed note, a purchase, a public prescription link). They are covered by the automated test suite (798 tests across API, web and shared) rather than by this probe. The last full run (2026-10-31, after the doctor and department data-access work) had 797 passed, 0 failed and 1 skipped (the backup test, which needs `PG_BIN`); see `docs/api-testing.md`.

## What the run left behind (cleanup status)

Everything below is in the local development database (`medos_dev`) only, checked against the database on 2026-10-30 after the final run. Nothing was written to the test database or any other environment. The Postman collection is read-only and creates nothing.

| Synthetic record | Count | Status now | Can it be removed? |
|---|---|---|---|
| Patients, first name `Zzprobe`, all registered 2026-10-30 | 6 | Active | **No, by design.** Patient records are never deleted (CLAUDE.md rule 18). |
| Bills (OPD, 10 rupees each) | 6 | Paid | **No.** Issued bills are final; they could only be reversed with a refund or credit note, which would add more records. |
| Receipts / payments (10 rupees each, 60 rupees total) | 6 | Final | **No.** Append-only. |
| Appointments | 12 | All cancelled | Already cleaned up through the cancel workflow. |
| Visits (OPD) | 12 | All cancelled | Already cleaned up. |
| OPD queue entries | 6 | All cancelled | Already cleaned up. |
| Admissions | 6 | All cancelled; the bed was released | Already cleaned up. |
| Integration keys named `API probe …` | 3 | Revoked | Already cleaned up; a revoked key cannot sign in. |
| Audit events for all of the above | several dozen | Final | **No.** The audit trail cannot be edited. |
| Cashier shift opened automatically, 0 rupees opening cash | 1 (cashier1) | **Open** | Left as it is: it is that cashier's normal working shift and closes through the usual Close shift screen with the counted cash. |

How to recognise the records: the patient's first name starts with `Zzprobe`. They show up in patient search and in today's registration and collection reports (60 rupees in total). If you want a clean demo, reset the development database from the seed (`scripts\db-up.ps1`, then `pnpm db:seed` on an empty database); nothing in the test database or the source depends on these records.

Each further run of `probe.mjs` adds one more `Zzprobe` patient with a 10 rupee paid bill in the same way. The collection run (26 requests) adds none.

Settings changed in the development database for earlier demos (not by this probe): `PRESCRIPTION_UPLOAD_ENABLED` is on, and the default earnings split is 60 percent.

No source code was changed for this report. Files added: this report, `docs/api-testing.md`, `docs/postman/medos.postman_collection.json`, `docs/postman/medos.local.postman_environment.json`, `scripts/api-health/probe.mjs` and `scripts/api-health/run-collection.mjs`.

## Postman Desktop verification

Reported by the project owner on 2026-10-30: the updated collection, imported into Postman Desktop as "MedOS API (local) Copy 2" and run with the **MedOS local** environment, gave 32 tests passed, 0 failed, 0 skipped, 0 errors in 4.304 seconds. This is the real-application check; the Newman and script runs above are supporting evidence.

## Using Postman

See `docs/api-testing.md` for the full steps. In short: import the collection and the **MedOS local** environment, put `SEED_PASSWORD` in the environment's `password` (a secret variable), run **Authentication → 2. Login**, then run the collection. Sign in as `admin` for the Admin-only folder. After 15 minutes run **7. Refresh token**.
