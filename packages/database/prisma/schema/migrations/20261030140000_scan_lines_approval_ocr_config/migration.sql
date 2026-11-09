-- Handwritten prescriptions: structured lines, doctor approval that creates the pharmacy prescription, and the OCR service connection (docs/prescriptions.md).

-- ===== prescription source =====
ALTER TABLE "MedicationOrder" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'DIGITAL';
ALTER TABLE "MedicationOrder" ADD CONSTRAINT medication_order_source CHECK (source IN ('DIGITAL', 'HANDWRITTEN'));
-- The one-draft rule is about the doctor's working prescription. An approved handwritten prescription is created and signed in one step.
DROP INDEX "MedicationOrder_one_draft_per_encounter";
CREATE UNIQUE INDEX "MedicationOrder_one_draft_per_encounter" ON "MedicationOrder" ("tenantId", "encounterId") WHERE status = 'DRAFT' AND source = 'DIGITAL';

-- ===== scan: review becomes approval =====
ALTER TABLE "PrescriptionScan" RENAME COLUMN "reviewedAt" TO "approvedAt";
ALTER TABLE "PrescriptionScan" RENAME COLUMN "reviewedById" TO "approvedById";
ALTER TABLE "PrescriptionScan"
  ADD COLUMN "lines" JSONB,
  ADD COLUMN "linesAt" TIMESTAMPTZ(3),
  ADD COLUMN "linesById" UUID,
  ADD COLUMN "medicationOrderId" UUID;
-- Before this change "reviewed" only meant the text had been checked. Approval now creates a prescription, so an earlier review is not an approval;
-- the audit trail keeps the PRESCRIPTION_SCAN_REVIEWED events.
UPDATE "PrescriptionScan" SET "approvedAt" = NULL, "approvedById" = NULL WHERE "approvedAt" IS NOT NULL;
CREATE UNIQUE INDEX "PrescriptionScan_tenantId_medicationOrderId_key" ON "PrescriptionScan"("tenantId", "medicationOrderId");
ALTER TABLE "PrescriptionScan" ADD CONSTRAINT "PrescriptionScan_tenantId_medicationOrderId_fkey" FOREIGN KEY ("tenantId", "medicationOrderId") REFERENCES "MedicationOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Approval and the prescription it created go together, and a prescription needs the approving doctor and at least one saved line.
ALTER TABLE "PrescriptionScan" ADD CONSTRAINT prescription_scan_approval CHECK (
  ("approvedAt" IS NULL AND "approvedById" IS NULL AND "medicationOrderId" IS NULL)
  OR ("approvedAt" IS NOT NULL AND "approvedById" IS NOT NULL AND "medicationOrderId" IS NOT NULL AND "lines" IS NOT NULL AND jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") >= 1));
ALTER TABLE "PrescriptionScan" ADD CONSTRAINT prescription_scan_lines_array CHECK ("lines" IS NULL OR (jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") <= 30));

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
  IF NEW."medicationOrderId" IS NOT NULL AND NEW."medicationOrderId" IS DISTINCT FROM OLD."medicationOrderId" THEN
    IF NOT EXISTS (SELECT 1 FROM "MedicationOrder" o WHERE o."tenantId" = NEW."tenantId" AND o.id = NEW."medicationOrderId" AND o."encounterId" = NEW."encounterId" AND o.source = 'HANDWRITTEN') THEN
      RAISE EXCEPTION 'The prescription of a scan must be a handwritten-source prescription of the same visit' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ===== OCR service connection =====
CREATE TABLE "OcrConfig" (
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "apiUrl" TEXT,
    "apiKeyEnc" TEXT,
    "keyLast4" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 20000,
    "lastTestAt" TIMESTAMPTZ(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "updatedById" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OcrConfig_pkey" PRIMARY KEY ("tenantId","facilityId")
);
ALTER TABLE "OcrConfig" ADD CONSTRAINT "OcrConfig_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OcrConfig" ADD CONSTRAINT ocr_config_timeout CHECK ("timeoutMs" BETWEEN 1000 AND 60000);
ALTER TABLE "OcrConfig" ADD CONSTRAINT ocr_config_key_needs_url CHECK ("apiKeyEnc" IS NULL OR "apiUrl" IS NOT NULL);
CREATE TRIGGER ocr_config_no_delete BEFORE DELETE ON "OcrConfig" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"OcrConfig"');
