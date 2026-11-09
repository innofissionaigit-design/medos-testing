-- Re-applies every PRIVILEGE the row-level security migrations set up (docs/rls.md). Idempotent. Run as the OWNER role.
--
-- Why it exists: backups and restores here use pg_dump/pg_restore with --no-owner --no-privileges. Policies and "ENABLE ROW LEVEL SECURITY"
-- survive a restore, but all GRANT/REVOKE statements do not. Without this script a restored database would give medos_app no access at
-- all, and the narrow login/refresh/worker functions would be executable by everyone. Run it after every restore, and after anything
-- else that recreates the database from a dump. It creates the role (without a login) if the cluster does not have it yet.
--
-- Kept in step with migrations 20261028150000_rls_roles_and_policies and 20261028170000_rls_system_paths by a test
-- (apps/api/src/common/rls.grants.spec.ts): the privileges this script leaves must equal the ones the migrations leave.
-- A single DO block so it runs unchanged through psql, Prisma and the application's own tests.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medos_app') THEN
    CREATE ROLE medos_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE medos_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  GRANT USAGE ON SCHEMA public TO medos_app;
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medos_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO medos_app;
  REVOKE ALL ON TABLE "_prisma_migrations" FROM medos_app;
  REVOKE UPDATE, DELETE ON TABLE "AuditEvent" FROM medos_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO medos_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO medos_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO medos_app;

  REVOKE ALL ON FUNCTION medos_enable_tenant_rls(regclass) FROM PUBLIC;
  REVOKE ALL ON FUNCTION medos_resolve_tenant(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION medos_resolve_refresh_token(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION medos_tenants_with_due_reminders(timestamptz) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION medos_resolve_tenant(text) TO medos_app;
  GRANT EXECUTE ON FUNCTION medos_resolve_refresh_token(text) TO medos_app;
  GRANT EXECUTE ON FUNCTION medos_tenants_with_due_reminders(timestamptz) TO medos_app;
END
$$;
