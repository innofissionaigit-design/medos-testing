-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BloodGroup" AS ENUM ('A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG');

-- CreateEnum
CREATE TYPE "IdentifierType" AS ENUM ('MRN', 'LEGACY', 'EXTERNAL', 'ABHA');

-- CreateTable
CREATE TABLE "Patient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "registeredFacilityId" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "searchName" TEXT NOT NULL,
    "gender" "Gender" NOT NULL,
    "dateOfBirth" DATE,
    "estimatedAgeYears" INTEGER,
    "ageRecordedOn" DATE,
    "mobile" TEXT,
    "addressLine" TEXT,
    "city" TEXT,
    "district" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "guardianName" TEXT,
    "guardianRelation" TEXT,
    "guardianMobile" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactMobile" TEXT,
    "bloodGroup" "BloodGroup",
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientIdentifier" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "type" "IdentifierType" NOT NULL,
    "value" TEXT NOT NULL,
    "issuer" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "tenantId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseBody" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("tenantId","scope","key")
);

-- CreateIndex
CREATE INDEX "Patient_tenantId_mobile_idx" ON "Patient"("tenantId", "mobile");

-- CreateIndex
CREATE INDEX "Patient_tenantId_createdAt_idx" ON "Patient"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Patient_tenantId_id_key" ON "Patient"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PatientIdentifier_tenantId_patientId_idx" ON "PatientIdentifier"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientIdentifier_tenantId_type_value_key" ON "PatientIdentifier"("tenantId", "type", "value");

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_tenantId_registeredFacilityId_fkey" FOREIGN KEY ("tenantId", "registeredFacilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientIdentifier" ADD CONSTRAINT "PatientIdentifier_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== Hand-written invariants =====
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Fast fuzzy name search and duplicate candidate lookup.
CREATE INDEX "Patient_searchName_trgm" ON "Patient" USING gin ("searchName" gin_trgm_ops);
-- Prefix search on MRN / mobile independent of database collation.
CREATE INDEX "Patient_mobile_prefix" ON "Patient" ("tenantId", "mobile" text_pattern_ops);
CREATE INDEX "PatientIdentifier_value_prefix" ON "PatientIdentifier" ("tenantId", "value" text_pattern_ops);

-- A patient has exactly one MRN.
CREATE UNIQUE INDEX "PatientIdentifier_one_mrn_per_patient" ON "PatientIdentifier" ("tenantId", "patientId") WHERE type = 'MRN';

ALTER TABLE "Patient" ADD CONSTRAINT patient_age_present CHECK ("dateOfBirth" IS NOT NULL OR "estimatedAgeYears" IS NOT NULL);
ALTER TABLE "Patient" ADD CONSTRAINT patient_age_estimate_has_date CHECK ("estimatedAgeYears" IS NULL OR "ageRecordedOn" IS NOT NULL);
ALTER TABLE "Patient" ADD CONSTRAINT patient_age_range CHECK ("estimatedAgeYears" IS NULL OR "estimatedAgeYears" BETWEEN 0 AND 130);
ALTER TABLE "Patient" ADD CONSTRAINT patient_dob_not_future CHECK ("dateOfBirth" IS NULL OR "dateOfBirth" <= CURRENT_DATE);
ALTER TABLE "Patient" ADD CONSTRAINT patient_mobile_format CHECK (mobile IS NULL OR mobile ~ '^[6-9][0-9]{9}$');
ALTER TABLE "Patient" ADD CONSTRAINT patient_guardian_mobile_format CHECK ("guardianMobile" IS NULL OR "guardianMobile" ~ '^[6-9][0-9]{9}$');
ALTER TABLE "Patient" ADD CONSTRAINT patient_emergency_mobile_format CHECK ("emergencyContactMobile" IS NULL OR "emergencyContactMobile" ~ '^[6-9][0-9]{9}$');
ALTER TABLE "Patient" ADD CONSTRAINT patient_first_name_present CHECK (length(btrim("firstName")) > 0);
ALTER TABLE "Patient" ADD CONSTRAINT patient_version_positive CHECK (version >= 1);

-- Identifiers are immutable once issued (an MRN must never be silently reassigned).
CREATE OR REPLACE FUNCTION medos_identifier_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."patientId" <> OLD."patientId" OR NEW.type <> OLD.type OR NEW.value <> OLD.value THEN
    RAISE EXCEPTION 'Patient identifiers are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER patient_identifier_immutable BEFORE UPDATE ON "PatientIdentifier"
  FOR EACH ROW EXECUTE FUNCTION medos_identifier_immutable();
CREATE TRIGGER patient_identifier_no_delete BEFORE DELETE ON "PatientIdentifier"
  FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- Patients are never hard-deleted.
CREATE TRIGGER patient_no_delete BEFORE DELETE ON "Patient"
  FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
