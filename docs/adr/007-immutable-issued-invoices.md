# ADR-007: Immutable issued invoices

**Status:** Accepted (Stage 0; CLAUDE.md §14, spec §6.4)

## Context
Invoices and payments are accounting-grade records. Silent edits destroy auditability and cause reconciliation and legal problems.

## Decision
- Invoices are editable only in `DRAFT`. Totals are always computed server-side with decimal-safe arithmetic (`NUMERIC` in the database); client totals are ignored.
- `ISSUE` assigns the invoice number from the numbering engine, freezes lines/discount/tax/total, and sets `issuedAt`, all in one transaction.
- After issue: no line/total change and no deletion. Enforced in the service **and** in the database (trigger or constraint rejecting UPDATE/DELETE of issued invoice rows and lines).
- Corrections use new records linked to the original: `Refund`, `CreditNote`, reversal or adjustment — each with reason, actor, timestamp and reference transaction. Payments and refunds are append-only.
- Payment posting is transactional, idempotent (client key + unique constraint), concurrency-safe (invoice row lock), and cannot exceed the balance. Cancellation of an issued invoice is a controlled workflow with permission, reason and audit; it does not delete.
- Status derives from recorded payments/corrections: `DRAFT → ISSUED → PARTIALLY_PAID → PAID`, with `CANCELLED` and `REFUNDED` as controlled terminal paths.

## Alternatives considered
- **Editable invoices with change log:** rejected, still mutates financial history.
- **Event-sourced full ledger:** over-engineered for MLP-1; the append-only payment/refund/credit records give reconstructability.

## Consequences
+ Financial history is reconstructable; receipts and reports stay consistent.
− Mistakes require explicit correction flows (more UI), which is intentional.
− Tax/GST rounding rules and refund-status semantics (G6, G9) need explicit decisions before Stage 18/20; GST treatment needs professional tax review.
