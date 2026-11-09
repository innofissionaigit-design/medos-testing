-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TELECONSULT_PATIENT_WAITING';

-- AlterTable
ALTER TABLE "Teleconsult" ADD COLUMN     "consentVersion" TEXT,
ADD COLUMN     "identityMethod" TEXT,
ADD COLUMN     "identityVerifiedAt" TIMESTAMPTZ(3),
ADD COLUMN     "identityVerifiedById" UUID,
ADD COLUMN     "patientWaitingAt" TIMESTAMPTZ(3);

-- ===== Hand-written invariants =====
-- Telemedicine, second stage (docs/telemedicine.md): waiting room, identity check, recorded consent wording, and a video fee that can be added to a booked appointment.
UPDATE "Teleconsult" SET "consentVersion" = 'TELE-1' WHERE "consentAt" IS NOT NULL AND "consentVersion" IS NULL;
ALTER TABLE "Teleconsult" ADD CONSTRAINT teleconsult_second_values CHECK (
  ("consentAt" IS NULL OR "consentVersion" IS NOT NULL)
  AND (("identityVerifiedAt" IS NULL AND "identityVerifiedById" IS NULL AND "identityMethod" IS NULL)
       OR ("identityVerifiedAt" IS NOT NULL AND "identityVerifiedById" IS NOT NULL AND "identityMethod" IN ('KNOWN_PATIENT', 'PHOTO_ID_SHOWN', 'APP_SIGN_IN', 'OTHER'))));

CREATE OR REPLACE FUNCTION medos_teleconsult_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A video consultation cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."appointmentId" <> OLD."appointmentId"
     OR NEW."practitionerId" <> OLD."practitionerId" OR NEW."scheduledAt" <> OLD."scheduledAt" OR NEW."roomToken" <> OLD."roomToken" THEN
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

-- A booking fee is fixed once recorded. The one addition allowed: a fee may be put on a booked appointment that had none (a video consultation with a fee), before check-in and before anything was skipped.
CREATE OR REPLACE FUNCTION medos_appointment_fee_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."bookingFee" IS DISTINCT FROM OLD."bookingFee" AND NOT (OLD."bookingFee" IS NULL AND OLD.status = 'BOOKED' AND OLD."feeSkippedAt" IS NULL) THEN
    RAISE EXCEPTION 'The booking fee of an appointment cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."feeSkippedAt" IS NOT NULL AND (NEW."feeSkippedAt" IS DISTINCT FROM OLD."feeSkippedAt" OR NEW."feeSkippedById" IS DISTINCT FROM OLD."feeSkippedById"
     OR NEW."feeSkipReason" IS DISTINCT FROM OLD."feeSkipReason" OR NEW."feeSkipNote" IS DISTINCT FROM OLD."feeSkipNote") THEN
    RAISE EXCEPTION 'A skipped booking fee cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

