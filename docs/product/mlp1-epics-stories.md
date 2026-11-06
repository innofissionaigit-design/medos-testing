# MLP-1 — Epics and User Stories

Status key: **Done** = implemented and covered by an executed automated test; **Done (UI untested)** = implemented, verified only manually or at API level; **Gap** = not confirmed built (see `docs/certification.md` §5); **Deferred** = consciously postponed (`REMINDER.md`).
Roles: REC reception, DOC doctor, NUR nurse, CSH cashier, PHM pharmacist, MGR manager, ADM administrator.

## E1 Platform, authentication and authorization
| ID | Story | Acceptance criteria | Status |
|---|---|---|---|
| 1.1 | As any user I log in with hospital code, username or email, and password | Wrong credentials give a generic error (the same for a wrong code, user, password, locked or inactive account); inactive users cannot log in; lockout after 5 wrong tries within 15 minutes, which an administrator can end at once (docs/authentication.md) | Done |
| 1.2 | As a user my session stays alive and can be ended | 15-min access token, rotating refresh token, reuse revokes the family, logout revokes; a logout, password reset or password change ends the session at once, not when the access token runs out (docs/authentication.md) | Done |
| 1.3 | As a user I change my password | Old password required; other sessions revoked | Done |
| 1.4 | As ADM I manage users and roles | Create, deactivate, assign roles; change takes effect on the next request | Done |
| 1.5 | As ADM I use custom roles | Create a role and choose its permissions in Administration (roles card) | Done (UI untested) |
| 1.6 | As the system I enforce permissions server-side | Every route declares a permission; 403 with stable code otherwise | Done |
| 1.7 | As the system I isolate tenants | A user of another hospital holding every permission tries every route that takes an id, with real ids of other hospitals' records: nothing succeeds, nothing crashes, reads answer 404 and writes reach their lookup and answer 404 (`common/tenant-sweep.spec.ts`; `docs/rls.md`) | Done |
| 1.8 | As the system I rate-limit auth endpoints | Sign-in 10 a minute per client address; refresh, logout, switch facility 30 a minute per session; password change 10 a minute per session; patient-app code and verify per address. Over the limit: 429 `RATE_LIMITED` with `Retry-After`. The counters are in PostgreSQL, so two API instances share one allowance (`docs/authentication.md`) | Done |

## E2 Tenant, facility and master data
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 2.1 | ADM maintains facility, departments | Facilities: add, edit details, switch off (refused while patients are admitted) and on; departments: add, rename, switch off (refused while working doctors are in them) and on; screens under Administration; other hospitals' records are "not found" (`docs/wards-and-doctors.md`) | Done |
| 2.2 | ADM maintains wards, rooms, beds | Add, rename, set the bed rate, switch off and on, retire; a bed is in service only while its room and ward are on; bed status explicit (`docs/wards-and-doctors.md`) | Done |
| 2.3 | ADM maintains practitioners and their weekly schedules | Add, edit, switch off and on; a saved schedule (even an empty one) is the only bookable time; the editor changes the bookable slots (`docs/wards-and-doctors.md`). Anyone who can read appointments sees every doctor's weekly schedule, read-only, on the Appointments page; the patient search in the booking window offers "Register a new patient" when nobody matches | Done |
| 2.4 | ADM maintains the service catalogue and prices | Administration → Price list: search, filter, add, edit (name, category, price, tax, SAC/HSN), switch off and on (no delete, so history stays complete); price changes audited and apply to new invoices only (`docs/service-catalogue.md`) | Done |
| 2.5 | ADM sets print header/footer, GST details, feature flags | Prints reflect settings; flags hide menus | Done |
| 2.6 | ADM configures numbering | Concurrency-safe, gap-free sequences issued in the record's own transaction (MRN, visit, admission, invoice, receipt, prescription and the rest); formats that restart every January, every April (financial year) or never; a changed restart rule never re-issues a number; the next number can be raised to continue an old series; GST bill numbers kept to 16 characters of letters, digits, - and / (`docs/numbering.md`) | Done |
| 2.7 | Supplier management screen | Create, activate and deactivate suppliers (Pharmacy → Suppliers) | Done (UI untested) |

## E3 Patient registration and identity
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 3.1 | REC registers a patient in under 45 seconds | Required fields only; MRN generated transactionally | Done |
| 3.2 | REC is warned about possible duplicates | Matches by mobile, name+mobile, name+DOB; never auto-merge | Done |
| 3.3 | REC deliberately creates a new patient despite matches | Needs DUPLICATE_OVERRIDE; audited | Done |
| 3.4 | Any clinician searches patients | By MRN, mobile or name; tenant-scoped; indexed | Done |
| 3.5 | REC edits demographics | Optimistic version check; audited | Done |
| 3.6 | REC uploads a photo and scanned documents | PNG/JPEG/PDF ≤ 5 MB, content-checked; one active photo; remove keeps history | Done |
| 3.7 | Patient identifiers beyond MRN | Separate identifier table; staff add an old hospital number or another ID (issuer required, Aadhaar refused) from the patient page, one number per patient in the hospital, never edited or deleted (a wrong one is removed with a reason and kept); search finds a patient by any number, including a merged duplicate's (`docs/patient-identifiers.md`). ABHA is recorded on the ABDM screen | Done |
| 3.8 | Patient merge tool | Link a duplicate to the real patient; history kept (`docs/patient-merge.md`) | Done |

## E4 Appointments and OPD queue
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 4.1 | REC books an appointment against a doctor schedule | Only free slot times offered on the screen, inside the doctor's sessions; the appointment takes the slot's length; no double booking even under race (database locks plus an exclusion constraint, 12 simultaneous requests: one wins); a repeated Book press returns the first booking; the screen refreshes the times when one was just taken (`docs/appointment-booking.md`) | Done |
| 4.2 | REC reschedules and cancels | Reason on cancel; state rules enforced | Done |
| 4.3 | REC marks no-show | Allowed only from BOOKED | Done |
| 4.4 | REC checks a patient in | Token issued per doctor per day | Done |
| 4.5 | REC creates a walk-in | Idempotent; queue entry created | Done |
| 4.6 | DOC calls next or a chosen patient | SKIP LOCKED; one doctor, one consultation at a time | Done |
| 4.7 | REC/DOC changes queue priority or emergency | New permission QUEUE_PRIORITY: reception changes any queue, a doctor only their own waiting patients (another doctor's or a nurse's is refused); the queue order changes (emergency, then priority, then arrival) and every change is audited with who made it (`QUEUE_PRIORITY_CHANGED`) | Done |
| 4.8 | Overbooking by exception | Server refuses it without APPOINTMENT_OVERBOOK and without a reason; the Book dialog now has a "Book outside the free times (exception)" option (time, minutes, reason) shown only to people who hold the permission; audited as APPOINTMENT_OVERBOOKED; an overbooked visit never blocks the regular slot. No built-in role holds the permission: give it to a trusted role (Administration -> Staff -> roles) (`docs/appointment-booking.md`) | Done |

## E5 Clinical: vitals, allergies, consultation, prescription
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 5.1 | DOC/NUR records vitals against an encounter | Append-only; wrong entry marked "entered in error". A doctor records on the visit page; a nurse (who cannot open the doctor's visit page) uses "Record vitals" next to the patient on the OPD queue, and on the admission page for inpatients | Done |
| 5.2 | DOC/NUR records allergies | Severity; status history | Done |
| 5.3 | DOC records diagnoses | Add and remove with history | Done |
| 5.4 | DOC writes a consultation note as draft | Draft persists; unsaved text survives prescription save | Done |
| 5.5 | DOC creates a prescription | One draft per encounter; allergy matched to every item | Done |
| 5.6 | DOC signs the consultation | Note becomes immutable; prescription signed with it | Done |
| 5.7 | DOC amends a signed consultation | Reason required; every version kept with actor and time | Done |
| 5.8 | DOC stops or amends a signed prescription item | Amendment supersedes; original kept | Done (API) / Done (UI untested) |
| 5.9 | Allergy override | Warning shown; acknowledgement audited | Done |

## E6 Billing and payments
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 6.1 | REC/CSH creates and edits a draft invoice | Server-side decimal totals | Done |
| 6.2 | CSH issues an invoice | Lines and totals frozen; DB rejects change | Done |
| 6.3 | CSH takes payment, split across modes | Cash, UPI, card, bank, other; overpayment rejected; idempotent | Done |
| 6.4 | CSH opens and closes a cashier shift | Cash needs an open shift; expected vs counted shown | Done |
| 6.5 | CSH issues a refund | Confirmation; cannot exceed paid; audited | Done |
| 6.6 | MGR applies a discount | INVOICE_DISCOUNT; audited | Done |
| 6.7 | MGR cancels an invoice or issues a credit note | Reason required; original preserved. For a paid bill the Cashier refunds first, then the Manager cancels (two people on purpose, `docs/billing-roles.md`, decision 6 Nov 2026) | Done |
| 6.8 | Receipts and invoices print | HTML and PDF; reprints stamped DUPLICATE COPY | Done |
| 6.9 | Advance payments and deposits | Take an advance, apply it to a bill, give it back (`docs/advance-payments.md`) | Done |
| 6.10 | GST/tax review | Per-line tax, MRP-inclusive medicines | Deferred (external review) |
| 6.11 | ADM chooses commission or fixed value for doctors; the share is posted to a ledger on every payment and refund and shown on the bill (`docs/earnings-and-reports.md`) | Percentage or fixed rules; advance money counts when applied; refunds reduce it | Done |
| 6.12 | ADM pays doctors their share with vouchers, tax deducted at source, reversals and statements (`docs/doctor-payouts.md`) | Never more than owed; vouchers never edited or deleted | Done |

## E7 Pharmacy
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 7.1 | PHM sees signed prescriptions first | Drafts never appear | Done |
| 7.2 | PHM dispenses with FEFO batch selection | No expired or blocked batch; no oversell under concurrency | Done |
| 7.3 | PHM dispenses and the bill goes to the Cashier | Dispensing issues the pharmacy bill (issued, unpaid) and tells the pharmacist it has gone to the Cashier, who takes the payment and owns the cash shift (`docs/billing-roles.md`); dispensing is idempotent: an Idempotency-Key is required and a repeat returns the first dispense. Decision 5 Nov 2026: payment is not taken at the pharmacy | Done |
| 7.4 | PHM handles patient returns | Stock restored to ledger | Done |
| 7.5 | PHM receives purchases | Batch and expiry recorded; ledger PURCHASE | Done |
| 7.6 | PHM returns stock to supplier | Ledger PURCHASE_RETURN | Done |
| 7.7 | PHM adjusts or writes off stock | Reason; ledger ADJUSTMENT/DAMAGE; confirmation | Done |
| 7.8 | PHM maintains the medicine master | Create and edit; audited | Done |
| 7.9 | Stock transfer between locations | Locations (ward store, OT store) and transfers with ledgers on both sides, no oversell under concurrency (`docs/stock-transfers.md`) | Done |
| 7.10 | Ledger reconciles to balances | DB check on every change | Done |
| 7.11 | PHM sends stock in two steps (sent, then received or sent back) | Stock on the way is in neither place; closed once | Done |
| 7.12 | NUR takes a medicine from a ward store for an admitted patient | Written to the store's ledger and charged to the admission | Done |
| 7.13 | Location stock appears in the current, low and near-expiry stock reports | Shown beside the main store | Done |

## E8 Inpatient: beds and admissions
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 8.1 | REC admits a patient under a consultant | One active admission per patient | Done |
| 8.2 | REC/NUR allocates and transfers beds | Full assignment history; Ward A → ICU → Ward B reconstructable. The transfer reason is shown with the bed moved to, labelled "Moved here" | Done |
| 8.3 | Bed status is explicit | AVAILABLE, OCCUPIED, RESERVED, CLEANING, MAINTENANCE | Done |
| 8.4 | Staff post charges to an admission | Catalogue or free-price (needs billing rights); void keeps record | Done |
| 8.5 | Bed-day charges accrue per assignment | Posted from history | Done |
| 8.6 | Cancel an admission | Allowed before clinical activity; audited | Done |

## E9 Nursing and medication administration
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 9.1 | NUR sees ward worklist | Admissions by ward and bed | Done |
| 9.2 | NUR records notes and addenda | Original never overwritten | Done |
| 9.3 | NUR records tasks | Create and complete | Done (API) |
| 9.4 | Medication schedule is generated from signed orders | Order and administration are separate | Done |
| 9.5 | NUR records Given, Held, Missed, Refused | Time, actor, remarks | Done (Given/Hold in UI; Missed/Refused API) |
| 9.6 | NUR records intake and output | Enter-in-error supported | Done |

## E10 Discharge
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 10.1 | DOC marks the patient fit for discharge | Prerequisite for clearances | Done |
| 10.2 | Departments clear their steps | Configurable steps; each audited | Done |
| 10.3 | Waive a step with a reason | Reason mandatory; audited | Done (API) / Done (UI untested) |
| 10.4 | Consultant signs the discharge summary | Only the treating consultant | Done |
| 10.5 | CSH raises the final bill from pending charges | Charges marked billed | Done |
| 10.6 | Discharge completes only when paid | Part payment still blocks | Done |
| 10.7 | Completion releases the bed and closes the encounter | Bed goes to cleaning | Done |

## E11 Reports
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 11.1 | MGR runs 13 operational reports | OPD counts (daily, doctor, department), collections, payment modes, cashier shifts, current and daily admissions, discharges, occupancy, pharmacy sales, stock, low stock, near-expiry, outstanding | Done |
| 11.2 | Ranges are bounded and facility-scoped | ≤ 93 days | Done |
| 11.3 | MGR exports a report to CSV | Formula-injection safe; the file is built from the server data, not the screen; every export is recorded in the audit trail (`REPORT_EXPORTED`: who, report, dates, row count) and the file is not saved if that record fails | Done |

## E12 Audit
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 12.1 | Every important mutation writes an audit event | Same transaction; actor, entity, request id. The audit screen shows ids, not patient names (decision 6 Nov 2026); a report export is also recorded | Done |
| 12.2 | ADM/MGR views and filters the audit log | Read-only; append-only at DB level | Done |

## E13 Printing and documents
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 13.1 | Print invoice, receipt, prescription, discharge summary, patient label | One document model → HTML or PDF; escaped; audited | Done |
| 13.2 | Admission form print | Patient, admission, contacts, allergies, consent wording, signature lines; HTML and PDF; English, Bengali or Hindi; reprints stamped (`docs/admission-form.md`) | Done |
| 13.3 | Indic scripts in PDF | Bengali and Devanagari fonts embedded | Done |

## E14 Localisation
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 14.1 | User switches the UI to Bengali or Hindi | ~600 strings; fallback to English; Latin digits | Done |
| 14.2 | Native-speaker translation review | Includes the Bengali and Hindi admission form wording | Deferred |

## E15 Quality, security and operations
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 15.1 | Mandatory OPD and IPD workflows pass end-to-end | API and browser, real database | Done |
| 15.2 | Security tests: IDOR, replay, concurrency, state transitions | Automated | Done |
| 15.3 | Backup and verified restore | Scripts; manual drill passed | Done (manual) |
| 15.4 | Seed realistic synthetic data | 1,000 patients, 12 admissions, 100 medicines, 50 invoices | Done |
| 15.5 | Docker images, compose, CI | Written, never run | Deferred |
| 15.6 | PostgreSQL RLS, shared rate limiter, PITR, encryption | RLS and the shared limiter are built and tested; encrypted backups and a point-in-time-recovery rehearsal work in development (`docs/backup.md`); WAL archiving and schedules are not yet set up on staging or production | Done (RLS, limiter, backups) / Deferred (production setup) |
| 15.7 | Clinical, GST, DPDP, penetration, accessibility reviews | External | Deferred |

## E16 Shell and UX
| ID | Story | Acceptance | Status |
|---|---|---|---|
| 16.1 | Role-appropriate navigation | Derived from permissions and feature flags | Done |
| 16.2 | Global patient search in the shell | Fast, tenant-scoped | Done |
| 16.3 | Dashboard per role | Worklists and counts | Done |
| 16.4 | Clear errors, no internal terms | Stable codes mapped to sentences | Done |
