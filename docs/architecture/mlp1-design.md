# MedOS MLP-1 — Design Document

Status: as built and verified on 2026-10-05. Mermaid diagrams render in VS Code (Markdown Preview Mermaid Support extension) and in `docs/architecture/diagrams.html` (open in any browser).

## 1. Purpose and scope
A multi-tenant Hospital Management System for small and medium Indian hospitals (10–150 beds, initially West Bengal). MLP-1 covers: authentication and RBAC, tenants and facilities, staff, patient registration, appointments, OPD queue and consultation, vitals, prescriptions, billing and payments, pharmacy, basic IPD, beds, basic nursing, discharge, core reports, audit trail, patient files, printing (HTML and PDF) and Bengali/Hindi UI.

Out of scope (see `docs/backlog.md`): AI, ABDM, Swasthya Sathi, LIMS, radiology, PACS, OT, insurance claims, payroll, HRMS, full accounting, patient app, telemedicine, advanced analytics.

## 2. Design principles
1. Patient safety, tenant security, financial integrity, data integrity, then speed (CLAUDE.md §60).
2. Tenant and facility come only from the authenticated session, never from the request.
3. Permissions, not role names, decide access. Re-read from the database on every request.
4. Signed clinical content and issued financial documents are never overwritten: amend, credit note, refund or reversal instead.
5. Integrity is enforced twice: in services and again in PostgreSQL (triggers, exclusion constraints, deferred reconciliation).
6. Every important mutation writes an audit event in the same transaction.
7. Configuration over customisation: feature flags, numbering, print templates, settings per facility.

## 3. Architecture

### 3.1 System context and containers
```mermaid
flowchart LR
  subgraph Users
    R[Reception] --- D[Doctor] --- N[Nurse] --- C[Cashier] --- P[Pharmacist] --- M[Manager] --- A[Admin]
  end
  Users -->|HTTPS| WEB
  subgraph Web["Web app (Next.js 15, React 19)"]
    WEB[Pages: app router<br/>TanStack Query, RHF, Zod<br/>i18n en / bn / hi]
    BFF[BFF route handlers<br/>/api/session/*<br/>httpOnly cookies medos_at, medos_rt]
    GW[Same-origin proxy<br/>/api/proxy/**<br/>x-medos-csrf, auth/* blocked]
    WEB --> BFF
    WEB --> GW
  end
  GW -->|Bearer access token| API
  BFF -->|login, refresh, logout| API
  subgraph APIsub["API (NestJS 10, /api/v1)"]
    API[Global guards: Auth, Permission, Feature flags<br/>Zod validation, error filter, request id, rate limit]
    MOD[Domain modules]
    API --> MOD
  end
  MOD -->|Prisma + SQL| PG[(PostgreSQL 17<br/>source of truth)]
  MOD -->|bytes| FS[(Local disk<br/>STORAGE_DIR<br/>S3 later)]
```

### 3.2 API module map (modular monolith)
```mermaid
flowchart TB
  subgraph Platform
    auth[auth] --- tenants --- facilities --- users --- settings --- numbering --- audit
  end
  subgraph FrontDesk["Front desk"]
    patients --- appointments --- queue --- encounters
    documents[documents<br/>patient files]
  end
  subgraph Clinical
    consultation --- allergies --- prescriptions
  end
  subgraph Money
    billing --- shifts[cashier shifts] --- pharmacy
  end
  subgraph Inpatient
    ipd[beds + admissions] --- charges --- nursing[nursing + MAR] --- discharge
  end
  subgraph Read["Read side"]
    reports --- print[print HTML/PDF]
  end
  Platform -.-> FrontDesk & Clinical & Money & Inpatient & Read
  Clinical --> encounters
  Money --> encounters
  Inpatient --> encounters
```
Every clinical record references an Encounter (OPD or IPD). All modules share one canonical Patient.

### 3.3 Request pipeline
```mermaid
sequenceDiagram
  participant B as Browser
  participant G as Next.js proxy
  participant A as API
  participant DB as PostgreSQL
  B->>G: fetch /api/proxy/... (cookie, x-medos-csrf)
  G->>A: Bearer token (+ Idempotency-Key)
  A->>DB: load user, tenant, facility, permissions
  A->>A: permission + feature check, Zod validate
  A->>DB: BEGIN, business write, audit event, COMMIT
  DB-->>A: triggers enforce invariants
  A-->>G: { data } or { error: {code,message,requestId} }
  G-->>B: same body (401 → single-flight refresh)
```

### 3.4 Deployment view (target; not yet run)
Local development: pnpm + turbo, local PostgreSQL 17 on 127.0.0.1:54329, API :4000, web :3000. Container images and compose stack exist but have never been built (REMINDER.md). Production needs HTTPS, secrets manager, managed PostgreSQL with PITR, S3 storage and a shared rate limiter.

## 4. Technology choices
| Area | Choice | Note |
|---|---|---|
| Web | Next.js 15, React 19, Tailwind 3, TanStack Query, React Hook Form, Zod | Hand-written UI components instead of shadcn (ADR-009) |
| API | NestJS 10, Prisma 6, zod strict schemas | |
| Database | PostgreSQL 17 | Hand-written SQL migrations carry domain rules |
| Auth | scrypt hashes, 15 min JWT access, opaque rotating refresh tokens | Argon2id deferred |
| Files | local disk behind `StorageService` | S3 driver deferred |
| PDF | pdfkit (MIT) | Latin fonts only for now |
| Tests | tsc, node:test + supertest on a real DB, Playwright (Chromium) | Jest/Vitest blocked by antivirus |

## 5. Security design
- **Tenant isolation:** every query is tenant-scoped; composite foreign keys; an id-sweep test hits every id route with another tenant's ids. PostgreSQL RLS is deferred (REMINDER.md).
- **Session:** tokens never reach browser JavaScript; httpOnly SameSite cookies; CSRF header on mutations; refresh-token reuse revokes the family; lockout after repeated failures.
- **Authorization:** permission-based RBAC (single source `packages/shared/src/permissions.ts`); UI hides, API decides.
- **Input:** strict zod schemas reject unknown fields; uploads validated by magic bytes; CSV export neutralises formula injection; print HTML is fully escaped with a locked-down CSP.
- **Logging:** structured, request id, no tokens, passwords or clinical payloads.

## 6. Data model (summary)
```mermaid
erDiagram
  TENANT ||--o{ FACILITY : has
  FACILITY ||--o{ DEPARTMENT : has
  FACILITY ||--o{ WARD : has
  WARD ||--o{ ROOM : has
  ROOM ||--o{ BED : has
  TENANT ||--o{ USER : employs
  USER }o--o{ ROLE : assigned
  ROLE }o--o{ PERMISSION : bundles
  TENANT ||--o{ PATIENT : registers
  PATIENT ||--o{ PATIENT_IDENTIFIER : has
  PATIENT ||--o{ PATIENT_FILE : has
  PATIENT ||--o{ ALLERGY : has
  PATIENT ||--o{ APPOINTMENT : books
  PATIENT ||--o{ ENCOUNTER : has
  ENCOUNTER ||--o{ VITALS : records
  ENCOUNTER ||--o{ CONSULTATION : has
  CONSULTATION ||--o{ CONSULTATION_VERSION : keeps
  ENCOUNTER ||--o{ DIAGNOSIS : has
  ENCOUNTER ||--o{ PRESCRIPTION : has
  PRESCRIPTION ||--o{ PRESCRIPTION_ITEM : lists
  PRESCRIPTION_ITEM ||--o{ MED_ADMINISTRATION : "given as"
  ENCOUNTER ||--o| ADMISSION : "IPD only"
  ADMISSION ||--o{ BED_ASSIGNMENT : "history"
  BED ||--o{ BED_ASSIGNMENT : hosts
  ADMISSION ||--o{ CHARGE : accrues
  ENCOUNTER ||--o{ INVOICE : billed
  INVOICE ||--o{ INVOICE_LINE : has
  INVOICE ||--o{ PAYMENT : receives
  PAYMENT ||--o{ REFUND : reversed_by
  INVOICE ||--o{ CREDIT_NOTE : adjusted_by
  MEDICINE ||--o{ BATCH : stocked_as
  BATCH ||--o{ STOCK_MOVEMENT : ledger
  USER ||--o{ AUDIT_EVENT : acts
```

## 7. Key business rules and where they are enforced
| Rule | Service | Database |
|---|---|---|
| One canonical patient; duplicates detected, never auto-merged | patients | trigram index |
| No double booking | appointments | exclusion constraint |
| One active admission per patient; a bed holds one admission | ipd | partial unique + exclusion |
| Signed consultation is immutable; amendments keep versions | consultation | immutability trigger |
| Vitals, notes, audit are append-only | respective services | append-only triggers |
| Issued invoice never changes; totals server-side decimal | billing | reconciliation checks (deferred) |
| Overpayment rejected; split payments | billing | check constraints |
| Stock ledger is truth; FEFO; no expired batch; no oversell | pharmacy | row locks, balance reconciles to ledger |
| Order ≠ administration | nursing | separate table |
| Discharge needs fitness, clearances, signed summary and paid final bill | discharge | state trigger |
| Patient files immutable except ACTIVE → REMOVED | documents | trigger |
| Idempotency on payments, refunds, dispensing, purchases, adjustments | idempotency store | unique key |

## 8. State machines
```mermaid
stateDiagram-v2
  direction LR
  state "Appointment" as AP {
    [*] --> BOOKED
    BOOKED --> CHECKED_IN
    BOOKED --> CANCELLED
    BOOKED --> NO_SHOW
    CHECKED_IN --> WAITING
    WAITING --> IN_CONSULTATION
    IN_CONSULTATION --> COMPLETED
  }
```
```mermaid
stateDiagram-v2
  direction LR
  [*] --> DRAFT: consultation / invoice
  DRAFT --> SIGNED: sign (consultation)
  SIGNED --> AMENDED: amend with reason
  DRAFT --> ISSUED: issue (invoice)
  ISSUED --> PART_PAID
  PART_PAID --> PAID
  ISSUED --> PAID
  ISSUED --> CANCELLED
  PAID --> REFUNDED: full refund
```
Bed status: AVAILABLE → OCCUPIED → CLEANING → AVAILABLE (also RESERVED, MAINTENANCE).

## 9. Business flow diagrams

### 9.1 OPD (mandatory workflow, CLAUDE.md §36)
```mermaid
flowchart TD
  A[Reception logs in] --> B[Register patient<br/>duplicate check]
  B --> C[Book or walk-in]
  C --> D[Check-in → token in OPD queue]
  D --> E[Doctor calls patient]
  E --> F[Vitals recorded]
  F --> G[Diagnosis + allergy check]
  G --> H[Prescription]
  H --> I[Sign consultation<br/>note locked]
  I --> J[Cashier issues invoice]
  J --> K[Split payment → receipt]
  K --> L[Pharmacy sees signed prescription]
  L --> M[FEFO dispense with allergy check]
  M --> N[Pharmacy receipt]
  I -. needs change .-> X[Amend with reason<br/>history kept]
```

### 9.2 IPD (mandatory workflow, CLAUDE.md §37)
```mermaid
flowchart TD
  A[Register patient] --> B[Admit under consultant]
  B --> C[Allocate bed]
  C --> D[Nurse vitals + note]
  D --> E[Doctor orders and signs medicines]
  E --> F[MAR: Given / Hold / Missed / Refused]
  F --> G[Charges added: services, ward medicines, bed days]
  G --> H[Bed transfer<br/>Ward A → ICU → Ward B]
  H --> I[Doctor marks fit]
  I --> J[Clearances: nursing, pharmacy, ...<br/>waiver needs reason]
  J --> K[Summary signed by consultant]
  K --> L[Final bill from pending charges]
  L --> M{Fully paid?}
  M -- no --> L
  M -- yes --> N[Discharge completes]
  N --> O[Bed released → cleaning<br/>encounter closed]
```

### 9.3 Money and stock
```mermaid
flowchart LR
  subgraph Billing
    D[Draft invoice<br/>editable] --> I[Issued<br/>immutable] --> P[Payments<br/>cash / UPI / card / bank / other]
    I --> CN[Credit note]
    P --> RF[Refund]
    I --> CX[Cancel]
  end
  subgraph Stock
    PU[Purchase] --> L[(Stock ledger)]
    SA[Sale / dispense] --> L
    RT[Patient return] --> L
    PR[Purchase return] --> L
    AD[Adjustment / damage] --> L
    L --> BAL[Batch balance<br/>reconciled by DB]
  end
```

## 10. Roles and permission bundles
| Role | Primary purpose | Key permissions |
|---|---|---|
| Receptionist | Registration, booking, queue, admission, draft invoices | PATIENT_*, APPOINTMENT_*, QUEUE_*, ADMISSION_READ/CREATE/TRANSFER, INVOICE_READ/CREATE, DUPLICATE_OVERRIDE |
| Doctor | Consultation, orders, discharge | CONSULTATION_*, VITALS_*, ALLERGY_WRITE, PRESCRIPTION_*, ADMISSION_DISCHARGE |
| Nurse | Ward care, MAR | NURSING_*, VITALS_*, ADMISSION_TRANSFER |
| Cashier | Invoices, payments, refunds, shifts | INVOICE_ISSUE, PAYMENT_CREATE/REFUND, CASHIER_SHIFT_MANAGE |
| Pharmacist | Dispense, stock, purchases | PHARMACY_*, INVOICE_ISSUE, PAYMENT_CREATE, REPORT_READ |
| Manager | Oversight | REPORT_READ, INVOICE_DISCOUNT/CANCEL/ADJUST, AUDIT_READ |
| Administrator | Setup and audit | ADMIN_USERS/MASTERS/SETTINGS, AUDIT_READ, REPORT_READ and more |
Custom roles are supported by the API. Exact lists: `packages/shared/src/permissions.ts`.

## 11. Non-functional design
- **Performance:** paginated lists, trigram and composite indexes, no N+1. Measured on one machine with 30,000 patients and 60,000 audit events: searches and lookups within budget.
- **Concurrency:** SKIP LOCKED queue calls, row locks for stock and beds, advisory locks and atomic upserts for numbering, exclusion constraints for booking.
- **Time and money:** timestamps in UTC, shown in Asia/Kolkata; money is NUMERIC / decimal.js, never floats; Latin digits in all languages.
- **Backup:** logical dump and verified restore scripts (`scripts/backup.ps1`, `restore-test.ps1`); PITR and encryption deferred.

## 12. Known limitations
See `docs/certification.md` §5 and `REMINDER.md`. Summary: Docker/CI never run; no RLS; per-instance rate limiting; no PITR/encryption; Latin-only PDF fonts; translations unreviewed; no external clinical, tax, data-protection or penetration review.
