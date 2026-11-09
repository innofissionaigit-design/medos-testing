# MedOS MLP-1 Product Specification

Status: Baseline (Stage 0). Authoritative with `CLAUDE.md`. Where the two conflict, `CLAUDE.md` wins and the conflict is recorded in §14.

## 1. Purpose

MedOS MLP-1 is the first commercially usable release of MedOS, a multi-tenant Hospital Management System for small and medium hospitals in India (initially 10–150 beds, West Bengal).

It lets a hospital run its essential daily workflow digitally:

Patient registration → OPD → consultation → billing → pharmacy → admission → nursing → discharge → operational reporting.

MLP = Minimum Lovable Product: useful, fast, reliable, understandable, auditable, secure, maintainable, commercially deployable. It is not a prototype or demo.

## 2. Target customers

Nursing homes, small multispecialty, day-care, maternity, orthopaedic, general and small surgical hospitals. Primary 10–75 beds; secondary 75–150. Geography: West Bengal first, India later.

## 3. Roles

| Role | Responsibilities |
|---|---|
| Administrator | users, permissions, masters (departments, doctors, wards/beds, services), reports, audit logs |
| Receptionist | search/register/update patient, appointments, check-in, OPD queue, admission request, basic billing items where permitted |
| Doctor | own queue, patient chart, previous encounters, vitals, consultation, diagnosis, allergies, prescribing, advice, follow-up, sign, controlled amendment |
| Nurse | ward patients, vitals, nursing notes, view medication orders, record administration, intake/output, tasks, discharge participation |
| Pharmacist | medicine master, batches, stock receipt, prescription queue, dispense, permitted returns, stock, low-stock and near-expiry review |
| Cashier | invoices where permitted, receive payment, print receipt, cashier shift, approved refunds, payment history |
| Manager / Owner | operational dashboard: revenue, OPD volume, IPD census, occupancy, pharmacy stock, outstanding invoices |

Roles are bundles of permissions only. Code checks permissions, never role names (CLAUDE.md §11).

## 4. In scope (50 items)

1 Authentication · 2 Authorization/RBAC · 3 Tenant management · 4 Facility management · 5 Hospital masters · 6 Users · 7 Doctors/practitioners · 8 Departments · 9 Patient registration · 10 Patient search · 11 Duplicate detection · 12 Appointments · 13 OPD queue · 14 Encounter foundation · 15 Vitals · 16 OPD consultation · 17 Diagnoses · 18 Allergies · 19 Medication orders · 20 Prescription printing · 21 Consultation signing/amendment · 22 Service catalogue · 23 Billing · 24 Payments · 25 Receipts · 26 Refunds/adjustments · 27 Cashier shifts · 28 Medicine master · 29 Batch master · 30 Stock ledger · 31 Basic procurement · 32 Dispensing · 33 Wards · 34 Rooms · 35 Beds · 36 IPD admission · 37 Bed allocation · 38 Bed transfer · 39 Basic IPD charges · 40 Nursing worklist · 41 Nursing notes · 42 MAR · 43 Intake/output · 44 Discharge workflow · 45 Discharge summary · 46 Print templates · 47 Core reports · 48 Audit trail · 49 Security controls · 50 Backup and deployment readiness.

## 5. Explicitly out of scope

AI of any kind (scribe, diagnosis, prescribing, nursing prioritisation, command centre) · ABDM/ABHA/HIP/HIU/NHCX · Swasthya Sathi · PM-JAY · LIMS/pathology · radiology/PACS/DICOM · OT/anaesthesia · blood bank · dialysis · IVF · dental charting · advanced emergency · ICU advanced monitoring · insurance/TPA claims · HRMS/payroll/attendance · ERP accounting/general ledger · patient mobile app · telemedicine · home healthcare · ambulance · CRM/marketing · advanced procurement/approval hierarchies/tenders · advanced packages · DRG · advanced analytics/warehouse/predictive · multi-country.

Any such suggestion goes to `docs/backlog.md`, never into code.

## 6. Core principles

1. **One Patient** – a single canonical Patient (+ PatientIdentifier) used by OPD, IPD, pharmacy, billing, nursing (ADR-005).
2. **One Encounter model** – OPD and IPD share `Encounter`; future EMERGENCY/TELECONSULT/DAYCARE (ADR-006).
3. **One numbering engine** – MRN, OPD visit, admission, invoice, receipt, prescription; concurrency-safe.
4. **Immutable critical records** – signed consultation, issued invoice, payment, refund, medication administration, stock transaction, discharge record, audit history. Corrections only via controlled workflows (ADR-007, ADR-008).
5. **Configuration, not custom code** – logo, numbering pattern, receipt footer, prices, labels, enabled modules.

## 7. Entity overview

Tenant, Facility, Department, User, Role, Permission, Practitioner, StaffProfile · Patient, PatientIdentifier · Appointment, PractitionerSchedule · Encounter, QueueEntry, Observation, ClinicalNote, Diagnosis, Allergy, MedicationOrder, MedicationOrderItem, FollowUp · Service · Invoice, InvoiceLine, Payment, Refund, CreditNote, CashierShift · Medicine, MedicineBatch, Supplier, Purchase, PurchaseItem, StockLedger, Dispense, DispenseItem · Ward, Room, Bed, Admission, BedAssignment, Charge · NursingNote, NursingTask, MedicationAdministration, IntakeOutput · DischargeSummary · AuditEvent, Document, NumberSequence.

Entities the spec implies but does not list (added by Stage 0, to be confirmed in the owning stage): `RefreshToken`/`Session`, `UserRole`/`RolePermission`, `PaymentMode`, `PaymentAllocation`, `PrintTemplate`, `TenantSetting`/`FeatureFlag`, `ConsultationVersion` (amendment history), `StockBalance` (materialized), `DischargeClearance`, `DuplicateOverride`.

## 8. Modules

Each module lists: actors · key fields · statuses/rules · Definition of Done (DoD). All modules inherit the cross-cutting requirements in §9–§12.

### M1 Authentication (Stage 3)
Login (username or email + password), logout, access token, refresh token with rotation, revocation, inactive-user and inactive-tenant rejection, facility selection, Argon2-class hashing, rate limiting, no tokens/passwords in logs. Audit: login success, failure (where appropriate), logout, refresh revocation.
**DoD:** integration tests pass; unauthenticated requests rejected on protected routes; inactive users cannot authenticate.

### M2 RBAC (Stage 4)
Permission-based. Permission set (CLAUDE.md §11): PATIENT_{READ,CREATE,UPDATE}; APPOINTMENT_{READ,CREATE,UPDATE,CANCEL}; QUEUE_{READ,MANAGE}; CONSULTATION_{READ,CREATE,SIGN,AMEND}; VITALS_{READ,CREATE}; PRESCRIPTION_{READ,CREATE,SIGN}; INVOICE_{READ,CREATE,ISSUE,DISCOUNT,CANCEL}; PAYMENT_{CREATE,REFUND}; PHARMACY_{READ,DISPENSE,PURCHASE,ADJUST_STOCK}; ADMISSION_{READ,CREATE,TRANSFER,DISCHARGE}; NURSING_{READ,DOCUMENT,MEDICATION_ADMINISTER}; REPORT_READ; ADMIN_{USERS,MASTERS,SETTINGS}; AUDIT_READ. The list is a minimum; additions are listed in §14.
**DoD:** unauthorized roles are rejected on direct API calls.

### M3 Tenant and facility (Stage 2)
Tenant: id, name, code, status, timezone, default currency, timestamps. Facility: id, tenantId, name, code, address, city, district, state, postalCode, phone, email, GST details, timezone, status.
**DoD:** cross-tenant tests pass; Tenant A can never read Tenant B data or learn it exists.

### M4 Hospital masters (Stage 5, extended in 17, 22, 26)
Departments, practitioners, staff, service catalogue, payment modes, wards, rooms, beds, medicines, suppliers, number sequences. Active/inactive, tenant scope, facility scope where appropriate, audited.
**DoD:** administrator can configure everything needed for OPD, IPD, pharmacy and billing.

### M5 Number sequence engine (Stage 6)
Sequences: MRN, OPD visit (`OPD_VISIT`), admission, invoice, receipt, prescription. Configurable format, e.g. `WB01-000001`, `OPD-2026-000001`, `ADM-…`, `INV-…`, `RCT-…`. Atomic, no `count+1`, no duplicates under parallel requests.
**DoD:** concurrency tests prove uniqueness.

### M6 Patient registration (Stage 7)
Fields: MRN, first/last name, gender, DOB or estimated age, mobile, address, city, district, state, postal code, guardian, emergency contact, blood group (opt), photo (opt).
Flow: search → possible matches → select existing or create → MRN generated → saved → audit.
Validation: name required; gender per policy; DOB or estimated age; valid phone; tenant-scoped uniqueness.
Screens: patient search, quick registration, full registration, profile, demographic edit. Target: new patient in ≈45 s.
**DoD:** register, then retrieve by MRN, name or mobile.

### M7 Duplicate detection (Stage 8)
Checks: exact mobile; mobile + similar name; name + DOB; name + approximate age. Never auto-merge. User may use existing or deliberately create new; the override is audited.
**DoD:** potential duplicates shown before registration is finalised.

### M8 Appointments (Stage 10)
Fields: patient, practitioner, department, facility, date, start time, duration, type, status, notes.
Statuses: `BOOKED, CHECKED_IN, WAITING, IN_CONSULTATION, COMPLETED, NO_SHOW, CANCELLED`.
Workflow: create, walk-in, reschedule, cancel, check-in, no-show. Prevent accidental double-booking; authorised override only where explicitly supported. Screens: today's appointments, doctor calendar, create, details.
**DoD:** patient moves from booked appointment to checked-in OPD queue.

### M9 OPD queue (Stage 11)
Queue entry: patient, encounter, doctor, department, token number, priority, checked-in / called / consultation-started / completed times.
Statuses: `WAITING, CALLED, IN_CONSULTATION, COMPLETED, SKIPPED, CANCELLED`.
Reception view: token, patient, doctor, department, waiting time, status. Doctor view: current, next, waiting, completed.
**DoD:** a checked-in patient appears in the correct queue automatically.

### M10 Encounter (Stage 9)
Types `OPD, IPD`. Fields: id, tenantId, facilityId, patientId, encounterNumber, type, status, departmentId, practitionerId, startedAt, endedAt. All relevant clinical records reference the encounter.
**DoD:** OPD and IPD use the common model.

### M11 Vitals / observations (Stage 12)
Types: systolic BP, diastolic BP, pulse, respiratory rate, temperature, SpO2, weight, height, BMI, blood glucose. Fields: patient, encounter, type, value, unit, recordedAt, recordedBy. Append-only, timestamped; corrections are new entries/entered-in-error, never overwrite.
**DoD:** doctor reviews vitals during consultation.

### M12 OPD consultation (Stage 13)
Sections: chief complaint, HPI, past history, examination, diagnosis, allergies, medications, advice, follow-up. One primary workspace; patient header shows name, MRN, age, sex, allergies, visit info; relevant previous visits visible without leaving.
**DoD:** doctor can complete, save, sign and print a full OPD consultation.

### M13 Diagnoses (Stage 14)
Fields: patient, encounter, text, optional code, type (provisional / final / secondary), recordedBy, recordedAt. Appear in consultation and longitudinal history.

### M14 Allergies (Stage 14)
Fields: patient, allergen, type, reaction, severity, status, recordedBy, recordedAt. Patient-level, visible across future encounters, prominent. Removal/correction audited (status change, never delete).

### M15 Medication orders / prescription (Stage 15)
Item: medicine, generic, brand, strength, dosage, route, frequency, duration, quantity, instructions. Routes `ORAL, IV, IM, SC, TOPICAL, OTHER`. Frequencies `OD, BD, TDS, QID, HS, SOS, STAT, OTHER` with free-text override. Stored structurally, never only as PDF.
**DoD:** signed prescription appears in the pharmacy queue.

### M16 Consultation signing / amendment (Stage 16)
Statuses `DRAFT, SIGNED, AMENDED`. Draft editable; signed immutable. Amendment records content, reason, user, timestamp; original recoverable.
**DoD:** audit trail shows who signed and who amended.

### M17 Service catalogue (Stage 17)
code, name, category, standard price, tax configuration, active. Examples: consultation, bed charge, injection, dressing, ECG, procedure, nursing charge.

### M18 Billing (Stage 18)
Invoice: number, patient, optional encounter, facility, subtotal, discount, tax, total, paid, balance, status, issuedAt. Statuses `DRAFT, ISSUED, PARTIALLY_PAID, PAID, CANCELLED, REFUNDED`. Server computes totals; issued invoices are immutable (ADR-007).
**DoD:** OPD services can be invoiced and paid.

### M19 Payments (Stage 19)
Modes: Cash, UPI, Card, Bank Transfer, Other. Split payments. Payment may not exceed balance unless an explicit advance workflow allows it. Receipt per successful payment.

### M20 Refunds / financial corrections (Stage 20)
Refund, cancellation where appropriate, adjustment, future credit-note compatibility. Each correction: reason, user, timestamp, reference transaction. **DoD:** financial history reconstructable.

### M21 Cashier shift (Stage 21)
cashier, facility, openedAt, openingCash, closedAt, expectedCash, actualCash, difference, status. Tracks cash collections, refunds, closing reconciliation.

### M22 Medicine master (Stage 22)
brand, generic, strength, dosage form, manufacturer, optional HSN, GST config, active. Searchable; used by prescriptions and inventory.

### M23 Batch master (Stage 22)
medicine, batch no., expiry, MRP, purchase price, selling price, received qty. Expired batches cannot be dispensed.

### M24 Stock ledger (Stage 23)
Types `PURCHASE, SALE, PATIENT_RETURN, PURCHASE_RETURN, ADJUSTMENT, DAMAGE, TRANSFER`. Fields: medicine, batch, type, quantity, direction, source reference, timestamp, user. Ledger is authoritative; materialized balance must reconcile to it (ADR-008).

### M25 Basic procurement (Stage 24)
Supplier master, purchase invoice, purchase items, stock receipt, purchase return. No approval workflows.

### M26 Dispensing (Stage 25)
Pharmacist views prescription queue → selects patient → reviews → system suggests batch (FEFO) → confirms qty → stock transaction → sale linked to patient/prescription → receipt where applicable. Prevent overselling under concurrency. **DoD:** prescription → dispense → stock deduction is atomic and correct.

### M27 Ward / room / bed (Stage 26)
Ward → Room → Bed. Bed statuses `AVAILABLE, OCCUPIED, RESERVED, CLEANING, MAINTENANCE`.

### M28 IPD admission (Stage 27)
admission number, patient, encounter, consultant, department, admitted at, status, initial bed.

### M29 Bed assignment / transfer (Stage 28)
admission, bed, assignedAt, releasedAt, reason. History preserved; `Ward A → ICU → Ward B` reconstructable.

### M30 IPD charges (Stage 29)
Bed charge, doctor visit, procedure, medicine, manual service charge; tied to patient/admission; flow into final bill.

### M31 Nursing worklist (Stage 30)
Assigned ward, admitted patients, bed, patient, doctor, pending tasks, medication due, vitals due.

### M32 Nursing notes (Stage 30)
patient, encounter/admission, author, note, timestamp. Append-only; corrections additive.

### M33 MAR (Stage 31)
Statuses `DUE, GIVEN, MISSED, HELD, REFUSED`. Fields: medication order item, scheduled time, administered time, administered by, status, remarks. Order and administration stay distinct.

### M34 Intake / output (Stage 32)
Intake: oral, IV, other. Output: urine, drain, vomit, other. Fields: type, amount, unit, timestamp, user. Daily and shift totals computable.

### M35 Discharge workflow (Stage 33)
Doctor marks medically fit → nursing clearance → pending charges reviewed → pharmacy items resolved → final bill → payment → discharge completed → bed released. Clearance steps configurable. **DoD:** completion releases the bed and closes the admission.

### M36 Discharge summary (Stage 34)
Admission date, discharge date, diagnosis, hospital course, procedures, investigation summary, discharge medication, advice, follow-up. Structured, not PDF-only.

### M37 Printing (Stage 35)
Templates: OPD prescription, invoice, payment receipt, pharmacy receipt, admission form, discharge summary, patient label. Configurable logo, name, address, phone, GST, patient identity, doctor identity, footer.

### M38 Reports (Stage 36)
OPD: daily count, doctor-wise, department-wise. IPD: active admissions, daily admissions, daily discharges, bed occupancy. Financial: daily collections, payment-mode summary, cashier shift summary, outstanding invoices. Pharmacy: sales, current stock, low stock, near-expiry.

### M39 Audit trail (Stage 37 review; written from Stage 2 on)
Coverage: authentication, patient create/update, appointment cancellation, clinical signing/amendment, prescription signing, invoice issue, refund, payment, admission, bed transfer, discharge, medication administration, stock adjustment, permission changes. Fields: tenant, facility, actor, action, entity, entity id, timestamp, request id, metadata. Append-only.

## 9. Cross-cutting acceptance criteria

### 9.1 Security (release-blocking)
Authentication protection · Argon2-class password hashing · server-side RBAC · tenant isolation · facility authorization · IDOR protection · input validation · output sanitisation · no sensitive data in logs · rate limiting on sensitive endpoints · secrets outside source · immutable critical history · permission, cross-tenant and failure-path tests.

Every new tenant-owned resource gets tests for: cross-tenant read/write, cross-facility access, wrong-role access, ID enumeration (cross-tenant ID returns the same `404` as a non-existent ID), invalid state transitions, duplicate submission, replay, and concurrency where relevant. Findings are fixed with a regression test before a stage may pass.

### 9.2 Concurrency
Automated tests for: MRN, invoice number, receipt number, dispensing, stock adjustment, bed allocation, duplicate payment prevention. No sequence collisions; no negative stock; no bed held by two admissions.

### 9.3 Data integrity
Prevent or handle: orphans, invalid tenant/facility relations, negative monetary totals, invalid invoice transitions, stock underflow, duplicate sequence numbers, illegal appointment/consultation/bed transitions. Invariants live in application logic and the database (FKs, composite tenant FKs, CHECKs, unique indexes).

### 9.4 Performance
Patient search near-instant on an MLP-sized dataset (seed: 1,000 patients); paginated lists; no N+1; OPD flow never loads full history; bounded dashboard queries; indexes match query patterns. Measured, not assumed.

### 9.5 UX
Fast reception search/registration; doctor completes visit on one screen; nurse ward worklist; pharmacist dispenses from the queue; cashier collects/reconciles quickly; admin finds reports easily. Every form: loading, validation, error and success states. Critical actions need deliberate confirmation. Desktop-first for reception/cashier/pharmacy; tablet-usable for doctor/nurse.

### 9.6 Accessibility
Semantic labels, keyboard-operable forms, visible focus, accessible dialogs, no click-only divs, status never conveyed by colour alone.

### 9.7 Localization
English first; strings externalised so Bengali/Hindi can follow; no user-facing text embedded in domain logic.

## 10. Mandatory E2E scenarios

Both run against the real test database with a real API; core backend behaviour is never mocked. Each step asserts persisted state, not only UI text.

### 10.1 OPD (Stage 41)
| # | Step | Must assert |
|---|---|---|
| 1 | Receptionist logs in | JWT/session issued; nav shows receptionist modules only |
| 2 | Searches patient | no match found; tenant-scoped |
| 3 | Registers patient | MRN generated per format; `PATIENT_CREATED` audit |
| 4 | Appointment or walk-in check-in | appointment `CHECKED_IN`; OPD encounter number issued |
| 5 | Token / queue | queue entry `WAITING` under the right doctor with a token |
| 6 | Doctor opens patient | patient header shows allergies and visit info |
| 7 | Vitals recorded | observations timestamped, attributed |
| 8 | Consultation documented | draft saved |
| 9 | Diagnosis recorded | linked to patient + encounter |
| 10 | Prescription created | structured items; prescription number issued |
| 11 | Consultation signed | status `SIGNED`; edit attempt rejected; audit |
| 12 | Invoice created | server-computed totals; issued → immutable |
| 13 | Payment (split) | receipt number issued; balance 0; status `PAID` |
| 14 | Pharmacy queue | signed prescription visible |
| 15 | Pharmacist dispenses | FEFO batch; ledger SALE row; sale linked to prescription |
| 16 | Stock | batch balance decreased by exact quantity and reconciles to ledger |

### 10.2 IPD (Stage 42)
| # | Step | Must assert |
|---|---|---|
| 1 | Patient search/registration | canonical patient reused |
| 2 | Admission | admission number; IPD encounter |
| 3 | Bed allocation | bed `OCCUPIED`; assignment row opened |
| 4 | Nursing worklist | patient + bed + pending tasks visible |
| 5 | Vitals | recorded against admission encounter |
| 6 | Doctor medication order | order items exist; no administration implied |
| 7 | Medication administration | MAR row `GIVEN` by nurse, distinct from order |
| 8 | Nursing note | additive, timestamped |
| 9 | IPD charge | charge linked to admission |
| 10 | Bed transfer | first assignment closed, second opened; history reconstructs |
| 11 | Doctor marks fit for discharge | state transition validated |
| 12 | Discharge summary | structured sections saved |
| 13 | Final invoice | includes bed + charges; server totals |
| 14 | Payment | balance 0 |
| 15 | Discharge completion | admission closed |
| 16 | Bed | released (`CLEANING` or `AVAILABLE` per config) |

## 11. Production-readiness checklist

**Application:** all modules implemented · both E2E pass · role-specific navigation · print output · configuration · audit trail.
**Database:** migrations committed and never edited after use · constraints and indexes reviewed · backup configured · restore tested.
**Security:** permission, tenant-isolation and IDOR tests · auth hardening · no secrets committed · dependency vulnerability scan clean of critical/high without justification.
**Testing:** unit · integration · OPD E2E · IPD E2E · failure-path · concurrency.
**Infrastructure:** local, staging, production environments · HTTPS · health checks · structured logs · error monitoring · encrypted backups · restore process.
**Documentation:** README · architecture · product spec · ADRs · API docs · deployment guide · backup/restore guide · license/dependency report.

## 12. Release-blocking issues

Cross-tenant data exposure · authorization bypass · incorrect billing totals · duplicate financial identifiers · negative stock from concurrency · MAR corruption · duplicate bed allocation · lost clinical history · silent overwrite of signed records · failed backup restoration · exposed production secrets · failing mandatory E2E.

## 13. MLP-1 definition of done

1 all in-scope modules implemented · 2 OPD E2E passes · 3 IPD E2E passes · 4 tenant isolation tests pass · 5 financial reconciliation tests pass · 6 pharmacy stock reconciliation passes · 7 bed-allocation concurrency passes · 8 clinical signing/amendment rules pass · 9 audit events exist for critical operations · 10 backups configured and restoration tested · 11 production build passes · 12 dependency/license review complete · 13 no release-blocking defects.

## 14. Spec gaps and conflicts found in Stage 0

These need a decision at or before the stage named. None is silently resolved in code.

| # | Gap / conflict | Needed by | Proposed handling |
|---|---|---|---|
| G1 | Spec says "OPD encounter" number; CLAUDE.md §46 names the sequence `OPD_VISIT`. | Stage 6 | Use `OPD_VISIT` (CLAUDE.md wins); label "Visit No." in UI. |
| G2 | Appointment and queue both have `WAITING`/`IN_CONSULTATION`; two sources of truth risk. | Stage 10/11 | ADR: appointment owns scheduling lifecycle; queue entry owns real-time flow; sync rules in one domain service. |
| G3 | Permission list lacks cashier shift, allergies, discharge summary, print, masters-read, patient-merge/duplicate-override. | Stage 4 | Extend list via ADR; names `CASHIER_SHIFT_MANAGE`, `ALLERGY_WRITE`, `DUPLICATE_OVERRIDE`, etc. |
| G4 | Tenant resolution at login (username unique per tenant?). | Stage 3 | Login takes tenant code + identifier; never trusts tenant from body afterwards. ADR if changed. |
| G5 | RLS (row-level security) as defence-in-depth is not decided. | Stage 2 | Evaluate; record result as ADR-004 amendment. |
| G6 | GST treatment of services vs medicines; rounding rule. | Stage 17/18 | Per-line tax config, decimal-safe, rule documented; **legal/tax review required** (not engineering certainty). |
| G7 | Must a cashier shift be open to take cash payments? | Stage 19/21 | Proposed: cash requires open shift; non-cash does not. Confirm. |
| G8 | Advance payments / over-payment workflow unspecified. | Stage 19 | Default: reject; advance deferred to backlog. |
| G9 | `REFUNDED` invoice status vs partial refunds. | Stage 20 | Model refunds as separate records; `REFUNDED` only for full refund; document. |
| G10 | Prescription signing permission vs consultation signing. | Stage 15/16 | Prescription is signed as part of consultation sign; `PRESCRIPTION_SIGN` retained for prescriptions outside a consultation (IPD orders). |
| G11 | IPD medication orders reuse `MedicationOrder` with IPD encounter. | Stage 15/31 | Single model; document in M15/M33. |
| G12 | PDF/print technology unspecified. | Stage 35 | Prefer print-CSS HTML; any PDF library needs a licence review. |
| G13 | Password hashing library (native addon vs WASM). | Stage 3 | Evaluate `argon2` / `@node-rs/argon2` (both believed MIT; verify at install). |
| G14 | Hospital data-protection obligations (India DPDP Act 2023, record retention). | Stage 38/40 | Flag for legal review; engineering does not certify compliance. |
| G15 | Redis server and MinIO licences are not permissive (see `docs/dependencies/licenses.md`). | Stage 1 | Decide Redis/Valkey and object-storage choice **before** adding to Compose. |

## 15. Delivery stages

Executed one at a time, each gated (see `docs/backlog.md` for the stage map and gate definition). Stage 0 produced this document set only; no application code exists.
