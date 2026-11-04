-- Patient merge, "link" design (docs/patient-merge.md). A duplicate patient is linked to the real one; no clinical or financial row is moved
-- (the guards on those tables forbid changing a record's patient, on purpose). The link can be re-pointed but never cleared: no undo.
ALTER TABLE "Patient"
  ADD COLUMN "mergedIntoId" UUID,
  ADD COLUMN "mergedAt" TIMESTAMPTZ(3),
  ADD COLUMN "mergedById" UUID,
  ADD COLUMN "mergeReason" TEXT;

ALTER TABLE "Patient" ADD CONSTRAINT "Patient_tenantId_mergedIntoId_fkey"
  FOREIGN KEY ("tenantId", "mergedIntoId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Patient_tenantId_mergedIntoId_idx" ON "Patient"("tenantId", "mergedIntoId");

-- All four merge fields are set together or not at all, and a patient is never merged into itself.
ALTER TABLE "Patient" ADD CONSTRAINT patient_merge_fields CHECK (
  ("mergedIntoId" IS NULL AND "mergedAt" IS NULL AND "mergedById" IS NULL AND "mergeReason" IS NULL)
  OR ("mergedIntoId" IS NOT NULL AND "mergedAt" IS NOT NULL AND "mergedById" IS NOT NULL AND "mergeReason" IS NOT NULL AND "mergedIntoId" <> id)
);

CREATE OR REPLACE FUNCTION medos_patient_merge_guard() RETURNS trigger AS $$
DECLARE target_merged UUID;
BEGIN
  IF OLD."mergedIntoId" IS NOT NULL THEN
    IF NEW."mergedIntoId" IS NULL THEN RAISE EXCEPTION 'A merge cannot be undone' USING ERRCODE = 'P0001'; END IF;
    IF NEW.status <> 'INACTIVE' THEN RAISE EXCEPTION 'A merged patient stays inactive' USING ERRCODE = 'P0001'; END IF;
    IF NEW."mergedById" IS DISTINCT FROM OLD."mergedById" OR NEW."mergedAt" IS DISTINCT FROM OLD."mergedAt" OR NEW."mergeReason" IS DISTINCT FROM OLD."mergeReason" THEN
      RAISE EXCEPTION 'The merge record cannot be changed' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW."mergedIntoId" IS NOT NULL AND NEW."mergedIntoId" IS DISTINCT FROM OLD."mergedIntoId" THEN
    SELECT p."mergedIntoId" INTO target_merged FROM "Patient" p WHERE p."tenantId" = NEW."tenantId" AND p.id = NEW."mergedIntoId";
    IF target_merged IS NOT NULL THEN RAISE EXCEPTION 'A patient cannot be merged into a patient that is itself merged' USING ERRCODE = 'P0001'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER patient_merge_guard BEFORE UPDATE ON "Patient" FOR EACH ROW EXECUTE FUNCTION medos_patient_merge_guard();

-- Permission to merge: held by the Administrator role.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT "tenantId", id, 'PATIENT_MERGE' FROM "Role" WHERE name = 'ADMINISTRATOR' AND "isSystem"
ON CONFLICT DO NOTHING;

INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261029150000_patient_merge',
  'added', jsonb_build_object('ADMINISTRATOR', jsonb_build_array('PATIENT_MERGE'))
)
FROM "Tenant" t;
