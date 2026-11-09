

-- ===== Hand-written invariants =====
-- The email worker (docs/email.md) asks which hospitals have emails due, then works one hospital at a time under that hospital's own context.
CREATE OR REPLACE FUNCTION medos_tenants_with_due_emails(p_now timestamptz) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT DISTINCT e."tenantId" FROM public."EmailOutbox" e WHERE e.status = 'PENDING' AND e."nextAttemptAt" <= p_now $$;

REVOKE ALL ON FUNCTION medos_tenants_with_due_emails(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_tenants_with_due_emails(timestamptz) TO medos_app;

