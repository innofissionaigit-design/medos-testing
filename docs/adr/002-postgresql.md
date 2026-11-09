# ADR-002: PostgreSQL as the system of record

**Status:** Accepted (Stage 0)

## Context
The system stores clinical, financial and inventory data requiring integrity, auditability, concurrency control and point-in-time recovery. Licensing must be commercial-friendly.

## Decision
PostgreSQL is the single source of truth. Use `NUMERIC` for money, `timestamptz` (UTC) for time, UUID primary keys, foreign keys, CHECK constraints, partial unique indexes, and transactions with row-level locking for sequences, stock, beds and payments. Prefer managed PostgreSQL in production with encrypted automated backups and PITR. Redis, caches and object storage are never authoritative for patient, invoice, inventory or clinical data.

## Alternatives considered
- **MySQL/MariaDB:** weaker constraint and partial-index support for our invariants.
- **MongoDB/document stores:** poor fit for relational integrity and ledgers.
- **SQLite:** unsuitable for multi-user concurrent hospital use.

## Consequences
+ Integrity enforced in the database, not only in code; permissive PostgreSQL License.
+ Strong concurrency tools (`SELECT … FOR UPDATE`, advisory locks, serialisable where needed).
− Requires migration discipline and a real test database in CI (no SQLite shortcuts).
− Prisma does not express every constraint (partial indexes, CHECK, triggers); those go in hand-written SQL inside committed migrations (see ADR-003).
