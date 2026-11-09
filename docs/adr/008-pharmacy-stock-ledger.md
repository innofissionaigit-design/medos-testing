# ADR-008: Pharmacy stock ledger

**Status:** Accepted (Stage 0; CLAUDE.md §15)

## Context
A single mutable `currentQuantity` cannot explain how stock changed, cannot be audited, and is prone to lost updates under concurrency. Overselling and negative stock are release-blocking.

## Decision
- Inventory truth is an **append-only `StockLedger`**: medicine, batch, type (`PURCHASE, SALE, PATIENT_RETURN, PURCHASE_RETURN, ADJUSTMENT, DAMAGE, TRANSFER`), signed/directional quantity, source reference, user, timestamp, reason. Rows are never updated or deleted; corrections are new entries.
- A materialised `StockBalance` per (tenant, facility, batch) is updated **in the same transaction** as the ledger insert, under a row lock, with `CHECK (quantity >= 0)`. A reconciliation query/job proves balance = sum(ledger) and is part of the test suite.
- Dispensing: one transaction locks the candidate batches, selects FEFO (earliest expiry first), rejects expired batches, decrements balance, inserts ledger rows, links the sale to patient/prescription, and issues the receipt. Failure rolls back everything.
- Dispense and stock-adjust operations carry idempotency keys; adjustments require `PHARMACY_ADJUST_STOCK` and a reason, and are audited.
- Batches are never deleted; expiry blocks dispensing, and near-expiry/low-stock are reports.

## Alternatives considered
- **Quantity column only:** rejected (no history, race-prone).
- **Compute stock purely by summing the ledger on every read:** correct but slow at scale and awkward to lock; materialised balance plus reconciliation chosen.
- **Redis counters:** rejected; not durable or authoritative.

## Consequences
+ Any batch's history is reconstructable; concurrent dispensing cannot oversell (lock + CHECK).
− Two writes per movement; reconciliation must be tested continuously.
− Transfers between facilities need paired ledger rows; scope in Stage 23.
