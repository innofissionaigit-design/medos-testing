# ADR-009: Platform, session and tooling decisions made during implementation

**Status:** Accepted (with the limitations listed under Consequences). **Later changes:** decision 1 (scrypt) is replaced by [ADR-011](011-argon2id.md) (Argon2id); decision 2's limiter is now shared across instances through PostgreSQL, still without Redis (`RATE_LIMIT_STORE`, [deployment.md](../deployment.md)); decision 3's S3-compatible driver now exists ([storage.md](../storage.md)); decision 11's Latin-only PDF fonts are replaced by embedded Noto Sans fonts for English, Bengali and Hindi (`apps/api/assets/fonts/`). The decisions are left as written below, as the record of what was decided then.

## Context
CLAUDE.md names Argon2, Redis, S3-compatible storage, shadcn/ui and Jest/Vitest. While building MLP-1 several of these were deliberately replaced or deferred, and new decisions (browser session handling) were needed. This ADR records them so documentation matches the implementation (CLAUDE.md §54).

## Decisions

1. **Password hashing: scrypt (Node `crypto`), N = 2^15** (2^10 only under test) instead of Argon2. No native add-on to compile or have blocked; memory-hard; parameters stored with each hash so they can be raised later. *Revisit:* move to Argon2id if the deployment image can carry the native module.
2. **No Redis in MLP-1.** Rate limiting is in-process per API instance; idempotency, numbering, locks and queues use PostgreSQL (atomic upserts, `SELECT … FOR UPDATE`, advisory locks, `SKIP LOCKED`). Redis stays optional for a shared rate limiter later.
3. **Patient files on local disk, behind a small storage interface.** Photos and scanned documents (PNG, JPEG, PDF, ≤ 5 MB) are stored by `StorageService` under `STORAGE_DIR` with server-generated UUID keys; PostgreSQL holds only metadata (`PatientFile`: immutable except ACTIVE → REMOVED with who/when/why; one active photo per patient). Uploads are validated by content (magic bytes must match the declared type), served with `nosniff` and a sandboxing CSP, and document views are audited. An S3-compatible driver replaces the local one before running more than one API instance (REMINDER.md).
4. **Tokens never reach browser JavaScript.** The web app is a backend-for-frontend: login and refresh happen in Next.js route handlers that keep the access and refresh tokens in `httpOnly`, `SameSite=Lax` (and `Secure` in production) cookies; a same-origin proxy attaches the token. Mutations require a custom `x-medos-csrf` header; the API's `/auth/*` endpoints are not reachable through the proxy. Refresh is single-flight per refresh token because the API rotates refresh tokens and revokes the family on reuse.
5. **Authorization is permission-based and re-read from the database on every request**, so deactivation and role changes take effect immediately. The UI hides what a user cannot use, but only the API decides.
6. **Integrity is enforced twice:** in services, and in PostgreSQL (append-only and immutability triggers, state-machine triggers, exclusion constraints for double booking and bed overlap, partial unique indexes, deferred reconciliation checks between invoices, receipts, refunds and credit notes, and between stock balances and the stock ledger).
7. **Test tooling:** `tsc` + `node:test` with real HTTP (supertest) against a dedicated `medos_test` database instead of Jest/Vitest, because antivirus on the development machine blocks their native binaries. Browser tests use Playwright against the production build.
8. **UI components are hand-written Tailwind components** (`apps/web/src/components/ui.tsx`) instead of shadcn/ui, to avoid pulling a large Radix dependency tree into the first release. They can be swapped for shadcn components without changing page logic.
9. **Money** is `decimal.js` in the API and `NUMERIC` in PostgreSQL; the API returns money as strings; the web app only formats, never computes authoritative totals. Pharmacy prices are MRP-inclusive (bill = quantity × selling price; the GST component is stored for reporting).
10. **Feature flags** (`PHARMACY_ENABLED`, `IPD_ENABLED`, `NURSING_ENABLED`) are per-facility settings enforced by a global guard and used by the UI navigation.

## Alternatives considered
Argon2 (native build risk), Redis rate limiting (extra infrastructure before it is needed), tokens in `localStorage` (readable by any XSS), Jest/Vitest (blocked here), shadcn/ui (dependency weight).

## Consequences
- Several API instances multiply the effective login rate limit until a shared limiter exists.
- The web BFF's single-flight refresh cache is per web instance; use sticky sessions or a shared cache when scaling the web tier horizontally.
- Hand-written SQL migrations carry domain rules that Prisma cannot express; they need review whenever the schema changes.
- Out-of-scope items remain in `docs/backlog.md`.

11. **PDF output with pdfkit (MIT).** Printable documents are built as a neutral document model and rendered to HTML or PDF from the same data. Built-in Latin fonts only for now (see REMINDER.md for Indic scripts).
12. **Localisation (Bengali, Hindi)** is done inside the shared UI components with English text as the key; a missing translation falls back to English. Dates and money follow the chosen language but always use Latin digits so amounts are unambiguous. `scripts/extract-ui-strings.mjs` reports translation gaps.
13. **CSV export** is generated in the browser from report data; cells starting with `= + - @` are prefixed with an apostrophe (spreadsheet formula injection).
