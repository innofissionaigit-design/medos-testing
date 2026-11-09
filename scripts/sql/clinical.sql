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
