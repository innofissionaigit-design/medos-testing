-- Rollback of 20261028150000_rls_roles_and_policies. Run as the OWNER role. Not a Prisma migration: it is never run automatically.
-- Order of operations is in docs/rls.md: point the API back at the owner DATABASE_URL FIRST, then run this, then
--   prisma migrate resolve --rolled-back 20261028150000_rls_roles_and_policies
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND policyname IN ('tenant_isolation', 'tenant_self') LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS medos_enable_tenant_rls(regclass);
DROP FUNCTION IF EXISTS medos_current_tenant();
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medos_app') THEN
    DROP OWNED BY medos_app;   -- removes every privilege and default privilege granted to it
    DROP ROLE medos_app;
  END IF;
END $$;
