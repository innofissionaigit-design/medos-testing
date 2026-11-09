# MedOS — Claude Code Project Instructions

MedOS is a multi-tenant Hospital Management System for small and medium hospitals in India, initially focused on 10–150 bed hospitals in West Bengal.

The immediate product target is MLP-1.

MLP-1 includes:

* Authentication and authorization
* Tenant and facility management
* Staff and doctor management
* Patient registration
* Appointment management
* OPD queue
* OPD consultation
* Vitals
* Prescription
* Billing and payments
* Pharmacy
* Basic IPD
* Bed management
* Basic nursing
* Discharge
* Core operational reports
* Audit trail

MLP-1 explicitly excludes:

* AI features
* ABDM integration
* Swasthya Sathi integration
* LIMS
* Radiology
* PACS
* OT
* Insurance claims
* Payroll
* HRMS
* Full ERP accounting
* Patient mobile app
* Telemedicine
* Advanced analytics

Do not implement out-of-scope functionality unless explicitly requested.

If an out-of-scope feature becomes relevant, document it in:

`docs/backlog.md`

Do not implement it automatically.

## 1. Product principles

MedOS must optimize for:

1. Fast hospital workflows
2. Strong clinical and financial auditability
3. Multi-tenant security
4. Simple UX
5. Minimal clicks
6. Keyboard-friendly workflows
7. Low training requirements
8. Reliable operation in small and medium hospitals
9. Configurability instead of customer-specific code
10. Future compatibility with Indian digital-health standards

The system should be usable by hospital staff with limited technical experience.

Never expose internal database terminology unnecessarily in the UI.

Prefer hospital terminology such as:

* Patient
* Visit
* Admission
* Invoice
* Payment
* Prescription
* Ward
* Bed
* Nurse
* Doctor

Avoid labels such as:

* Entity
* Transaction object
* Master record
* Encounter object

unless appropriate for internal engineering use.

## 2. Architecture

Use a modular monolith.

Do not introduce microservices unless explicitly requested.

Repository structure:

```
apps/
  web/
  api/

packages/
  database/
  ui/
  shared/
  config/

docs/
  product/
  architecture/
  adr/
  backlog.md
```

Frontend:

* Next.js
* TypeScript
* Tailwind CSS
* shadcn/ui
* TanStack Query
* React Hook Form
* Zod

Backend:

* NestJS
* TypeScript
* Prisma
* PostgreSQL

Infrastructure:

* Redis
* S3-compatible object storage
* Docker
* Docker Compose

Testing:

* Jest or Vitest for unit testing
* API integration testing
* Playwright for E2E testing

Use strict TypeScript everywhere.

Avoid `any`.

## 3. Backend module structure

Backend modules live under:

```
apps/api/src/modules/
```

Examples:

```
auth/
tenants/
facilities/
users/
practitioners/
patients/
appointments/
queue/
encounters/
clinical/
billing/
pharmacy/
ipd/
nursing/
reports/
audit/
```

Each module should contain only relevant files.

Typical structure:

```
module/
  dto/
  entities/
  controllers/
  services/
  repositories/
  guards/
  tests/
  module.ts
```

Do not put business logic in controllers.

Controllers should:

* validate request boundary
* invoke services
* return responses

Services should contain business rules.

Repositories/data access should contain persistence concerns where appropriate.

## 4. Multi-tenancy rules

MedOS is multi-tenant from day one.

Every hospital-owned record must include:

```
tenantId
```

Facility-specific records must additionally include:

```
facilityId
```

where applicable.

Never trust `tenantId` or `facilityId` supplied directly by the frontend for authorization.

Tenant and facility context must come from the authenticated session.

Every database query involving tenant-owned data must be tenant-scoped.

Cross-tenant access is a critical security defect.

Whenever adding a new tenant-owned entity:

1. include `tenantId`
2. add relevant indexes
3. enforce tenant-aware uniqueness
4. add authorization tests
5. add cross-tenant isolation tests

Never create queries such as:

```
findUnique({
  where: { id }
})
```

for tenant-owned resources unless tenant isolation is guaranteed elsewhere and clearly documented.

Prefer tenant-scoped access patterns.

## 5. Facility hierarchy

The conceptual hierarchy is:

```
Tenant
  ↓
Facility
  ↓
Department
  ↓
Ward / Room / Bed
```

A tenant may eventually contain multiple facilities.

Do not assume one hospital equals one database.

## 6. Core identity rules

Use UUIDs for internal primary keys.

Human-readable identifiers must be separate fields.

Examples:

* MRN
* OPD visit number
* Admission number
* Invoice number
* Receipt number
* Prescription number

Human-readable identifiers must be generated transactionally.

Never generate business identifiers using:

```
count + 1
```

Use a sequence mechanism that is safe under concurrency.

## 7. Patient identity

There must be one canonical patient record.

Do not create separate patient identities for:

* OPD
* IPD
* pharmacy
* billing
* nursing

All modules reference the same patient entity.

The patient record must support multiple identifiers through a separate patient identifier model.

Examples:

* MRN
* ABHA later
* legacy hospital ID
* external ID

Do not put every possible external identifier directly into the Patient table.

## 8. Encounter model

All clinical activity must reference an Encounter where applicable.

Supported encounter types for MLP-1:

```
OPD
IPD
```

Future types may include:

```
EMERGENCY
TELECONSULT
DAYCARE
```

Do not create unrelated module-specific visit systems.

Clinical entities such as:

* diagnosis
* vitals
* clinical notes
* prescriptions
* orders

should reference the encounter whenever clinically appropriate.

## 9. Clinical data principles

Clinical history must be auditable.

Never silently overwrite:

* signed consultation notes
* diagnoses
* allergies
* prescriptions
* medication administration
* vitals
* nursing notes

Corrections must preserve history.

Use statuses such as:

```
DRAFT
SIGNED
AMENDED
```

where appropriate.

Signed clinical content must not be directly overwritten.

Amendments should include:

* original record
* amended version
* reason
* actor
* timestamp

Patient safety is more important than convenience.

## 10. Clinical AI

AI is out of scope for MLP-1.

Do not add:

* diagnosis generation
* AI prescriptions
* AI clinical advice
* AI summarization
* ambient scribe
* predictive deterioration
* AI nursing assistant

unless explicitly requested in a later milestone.

Design the data model cleanly enough that AI can be added later.

## 11. Authorization

Use permission-based RBAC.

Avoid authorization logic such as:

```
if (user.role === "ADMIN")
```

Prefer permissions.

Example permissions:

```
PATIENT_READ
PATIENT_CREATE
PATIENT_UPDATE

APPOINTMENT_READ
APPOINTMENT_CREATE
APPOINTMENT_UPDATE
APPOINTMENT_CANCEL

QUEUE_READ
QUEUE_MANAGE

CONSULTATION_READ
CONSULTATION_CREATE
CONSULTATION_SIGN
CONSULTATION_AMEND

VITALS_READ
VITALS_CREATE

PRESCRIPTION_READ
PRESCRIPTION_CREATE
PRESCRIPTION_SIGN

INVOICE_READ
INVOICE_CREATE
INVOICE_ISSUE
INVOICE_DISCOUNT
INVOICE_CANCEL

PAYMENT_CREATE
PAYMENT_REFUND

PHARMACY_READ
PHARMACY_DISPENSE
PHARMACY_PURCHASE
PHARMACY_ADJUST_STOCK

ADMISSION_READ
ADMISSION_CREATE
ADMISSION_TRANSFER
ADMISSION_DISCHARGE

NURSING_READ
NURSING_DOCUMENT
NURSING_MEDICATION_ADMINISTER

REPORT_READ

ADMIN_USERS
ADMIN_MASTERS
ADMIN_SETTINGS
AUDIT_READ
```

Authorization must always be enforced server-side.

Frontend permission checks are only for UX.

Never rely on frontend hiding alone.

## 12. Authentication

Authentication must support:

* username or email
* password
* access token
* refresh token
* logout
* token revocation
* inactive user handling

Passwords must use a modern password hashing algorithm such as Argon2.

Do not store plaintext passwords.

Do not log passwords.

Do not log tokens.

Refresh tokens must be revocable.

Rate-limit authentication endpoints.

## 13. Audit rules

All important clinical, financial, security and administrative mutations must create audit events.

Examples:

* login success
* login failure where appropriate
* patient created
* patient demographics updated
* appointment cancelled
* consultation signed
* consultation amended
* prescription signed
* invoice issued
* discount approved
* payment received
* refund created
* admission created
* bed transferred
* patient discharged
* medication administered
* stock adjusted
* user permission changed

Audit events should include:

```
tenantId
facilityId when applicable
actorUserId
action
entityType
entityId
timestamp
requestId if available
metadata
```

Do not store unnecessary complete clinical payloads in audit logs.

Prefer targeted change metadata.

Audit logs should not be editable through normal application workflows.

## 14. Financial integrity

Financial data must be treated as accounting-grade data.

Invoices may be edited while in draft state.

Once an invoice is issued:

* do not silently change invoice lines
* do not overwrite financial totals
* do not delete the invoice

Use:

* credit notes
* refunds
* reversals
* adjustments

Financial mutations should use database transactions.

Invoice totals must be calculated server-side.

Never trust totals supplied by the frontend.

Payments must support:

```
CASH
UPI
CARD
BANK_TRANSFER
OTHER
```

Support split payments.

Example:

```
₹500 cash
₹700 UPI
```

All money values must use decimal-safe database types.

Never use floating-point arithmetic for money.

## 15. Pharmacy integrity

Pharmacy inventory must use a stock ledger.

Do not treat a single `currentQuantity` field as the only source of truth.

Stock movements should include:

```
PURCHASE
SALE
PATIENT_RETURN
PURCHASE_RETURN
ADJUSTMENT
DAMAGE
TRANSFER
```

Every movement must record:

* medicine
* batch
* quantity
* direction
* reason/type
* user
* timestamp
* reference transaction if applicable

Current stock may be cached for performance, but the ledger must remain reconstructable.

Dispensing must be safe under concurrent use.

Prevent overselling under race conditions.

Use database transactions and appropriate locking.

Prefer FEFO for batch suggestion:

First Expiry, First Out.

Do not dispense expired batches.

## 16. Medication orders vs administration

A medication order is not the same as medication administration.

Doctor creates medication order.

Nurse records actual administration separately.

Medication administration statuses:

```
DUE
GIVEN
MISSED
HELD
REFUSED
```

Administration records should capture:

* medication order item
* scheduled time
* actual time
* nurse/user
* status
* remarks

Never infer medication administration merely because a drug was prescribed.

## 17. Bed management

Beds must have explicit operational status.

Example:

```
AVAILABLE
OCCUPIED
RESERVED
CLEANING
MAINTENANCE
```

Bed transfers must preserve assignment history.

Never overwrite the current bed without creating historical assignment records.

The system must support reconstructing:

```
Ward A → ICU → Ward B
```

## 18. Soft deletion

Do not hard-delete clinical or financial records.

Administrative master data may support soft deletion or inactive status.

Prefer:

```
ACTIVE
INACTIVE
```

over deletion where practical.

Never cascade-delete patient clinical history.

Never cascade-delete financial history.

## 19. Database standards

Use:

* proper foreign keys
* not-null constraints
* tenant-aware uniqueness
* indexes for common queries
* database transactions for atomic workflows
* migrations for every schema change

Never edit already deployed production migrations.

Create a new migration.

All migrations must be committed to git.

Important workflows must have concurrency tests.

Examples:

* MRN generation
* invoice number generation
* stock dispensing
* bed allocation
* payment posting

## 20. API standards

All API endpoints must live under:

```
/api/v1
```

Use REST unless there is a compelling reason otherwise.

Use predictable response shapes.

Validate all input.

Reject unexpected data when appropriate.

Use consistent error structures.

Example:

```
{
  "error": {
    "code": "PATIENT_NOT_FOUND",
    "message": "Patient not found"
  }
}
```

Do not expose internal stack traces to clients.

Do not expose database errors directly.

## 21. Validation

Every API input must be validated.

Examples:

* valid date
* valid mobile format where appropriate
* valid enum
* non-negative amount
* required patient identity fields
* valid state transitions
* valid facility context

Business validation must happen server-side.

Frontend validation improves UX but is not authoritative.

## 22. State transitions

Use explicit state-transition rules.

Example appointment states:

```
BOOKED
CHECKED_IN
WAITING
IN_CONSULTATION
COMPLETED
NO_SHOW
CANCELLED
```

Do not allow arbitrary status mutation.

Example:

```
COMPLETED → BOOKED
```

should not occur without a deliberate business workflow.

Implement transition validation centrally where appropriate.

## 23. Frontend UX principles

Hospital workflows must be fast.

Optimize common tasks before rare tasks.

Target:

Patient registration:
under 45 seconds for a new patient.

Common OPD workflow:
minimal clicks.

Doctor consultation:
single primary consultation screen.

Nurse:
single worklist / ward view.

Pharmacist:
prescription queue first.

Cashier:
billing and payment first.

Use keyboard navigation wherever practical.

Avoid unnecessary modal dialogs.

Avoid excessive confirmation prompts.

Confirmation is required for destructive/high-risk actions such as:

* refund
* invoice cancellation
* clinical amendment
* patient discharge
* stock adjustment
* permission change

## 24. Role-specific navigation

Receptionist navigation should prioritize:

```
Dashboard
Patients
Appointments
OPD Queue
Admissions
Billing
```

Doctor:

```
My Queue
Patients
Today's Visits
```

Nurse:

```
Ward
Tasks
Medication
```

Pharmacist:

```
Prescription Queue
Sales
Stock
Purchases
```

Cashier:

```
Billing
Payments
Refunds
Shift
```

Administrator:

```
Dashboard
Reports
Masters
Users
Settings
Audit
```

Do not show irrelevant modules to users without access.

## 25. Global patient search

Global patient search should be easy to access from the main application shell.

Minimum search fields:

* MRN
* mobile
* patient name

Search must be tenant-scoped.

Later it may include ABHA.

Do not perform expensive unindexed wildcard queries on large tables.

## 26. Duplicate patient detection

Patient registration should detect possible duplicates.

Check combinations such as:

* exact mobile
* similar name + mobile
* name + date of birth
* name + approximate age

Never automatically merge patient records.

Show possible matches.

Allow authorized users to:

* select existing patient
* deliberately create a new patient

Any override should be auditable.

## 27. Printing

Printing is a core product requirement.

MLP-1 should support configurable print templates for:

* OPD prescription
* invoice
* receipt
* pharmacy receipt
* admission form
* discharge summary
* patient label

Templates must support configurable:

* hospital name
* logo
* address
* contact details
* GST details
* footer
* doctor details
* patient identifiers

Do not hard-code hospital-specific branding in UI components.

## 28. Localization

Design UI strings so localization can be introduced cleanly.

Initial product language may be English.

Future languages include:

* Bengali
* Hindi

Do not hard-code user-facing strings deeply inside business logic.

Use localization-friendly frontend patterns.

## 29. Configuration over customization

Never create customer-specific code such as:

```
if (hospital.name === "ABC Hospital") {
  ...
}
```

Use configuration.

Examples:

* custom numbering format
* labels
* receipt footer
* hospital logo
* consultation price
* enabled modules
* print settings

If a requirement appears customer-specific, first ask whether it can be represented as configuration.

## 30. Feature flags

Support facility or tenant feature flags where useful.

Examples:

```
PHARMACY_ENABLED
IPD_ENABLED
NURSING_ENABLED
```

Do not create code forks per hospital.

## 31. Reports

MLP-1 reporting should focus on operational needs.

Required reports include:

* daily OPD count
* doctor-wise OPD count
* department-wise OPD count
* daily collections
* payment mode summary
* cashier shift summary
* current admissions
* daily admissions
* daily discharges
* bed occupancy
* pharmacy sales
* current pharmacy stock
* low stock
* near-expiry stock
* outstanding invoices

Do not build a generic BI platform during MLP-1.

## 32. Security

Treat healthcare data as sensitive.

Required practices:

* HTTPS in production
* encrypted storage where supported
* RBAC
* tenant isolation
* secure password hashing
* secure refresh-token handling
* input validation
* rate limiting
* secure headers
* request IDs
* secrets outside source code
* no sensitive data in logs

Do not log:

* passwords
* access tokens
* refresh tokens
* full patient records
* complete prescriptions
* full consultation payloads

Do not expose secrets in frontend bundles.

Do not commit `.env` files containing secrets.

## 33. Logging

Use structured logging.

Logs should include where appropriate:

* requestId
* tenantId
* facilityId
* userId
* route
* status
* error code

Avoid patient names and clinical content in standard application logs.

Good:

```
invoice_issue_failed
invoiceId=...
requestId=...
```

Bad:

```
Full patient payload: {...}
```

## 34. Error handling

All unexpected errors should be captured centrally.

Production API responses must not expose:

* stack traces
* SQL
* environment values
* secrets

Create stable domain error codes.

Examples:

```
PATIENT_NOT_FOUND
APPOINTMENT_INVALID_STATE
INVOICE_ALREADY_ISSUED
PAYMENT_EXCEEDS_BALANCE
BED_NOT_AVAILABLE
INSUFFICIENT_STOCK
UNAUTHORIZED_FACILITY
```

## 35. Testing requirements

Every domain feature should include appropriate tests.

Use:

Unit tests for:

* domain rules
* calculations
* state transitions

Integration tests for:

* database behavior
* APIs
* authorization
* transactions

E2E tests for:

* complete hospital workflows

Do not consider a core workflow complete without tests.

## 36. Mandatory OPD E2E workflow

The following workflow must remain passing:

```
Receptionist login
↓
Register patient
↓
Book/check-in patient
↓
Patient enters OPD queue
↓
Doctor opens patient
↓
Vitals recorded
↓
Diagnosis recorded
↓
Prescription created
↓
Consultation signed
↓
Invoice generated
↓
Payment collected
↓
Pharmacy receives prescription
↓
Medicine dispensed
↓
Receipt generated
```

Use the real test database.

Do not mock core backend behavior in this E2E flow.

## 37. Mandatory IPD E2E workflow

The following workflow must remain passing:

```
Patient registration
↓
Admission
↓
Bed allocation
↓
Vitals
↓
Nursing note
↓
Medication administration
↓
Charge added
↓
Bed transfer
↓
Doctor discharge
↓
Final bill
↓
Payment
↓
Bed released
```

## 38. Security testing

Whenever implementing a new tenant-owned resource, test:

* cross-tenant access
* unauthorized facility access
* unauthorized role access
* object ID enumeration / IDOR
* invalid state transitions

Important modules should also test:

* duplicate submission
* replay
* concurrency
* race conditions

## 39. Performance

Do not prematurely optimize.

But avoid obvious scalability problems.

Use pagination for large lists.

Index commonly searched fields.

Avoid N+1 database queries.

Avoid fetching full patient history when only summary data is needed.

Use selective fields where appropriate.

Measure before introducing complex caching.

## 40. Redis

Redis may be used for:

* caching
* queues
* distributed locks
* rate limiting
* short-lived state

Do not use Redis as the authoritative data store for clinical or financial records.

PostgreSQL remains the source of truth.

## 41. Background jobs

Use background jobs for non-blocking work such as:

* notifications
* report generation
* file processing
* future integrations

Do not move critical financial or clinical commit logic into unreliable asynchronous flows unless designed carefully.

A successful API response for a critical transaction should mean the critical state is durably stored.

## 42. Files and documents

Use S3-compatible storage for:

* patient documents
* scanned documents
* generated reports
* print artifacts where stored

Do not store large binary files directly in PostgreSQL unless specifically justified.

Store metadata in the database.

Use access-controlled URLs.

## 43. Dates and time

Store timestamps in UTC.

Display in facility timezone.

Default initial timezone:

```
Asia/Kolkata
```

Do not assume server timezone equals hospital timezone.

Avoid storing ambiguous local timestamps without timezone context.

## 44. Money

Use INR initially.

Do not hard-code the currency symbol in business logic.

Use decimal-safe types.

Do not use JS floating point for authoritative financial calculations.

## 45. Master data

Core masters include:

* departments
* practitioners
* service catalogue
* payment modes
* wards
* rooms
* beds
* medicines
* suppliers
* number sequences

Master-data changes must be auditable where they affect billing or clinical operations.

## 46. Numbering engine

Create a reusable numbering service.

It should support sequences such as:

```
MRN
OPD_VISIT
ADMISSION
INVOICE
RECEIPT
PRESCRIPTION
```

Future formatting may support:

```
{FACILITY}-{YEAR}-{SEQUENCE}
```

Sequence generation must be concurrency-safe.

## 47. Data migration readiness

Do not tightly couple patient creation to UI assumptions.

Future hospital onboarding may import:

* patient master
* medicine master
* outstanding stock
* doctor master
* service catalogue

Keep import pathways in mind.

Do not build full migration tooling unless requested.

## 48. Demo data

Development seed data should use realistic but synthetic Indian data.

Use:

* synthetic Indian names
* synthetic addresses
* synthetic phone numbers
* synthetic clinical data

Never use real patient information.

Seed enough data to test realistic screens.

Suggested demo scale:

* 1 tenant
* 1 facility
* 8 departments
* 10 doctors
* 12 nurses
* 1,000 patients
* 100 appointments
* 30 current OPD encounters
* 20 beds
* 12 current admissions
* 100 medicines
* multiple medicine batches
* 50 invoices

## 49. CI requirements

Every pull request should run:

```
install
lint
typecheck
unit tests
integration tests
build
```

Critical E2E tests should run in CI where practical.

Do not merge code with failing checks.

## 50. Environments

Maintain separate environments:

```
local
staging
production
```

Each environment must have separate:

* database
* Redis
* storage
* secrets
* domains

Never use production data for development.

## 51. Backups

Production PostgreSQL must have automated backups.

Prefer point-in-time recovery.

Backups must be encrypted.

Restore procedures must be tested.

Do not assume successful backup creation means successful recovery.

## 52. Deployment

Use Docker.

Local development should be runnable with predictable commands.

Prefer managed PostgreSQL in production.

Do not self-host complex infrastructure unless necessary.

Production deployment should initially require explicit approval.

Do not automatically deploy every main-branch merge directly to production.

## 53. ADRs

Create Architecture Decision Records under:

```
docs/adr/
```

Use an ADR when making long-lived decisions.

Format:

```
Title
Status
Context
Decision
Alternatives Considered
Consequences
```

Examples:

```
001-modular-monolith.md
002-postgresql.md
003-prisma.md
004-multi-tenancy.md
005-stock-ledger.md
006-immutable-invoices.md
007-encounter-model.md
```

Do not create unnecessary ADRs for trivial implementation details.

## 54. Documentation

Important modules should document:

* purpose
* entities
* workflows
* state transitions
* permissions
* audit events
* known limitations

Keep documentation current when behavior changes.

Do not leave architecture documentation knowingly inconsistent with implementation.

## 55. Development workflow for Claude

Before implementing a substantial feature:

1. Read this `CLAUDE.md`
2. Read `docs/product/mlp1.md`
3. Inspect existing implementation
4. Inspect relevant schema
5. Inspect existing tests
6. Propose implementation plan before major structural changes

For substantial features, first provide:

1. current relevant architecture
2. proposed data model changes
3. API changes
4. UI changes
5. validation rules
6. permissions
7. audit events
8. edge cases
9. tests
10. migration requirements

Do not modify files until the plan is approved when explicitly asked to plan first.

## 56. Scope control

Do not expand scope because a feature "might be useful."

If the request is:

```
Build patient registration
```

do not also build:

* ABDM
* insurance
* AI duplicate detection
* telemedicine
* CRM

Stay within requested scope.

If you identify a future requirement:

add it to:

```
docs/backlog.md
```

when appropriate.

## 57. Implementation quality

Do not leave:

* TODOs in critical business paths
* mocked domain behavior
* hard-coded tenant IDs
* hard-coded facility IDs
* hard-coded hospital names
* placeholder authorization
* disabled validation
* commented-out production logic
* silent error swallowing

Do not claim a feature is complete unless it is functionally implemented.

## 58. Before declaring a task complete

Always run the relevant project checks.

At minimum:

```
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If database changes were made:

* verify migration
* verify seed if relevant
* run integration tests

If an important user workflow changed:

* run relevant Playwright E2E tests

Fix failures before declaring completion.

Do not suppress tests merely to obtain a green build.

## 59. Final implementation summary

After completing a task, provide a concise summary containing:

* what was implemented
* key files changed
* database changes
* migrations created
* APIs added/changed
* permissions added
* tests added
* commands run
* known limitations
* suggested next step

Do not claim tests passed unless they were actually executed.

## 60. Golden rule

When there is tension between:

* fast development
* data integrity
* clinical safety
* financial correctness
* tenant security

prioritize:

1. patient safety
2. tenant security
3. financial integrity
4. data integrity
5. development speed

MedOS should be simple for the user, not simplistic internally.
