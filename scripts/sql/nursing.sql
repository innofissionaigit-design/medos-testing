CREATE TRIGGER nursing_note_scope_addendum BEFORE INSERT OR UPDATE OF "addendumOfId" ON "NursingNote" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('NursingNote', 'addendumOfId');

-- ===== nursing notes: append-only =====
ALTER TABLE "NursingNote" ADD CONSTRAINT nursing_note_text CHECK (length(btrim(note)) >= 3);
CREATE OR REPLACE FUNCTION medos_nursing_note_guard() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) THEN
    RAISE EXCEPTION 'A nursing note cannot be edited; add an addendum' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'ACTIVE' AND NEW.status = 'ENTERED_IN_ERROR' AND NEW."errorReason" IS NOT NULL AND NEW."errorById" IS NOT NULL AND NEW."errorAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid nursing note status change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER nursing_note_guard BEFORE UPDATE ON "NursingNote" FOR EACH ROW EXECUTE FUNCTION medos_nursing_note_guard();
CREATE TRIGGER nursing_note_no_delete BEFORE DELETE ON "NursingNote" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== tasks =====
ALTER TABLE "NursingTask" ADD CONSTRAINT nursing_task_title CHECK (length(btrim(title)) >= 3);
ALTER TABLE "NursingTask" ADD CONSTRAINT nursing_task_close_complete CHECK (
  (status = 'PENDING' AND "completedAt" IS NULL AND "completedById" IS NULL) OR (status IN ('DONE', 'CANCELLED') AND "completedAt" IS NOT NULL AND "completedById" IS NOT NULL));
CREATE OR REPLACE FUNCTION medos_nursing_task_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'A closed task cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."admissionId" <> OLD."admissionId" OR NEW.title <> OLD.title OR NEW."dueAt" <> OLD."dueAt" OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'Task details cannot be changed; cancel it and create a new task' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER nursing_task_guard BEFORE UPDATE ON "NursingTask" FOR EACH ROW EXECUTE FUNCTION medos_nursing_task_guard();
CREATE TRIGGER nursing_task_no_delete BEFORE DELETE ON "NursingTask" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== MAR: administration is a one-way, attributable event =====
ALTER TABLE "MedicationAdministration" ADD CONSTRAINT mar_status_complete CHECK (
  (status = 'DUE' AND "administeredAt" IS NULL AND "administeredById" IS NULL)
  OR (status = 'GIVEN' AND "administeredAt" IS NOT NULL AND "administeredById" IS NOT NULL)
  OR (status IN ('MISSED', 'HELD', 'REFUSED') AND "administeredById" IS NOT NULL AND remarks IS NOT NULL AND length(btrim(remarks)) >= 3));
CREATE OR REPLACE FUNCTION medos_mar_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Medication administration records cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'DUE' THEN
    RAISE EXCEPTION 'A recorded administration cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."admissionId" <> OLD."admissionId" OR NEW."medicationOrderItemId" <> OLD."medicationOrderItemId"
     OR NEW."scheduledAt" <> OLD."scheduledAt" OR NEW."patientId" <> OLD."patientId" OR NEW.unscheduled <> OLD.unscheduled THEN
    RAISE EXCEPTION 'Schedule fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER mar_guard BEFORE UPDATE OR DELETE ON "MedicationAdministration" FOR EACH ROW EXECUTE FUNCTION medos_mar_guard();

-- ===== intake / output: append-only with entered-in-error =====
ALTER TABLE "IntakeOutput" ADD CONSTRAINT io_amount CHECK (amount > 0 AND amount <= 20000);
ALTER TABLE "IntakeOutput" ADD CONSTRAINT io_category_matches_direction CHECK (
  (direction = 'INTAKE' AND category IN ('ORAL', 'IV', 'OTHER_INTAKE')) OR (direction = 'OUTPUT' AND category IN ('URINE', 'DRAIN', 'VOMIT', 'OTHER_OUTPUT')));
ALTER TABLE "IntakeOutput" ADD CONSTRAINT io_not_future CHECK ("recordedAt" <= now() + interval '5 minutes');
CREATE OR REPLACE FUNCTION medos_io_guard() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) THEN
    RAISE EXCEPTION 'Recorded intake/output cannot be modified' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'FINAL' AND NEW.status = 'ENTERED_IN_ERROR' AND NEW."errorReason" IS NOT NULL AND NEW."errorById" IS NOT NULL AND NEW."errorAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid intake/output status change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER io_guard BEFORE UPDATE ON "IntakeOutput" FOR EACH ROW EXECUTE FUNCTION medos_io_guard();
CREATE TRIGGER io_no_delete BEFORE DELETE ON "IntakeOutput" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
