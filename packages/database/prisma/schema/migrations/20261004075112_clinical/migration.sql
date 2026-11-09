-- CreateEnum
CREATE TYPE "AllergyType" AS ENUM ('DRUG', 'FOOD', 'ENVIRONMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "AllergySeverity" AS ENUM ('MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING');

-- CreateEnum
CREATE TYPE "AllergyStatus" AS ENUM ('ACTIVE', 'RESOLVED', 'ENTERED_IN_ERROR');

-- CreateEnum
CREATE TYPE "DiagnosisType" AS ENUM ('PROVISIONAL', 'FINAL', 'SECONDARY');

-- CreateEnum
CREATE TYPE "DiagnosisStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "ClinicalDocKind" AS ENUM ('CONSULTATION', 'DISCHARGE_SUMMARY');

-- CreateEnum
CREATE TYPE "ClinicalDocStatus" AS ENUM ('DRAFT', 'SIGNED', 'AMENDED');

-- CreateEnum
CREATE TYPE "ClinicalVersionKind" AS ENUM ('SIGNED', 'AMENDED');

-- CreateEnum
CREATE TYPE "MedicationOrderStatus" AS ENUM ('DRAFT', 'SIGNED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MedicationRoute" AS ENUM ('ORAL', 'IV', 'IM', 'SC', 'TOPICAL', 'OTHER');

-- CreateEnum
CREATE TYPE "MedicationFrequency" AS ENUM ('OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'STAT', 'OTHER');

-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('ACTIVE', 'STOPPED');

-- CreateTable
CREATE TABLE "Allergy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "allergen" TEXT NOT NULL,
    "allergenKey" TEXT NOT NULL,
    "type" "AllergyType" NOT NULL,
    "reaction" TEXT,
    "severity" "AllergySeverity" NOT NULL,
    "status" "AllergyStatus" NOT NULL DEFAULT 'ACTIVE',
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusReason" TEXT,
    "statusChangedById" UUID,
    "statusChangedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Allergy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Diagnosis" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "code" TEXT,
    "type" "DiagnosisType" NOT NULL,
    "status" "DiagnosisStatus" NOT NULL DEFAULT 'ACTIVE',
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedById" UUID,
    "removedAt" TIMESTAMPTZ(3),
    "removeReason" TEXT,
    "supersededAtVersion" INTEGER,

    CONSTRAINT "Diagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalDocument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "kind" "ClinicalDocKind" NOT NULL,
    "status" "ClinicalDocStatus" NOT NULL DEFAULT 'DRAFT',
    "authorId" UUID NOT NULL,
    "draft" JSONB NOT NULL DEFAULT '{}',
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "signedAt" TIMESTAMPTZ(3),
    "signedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ClinicalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalDocumentVersion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" "ClinicalVersionKind" NOT NULL,
    "content" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicalDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationOrder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "orderNumber" TEXT,
    "status" "MedicationOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "orderedById" UUID NOT NULL,
    "signedById" UUID,
    "signedAt" TIMESTAMPTZ(3),
    "supersededAtVersion" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MedicationOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationOrderItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "genericName" TEXT NOT NULL,
    "brandName" TEXT,
    "strength" TEXT,
    "dosage" TEXT NOT NULL,
    "route" "MedicationRoute" NOT NULL,
    "frequency" "MedicationFrequency" NOT NULL,
    "frequencyText" TEXT,
    "durationDays" INTEGER,
    "quantity" INTEGER,
    "instructions" TEXT,
    "status" "OrderItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "dispensedQuantity" INTEGER NOT NULL DEFAULT 0,
    "stoppedAt" TIMESTAMPTZ(3),
    "stoppedById" UUID,
    "stopReason" TEXT,

    CONSTRAINT "MedicationOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Allergy_tenantId_patientId_status_idx" ON "Allergy"("tenantId", "patientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Allergy_tenantId_id_key" ON "Allergy"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Diagnosis_tenantId_encounterId_status_idx" ON "Diagnosis"("tenantId", "encounterId", "status");

-- CreateIndex
CREATE INDEX "Diagnosis_tenantId_patientId_recordedAt_idx" ON "Diagnosis"("tenantId", "patientId", "recordedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Diagnosis_tenantId_id_key" ON "Diagnosis"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ClinicalDocument_tenantId_patientId_idx" ON "ClinicalDocument"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalDocument_tenantId_id_key" ON "ClinicalDocument"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalDocument_tenantId_encounterId_kind_key" ON "ClinicalDocument"("tenantId", "encounterId", "kind");

-- CreateIndex
CREATE INDEX "ClinicalDocumentVersion_tenantId_documentId_idx" ON "ClinicalDocumentVersion"("tenantId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalDocumentVersion_documentId_version_key" ON "ClinicalDocumentVersion"("documentId", "version");

-- CreateIndex
CREATE INDEX "MedicationOrder_tenantId_encounterId_status_idx" ON "MedicationOrder"("tenantId", "encounterId", "status");

-- CreateIndex
CREATE INDEX "MedicationOrder_tenantId_facilityId_status_signedAt_idx" ON "MedicationOrder"("tenantId", "facilityId", "status", "signedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MedicationOrder_tenantId_id_key" ON "MedicationOrder"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MedicationOrder_tenantId_facilityId_orderNumber_key" ON "MedicationOrder"("tenantId", "facilityId", "orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "MedicationOrderItem_tenantId_id_key" ON "MedicationOrderItem"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MedicationOrderItem_orderId_lineNo_key" ON "MedicationOrderItem"("orderId", "lineNo");

-- AddForeignKey
ALTER TABLE "Allergy" ADD CONSTRAINT "Allergy_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_tenantId_facilityId_encounterId_fkey" FOREIGN KEY ("tenantId", "facilityId", "encounterId") REFERENCES "Encounter"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalDocument" ADD CONSTRAINT "ClinicalDocument_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalDocument" ADD CONSTRAINT "ClinicalDocument_tenantId_facilityId_encounterId_fkey" FOREIGN KEY ("tenantId", "facilityId", "encounterId") REFERENCES "Encounter"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalDocumentVersion" ADD CONSTRAINT "ClinicalDocumentVersion_tenantId_documentId_fkey" FOREIGN KEY ("tenantId", "documentId") REFERENCES "ClinicalDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationOrder" ADD CONSTRAINT "MedicationOrder_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationOrder" ADD CONSTRAINT "MedicationOrder_tenantId_facilityId_encounterId_fkey" FOREIGN KEY ("tenantId", "facilityId", "encounterId") REFERENCES "Encounter"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationOrderItem" ADD CONSTRAINT "MedicationOrderItem_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "MedicationOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- ===== allergies: content immutable, status changes require reason/user/time =====
CREATE UNIQUE INDEX "Allergy_one_active_per_allergen" ON "Allergy" ("tenantId", "patientId", type, "allergenKey") WHERE status = 'ACTIVE';
ALTER TABLE "Allergy" ADD CONSTRAINT allergy_text_present CHECK (length(btrim(allergen)) > 0 AND length("allergenKey") > 0);

CREATE OR REPLACE FUNCTION medos_allergy_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."patientId" <> OLD."patientId" OR NEW.allergen <> OLD.allergen OR NEW."allergenKey" <> OLD."allergenKey"
     OR NEW.type <> OLD.type OR NEW.severity <> OLD.severity OR NEW.reaction IS DISTINCT FROM OLD.reaction
     OR NEW."recordedById" <> OLD."recordedById" OR NEW."recordedAt" <> OLD."recordedAt" THEN
    RAISE EXCEPTION 'Allergy details are immutable; mark it entered-in-error and record a new one' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF (OLD.status::text, NEW.status::text) NOT IN (('ACTIVE', 'RESOLVED'), ('ACTIVE', 'ENTERED_IN_ERROR'), ('RESOLVED', 'ACTIVE'), ('RESOLVED', 'ENTERED_IN_ERROR')) THEN
      RAISE EXCEPTION 'Invalid allergy status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."statusReason" IS NULL OR NEW."statusChangedById" IS NULL OR NEW."statusChangedAt" IS NULL THEN
      RAISE EXCEPTION 'Allergy status change requires reason, user and time' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER allergy_guard BEFORE UPDATE ON "Allergy" FOR EACH ROW EXECUTE FUNCTION medos_allergy_guard();
CREATE TRIGGER allergy_no_delete BEFORE DELETE ON "Allergy" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== diagnoses: content immutable; ACTIVE -> REMOVED with reason =====
ALTER TABLE "Diagnosis" ADD CONSTRAINT diagnosis_text_present CHECK (length(btrim(text)) > 0);
CREATE OR REPLACE FUNCTION medos_diagnosis_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."encounterId" <> OLD."encounterId"
     OR NEW.text <> OLD.text OR NEW.code IS DISTINCT FROM OLD.code OR NEW.type <> OLD.type
     OR NEW."recordedById" <> OLD."recordedById" OR NEW."recordedAt" <> OLD."recordedAt" THEN
    RAISE EXCEPTION 'Diagnosis details are immutable; remove it and record a new one' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (OLD.status = 'ACTIVE' AND NEW.status = 'REMOVED') THEN
      RAISE EXCEPTION 'Invalid diagnosis status transition' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."removeReason" IS NULL OR NEW."removedById" IS NULL OR NEW."removedAt" IS NULL THEN
      RAISE EXCEPTION 'Removing a diagnosis requires reason, user and time' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER diagnosis_guard BEFORE UPDATE ON "Diagnosis" FOR EACH ROW EXECUTE FUNCTION medos_diagnosis_guard();
CREATE TRIGGER diagnosis_no_delete BEFORE DELETE ON "Diagnosis" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== clinical documents: signed content can never be overwritten =====
CREATE OR REPLACE FUNCTION medos_clinical_document_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId"
     OR NEW."encounterId" <> OLD."encounterId" OR NEW.kind <> OLD.kind OR NEW."authorId" <> OLD."authorId" THEN
    RAISE EXCEPTION 'Clinical document identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status::text, NEW.status::text) NOT IN (('DRAFT', 'SIGNED'), ('SIGNED', 'AMENDED')) THEN
    RAISE EXCEPTION 'Invalid clinical document transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF NEW.draft IS DISTINCT FROM OLD.draft OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt" OR NEW."signedById" IS DISTINCT FROM OLD."signedById" THEN
      RAISE EXCEPTION 'A signed document cannot be edited; use an amendment' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."currentVersion" < OLD."currentVersion" OR NEW."currentVersion" > OLD."currentVersion" + 1 THEN
      RAISE EXCEPTION 'Document versions only move forward by one' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.status = 'SIGNED' AND OLD.status = 'DRAFT' AND (NEW."signedAt" IS NULL OR NEW."signedById" IS NULL OR NEW."currentVersion" <> 1) THEN
    RAISE EXCEPTION 'Signing requires signer, time and version 1' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER clinical_document_guard BEFORE UPDATE ON "ClinicalDocument" FOR EACH ROW EXECUTE FUNCTION medos_clinical_document_guard();
CREATE TRIGGER clinical_document_no_delete BEFORE DELETE ON "ClinicalDocument" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

CREATE TRIGGER clinical_version_immutable BEFORE UPDATE OR DELETE ON "ClinicalDocumentVersion" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER clinical_version_no_truncate BEFORE TRUNCATE ON "ClinicalDocumentVersion" FOR EACH STATEMENT EXECUTE FUNCTION medos_forbid_mutation();
ALTER TABLE "ClinicalDocumentVersion" ADD CONSTRAINT clinical_version_positive CHECK (version >= 1);

-- ===== medication orders =====
CREATE UNIQUE INDEX "MedicationOrder_one_draft_per_encounter" ON "MedicationOrder" ("tenantId", "encounterId") WHERE status = 'DRAFT';
ALTER TABLE "MedicationOrder" ADD CONSTRAINT medication_order_signed_has_number CHECK (
  (status = 'DRAFT' AND "orderNumber" IS NULL AND "signedAt" IS NULL) OR (status <> 'DRAFT' AND "orderNumber" IS NOT NULL AND "signedAt" IS NOT NULL AND "signedById" IS NOT NULL) OR status = 'CANCELLED');

CREATE OR REPLACE FUNCTION medos_medication_order_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId"
     OR NEW."encounterId" <> OLD."encounterId" OR NEW."orderedById" <> OLD."orderedById" THEN
    RAISE EXCEPTION 'Medication order identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status::text, NEW.status::text) NOT IN (
    ('DRAFT', 'SIGNED'), ('DRAFT', 'CANCELLED'), ('SIGNED', 'SUPERSEDED'), ('SIGNED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'Invalid medication order transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW."orderNumber" IS DISTINCT FROM OLD."orderNumber" OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt" OR NEW."signedById" IS DISTINCT FROM OLD."signedById") THEN
    RAISE EXCEPTION 'A signed medication order cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER medication_order_guard BEFORE UPDATE ON "MedicationOrder" FOR EACH ROW EXECUTE FUNCTION medos_medication_order_guard();
CREATE TRIGGER medication_order_no_delete BEFORE DELETE ON "MedicationOrder" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "MedicationOrderItem" ADD CONSTRAINT order_item_dispensed_valid CHECK ("dispensedQuantity" >= 0 AND ("quantity" IS NULL OR "dispensedQuantity" <= "quantity"));
ALTER TABLE "MedicationOrderItem" ADD CONSTRAINT order_item_other_needs_text CHECK (frequency <> 'OTHER' OR ("frequencyText" IS NOT NULL AND length(btrim("frequencyText")) > 0));
ALTER TABLE "MedicationOrderItem" ADD CONSTRAINT order_item_numbers CHECK (("durationDays" IS NULL OR "durationDays" BETWEEN 1 AND 365) AND (quantity IS NULL OR quantity BETWEEN 1 AND 100000) AND "lineNo" >= 1);
ALTER TABLE "MedicationOrderItem" ADD CONSTRAINT order_item_stop_has_reason CHECK (status = 'ACTIVE' OR ("stopReason" IS NOT NULL AND "stoppedAt" IS NOT NULL AND "stoppedById" IS NOT NULL));

-- Items of a signed order: no inserts or deletes; only stop (with reason) and dispensed-quantity increases.
CREATE OR REPLACE FUNCTION medos_order_item_guard() RETURNS trigger AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status::text INTO parent_status FROM "MedicationOrder" WHERE id = NEW."orderId";
    IF parent_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Items cannot be added to a signed order' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status::text INTO parent_status FROM "MedicationOrder" WHERE id = OLD."orderId";
  IF TG_OP = 'DELETE' THEN
    IF parent_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Items of a signed order cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    IF (to_jsonb(NEW) - ARRAY['status', 'stoppedAt', 'stoppedById', 'stopReason', 'dispensedQuantity'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'stoppedAt', 'stoppedById', 'stopReason', 'dispensedQuantity']) THEN
      RAISE EXCEPTION 'Items of a signed order cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."dispensedQuantity" < OLD."dispensedQuantity" THEN
      RAISE EXCEPTION 'Dispensed quantity can only increase' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'STOPPED' AND NEW.status <> 'STOPPED' THEN
      RAISE EXCEPTION 'A stopped item cannot be restarted; prescribe it again' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER medication_order_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "MedicationOrderItem" FOR EACH ROW EXECUTE FUNCTION medos_order_item_guard();

-- Optional encounter reference on allergies is not modelled; allergies are patient-level.

