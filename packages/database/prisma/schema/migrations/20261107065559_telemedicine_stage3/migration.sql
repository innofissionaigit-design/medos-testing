-- AlterTable
ALTER TABLE "Practitioner" ADD COLUMN     "videoFee" DECIMAL(12,2);

-- ===== Hand-written invariants =====
-- Telemedicine, third stage (docs/telemedicine.md): a fee per doctor, and a video consultation that follows its appointment when the appointment is moved.
ALTER TABLE "Practitioner" ADD CONSTRAINT practitioner_video_fee_range CHECK ("videoFee" IS NULL OR "videoFee" >= 0);

CREATE OR REPLACE FUNCTION medos_teleconsult_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A video consultation cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."appointmentId" <> OLD."appointmentId"
     OR NEW."practitionerId" <> OLD."practitionerId" OR NEW."roomToken" <> OLD."roomToken" THEN
    RAISE EXCEPTION 'A video consultation cannot be moved to another appointment, patient, doctor or time' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The time may change only while the call has not started, and only to the appointment's own (new) time.
  IF NEW."scheduledAt" <> OLD."scheduledAt" AND (OLD.status <> 'SCHEDULED' OR NOT EXISTS (
       SELECT 1 FROM "Appointment" a WHERE a.id = NEW."appointmentId" AND a."tenantId" = NEW."tenantId" AND a."startAt" = NEW."scheduledAt")) THEN
    RAISE EXCEPTION 'A video consultation cannot be moved to another appointment, patient, doctor or time' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('COMPLETED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'A finished video consultation cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'SCHEDULED' AND NEW.status = 'COMPLETED' THEN RAISE EXCEPTION 'A video consultation that never started cannot be completed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD."consentAt" IS NOT NULL AND (NEW."consentAt" IS DISTINCT FROM OLD."consentAt" OR NEW."consentVersion" IS DISTINCT FROM OLD."consentVersion") THEN RAISE EXCEPTION 'The patient''s consent cannot be changed or removed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD."doctorJoinedAt" IS NOT NULL AND NEW."doctorJoinedAt" IS DISTINCT FROM OLD."doctorJoinedAt" THEN RAISE EXCEPTION 'When the doctor joined cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD."patientJoinedAt" IS NOT NULL AND NEW."patientJoinedAt" IS DISTINCT FROM OLD."patientJoinedAt" THEN RAISE EXCEPTION 'When the patient joined cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD."patientWaitingAt" IS NOT NULL AND NEW."patientWaitingAt" IS DISTINCT FROM OLD."patientWaitingAt" THEN RAISE EXCEPTION 'When the patient arrived cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD."identityVerifiedAt" IS NOT NULL AND (NEW."identityVerifiedAt" IS DISTINCT FROM OLD."identityVerifiedAt" OR NEW."identityVerifiedById" IS DISTINCT FROM OLD."identityVerifiedById" OR NEW."identityMethod" IS DISTINCT FROM OLD."identityMethod") THEN
    RAISE EXCEPTION 'The identity check cannot be changed or removed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

