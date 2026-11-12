# Modules

Per-module purpose, entities, workflow and state rules, permissions and audit events (CLAUDE.md §54). The exact route list with permissions is generated in [`api-routes.md`](api-routes.md). Business rules live in `apps/api/src/modules/<module>/*.service.ts`; PostgreSQL enforces the hard invariants again in `packages/database/prisma/migrations`.

## Platform (`apps/api/src/common`, `modules/auth|tenants|facilities|users|settings|numbering|audit`)
| Concern | Behaviour |
|---|---|
| Sign-in and lock-out | Hospital code + username or email + password; one generic answer for every wrong detail; 5 wrong tries within 15 minutes lock the account for 15 minutes; an administrator can unlock it. See `docs/authentication.md`. |
| Tenant context | Taken only from the authenticated session; `AuthGuard` re-reads user, tenant, facility and permissions from the database on every request. |
| Auth | tenant code + username/email + password; scrypt hashes; 15-minute access JWT; opaque rotating refresh tokens (reuse revokes the family); lockout after repeated failures; per-route rate limits. |
| Permissions | `packages/shared/src/permissions.ts` (single source). Roles are bundles of permissions; custom roles supported. |
| Idempotency | `Idempotency-Key` mandatory on payments, refunds, credit notes, dispensing, purchases, stock adjustments; optional on patient create, walk-in, admit. A reused key with a different body is rejected (422). |
| Numbering | Concurrency-safe counters per tenant/facility (MRN, visit, admission, invoice, receipt, prescription, dispense…). |
| Settings | Per-facility, validated by a key registry; feature flags; print header/footer; discharge rules. Changes audited. |
| Errors | Stable codes, no stack traces, request id in every error and log line. |

## Clinical front desk
| Module | Entities and rules | Key permissions | Audit events |
|---|---|---|---|
| Patients | One canonical patient; MRN as identifier; trigram duplicate detection (never auto-merge); optimistic `version` on update; override needs `DUPLICATE_OVERRIDE` and is audited | PATIENT_READ/CREATE/UPDATE, DUPLICATE_OVERRIDE | PATIENT_CREATED, PATIENT_UPDATED, PATIENT_DUPLICATE_OVERRIDDEN |
| Appointments | Practitioner schedules, slot availability; exclusion constraints prevent double booking; walk-in; overbooking needs APPOINTMENT_OVERBOOK | APPOINTMENT_* | APPOINTMENT_CREATED/RESCHEDULED/CANCELLED/CHECKED_IN/NO_SHOW |
| Privacy | Append-only patient consent records (privacy notice acknowledged, appointment reminders) with history; reminders honour withdrawal and the `REMINDERS_REQUIRE_CONSENT` setting; log of patients' data requests (access, correction, erasure, grievance) with a closed-state outcome and no deletion. Records and tracks only: nothing erases or corrects data, and no legal compliance is claimed. See `docs/privacy.md` | PATIENT_READ, PATIENT_UPDATE, PRIVACY_MANAGE | CONSENT_GRANTED, CONSENT_WITHDRAWN, DATA_REQUEST_CREATED, DATA_REQUEST_UPDATED |
| Follow-ups | FOLLOW_UP appointments linked to the ordering consultation (same patient, never re-pointed), booked by the treating doctor; SMS reminders planned per facility setting, replaced on reschedule, cancelled on cancel/no-show/check-in; provider interface (log-only by default). See `docs/follow-ups.md` | FOLLOWUP_SCHEDULE, APPOINTMENT_* | FOLLOW_UP_SCHEDULED, APPOINTMENT_* |
| OPD queue | Token per day per doctor; `call-next` uses `SKIP LOCKED`; completion blocked while the consultation is a draft; priority/emergency | QUEUE_READ/MANAGE | QUEUE_CALL, QUEUE_START… , QUEUE_PRIORITY_CHANGED |
| Encounters, vitals | Every clinical record references an encounter; vitals are append-only with enter-in-error | VITALS_READ/CREATE | ENCOUNTER_OPENED, VITALS_RECORDED, VITALS_ENTERED_IN_ERROR |

## Clinical records
| Module | Rules | Permissions | Audit events |
|---|---|---|---|
| Consultation | DRAFT → SIGNED → AMENDED; signed content is never overwritten; amendment keeps every version with reason and actor | CONSULTATION_READ/CREATE/SIGN/AMEND | CONSULTATION_STARTED/SIGNED/AMENDED, DIAGNOSIS_RECORDED/REMOVED |
| Allergies | Recorded with severity; status changes keep history; matched against every prescription and dispense (acknowledgement is audited) | ALLERGY_WRITE | ALLERGY_RECORDED, ALLERGY_STATUS_CHANGED, *_ALLERGY_ACKNOWLEDGED |
| Prescriptions | One draft per encounter; signed with the consultation (OPD) or on its own (IPD orders); amendments supersede; stopping an item keeps the original | PRESCRIPTION_READ/CREATE/SIGN | PRESCRIPTION_DRAFT_SAVED/SIGNED/SUPERSEDED, PRESCRIPTION_ITEM_STOPPED |

## Money
| Module | Rules | Permissions | Audit events |
|---|---|---|---|
| Billing | Draft invoices are editable; issued invoices never change (credit note, refund or cancel instead); totals computed server-side with decimal maths; split payments; overpayment rejected; deferred DB checks reconcile invoice totals to receipts, refunds and credit notes | INVOICE_*, PAYMENT_CREATE/REFUND, INVOICE_ADJUST | INVOICE_CREATED/ISSUED/CANCELLED, PAYMENT_RECEIVED, REFUND_CREATED, CREDIT_NOTE_CREATED, INVOICE_DISCOUNT_APPLIED |
| Cashier shifts | One open shift per cashier; cash needs an open shift; expected vs counted cash on close | CASHIER_SHIFT_MANAGE | SHIFT_OPENED/CLOSED |
| Pharmacy | Medicine master; batches with expiry; stock ledger is the source of truth and the balance is reconciled to it by the database; FEFO allocation under row locks; no expired or blocked batch is dispensed; returns restore stock | PHARMACY_READ/DISPENSE/PURCHASE/ADJUST_STOCK/MASTERS | PHARMACY_DISPENSED/RETURN, STOCK_OPENING_RECORDED, STOCK_ADJUSTED, PURCHASE_RECEIVED/RETURNED, MEDICINE_* |

## Inpatient
| Module | Rules | Permissions | Audit events |
|---|---|---|---|
| Beds and admissions | Ward → room → bed; one active admission per patient; one open bed assignment per admission; a bed is occupied by at most one admission; transfers keep the full bed history; admissions are closed (read-only) after discharge | ADMISSION_READ/CREATE/TRANSFER | ADMISSION_CREATED/CANCELLED, BED_TRANSFERRED, BED_STATUS_CHANGED |
| IPD charges | Pending → billed/voided; bed days accrue per assignment | CHARGE_CREATE (free-price lines need billing rights) | CHARGE_POSTED/VOIDED, BED_CHARGES_POSTED |
| Nursing and MAR | Notes with addenda; tasks; medication schedule generated from signed orders; GIVEN/MISSED/HELD/REFUSED recorded separately from the order; intake/output with enter-in-error | NURSING_READ/DOCUMENT/MEDICATION_ADMINISTER | NURSING_NOTE_*, NURSING_TASK_CREATED, MAR_SCHEDULE_GENERATED, MEDICATION_GIVEN, INTAKE_OUTPUT_* |
| Discharge | Doctor marks fit first; configurable clearance steps; waiver needs a reason; final bill from pending charges; summary prepared by the RMO / treating team, signed by the treating consultant and verified by the RMO (verification can be made mandatory; see docs/discharge-stages.md); an insurance stage reads the claim linked to the admission (documents attached, authorisation tracked; self-pay clears itself); completion releases the bed and closes the encounter; cannot complete with an unpaid final bill | ADMISSION_DISCHARGE (+ step permissions) | DISCHARGE_STEP_CLEARED/WAIVED, FINAL_INVOICE_CREATED, DISCHARGE_SUMMARY_* (STARTED, SIGNED, VERIFIED, AMENDED), ADMISSION_DISCHARGED |
| Procedures | A procedure planned for an admitted patient is chosen from the price list; the OT / procedure coordinator performs it (its charge is posted), records implants (with serial or lot number) and consumables (each a price-list item with its charge) and finalises it; a finalised or cancelled procedure and its items never change (database triggers); nothing changes once the final bill is issued; see docs/procedures.md | PROCEDURE_READ / PROCEDURE_PLAN / PROCEDURE_MANAGE | PROCEDURE_PLANNED / PERFORMED / ITEM_RECORDED / ITEM_REMOVED / FINALISED / CANCELLED |

## Documents
| Module | Rules | Permissions | Audit events |
|---|---|---|---|
| Patient files | Photo (one active) and scanned documents; PNG/JPEG/PDF only, content-checked, ≤ 5 MB, virus-scanned when a ClamAV daemon is configured; bytes on disk (S3 later), metadata in PostgreSQL; removal hides the file but keeps it and its history; the database forbids edits and deletes | PATIENT_READ (view), PATIENT_UPDATE (upload, remove) | PATIENT_FILE_UPLOADED, PATIENT_FILE_VIEWED (documents), PATIENT_FILE_REMOVED, PATIENT_FILE_REJECTED (virus found) |

## Read side
| Module | Notes |
|---|---|
| Print | Server-rendered, fully escaped HTML or PDF (`?format=pdf`) for invoice, receipt, prescription, discharge summary and patient label, from one document model; locked-down CSP; reprints are stamped "DUPLICATE COPY"; every print is audited (`DOCUMENT_PRINTED`, with its format). |
| Reports | 14 bounded operational reports (date ranges ≤ 93 days, facility-scoped). `REPORT_READ` opens every report (Administrator, Manager); each area has its own permission: `REPORT_OPD` (OPD daily / by doctor / by department — Receptionist, Doctor), `REPORT_FINANCE` (collections with payment modes, outstanding invoices, cashier shifts — Cashier, who sees only their own shifts), `REPORT_IPD` (current admissions, admissions/discharges, bed occupancy — Receptionist, Doctor, Nurse), `REPORT_PHARMACY` (sales, stock movement, current / low / near-expiry stock — Pharmacist). Stock movement reads the stock ledger: opening, units in and out by type, closing. |
| Notifications | A bell for staff with seven events (critical lab and radiology results, a patient in the queue, a prescription at the pharmacy, a pharmacy bill, an outside booking, an auto-cancelled booking). Written with the event, shown live over server-sent events with polling as fallback; no patient data in a notification ([`notifications.md`](notifications.md), ADR-012). |
| Email | Emails to patients (appointment booked or cancelled, report ready, receipt): queued with the event and sent by a worker, with the patient's agreement checked twice, templates in English, Bengali and Hindi that a hospital can reword, a delivery log and a do-not-email list. No clinical content ever ([`email.md`](email.md), ADR-013). |
| Audit viewer | Read-only list with filters; the table is append-only at the database level. |

## Known limitations
See [`certification.md`](certification.md#known-limitations).
