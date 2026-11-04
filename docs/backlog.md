# MedOS Backlog

Nothing in this file is in MLP-1 scope. Items are added here, never implemented, until a milestone approves them (CLAUDE.md §56).

## 1. MLP-1 stage map and gate

Each stage runs: PLAN → REVIEW CODE → DESIGN → IMPLEMENT → MIGRATE → TEST → SECURITY REVIEW → LICENSE REVIEW → BUILD → E2E → SELF-REVIEW → DOCUMENT → REPORT. A stage passes only when `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all pass (plus Playwright where workflow behaviour exists), regression tests exist for every material issue found, and docs are synchronised. Work stops after each stage until `CONTINUE`.

| # | Stage | # | Stage |
|---|---|---|---|
| 0 | Repository audit and specification | 22 | Pharmacy medicine and batch masters |
| 1 | Monorepo / bootstrap / infrastructure | 23 | Pharmacy stock ledger |
| 2 | Tenant / facility foundation | 24 | Pharmacy procurement / stock receipt |
| 3 | Authentication | 25 | Prescription dispensing |
| 4 | RBAC and permissions | 26 | Ward / room / bed masters |
| 5 | Hospital masters | 27 | IPD admission |
| 6 | Number sequence engine | 28 | Bed assignments / transfers |
| 7 | Patient registration | 29 | IPD charges |
| 8 | Duplicate patient detection | 30 | Nursing notes / worklist |
| 9 | Encounter foundation | 31 | Medication Administration Record |
| 10 | Practitioner schedules and appointments | 32 | Intake / output |
| 11 | OPD queue | 33 | Discharge workflow |
| 12 | Vitals / observations | 34 | Discharge summary |
| 13 | OPD consultation | 35 | Printing / template system |
| 14 | Diagnoses / allergies | 36 | Core reports |
| 15 | Medication orders / prescription | 37 | Audit review |
| 16 | Consultation signing / amendment | 38 | Security hardening |
| 17 | Service catalogue | 39 | Performance / concurrency hardening |
| 18 | Billing foundation | 40 | Backup / restore / deployment readiness |
| 19 | Payments / receipts | 41 | Full OPD E2E certification |
| 20 | Refund / cancellation / financial controls | 42 | Full IPD E2E certification |
| 21 | Cashier shifts | 43 | MLP-1 release candidate review |

Stages 2, 3 and 4 are interdependent in practice (audit writes need an actor; tenant scoping needs a session). Stage 2 will use a minimal, tested tenant-context interface that Stage 3 satisfies, without building Stage 3 early.

## 2. Open decisions blocking stages

See `docs/product/mlp1.md` §14 (G1–G15). Hard blockers: **G15 before Stage 1** (Redis and object-storage licences); G4/G5 before Stage 2–3.

## 3. Deferred by milestone (from the product spec)

- **MLP-2:** LIMS, advanced inventory/procurement, OT, insurance, TPA, enhanced MRD.
- **MLP-3:** West Bengal localisation, Bengali UI, Swasthya Sathi workflows.
- **MLP-4:** ABDM, ABHA, interoperability, FHIR gateway.
- **MLP-5:** doctor AI copilot. **MLP-6:** nursing AI. **MLP-7:** live operational command centre. **MLP-8:** revenue intelligence. **MLP-9:** predictive hospital operations. **MLP-10:** patient super app.

## 4. Out-of-scope items captured so far

Radiology/PACS/DICOM, pathology, blood bank, dialysis, IVF, dental charting, advanced ED/ICU, ambulance, telemedicine, home healthcare, HRMS/payroll, general ledger/ERP accounting, CRM/marketing, packages/DRG, BI/data warehouse, multi-country, patient mobile app, purchase approval hierarchies, vendor tenders.

## 5. Candidate items surfaced during Stage 0 (unscheduled)

- ~~Advance payments / patient deposits~~ — built, see docs/advance-payments.md. Still open: linking an advance to an admission, using an advance at another facility.
- ~~Patient merge tool~~ — built as a link, see docs/patient-merge.md. Still open: showing duplicates side by side before merging, and un-merge (deliberately not offered).
- ~~Bulk data import~~ — built, see docs/import.md. Still open: updating existing records by import, other kinds (practitioners, wards).
- Credit-note document generation beyond data compatibility.
- Bengali/Hindi string catalogues (architecture ready in MLP-1, content later).

## 6. Candidate items surfaced while building (unscheduled; see docs/certification.md §5)

- UI gaps: consultation amendment, patient demographics edit, draft-invoice edit, appointment reschedule, stock purchases/returns/adjustments, supplier management, role/permission editor, password reset/change, practitioner schedule editor, nursing tasks, IPD vitals, discharge waiver, report export (CSV/Excel).
- Patient photo and scanned documents (needs S3-compatible storage, CLAUDE.md §42); stock `TRANSFER` movements.
- Shared cache (Redis/Valkey) for the web server's refresh single-flight when running more than one web instance. (The API rate limiter is already shared through PostgreSQL.)
- Row-level security follow-ups (the feature itself is done in development: ADR-010, `docs/rls.md`): switch staging and production and keep the `rls-evidence` output; confirm the new CI step on a real CI run; an automated check that SQL is never built from strings and that `app.tenant_id` is only written in `prisma.service.ts`; a load test with many hospitals and several API instances; a database-administrator review of the three `SECURITY DEFINER` functions; password rotation for `medos_app`; consider facility-level policies (today the policies isolate hospitals, facility isolation stays in the application).
- Upgrade to NestJS 11 (clears the remaining `pnpm audit` advisory); consider Argon2id (ADR-009).
- Backups: done in tooling (encrypted `db-backup`, drill, status/alerts, PITR rehearsal, schedule templates; docs/backup.md). Remaining: enable archiving and install the schedules on staging/production and keep the first drill output; archive-lag monitoring (`pg_stat_archiver`); backup-size anomaly alerts; per-hospital restore; run `restore.ps1`/`restore-test.ps1` once where scripts are allowed.
- Localisation catalogues (Bengali, Hindi); accessibility audit.
- External reviews (need independent people; briefs in `docs/reviews/`): clinical safety, GST/tax, DPDP/legal, penetration test, accessibility audit. Product work these will probably trigger, not yet built: class-level allergy matching and dose/interaction checks (clinical); CGST/SGST split, round-off, e-invoicing (GST; HSN/SAC capture and the selling-price-not-above-MRP check already exist); consent screens and notice management, request-list screens, retention schedule and anonymisation, break-glass access reason (DPDP; consent and request records exist in the API, see `privacy.md`); MFA (security; per-account lockout already exists). Every provisional default is listed in `reviews/pending-decisions.md`.
- Load test follow-ups: run at staging scale with several API instances and a separate database host; add pharmacy, IPD and report paths to `load-test.ts`; investigate check-in (walk-in) latency, the heaviest operation. Accessibility: install Playwright Chromium and run `a11y.spec.ts` for every role, measure contrast.
- Booking fee: per-doctor / per-department amounts, adding the fee to the visit bill automatically (see docs/booking-fee.md).
- Earnings and prescriptions (docs/earnings-and-reports.md, docs/prescriptions.md): doctor settlement/payout statements (payroll is out of scope for MLP-1), per-department or per-service share rules, a background queue for OCR with retry, a ready-made adapter for a named OCR vendor (the `http` provider covers any service that answers with text), medicine-master matching of OCR suggestions, printing a template library.
- Prescription sharing: a patient-facing page that asks for the date of birth before showing the prescription; messages in Bengali and Hindi; delivery receipts from the provider (today the provider's acceptance is what is recorded).
- Integration API: webhook events for check-in and no-show, one key for several facilities, a real payment-confirmation callback (see docs/integration-api.md).
- Data access by doctor and department (docs/data-access.md): limit the money and pharmacy reports, patient files/documents, nursing worklists and pharmacy screens by doctor or department; audit denied reads; an "all my departments" bulk assignment screen; per-facility department scope for users who work in several facilities.
- Tests the doctor advised (docs/test-orders.md): department work lists and results for laboratory, radiology and cardiology (LIMS, radiology and PACS are out of scope for MLP-1); fuzzy matching of a doctor's wording to the price list; backfilling test orders for consultations signed before this release; showing the tests on the printed prescription with their bill status.
- OCR prescription review (docs/prescriptions.md): reading headings and abbreviations in Bengali and Hindi, diagnosis code suggestions, remembering the doctor's corrections to improve matching, and an OCR confidence per field.
- Doctor share ledger and payouts (docs/earnings-and-reports.md, docs/doctor-payouts.md): splitting one admission between several doctors, sharing by service or department, commission for a referring doctor or agent (today only the doctor of the visit earns a share), the doctor's PAN and a yearly tax-deducted-at-source certificate, and paying out through a bank file.
- Stock locations (docs/stock-transfers.md): receiving only part of a two-step transfer, transfers between facilities, a stock count per location, reorder levels per location, and linking a nurse's medicine administration record to the ward store batch that was used.

- Radiology (docs/radiology.md) is built for reporting only. Still to do: image storage and viewer (PACS/DICOM), report templates and structured measurements, preliminary reads, cardiology and procedure work lists.

- Insurance claims (docs/claims.md) track claims by hand. Still to do: electronic submission (insurer portals, NHCX), document attachments, insurer rate cards and packages, co-pay and deductible calculation, TDS on insurer payments, several invoices per claim.

- Payroll (docs/payroll.md) covers monthly salary only. Still to do: attendance and leave, arrears, advances and loan recovery, Form 16 and TDS computation, PF/ESI challans and bank transfer files, more salary heads, and the rest of HRMS (recruitment, appraisals).

- Patient app (docs/patient-app.md) is a web page for patients. Still to do: a store app and push notifications, online payment of bills, direct booking, report and prescription downloads, clean-up of old sign-in codes and sessions, showing records of merged patients, choosing a facility when a hospital has several, and telemedicine.

- Telemedicine (docs/telemedicine.md) links video calls to appointments. Still to do: show "consulted by video" on the visit and printed prescription, reminders carrying the call link, a waiting room, an identity check step, chat and file sharing, and a video provider that creates rooms through its own API.

- ABDM (docs/abdm.md) is groundwork only. Still to do, once ABDM sandbox credentials and the current specifications are in hand: ABHA verification and creation, linking care contexts, consent and sharing of records with FHIR bundles, gateway callbacks, and an approval step for switching to production.

- AI assistant (docs/ai-assistant.md) drafts two things for a doctor. Still to do, only after clinical review of its output: other tasks (for example discharge summary drafts), lab and radiology reports as input, Bengali and Hindi, stronger de-identification, a way to report an unsafe draft, and per-hospital policy settings.
