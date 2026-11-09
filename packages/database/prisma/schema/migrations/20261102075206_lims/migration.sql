-- CreateEnum
CREATE TYPE "LabParamType" AS ENUM ('NUMERIC', 'TEXT', 'CHOICE');

-- CreateEnum
CREATE TYPE "LabSampleStatus" AS ENUM ('COLLECTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LabResultStatus" AS ENUM ('DRAFT', 'VERIFIED');

-- CreateEnum
CREATE TYPE "LabResultKind" AS ENUM ('VERIFIED', 'AMENDED');

-- CreateTable
CREATE TABLE "LabTestDefinition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "specimen" TEXT NOT NULL,
    "method" TEXT,
    "instructions" TEXT,
    "turnaroundHours" INTEGER,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LabTestDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabParameter" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "type" "LabParamType" NOT NULL DEFAULT 'NUMERIC',
    "choices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decimals" INTEGER NOT NULL DEFAULT 1,
    "low" DECIMAL(12,3),
    "high" DECIMAL(12,3),
    "lowMale" DECIMAL(12,3),
    "highMale" DECIMAL(12,3),
    "lowFemale" DECIMAL(12,3),
    "highFemale" DECIMAL(12,3),
    "criticalLow" DECIMAL(12,3),
    "criticalHigh" DECIMAL(12,3),
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "LabParameter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabSample" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "testOrderId" UUID NOT NULL,
    "accessionNumber" TEXT NOT NULL,
    "specimen" TEXT NOT NULL,
    "status" "LabSampleStatus" NOT NULL DEFAULT 'COLLECTED',
    "notes" TEXT,
    "collectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collectedById" UUID NOT NULL,
    "rejectReason" TEXT,
    "rejectedAt" TIMESTAMPTZ(3),
    "rejectedById" UUID,

    CONSTRAINT "LabSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabResult" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "testOrderId" UUID NOT NULL,
    "sampleId" UUID,
    "definitionId" UUID,
    "name" TEXT NOT NULL,
    "specimen" TEXT,
    "status" "LabResultStatus" NOT NULL DEFAULT 'DRAFT',
    "draft" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "hasCritical" BOOLEAN NOT NULL DEFAULT false,
    "criticalAckById" UUID,
    "criticalAckAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LabResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabResultVersion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "resultId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" "LabResultKind" NOT NULL,
    "values" JSONB NOT NULL,
    "comment" TEXT,
    "reason" TEXT,
    "hasCritical" BOOLEAN NOT NULL DEFAULT false,
    "enteredById" UUID,
    "verifiedById" UUID NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabResultVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LabTestDefinition_tenantId_id_key" ON "LabTestDefinition"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LabTestDefinition_tenantId_facilityId_serviceId_key" ON "LabTestDefinition"("tenantId", "facilityId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "LabParameter_tenantId_id_key" ON "LabParameter"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LabParameter_definitionId_lineNo_key" ON "LabParameter"("definitionId", "lineNo");

-- CreateIndex
CREATE INDEX "LabSample_tenantId_testOrderId_idx" ON "LabSample"("tenantId", "testOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "LabSample_tenantId_id_key" ON "LabSample"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LabSample_tenantId_facilityId_accessionNumber_key" ON "LabSample"("tenantId", "facilityId", "accessionNumber");

-- CreateIndex
CREATE INDEX "LabResult_tenantId_facilityId_status_updatedAt_idx" ON "LabResult"("tenantId", "facilityId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LabResult_tenantId_id_key" ON "LabResult"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LabResult_tenantId_testOrderId_key" ON "LabResult"("tenantId", "testOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "LabResultVersion_tenantId_id_key" ON "LabResultVersion"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LabResultVersion_resultId_version_key" ON "LabResultVersion"("resultId", "version");

-- AddForeignKey
ALTER TABLE "LabTestDefinition" ADD CONSTRAINT "LabTestDefinition_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabTestDefinition" ADD CONSTRAINT "LabTestDefinition_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabParameter" ADD CONSTRAINT "LabParameter_tenantId_definitionId_fkey" FOREIGN KEY ("tenantId", "definitionId") REFERENCES "LabTestDefinition"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabSample" ADD CONSTRAINT "LabSample_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabSample" ADD CONSTRAINT "LabSample_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabSample" ADD CONSTRAINT "LabSample_tenantId_testOrderId_fkey" FOREIGN KEY ("tenantId", "testOrderId") REFERENCES "TestOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_tenantId_testOrderId_fkey" FOREIGN KEY ("tenantId", "testOrderId") REFERENCES "TestOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResultVersion" ADD CONSTRAINT "LabResultVersion_tenantId_resultId_fkey" FOREIGN KEY ("tenantId", "resultId") REFERENCES "LabResult"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Laboratory (LIMS): docs/lims.md. Definitions and parameters are never deleted; a sample can only go from taken to rejected; a result's verified versions are never
-- changed; a result and its versions belong to one billed laboratory test of the same patient, visit and facility.

-- ===== test definitions and parameters =====
ALTER TABLE "LabTestDefinition" ADD CONSTRAINT lab_definition_values CHECK (length(btrim(specimen)) BETWEEN 2 AND 80 AND ("turnaroundHours" IS NULL OR "turnaroundHours" BETWEEN 1 AND 720));
CREATE TRIGGER lab_definition_no_delete BEFORE DELETE ON "LabTestDefinition" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE OR REPLACE FUNCTION medos_lab_definition_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Service" s WHERE s.id = NEW."serviceId" AND s."tenantId" = NEW."tenantId" AND s."facilityId" = NEW."facilityId" AND s.category = 'INVESTIGATION') THEN
    RAISE EXCEPTION 'A laboratory test must be set up for a test on the price list of the same hospital and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lab_definition_scope BEFORE INSERT ON "LabTestDefinition" FOR EACH ROW EXECUTE FUNCTION medos_lab_definition_scope();

ALTER TABLE "LabParameter" ADD CONSTRAINT lab_parameter_values CHECK (
  length(btrim(name)) BETWEEN 1 AND 80 AND decimals BETWEEN 0 AND 6 AND "lineNo" >= 1
  AND (type <> 'CHOICE' OR cardinality(choices) >= 2)
  AND (low IS NULL OR high IS NULL OR low <= high) AND ("lowMale" IS NULL OR "highMale" IS NULL OR "lowMale" <= "highMale")
  AND ("lowFemale" IS NULL OR "highFemale" IS NULL OR "lowFemale" <= "highFemale") AND ("criticalLow" IS NULL OR "criticalHigh" IS NULL OR "criticalLow" <= "criticalHigh"));
CREATE TRIGGER lab_parameter_no_delete BEFORE DELETE ON "LabParameter" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== samples =====
ALTER TABLE "LabSample" ADD CONSTRAINT lab_sample_rejection CHECK ((status = 'REJECTED') = ("rejectReason" IS NOT NULL AND "rejectedAt" IS NOT NULL AND "rejectedById" IS NOT NULL) AND ("rejectReason" IS NULL OR length(btrim("rejectReason")) >= 3));
CREATE UNIQUE INDEX lab_sample_one_live ON "LabSample" ("tenantId", "testOrderId") WHERE status = 'COLLECTED';
CREATE OR REPLACE FUNCTION medos_lab_order_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "TestOrder" o WHERE o.id = NEW."testOrderId" AND o."tenantId" = NEW."tenantId" AND o."facilityId" = NEW."facilityId" AND o."patientId" = NEW."patientId"
                 AND o."encounterId" = NEW."encounterId" AND o.category = 'LABORATORY' AND o.status = 'BILLED') THEN
    RAISE EXCEPTION 'A sample or result must belong to a billed laboratory test of the same patient, visit and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lab_sample_scope BEFORE INSERT ON "LabSample" FOR EACH ROW EXECUTE FUNCTION medos_lab_order_scope();
CREATE TRIGGER lab_result_scope BEFORE INSERT ON "LabResult" FOR EACH ROW EXECUTE FUNCTION medos_lab_order_scope();
CREATE OR REPLACE FUNCTION medos_lab_sample_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A laboratory sample cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NOT (OLD.status = 'COLLECTED' AND NEW.status = 'REJECTED' AND NEW.id = OLD.id AND NEW."tenantId" = OLD."tenantId" AND NEW."facilityId" = OLD."facilityId" AND NEW."patientId" = OLD."patientId"
          AND NEW."encounterId" = OLD."encounterId" AND NEW."testOrderId" = OLD."testOrderId" AND NEW."accessionNumber" = OLD."accessionNumber" AND NEW.specimen = OLD.specimen
          AND NEW."collectedAt" = OLD."collectedAt" AND NEW."collectedById" = OLD."collectedById") THEN
    RAISE EXCEPTION 'A laboratory sample can only be rejected (with a reason); nothing else about it changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lab_sample_guard BEFORE UPDATE OR DELETE ON "LabSample" FOR EACH ROW EXECUTE FUNCTION medos_lab_sample_guard();

-- ===== results and their versions =====
ALTER TABLE "LabResult" ADD CONSTRAINT lab_result_state CHECK ("currentVersion" >= 0 AND (status = 'VERIFIED') = ("currentVersion" >= 1) AND ("criticalAckAt" IS NULL) = ("criticalAckById" IS NULL));
CREATE OR REPLACE FUNCTION medos_lab_result_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A laboratory result cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."encounterId" <> OLD."encounterId" OR NEW."testOrderId" <> OLD."testOrderId" THEN
    RAISE EXCEPTION 'A laboratory result cannot be moved to another patient, visit or test' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."currentVersion" < OLD."currentVersion" OR NEW."currentVersion" > OLD."currentVersion" + 1 OR (OLD.status = 'VERIFIED' AND NEW.status <> 'VERIFIED') THEN
    RAISE EXCEPTION 'A verified laboratory result can only move forward, one version at a time' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lab_result_guard BEFORE UPDATE OR DELETE ON "LabResult" FOR EACH ROW EXECUTE FUNCTION medos_lab_result_guard();

ALTER TABLE "LabResultVersion" ADD CONSTRAINT lab_version_kind CHECK (version >= 1 AND (kind = 'VERIFIED') = (version = 1) AND (kind = 'AMENDED') = ("reason" IS NOT NULL AND length(btrim("reason")) >= 5));
CREATE TRIGGER lab_version_immutable BEFORE UPDATE OR DELETE ON "LabResultVersion" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
-- Versions follow one another with no gaps, and are written only for a result that is moving to that version.
CREATE OR REPLACE FUNCTION medos_lab_version_order() RETURNS trigger AS $$
DECLARE last integer;
BEGIN
  SELECT COALESCE(MAX(version), 0) INTO last FROM "LabResultVersion" WHERE "resultId" = NEW."resultId";
  IF NEW.version <> last + 1 THEN
    RAISE EXCEPTION 'Laboratory result versions must follow one another without gaps' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lab_version_order BEFORE INSERT ON "LabResultVersion" FOR EACH ROW EXECUTE FUNCTION medos_lab_version_order();

SELECT medos_enable_tenant_rls('"LabTestDefinition"');
SELECT medos_enable_tenant_rls('"LabParameter"');
SELECT medos_enable_tenant_rls('"LabSample"');
SELECT medos_enable_tenant_rls('"LabResult"');
SELECT medos_enable_tenant_rls('"LabResultVersion"');

-- ===== who may do what: two new roles, and the lab permissions for the roles that need them =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, r.name, true FROM "Tenant" t CROSS JOIN (VALUES ('LAB_TECHNICIAN'), ('PATHOLOGIST')) AS r(name) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('LAB_TECHNICIAN', 'LAB_READ'), ('LAB_TECHNICIAN', 'LAB_COLLECT'), ('LAB_TECHNICIAN', 'LAB_RESULT'), ('LAB_TECHNICIAN', 'PATIENT_READ'),
  ('PATHOLOGIST', 'LAB_READ'), ('PATHOLOGIST', 'LAB_RESULT'), ('PATHOLOGIST', 'LAB_VERIFY'), ('PATHOLOGIST', 'LAB_MASTERS'), ('PATHOLOGIST', 'PATIENT_READ'),
  ('ADMINISTRATOR', 'LAB_READ'), ('ADMINISTRATOR', 'LAB_MASTERS'), ('DOCTOR', 'LAB_READ'), ('NURSE', 'LAB_READ'), ('NURSE', 'LAB_COLLECT'), ('MANAGER', 'LAB_READ')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration lims', 'added', jsonb_build_object(
  'LAB_TECHNICIAN', jsonb_build_array('LAB_READ', 'LAB_COLLECT', 'LAB_RESULT', 'PATIENT_READ'), 'PATHOLOGIST', jsonb_build_array('LAB_READ', 'LAB_RESULT', 'LAB_VERIFY', 'LAB_MASTERS', 'PATIENT_READ'),
  'ADMINISTRATOR', jsonb_build_array('LAB_READ', 'LAB_MASTERS'), 'DOCTOR', jsonb_build_array('LAB_READ'), 'NURSE', jsonb_build_array('LAB_READ', 'LAB_COLLECT'), 'MANAGER', jsonb_build_array('LAB_READ')))
FROM "Tenant" t;

