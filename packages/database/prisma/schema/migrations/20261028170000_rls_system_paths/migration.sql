-- Row-level security, phase 2: the few things that must work BEFORE a hospital is known. Each is a narrow SECURITY DEFINER
-- function (runs with the owner's rights, so it can see across hospitals) that returns the least it can, and only the
-- restricted role may call it. The API does everything else under the tenant context of a verified session.
--  * medos_resolve_tenant(code)           login: which hospital does this code belong to, and is it active
--  * medos_resolve_refresh_token(hash)    token refresh / logout: which hospital issued this token (the caller must hold the token)
--  * medos_tenants_with_due_reminders(t)  reminder worker: which hospitals have reminders due (it then works one hospital at a time)
-- search_path is pinned so a caller cannot make these functions resolve names to its own objects.

CREATE OR REPLACE FUNCTION medos_resolve_tenant(p_code text) RETURNS TABLE (id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT t.id, t.status::text FROM public."Tenant" t WHERE t.code = p_code $$;

CREATE OR REPLACE FUNCTION medos_resolve_refresh_token(p_hash text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT r."tenantId" FROM public."RefreshToken" r WHERE r."tokenHash" = p_hash $$;

CREATE OR REPLACE FUNCTION medos_tenants_with_due_reminders(p_now timestamptz) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT DISTINCT r."tenantId" FROM public."AppointmentReminder" r WHERE r.status = 'PENDING' AND r."sendAt" <= p_now $$;

REVOKE ALL ON FUNCTION medos_resolve_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION medos_resolve_refresh_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION medos_tenants_with_due_reminders(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_resolve_tenant(text) TO medos_app;
GRANT EXECUTE ON FUNCTION medos_resolve_refresh_token(text) TO medos_app;
GRANT EXECUTE ON FUNCTION medos_tenants_with_due_reminders(timestamptz) TO medos_app;
