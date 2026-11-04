-- Doctor earnings split rules, handwritten prescription scans with OCR results, prescription templates, and food timing on medicines.
-- CreateEnum
CREATE TYPE "ShareMode" AS ENUM ('PERCENT', 'FIXED', 'MIXED');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('UPLOADED', 'OCR_DONE', 'OCR_FAILED', 'OCR_NOT_CONFIGURED');

-- AlterTable
ALTER TABLE "MedicationOrderItem" ADD COLUMN     "foodRelation" TEXT;

-- CreateTable
CREATE TABLE "DoctorShareRule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "practitionerId" UUID,
    "mode" "ShareMode" NOT NULL,
    "percent" DECIMAL(5,2),
    "fixedAmount" DECIMAL(12,2),
    "effectiveFrom" DATE NOT NULL,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoctorShareRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrescriptionScan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'UPLOADED',
    "ocrProvider" TEXT,
    "ocrText" TEXT,
    "ocrConfidence" DECIMAL(5,4),
    "ocrError" TEXT,
    "ocrAttempts" INTEGER NOT NULL DEFAULT 0,
    "ocrAt" TIMESTAMPTZ(3),
    "correctedText" TEXT,
    "correctedById" UUID,
    "correctedAt" TIMESTAMPTZ(3),
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrescriptionScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrescriptionTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "content" JSONB NOT NULL,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PrescriptionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DoctorShareRule_tenantId_facilityId_practitionerId_effectiv_idx" ON "DoctorShareRule"("tenantId", "facilityId", "practitionerId", "effectiveFrom" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DoctorShareRule_tenantId_id_key" ON "DoctorShareRule"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PrescriptionScan_tenantId_encounterId_createdAt_idx" ON "PrescriptionScan"("tenantId", "encounterId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionScan_tenantId_id_key" ON "PrescriptionScan"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionScan_tenantId_fileId_key" ON "PrescriptionScan"("tenantId", "fileId");

-- CreateIndex
CREATE INDEX "PrescriptionTemplate_tenantId_facilityId_status_idx" ON "PrescriptionTemplate"("tenantId", "facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionTemplate_tenantId_id_key" ON "PrescriptionTemplate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionTemplate_tenantId_ownerId_name_key" ON "PrescriptionTemplate"("tenantId", "ownerId", "name");

-- AddForeignKey
ALTER TABLE "DoctorShareRule" ADD CONSTRAINT "DoctorShareRule_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorShareRule" ADD CONSTRAINT "DoctorShareRule_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionScan" ADD CONSTRAINT "PrescriptionScan_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionScan" ADD CONSTRAINT "PrescriptionScan_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionScan" ADD CONSTRAINT "PrescriptionScan_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionScan" ADD CONSTRAINT "PrescriptionScan_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "PatientFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionTemplate" ADD CONSTRAINT "PrescriptionTemplate_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionTemplate" ADD CONSTRAINT "PrescriptionTemplate_tenantId_ownerId_fkey" FOREIGN KEY ("tenantId", "ownerId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== hand-written rules (docs/earnings-and-reports.md, docs/prescriptions.md) =====

-- A share rule has exactly the numbers its mode needs, and is never edited or deleted: a change adds a new dated rule.
ALTER TABLE "DoctorShareRule" ADD CONSTRAINT doctor_share_rule_numbers CHECK (
  (mode = 'PERCENT' AND percent IS NOT NULL AND percent BETWEEN 0 AND 100 AND "fixedAmount" IS NULL)
  OR (mode = 'FIXED' AND "fixedAmount" IS NOT NULL AND "fixedAmount" >= 0 AND percent IS NULL)
  OR (mode = 'MIXED' AND percent IS NOT NULL AND percent BETWEEN 0 AND 100 AND "fixedAmount" IS NOT NULL AND "fixedAmount" >= 0));
CREATE TRIGGER doctor_share_rule_immutable BEFORE UPDATE OR DELETE ON "DoctorShareRule" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
-- A rule for one doctor must name a doctor of the same hospital and facility.
CREATE OR REPLACE FUNCTION medos_share_rule_scope() RETURNS trigger AS $$
BEGIN
  IF NEW."practitionerId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Practitioner" p WHERE p.id = NEW."practitionerId" AND p."tenantId" = NEW."tenantId" AND p."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'A share rule must name a doctor of the same hospital and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER doctor_share_rule_scope BEFORE INSERT ON "DoctorShareRule" FOR EACH ROW EXECUTE FUNCTION medos_share_rule_scope();

-- Food timing is one of a fixed set.
ALTER TABLE "MedicationOrderItem" ADD CONSTRAINT medication_item_food_relation CHECK ("foodRelation" IS NULL OR "foodRelation" IN ('BEFORE_FOOD', 'AFTER_FOOD', 'WITH_FOOD', 'EMPTY_STOMACH', 'ANY_TIME'));

-- A scan keeps what the OCR service returned exactly as it was: once text is recorded it never changes; the doctor's corrections are a separate field.
-- A scan is never deleted, and always belongs to a visit of the same patient and facility.
CREATE OR REPLACE FUNCTION medos_prescription_scan_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A prescription scan cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD."ocrText" IS NOT NULL AND NEW."ocrText" IS DISTINCT FROM OLD."ocrText" THEN
    RAISE EXCEPTION 'The OCR text of a scan cannot be changed; record a correction instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."encounterId" <> OLD."encounterId" OR NEW."patientId" <> OLD."patientId" OR NEW."fileId" <> OLD."fileId" THEN
    RAISE EXCEPTION 'A scan cannot be moved to another visit, patient or file' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER prescription_scan_guard BEFORE UPDATE OR DELETE ON "PrescriptionScan" FOR EACH ROW EXECUTE FUNCTION medos_prescription_scan_guard();
CREATE OR REPLACE FUNCTION medos_prescription_scan_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Encounter" e WHERE e."tenantId" = NEW."tenantId" AND e.id = NEW."encounterId" AND e."patientId" = NEW."patientId" AND e."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'A prescription scan must belong to a visit of the same patient and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "PatientFile" f WHERE f."tenantId" = NEW."tenantId" AND f.id = NEW."fileId" AND f."patientId" = NEW."patientId") THEN
    RAISE EXCEPTION 'A prescription scan must use a file of the same patient' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER prescription_scan_scope BEFORE INSERT ON "PrescriptionScan" FOR EACH ROW EXECUTE FUNCTION medos_prescription_scan_scope();

ALTER TABLE "PrescriptionTemplate" ADD CONSTRAINT prescription_template_name CHECK (length(btrim(name)) BETWEEN 2 AND 80);

SELECT medos_enable_tenant_rls('"DoctorShareRule"');
SELECT medos_enable_tenant_rls('"PrescriptionScan"');
SELECT medos_enable_tenant_rls('"PrescriptionTemplate"');

-- New permissions for existing hospitals (new hospitals get them from the role definitions):
--   Administrator: EARNINGS_CONFIGURE (set how collections are split between the hospital and doctors)
--   Doctor: REPORT_MY_PRACTICE (their own bookings and earnings), PRESCRIPTION_SCAN (upload a handwritten prescription)
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, x.permission
FROM "Role" r JOIN (VALUES ('ADMINISTRATOR', 'EARNINGS_CONFIGURE'), ('DOCTOR', 'REPORT_MY_PRACTICE'), ('DOCTOR', 'PRESCRIPTION_SCAN')) AS x(role, permission) ON x.role = r.name
WHERE r."isSystem"
ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261030100000_earnings_scans_templates',
  'added', jsonb_build_object('ADMINISTRATOR', jsonb_build_array('EARNINGS_CONFIGURE'), 'DOCTOR', jsonb_build_array('REPORT_MY_PRACTICE', 'PRESCRIPTION_SCAN')))
FROM "Tenant" t;
