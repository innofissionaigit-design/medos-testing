# ADR-003: Prisma as ORM and migration tool

**Status:** Accepted (Stage 0; confirm package versions and licence at Stage 1)

## Context
We need typed data access, a schema source of truth, and reliable migrations, in a strict-TypeScript monorepo.

## Decision
Use Prisma (schema in `packages/database`). Every schema change has a committed migration; applied migrations are never edited. Constraints Prisma cannot model (CHECK, partial unique indexes, composite tenant foreign keys where unsupported, immutability triggers) are added as raw SQL in migration files and covered by integration tests that prove the database rejects violations. Business-critical atomic operations (sequence allocation, stock decrement, bed assignment) may use `$queryRaw` with parameterised SQL inside `$transaction`. A tenant-scoped data-access layer wraps the client so tenant-owned reads/writes cannot omit `tenantId`.

## Alternatives considered
- **TypeORM / MikroORM:** acceptable, but weaker type safety and migration ergonomics for this team.
- **Drizzle / Kysely:** attractive and lighter; Prisma chosen for schema-first workflow and migration tooling; revisit only through a new ADR.
- **Raw SQL only:** maximum control, higher boilerplate and typing cost.

## Consequences
+ Strong types end to end; one schema source of truth.
− Raw-SQL escape hatches required for several invariants; they must stay tested.
− Prisma client extensions for tenant scoping need care and tests; direct `findUnique({where:{id}})` on tenant-owned models is banned by lint/review.
