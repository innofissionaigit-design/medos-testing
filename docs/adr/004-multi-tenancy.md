# ADR-004: Multi-tenancy model

**Status:** Accepted. The row-level security question is decided in [ADR-010](010-row-level-security.md) (gap G5 closed in code; staging and production not yet switched)

## Context
Many hospitals share one platform. Cross-tenant data exposure is a release-blocking defect. A tenant may later own several facilities; a hospital is not a database.

## Decision
Shared database, shared schema. Every tenant-owned table has a non-null `tenantId`; facility-scoped tables also have `facilityId`. Rules:
1. Tenant and facility identity come only from the authenticated server-side session; request-supplied values are never authoritative.
2. All access goes through tenant-scoped repositories; each query includes `tenantId`.
3. Database enforcement: unique business keys are tenant-scoped (`(tenantId, …)`); child tables reference parents through composite keys `(tenantId, id)` so cross-tenant references are impossible; indexes lead with `tenantId` where queries do.
4. Facility access is validated against the user's facility grants on every request.
5. Unknown and cross-tenant IDs return the same not-found response (no existence leak).
6. Every new tenant-owned entity ships cross-tenant, cross-facility, role and IDOR tests.

**Amendment:** PostgreSQL Row-Level Security was adopted as a second layer (transaction-local `app.tenant_id`, a restricted application role, a policy on every tenant table): see [ADR-010](010-row-level-security.md). The rules above still apply; RLS backs them up and does not replace them.

## Alternatives considered
- **Database per tenant:** strongest isolation, but heavy operations, migrations and cost for small hospitals.
- **Schema per tenant:** migration fan-out and connection pooling complexity.
- **Application filtering only:** simple, but a single missed filter leaks data; mitigated by composite FKs, scoped repositories and tests (and possibly RLS).

## Consequences
+ Cheap onboarding, single migration path, easy cross-tenant reporting for the platform operator (carefully permissioned).
− Isolation relies on discipline plus tests; the shared harness (two tenants, two facilities, users per role) is mandatory from Stage 2.
− Noisy-neighbour risk; acceptable at target scale, revisit with measurements.
