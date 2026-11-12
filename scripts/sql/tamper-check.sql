-- Run against a restored database: the append-only audit trigger must still block edits.
-- With at least one audit row the edit is really tried. A brand-new database has none yet, so there is nothing to edit; then the guard is proven by its trigger
-- (audit_event_no_update, which refuses UPDATE and DELETE) being present and enabled.
DO $$
DECLARE
  rows_to_edit bigint;
BEGIN
  SELECT count(*) INTO rows_to_edit FROM "AuditEvent";
  IF rows_to_edit = 0 THEN
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '"AuditEvent"'::regclass AND tgname = 'audit_event_no_update' AND tgenabled <> 'D' AND (tgtype & 16) = 16 AND (tgtype & 8) = 8) THEN
      RAISE NOTICE 'APPEND_ONLY_OK';
      RETURN;
    END IF;
    RAISE EXCEPTION 'AUDIT TABLE IS NOT PROTECTED';
  END IF;
  UPDATE "AuditEvent" SET action = 'TAMPERED' WHERE id = (SELECT id FROM "AuditEvent" LIMIT 1);
  RAISE EXCEPTION 'AUDIT TABLE IS NOT PROTECTED';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%append-only%' THEN
    RAISE NOTICE 'APPEND_ONLY_OK';
  ELSE
    RAISE;
  END IF;
END $$;
