-- Rollback of 20261028170000_rls_system_paths. Run as the OWNER role. Not a Prisma migration: never run automatically.
-- Only valid once the API no longer calls these functions (DB_TENANT_CONTEXT=off, i.e. the code before phase 2 or the flag reverted),
-- then: prisma migrate resolve --rolled-back 20261028170000_rls_system_paths
DROP FUNCTION IF EXISTS medos_resolve_tenant(text);
DROP FUNCTION IF EXISTS medos_resolve_refresh_token(text);
DROP FUNCTION IF EXISTS medos_tenants_with_due_reminders(timestamptz);
