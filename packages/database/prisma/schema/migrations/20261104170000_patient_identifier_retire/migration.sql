-- Patient identifiers beyond the MRN (docs/patient-identifiers.md). Staff can add an old hospital number or another ID to a patient, and can retire one that was entered
-- wrongly. A retired identifier stays in the table for the record (who retired it, when and why) and is never edited again; the same value can then be recorded correctly.

-- AlterTable
ALTER TABLE "PatientIdentifier" ADD COLUMN     "createdById" UUID,
ADD COLUMN     "removedAt" TIMESTAMPTZ(3),
ADD COLUMN     "removedById" UUID,
ADD COLUMN     "removalReason" TEXT;

-- A value belongs to one patient at a time: unique among the identifiers that have not been retired.
DROP INDEX "PatientIdentifier_tenantId_type_value_key";
CREATE UNIQUE INDEX "PatientIdentifier_active_value_key" ON "PatientIdentifier" ("tenantId", "type", "value") WHERE "removedAt" IS NULL;
CREATE INDEX "PatientIdentifier_tenantId_type_value_idx" ON "PatientIdentifier"("tenantId", "type", "value");

-- The MRN is never retired, and a retirement always says who and why.
ALTER TABLE "PatientIdentifier" ADD CONSTRAINT patient_identifier_mrn_stays CHECK (type <> 'MRN' OR "removedAt" IS NULL);
ALTER TABLE "PatientIdentifier" ADD CONSTRAINT patient_identifier_retirement_complete CHECK (
  ("removedAt" IS NULL AND "removedById" IS NULL AND "removalReason" IS NULL)
  OR ("removedAt" IS NOT NULL AND "removedById" IS NOT NULL AND length(btrim(coalesce("removalReason", ''))) >= 3)
);

-- An identifier never changes what it is; the only edit allowed is retiring it, once.
CREATE OR REPLACE FUNCTION medos_identifier_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."patientId" <> OLD."patientId" OR NEW.type <> OLD.type OR NEW.value <> OLD.value
     OR NEW.issuer IS DISTINCT FROM OLD.issuer OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Patient identifiers are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."removedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'A retired patient identifier is final' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
