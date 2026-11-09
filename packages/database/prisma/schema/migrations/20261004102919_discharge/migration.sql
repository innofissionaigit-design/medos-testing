-- CreateEnum
CREATE TYPE "ClearanceStep" AS ENUM ('MEDICALLY_FIT', 'NURSING', 'CHARGES_REVIEWED', 'PHARMACY', 'BILLING');

-- CreateEnum
CREATE TYPE "ClearanceStatus" AS ENUM ('CLEARED', 'WAIVED');

-- CreateEnum
CREATE TYPE "DischargeType" AS ENUM ('ROUTINE', 'LAMA', 'REFERRED', 'ABSCONDED', 'DEATH');

-- AlterTable
ALTER TABLE "Admission" ADD COLUMN     "dischargeNote" TEXT,
ADD COLUMN     "dischargeType" "DischargeType",
ADD COLUMN     "finalInvoiceId" UUID;

-- CreateTable
CREATE TABLE "Setting" (
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("tenantId","facilityId","key")
);

-- CreateTable
CREATE TABLE "DischargeClearance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "step" "ClearanceStep" NOT NULL,
    "status" "ClearanceStatus" NOT NULL,
    "note" TEXT,
    "byId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DischargeClearance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DischargeClearance_tenantId_id_key" ON "DischargeClearance"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DischargeClearance_admissionId_step_key" ON "DischargeClearance"("admissionId", "step");

-- AddForeignKey
ALTER TABLE "Setting" ADD CONSTRAINT "Setting_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DischargeClearance" ADD CONSTRAINT "DischargeClearance_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Admission" ADD CONSTRAINT "Admission_finalInvoiceId_fkey" FOREIGN KEY ("finalInvoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- ===== admissions: discharge details =====
CREATE TRIGGER admission_scope_final_invoice BEFORE INSERT OR UPDATE OF "finalInvoiceId" ON "Admission" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Invoice', 'finalInvoiceId');
ALTER TABLE "Admission" ADD CONSTRAINT admission_discharged_has_type CHECK (status <> 'DISCHARGED' OR "dischargeType" IS NOT NULL);

CREATE OR REPLACE FUNCTION medos_admission_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."encounterId" <> OLD."encounterId"
     OR NEW."admissionNumber" <> OLD."admissionNumber" OR NEW."admittedAt" <> OLD."admittedAt" THEN
    RAISE EXCEPTION 'Admission identity fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND OLD.status <> 'ADMITTED' THEN
    RAISE EXCEPTION 'A closed admission cannot be reopened' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'ADMITTED' AND (NEW."dischargedAt" IS DISTINCT FROM OLD."dischargedAt" OR NEW."dischargeType" IS DISTINCT FROM OLD."dischargeType"
     OR NEW."finalInvoiceId" IS DISTINCT FROM OLD."finalInvoiceId" OR NEW."dischargeNote" IS DISTINCT FROM OLD."dischargeNote") THEN
    RAISE EXCEPTION 'A closed admission cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."finalInvoiceId" IS NOT NULL AND NEW."finalInvoiceId" IS DISTINCT FROM OLD."finalInvoiceId" THEN
    RAISE EXCEPTION 'The final invoice of an admission cannot be replaced' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===== clearances are append-only; waivers need a real reason; the medical-fitness step can never be waived =====
ALTER TABLE "DischargeClearance" ADD CONSTRAINT clearance_waiver_reason CHECK (status = 'CLEARED' OR (note IS NOT NULL AND length(btrim(note)) >= 10));
ALTER TABLE "DischargeClearance" ADD CONSTRAINT clearance_fit_not_waivable CHECK (NOT (step = 'MEDICALLY_FIT' AND status = 'WAIVED'));
CREATE TRIGGER clearance_immutable BEFORE UPDATE OR DELETE ON "DischargeClearance" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== settings =====
CREATE TRIGGER setting_no_delete BEFORE DELETE ON "Setting" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

