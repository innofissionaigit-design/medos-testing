-- Post-discharge (docs/discharge-stages.md): the Medical Records Department codes the final diagnoses (ICD-10) when it signs the record off,
-- and tracks where the paper record is (received, filed, issued, returned). Both are append-only.

-- CreateEnum
CREATE TYPE "RecordFileAction" AS ENUM ('RECEIVED', 'FILED', 'ISSUED', 'RETURNED');

-- CreateTable
CREATE TABLE "MedicalRecordCode" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "diagnosis" TEXT NOT NULL,
    "icd10" TEXT NOT NULL,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "codedById" UUID NOT NULL,
    "codedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicalRecordCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicalRecordFileMovement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "action" "RecordFileAction" NOT NULL,
    "location" TEXT,
    "issuedTo" TEXT,
    "note" TEXT,
    "byId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicalRecordFileMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MedicalRecordCode_tenantId_id_key" ON "MedicalRecordCode"("tenantId", "id");
CREATE UNIQUE INDEX "MedicalRecordCode_admissionId_icd10_key" ON "MedicalRecordCode"("admissionId", "icd10");
CREATE INDEX "MedicalRecordCode_tenantId_icd10_idx" ON "MedicalRecordCode"("tenantId", "icd10");
CREATE UNIQUE INDEX "MedicalRecordFileMovement_tenantId_id_key" ON "MedicalRecordFileMovement"("tenantId", "id");
CREATE INDEX "MedicalRecordFileMovement_tenantId_admissionId_at_idx" ON "MedicalRecordFileMovement"("tenantId", "admissionId", "at");

-- AddForeignKey
ALTER TABLE "MedicalRecordCode" ADD CONSTRAINT "MedicalRecordCode_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MedicalRecordFileMovement" ADD CONSTRAINT "MedicalRecordFileMovement_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- An ICD-10 code looks like A00, A00.0 or S72.001; one primary diagnosis per admission.
ALTER TABLE "MedicalRecordCode" ADD CONSTRAINT record_code_icd10_format CHECK ("icd10" ~ '^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$' AND length(btrim("diagnosis")) BETWEEN 2 AND 300);
CREATE UNIQUE INDEX record_code_one_primary ON "MedicalRecordCode"("admissionId") WHERE "primary";
-- A file movement says where it went: filed needs a location, issued needs who has it.
ALTER TABLE "MedicalRecordFileMovement" ADD CONSTRAINT record_file_movement_details CHECK (
  ("action" <> 'FILED' OR ("location" IS NOT NULL AND length(btrim("location")) >= 2))
  AND ("action" <> 'ISSUED' OR ("issuedTo" IS NOT NULL AND length(btrim("issuedTo")) >= 2))
  AND ("location" IS NULL OR length("location") <= 120) AND ("issuedTo" IS NULL OR length("issuedTo") <= 120) AND ("note" IS NULL OR length("note") <= 300)
);
CREATE TRIGGER medical_record_code_immutable BEFORE UPDATE OR DELETE ON "MedicalRecordCode" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER medical_record_file_movement_immutable BEFORE UPDATE OR DELETE ON "MedicalRecordFileMovement" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"MedicalRecordCode"');
SELECT medos_enable_tenant_rls('"MedicalRecordFileMovement"');
