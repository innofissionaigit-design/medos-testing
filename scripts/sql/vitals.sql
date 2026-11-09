-- Observations are append-only: only the FINAL -> ENTERED_IN_ERROR flag may change, with who/when/why.
CREATE OR REPLACE FUNCTION medos_observation_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId"
     OR NEW."encounterId" <> OLD."encounterId" OR NEW.type <> OLD.type OR NEW.value <> OLD.value OR NEW.unit <> OLD.unit
     OR NEW.derived <> OLD.derived OR NEW."recordedAt" <> OLD."recordedAt" OR NEW."recordedById" <> OLD."recordedById" THEN
    RAISE EXCEPTION 'Recorded observations cannot be modified' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'FINAL' AND NEW.status = 'ENTERED_IN_ERROR') THEN
    RAISE EXCEPTION 'Invalid observation status transition' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'ENTERED_IN_ERROR' AND (NEW."errorReason" IS NULL OR NEW."errorMarkedById" IS NULL OR NEW."errorMarkedAt" IS NULL) THEN
    RAISE EXCEPTION 'Entered-in-error requires reason, user and time' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER observation_guard BEFORE UPDATE ON "Observation" FOR EACH ROW EXECUTE FUNCTION medos_observation_guard();
CREATE TRIGGER observation_no_delete BEFORE DELETE ON "Observation" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- Physiologically impossible values are rejected by the database as a last line of defence.
ALTER TABLE "Observation" ADD CONSTRAINT observation_value_range CHECK (
  CASE type
    WHEN 'SYSTOLIC_BP' THEN value BETWEEN 40 AND 300
    WHEN 'DIASTOLIC_BP' THEN value BETWEEN 20 AND 200
    WHEN 'PULSE' THEN value BETWEEN 20 AND 250
    WHEN 'RESPIRATORY_RATE' THEN value BETWEEN 4 AND 80
    WHEN 'TEMPERATURE' THEN value BETWEEN 30 AND 45
    WHEN 'SPO2' THEN value BETWEEN 30 AND 100
    WHEN 'WEIGHT' THEN value BETWEEN 0.3 AND 400
    WHEN 'HEIGHT' THEN value BETWEEN 20 AND 260
    WHEN 'BMI' THEN value BETWEEN 5 AND 120
    WHEN 'BLOOD_GLUCOSE' THEN value BETWEEN 10 AND 1500
  END);
ALTER TABLE "Observation" ADD CONSTRAINT observation_recorded_not_future CHECK ("recordedAt" <= now() + interval '5 minutes');
