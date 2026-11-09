-- One line describing the row-level security state of a database: tables with RLS | policies | can the restricted login read patients |
-- is the login function open to everyone. A restored database must show the same line as its source (scripts/restore-test.ps1).
-- Safe on a database that has not had the row-level security migrations (it says so instead of failing).
select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity)
  || '|' || (select count(*) from pg_policies where schemaname = 'public')
  || '|' || case when to_regrole('medos_app') is null or to_regclass('"Patient"') is null then 'no-app-role' else has_table_privilege('medos_app', '"Patient"', 'SELECT')::text end
  || '|' || case when to_regprocedure('medos_resolve_tenant(text)') is null then 'no-function' else has_function_privilege('public', 'medos_resolve_tenant(text)', 'EXECUTE')::text end;
