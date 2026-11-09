-- AlterTable
ALTER TABLE "Dispense" ADD COLUMN     "prescriptionScanId" UUID;

-- AlterTable
ALTER TABLE "PrescriptionScan" ADD COLUMN     "pharmacyAt" TIMESTAMPTZ(3),
ADD COLUMN     "pharmacyById" UUID,
ADD COLUMN     "pharmacyNote" TEXT,
ADD COLUMN     "pharmacyOutcome" TEXT;

-- CreateIndex
CREATE INDEX "Dispense_tenantId_prescriptionScanId_idx" ON "Dispense"("tenantId", "prescriptionScanId");

-- CreateIndex
CREATE INDEX "PrescriptionScan_tenantId_facilityId_pharmacyOutcome_create_idx" ON "PrescriptionScan"("tenantId", "facilityId", "pharmacyOutcome", "createdAt");

-- AddForeignKey
ALTER TABLE "Dispense" ADD CONSTRAINT "Dispense_tenantId_prescriptionScanId_fkey" FOREIGN KEY ("tenantId", "prescriptionScanId") REFERENCES "PrescriptionScan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== rules =====
-- The pharmacy's handling of a handwritten prescription picture: the pharmacist verified it, entered the medicines and billed (DISPENSED), or could not use it (REJECTED, with the reason).
-- Who and when always go with the outcome, and once it is recorded it is final.
ALTER TABLE "PrescriptionScan" ADD CONSTRAINT prescription_scan_pharmacy CHECK (
  ("pharmacyOutcome" IS NULL AND "pharmacyAt" IS NULL AND "pharmacyById" IS NULL AND "pharmacyNote" IS NULL)
  OR ("pharmacyOutcome" IN ('DISPENSED', 'REJECTED') AND "pharmacyAt" IS NOT NULL AND "pharmacyById" IS NOT NULL AND ("pharmacyOutcome" = 'DISPENSED' OR length(btrim(coalesce("pharmacyNote", ''))) >= 5)));

CREATE OR REPLACE FUNCTION medos_prescription_scan_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A prescription scan cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD."ocrText" IS NOT NULL AND NEW."ocrText" IS DISTINCT FROM OLD."ocrText" THEN
    RAISE EXCEPTION 'The OCR text of a scan cannot be changed; record a correction instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."encounterId" <> OLD."encounterId" OR NEW."patientId" <> OLD."patientId" OR NEW."fileId" <> OLD."fileId" THEN
    RAISE EXCEPTION 'A scan cannot be moved to another visit, patient or file' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."approvedAt" IS NOT NULL AND (
       NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."medicationOrderId" IS DISTINCT FROM OLD."medicationOrderId"
       OR NEW."lines" IS DISTINCT FROM OLD."lines" OR NEW."correctedText" IS DISTINCT FROM OLD."correctedText") THEN
    RAISE EXCEPTION 'An approved prescription scan cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."pharmacyOutcome" IS NOT NULL AND (
       NEW."pharmacyOutcome" IS DISTINCT FROM OLD."pharmacyOutcome" OR NEW."pharmacyAt" IS DISTINCT FROM OLD."pharmacyAt"
       OR NEW."pharmacyById" IS DISTINCT FROM OLD."pharmacyById" OR NEW."pharmacyNote" IS DISTINCT FROM OLD."pharmacyNote") THEN
    RAISE EXCEPTION 'What the pharmacy did with this prescription cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."medicationOrderId" IS NOT NULL AND NEW."medicationOrderId" IS DISTINCT FROM OLD."medicationOrderId" THEN
    IF NOT EXISTS (SELECT 1 FROM "MedicationOrder" o WHERE o."tenantId" = NEW."tenantId" AND o.id = NEW."medicationOrderId" AND o."encounterId" = NEW."encounterId" AND o.source = 'HANDWRITTEN') THEN
      RAISE EXCEPTION 'The prescription of a scan must be a handwritten-source prescription of the same visit' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- A dispense made from a picture must use a picture of the same patient and facility, and never change afterwards.
CREATE OR REPLACE FUNCTION medos_dispense_scan_scope() RETURNS trigger AS $$
BEGIN
  IF NEW."prescriptionScanId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "PrescriptionScan" s WHERE s."tenantId" = NEW."tenantId" AND s.id = NEW."prescriptionScanId" AND s."patientId" = NEW."patientId" AND s."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'A dispense must use a prescription picture of the same patient and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."prescriptionScanId" IS DISTINCT FROM OLD."prescriptionScanId" THEN
    RAISE EXCEPTION 'A completed dispense cannot be changed; record a return' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER dispense_scope_scan BEFORE INSERT OR UPDATE OF "prescriptionScanId" ON "Dispense" FOR EACH ROW EXECUTE FUNCTION medos_dispense_scan_scope();