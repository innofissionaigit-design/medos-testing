-- CreateEnum
CREATE TYPE "RadModality" AS ENUM ('XRAY', 'ULTRASOUND', 'CT', 'MRI', 'MAMMOGRAPHY', 'OTHER');

-- CreateEnum
CREATE TYPE "RadStudyStatus" AS ENUM ('PERFORMED', 'REPORTED');

-- CreateEnum
CREATE TYPE "RadReportKind" AS ENUM ('SIGNED', 'AMENDED');

-- CreateTable
CREATE TABLE "RadStudy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "testOrderId" UUID NOT NULL,
    "accessionNumber" TEXT NOT NULL,
    "modality" "RadModality" NOT NULL,
    "bodyPart" TEXT NOT NULL,
    "clinicalNotes" TEXT,
    "status" "RadStudyStatus" NOT NULL DEFAULT 'PERFORMED',
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "hasCritical" BOOLEAN NOT NULL DEFAULT false,
    "criticalAckById" UUID,
    "criticalAckAt" TIMESTAMPTZ(3),
    "performedById" UUID NOT NULL,
    "performedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RadStudy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadReportVersion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "studyId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" "RadReportKind" NOT NULL,
    "findings" TEXT NOT NULL,
    "impression" TEXT NOT NULL,
    "hasCritical" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "signedById" UUID NOT NULL,
    "signedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RadReportVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RadStudy_tenantId_facilityId_status_updatedAt_idx" ON "RadStudy"("tenantId", "facilityId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RadStudy_tenantId_id_key" ON "RadStudy"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RadStudy_tenantId_testOrderId_key" ON "RadStudy"("tenantId", "testOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "RadStudy_tenantId_facilityId_accessionNumber_key" ON "RadStudy"("tenantId", "facilityId", "accessionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RadReportVersion_tenantId_id_key" ON "RadReportVersion"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RadReportVersion_studyId_version_key" ON "RadReportVersion"("studyId", "version");

-- AddForeignKey
ALTER TABLE "RadStudy" ADD CONSTRAINT "RadStudy_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RadStudy" ADD CONSTRAINT "RadStudy_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RadStudy" ADD CONSTRAINT "RadStudy_tenantId_testOrderId_fkey" FOREIGN KEY ("tenantId", "testOrderId") REFERENCES "TestOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RadReportVersion" ADD CONSTRAINT "RadReportVersion_tenantId_studyId_fkey" FOREIGN KEY ("tenantId", "studyId") REFERENCES "RadStudy"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Radiology: docs/radiology.md. A study belongs to one billed radiology test of the same patient, visit and facility; signed report versions are never changed.

ALTER TABLE "RadStudy" ADD CONSTRAINT rad_study_values CHECK (length(btrim("bodyPart")) BETWEEN 2 AND 80 AND length(btrim("accessionNumber")) >= 4);
ALTER TABLE "RadStudy" ADD CONSTRAINT rad_study_state CHECK ("currentVersion" >= 0 AND (status = 'REPORTED') = ("currentVersion" >= 1) AND ("criticalAckAt" IS NULL) = ("criticalAckById" IS NULL));
CREATE OR REPLACE FUNCTION medos_rad_study_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "TestOrder" o WHERE o.id = NEW."testOrderId" AND o."tenantId" = NEW."tenantId" AND o."facilityId" = NEW."facilityId" AND o."patientId" = NEW."patientId"
                 AND o."encounterId" = NEW."encounterId" AND o.category = 'RADIOLOGY' AND o.status = 'BILLED') THEN
    RAISE EXCEPTION 'A radiology study must belong to a billed radiology test of the same patient, visit and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rad_study_scope BEFORE INSERT ON "RadStudy" FOR EACH ROW EXECUTE FUNCTION medos_rad_study_scope();
CREATE OR REPLACE FUNCTION medos_rad_study_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A radiology study cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."encounterId" <> OLD."encounterId"
     OR NEW."testOrderId" <> OLD."testOrderId" OR NEW."accessionNumber" <> OLD."accessionNumber" THEN
    RAISE EXCEPTION 'A radiology study cannot be moved to another patient, visit or test' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."currentVersion" < OLD."currentVersion" OR NEW."currentVersion" > OLD."currentVersion" + 1 OR (OLD.status = 'REPORTED' AND NEW.status <> 'REPORTED') THEN
    RAISE EXCEPTION 'A reported radiology study can only move forward, one version at a time' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rad_study_guard BEFORE UPDATE OR DELETE ON "RadStudy" FOR EACH ROW EXECUTE FUNCTION medos_rad_study_guard();

ALTER TABLE "RadReportVersion" ADD CONSTRAINT rad_version_kind CHECK (version >= 1 AND (kind = 'SIGNED') = (version = 1) AND (kind = 'AMENDED') = ("reason" IS NOT NULL AND length(btrim("reason")) >= 5)
  AND length(btrim(findings)) >= 3 AND length(btrim(impression)) >= 3);
CREATE TRIGGER rad_version_immutable BEFORE UPDATE OR DELETE ON "RadReportVersion" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE OR REPLACE FUNCTION medos_rad_version_order() RETURNS trigger AS $$
DECLARE last integer;
BEGIN
  SELECT COALESCE(MAX(version), 0) INTO last FROM "RadReportVersion" WHERE "studyId" = NEW."studyId";
  IF NEW.version <> last + 1 THEN
    RAISE EXCEPTION 'Radiology report versions must follow one another without gaps' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rad_version_order BEFORE INSERT ON "RadReportVersion" FOR EACH ROW EXECUTE FUNCTION medos_rad_version_order();

SELECT medos_enable_tenant_rls('"RadStudy"');
SELECT medos_enable_tenant_rls('"RadReportVersion"');

INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, r.name, true FROM "Tenant" t CROSS JOIN (VALUES ('RADIOGRAPHER'), ('RADIOLOGIST')) AS r(name) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('RADIOGRAPHER', 'RAD_READ'), ('RADIOGRAPHER', 'RAD_PERFORM'), ('RADIOGRAPHER', 'PATIENT_READ'),
  ('RADIOLOGIST', 'RAD_READ'), ('RADIOLOGIST', 'RAD_REPORT'), ('RADIOLOGIST', 'PATIENT_READ'),
  ('ADMINISTRATOR', 'RAD_READ'), ('DOCTOR', 'RAD_READ'), ('NURSE', 'RAD_READ'), ('MANAGER', 'RAD_READ')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration radiology', 'added', jsonb_build_object(
  'RADIOGRAPHER', jsonb_build_array('RAD_READ', 'RAD_PERFORM', 'PATIENT_READ'), 'RADIOLOGIST', jsonb_build_array('RAD_READ', 'RAD_REPORT', 'PATIENT_READ'),
  'ADMINISTRATOR', jsonb_build_array('RAD_READ'), 'DOCTOR', jsonb_build_array('RAD_READ'), 'NURSE', jsonb_build_array('RAD_READ'), 'MANAGER', jsonb_build_array('RAD_READ')))
FROM "Tenant" t;

