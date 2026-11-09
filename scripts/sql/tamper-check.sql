-- Run against a restored database: the append-only audit trigger must still block edits.
DO $$
BEGIN
  UPDATE "AuditEvent" SET action = 'TAMPERED' WHERE id = (SELECT id FROM "AuditEvent" LIMIT 1);
  RAISE EXCEPTION 'AUDIT TABLE IS NOT PROTECTED';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%append-only%' THEN
    RAISE NOTICE 'APPEND_ONLY_OK';
  ELSE
    RAISE;
  END IF;
END $$;
