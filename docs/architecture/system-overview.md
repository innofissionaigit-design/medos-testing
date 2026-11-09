# MedOS System Overview

Status: Stage 0 target architecture. Nothing is implemented yet; this describes what Stages 1+ will build. Update it when implementation diverges.

## 1. Shape

A **modular monolith**: one NestJS API process, one Next.js web app, one PostgreSQL database (source of truth), Redis for ephemeral concerns, S3-compatible object storage for files. No microservices, Kafka or Kubernetes (ADR-001).

```
Browser ──HTTPS──► apps/web (Next.js)
                      │  TanStack Query, Zod
                      ▼
                 /api/v1  apps/api (NestJS)
   ┌──────────────────┼─────────────────────────┐
   │ guards: auth → tenant/facility ctx → permission
   │ modules: auth, tenants, facilities, users, practitioners, patients,
   │          appointments, queue, encounters, clinical, billing,
   │          pharmacy, ipd, nursing, reports, audit
   └───────┬───────────────┬───────────────┬─────┘
           ▼               ▼               ▼
      PostgreSQL         Redis        S3-compatible
   (Prisma, truth)  (rate limit,      (documents,
                     cache, locks)     print artifacts)
```

## 2. Repository layout (CLAUDE.md §2)

```
apps/web  apps/api
packages/database (Prisma schema, migrations, seed)  packages/ui  packages/shared (zod schemas, enums, permission keys)  packages/config
docs/{product,architecture,adr,dependencies}  docs/backlog.md
```
pnpm workspaces + Turborepo. Module layout inside the API: `apps/api/src/modules/<module>/{dto,controllers,services,repositories,guards,tests}`.

## 3. Request pipeline

1. Request ID assigned (propagated to logs and audit).
2. Authentication guard validates the access token → `userId`, `tenantId`, `facilityId` (server-side session only).
3. Tenant/facility context guard verifies the user's access to the facility; request-supplied tenant/facility values are never authoritative.
4. Permission guard checks required permission(s) (never role names).
5. Controller validates the boundary (Zod/DTO, whitelist, reject unknown fields) and calls a service.
6. Service enforces business rules and state transitions, runs a DB transaction where needed, writes the audit event in the same transaction.
7. Central exception filter maps domain errors to `{ "error": { "code", "message" } }`; no stack traces, SQL or secrets.

## 4. Tenant isolation

Shared database, shared schema, `tenantId` on every tenant-owned row (ADR-004). All data access goes through tenant-scoped repository helpers; `findUnique({ where: { id } })` on tenant-owned tables is forbidden. DB layer: composite unique `(tenantId, id)` and composite foreign keys so a child can never reference another tenant's parent; tenant-scoped unique business keys. Cross-tenant IDs yield the same `404` as missing IDs. Row-level security is under evaluation (G5).

## 5. Core domain model

```
Tenant ─ Facility ─ Department ─ Ward ─ Room ─ Bed
Patient ─ PatientIdentifier (MRN, legacy, ABHA later)
Patient ─ Encounter(OPD|IPD) ─┬─ QueueEntry / Appointment (OPD)
                              ├─ Observation, ClinicalNote(+versions), Diagnosis
                              ├─ MedicationOrder ─ Item ─ MedicationAdministration
                              ├─ Admission ─ BedAssignment, Charge, NursingNote, IntakeOutput, DischargeSummary
                              └─ Invoice ─ InvoiceLine, Payment(+allocations), Refund, CreditNote
Medicine ─ MedicineBatch ─ StockLedger(append-only) ─► StockBalance(materialized)
NumberSequence · AuditEvent(append-only) · Document · PrintTemplate · TenantSetting
```

Allergy is patient-level; Diagnosis, Observation, notes and orders reference both patient and encounter.

## 6. Integrity patterns

| Concern | Mechanism |
|---|---|
| Business numbers (MRN, invoice, receipt…) | `NumberSequence` row advanced atomically (`UPDATE … RETURNING` / row lock) inside the caller's transaction; unique `(tenantId, scope, number)` |
| Money | PostgreSQL `NUMERIC(precision,scale)`; server-side decimal library; no JS floats; totals computed on server |
| Issued invoice | immutable after issue; corrections via refund / credit note / reversal records (ADR-007) |
| Stock | append-only ledger; `StockBalance` updated in the same transaction under row lock; reconciliation check (ADR-008) |
| Beds | partial unique index: at most one open `BedAssignment` per bed and per admission; status transitions validated |
| Signed clinical notes | append-only versions; signed rows reject UPDATE (app + DB trigger planned); amendment = new version + reason |
| Audit | append-only; no update/delete path; written in the business transaction |
| State machines | central transition tables per aggregate (appointment, queue, consultation, invoice, bed, admission, MAR) |
| Idempotency | client idempotency key on payments/dispense/refund endpoints; unique constraint backs it |

## 7. Cross-cutting

- **Errors:** stable domain codes (`PATIENT_NOT_FOUND`, `INVOICE_ALREADY_ISSUED`, `INSUFFICIENT_STOCK`, `BED_NOT_AVAILABLE`, `UNAUTHORIZED_FACILITY`, …).
- **Logging:** structured JSON with requestId, tenantId, facilityId, userId, route, status, errorCode; never passwords, tokens, or clinical payloads.
- **Time:** UTC storage; facility timezone (`Asia/Kolkata` default) for display.
- **Redis:** rate limiting, cache, short-lived locks only; never the system of record (CLAUDE.md §40).
- **Files:** object storage for documents/prints; metadata in `Document`; access via short-lived authorised URLs.
- **Config:** feature flags and settings per tenant/facility (`PHARMACY_ENABLED`, `IPD_ENABLED`, `NURSING_ENABLED`); no per-customer code.
- **i18n:** message keys in the web app; no user-facing text in domain logic.

## 8. Environments

local · staging · production, each with separate database, Redis, storage, secrets and domains. Tests run only against a dedicated test database with synthetic data. Production deploys require explicit approval.

## 9. Testing architecture

Unit (domain rules, calculations, state machines) · integration (real PostgreSQL test DB: repositories, APIs, authorization, transactions, concurrency) · Playwright E2E (OPD, IPD certification flows against the real API). A shared test harness provides two tenants, two facilities and users per role so cross-tenant, cross-facility, IDOR and role tests are cheap to add for every resource.

## 10. Known open items

G4 (login tenant resolution), G5 (RLS), G12 (print tech), G13 (hashing lib), G15 (Redis/object-storage licences) — see `docs/product/mlp1.md` §14.
