-- Follow-up management. A follow-up is an ordinary FOLLOW_UP appointment (same booking, conflict, schedule and status
-- rules as every appointment) linked to the consultation that ordered it, with SMS reminders kept in step with it.

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('SMS');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN "followUpOfEncounterId" UUID;

-- CreateTable
CREATE TABLE "AppointmentReminder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "channel" "ReminderChannel" NOT NULL DEFAULT 'SMS',
    "offsetMinutes" INTEGER NOT NULL,
    "appointmentStartAt" TIMESTAMPTZ(3) NOT NULL,
    "sendAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AppointmentReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppointmentReminder_tenantId_appointmentId_idx" ON "AppointmentReminder"("tenantId", "appointmentId");

-- CreateIndex
CREATE INDEX "AppointmentReminder_status_sendAt_idx" ON "AppointmentReminder"("status", "sendAt");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_followUpOfEncounterId_idx" ON "Appointment"("tenantId", "followUpOfEncounterId");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_followUpOfEncounterId_fkey" FOREIGN KEY ("followUpOfEncounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT "AppointmentReminder_tenantId_appointmentId_fkey" FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "Appointment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== follow-up link (hand-written) =====
ALTER TABLE "Appointment" ADD CONSTRAINT appointment_follow_up_type CHECK ("followUpOfEncounterId" IS NULL OR type = 'FOLLOW_UP');
CREATE TRIGGER appointment_scope_follow_up BEFORE INSERT OR UPDATE OF "followUpOfEncounterId" ON "Appointment" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Encounter', 'followUpOfEncounterId');

-- The ordering consultation must be the same patient's, and the link never changes once made.
CREATE OR REPLACE FUNCTION medos_follow_up_link() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."followUpOfEncounterId" IS DISTINCT FROM OLD."followUpOfEncounterId" THEN
    RAISE EXCEPTION 'A follow-up stays linked to the consultation that ordered it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."followUpOfEncounterId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Encounter" e WHERE e.id = NEW."followUpOfEncounterId" AND e."tenantId" = NEW."tenantId" AND e."patientId" = NEW."patientId"
  ) THEN
    RAISE EXCEPTION 'A follow-up must belong to the same patient as its consultation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER appointment_follow_up_link BEFORE INSERT OR UPDATE OF "followUpOfEncounterId" ON "Appointment" FOR EACH ROW EXECUTE FUNCTION medos_follow_up_link();

-- ===== reminders (hand-written) =====
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT reminder_offset_positive CHECK ("offsetMinutes" > 0);
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT reminder_attempts_nonneg CHECK (attempts >= 0);
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT reminder_sent_has_time CHECK (status <> 'SENT' OR "sentAt" IS NOT NULL);
-- At most one live reminder per appointment, channel and offset: replanning can never queue duplicates.
CREATE UNIQUE INDEX "AppointmentReminder_one_pending_per_offset" ON "AppointmentReminder" ("appointmentId", channel, "offsetMinutes") WHERE status = 'PENDING';
CREATE TRIGGER appointment_reminder_scope BEFORE INSERT OR UPDATE OF "appointmentId" ON "AppointmentReminder" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Appointment', 'appointmentId');

-- Settled reminders (sent, failed, cancelled, skipped) are history: only PENDING rows may change, and none are deleted.
CREATE OR REPLACE FUNCTION medos_reminder_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Reminder is already %', OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."appointmentId" <> OLD."appointmentId" THEN
    RAISE EXCEPTION 'Reminder identity fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER appointment_reminder_guard BEFORE UPDATE ON "AppointmentReminder" FOR EACH ROW EXECUTE FUNCTION medos_reminder_guard();
CREATE TRIGGER appointment_reminder_no_delete BEFORE DELETE ON "AppointmentReminder" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== permission (data) =====
-- Doctors may schedule a follow-up from their own consultation; they still cannot book general appointments.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r."id", 'FOLLOWUP_SCHEDULE' FROM "Role" r WHERE r."isSystem" AND r."name" = 'DOCTOR'
ON CONFLICT ("roleId", "permission") DO NOTHING;

INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261026130000_follow_ups',
  'added', jsonb_build_object('DOCTOR', jsonb_build_array('FOLLOWUP_SCHEDULE'))
)
FROM "Tenant" t;
