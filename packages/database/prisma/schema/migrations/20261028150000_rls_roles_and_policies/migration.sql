-- Row-level security, phase 1: the restricted application role, its privileges, and a tenant-isolation policy on every
-- tenant table. NO BEHAVIOUR CHANGE YET: the API still connects as the owner role, which is not subject to these policies.
-- They take effect only for connections made as medos_app (phase 3). Rollback: packages/database/rollback/.
--
-- Decisions:
--  * ENABLE without FORCE. The owner (migrations, seed, provisioning) must keep seeing every tenant, otherwise a data migration
--    would silently touch zero rows. Safety instead rests on medos_app never owning a table (checked by a test).
--  * Tenant context is the transaction-local setting app.tenant_id. Unset or empty means "no tenant": no rows, no writes.
--    A malformed value raises an error. Both fail closed.
--  * The login, token-refresh, reminder-worker, seed and provisioning paths are added in phase 2 as explicit exceptions.

-- 1. The restricted role. Created WITHOUT login: the password and LOGIN are an operations step (docs/rls.md), never in git.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medos_app') THEN
    CREATE ROLE medos_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE medos_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

-- 2. Least privilege: data changes only. No DDL, no TRUNCATE, no ownership, nothing on the migration history table,
--    and the audit trail is append-only for the application.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO medos_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO medos_app;
REVOKE ALL ON TABLE "_prisma_migrations" FROM medos_app;
REVOKE UPDATE, DELETE ON TABLE "AuditEvent" FROM medos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO medos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO medos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO medos_app;

-- 3. The tenant of the current transaction. NULL when unset or empty; raises on a malformed value.
CREATE OR REPLACE FUNCTION medos_current_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- 4. One call per tenant table; future migrations that add a tenant table call it too (a test fails if one is forgotten).
--    (SELECT ...) makes PostgreSQL evaluate the tenant once per query so the tenantId indexes stay usable.
CREATE OR REPLACE FUNCTION medos_enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s FOR ALL USING ("tenantId" = (SELECT medos_current_tenant())) WITH CHECK ("tenantId" = (SELECT medos_current_tenant()))',
    tbl);
END
$$;
REVOKE ALL ON FUNCTION medos_enable_tenant_rls(regclass) FROM PUBLIC;

-- 5. Every table with a tenantId column.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
  LOOP
    PERFORM medos_enable_tenant_rls(r.tbl);
  END LOOP;
END $$;

-- 6. The tenant table has no tenantId: a tenant may see only itself. (Finding one by code at login is a phase-2 exception.)
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON "Tenant";
CREATE POLICY tenant_self ON "Tenant" FOR ALL
  USING (id = (SELECT medos_current_tenant())) WITH CHECK (id = (SELECT medos_current_tenant()));

-- "RateLimitBucket" is deliberately not covered: it holds hashed tokens and addresses, not tenant data.
