# ADR-010: PostgreSQL row-level security as a second layer of tenant isolation

**Status:** Accepted. Implemented and verified in development; staging and production have not been switched (runbook in [`../rls.md`](../rls.md)). Closes the open question in ADR-004 (gap G5).

## Context
ADR-004 isolates hospitals by discipline and structure: every query carries `tenantId`, children reference parents through composite keys, optional links are guarded by same-tenant triggers, and a sweep test probes every id route. A single query that forgets its tenant filter would still leak another hospital's records, and cross-tenant access is a release-blocking defect. A database-enforced layer removes the dependence on every query being right.

## Decision
1. **Two database logins.** The *owner* runs migrations, the seed and provisioning tools. The API runs as the restricted role `medos_app`: not a superuser, no BYPASSRLS, owns nothing, member of no role, data privileges only (no DDL, no TRUNCATE, nothing on `_prisma_migrations`, append-only audit trail). The owner's URL is never in the API's environment.
2. **A policy on every tenant table** (`tenant_isolation`: `"tenantId" = (SELECT medos_current_tenant())`, same `WITH CHECK`), and `tenant_self` on `Tenant`. Only `RateLimitBucket` is exempt (no hospital data). `ENABLE` without `FORCE`: the owner stays exempt so data migrations never silently touch zero rows; safety rests on `medos_app` never owning a table, which is tested and checked at startup.
3. **Tenant context is transaction-local.** `set_config('app.tenant_id', …, true)` runs as the first statement of every transaction, and single queries and raw SQL are wrapped in a short one, so a pooled connection cannot carry a tenant into another request. The tenant comes from the verified session (the auth guard binds it from the signed token before its first lookup), never from a request value. No context means no rows and no writes, and the application additionally refuses to send a query with no scope.
4. **Explicit, narrow paths where no tenant exists yet.** Three `SECURITY DEFINER` functions, executable only by `medos_app`, with a pinned `search_path`: resolve a hospital code (login), resolve a refresh token's hospital (refresh, logout), list hospitals with reminders due (worker, which then serves each under its own scope). Health checks and the rate limiter run in an explicit tenant-less scope that reads no rows. Seed and provisioning run with the owner login.
5. **Safe rollout switches.** `DB_TENANT_CONTEXT` (`off` by default, must be `on` for the restricted login) and, for development and tests only, `DB_SESSION_ROLE` to emulate the role from an owner login. At startup the API verifies its own login and refuses to run if login and settings disagree.
6. **Privileges are re-applied after a restore.** Backups use `--no-privileges`; `packages/database/ops/rls-grants.sql` re-grants, and a test keeps it equal to the migrations.
7. **A new tenant table must call `medos_enable_tenant_rls()`** in its migration; a test fails if any tenant table lacks the policy.

## Alternatives considered
- **`FORCE ROW LEVEL SECURITY` with an owner that has BYPASSRLS:** stronger against owner mistakes, but granting BYPASSRLS needs a superuser (not available on common managed PostgreSQL) and, without it, data migrations silently skip rows.
- **A client pool per tenant, or a tenant baked into the connection string:** does not scale with the number of hospitals.
- **Session-level `SET` on a pooled connection:** leaks tenant between requests; rejected for the transaction-local form.
- **One long transaction per request carrying the context:** conflicts with the services' retry-on-conflict logic and holds a connection for the whole request.
- **Database or schema per tenant:** already rejected in ADR-004.
- **Application filtering only (status quo):** one missed filter leaks data.

## Consequences
+ A forgotten tenant filter, a raw query, or an injected id can no longer read or write another hospital's rows through the API's login; the database refuses.
+ Verified over a real restricted login: 470 of 470 API tests, 24 escalation attempts refused, connection reuse without leakage, a restore rehearsal, and an evidence tool that runs read-only in any environment.
− A single read outside a transaction costs about 2-3 ms more; writes are unchanged within noise.
− Two database logins to operate, a re-grant step after every restore, and migrations must be applied before the code that calls the new functions.
− The owner and superusers bypass the policies by design: their credentials must stay out of the API. Code able to run arbitrary SQL in the API's own session could still set the tenant; the setting is written in one place and SQL is never built from strings, but no automated check enforces that yet.
− Policies isolate hospitals, not facilities: facility isolation stays in the application (backlog).
− The three definer functions are trusted code and must be reviewed with any change.
