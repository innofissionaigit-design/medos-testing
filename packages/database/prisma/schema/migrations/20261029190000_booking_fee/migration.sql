-- Booking fee for appointments, with a permissioned, audited skip (docs/booking-fee.md).
-- AlterTable
ALTER TABLE "AdvanceDeposit" ADD COLUMN     "appointmentId" UUID;

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "bookingFee" DECIMAL(12,2),
ADD COLUMN     "feeSkipNote" TEXT,
ADD COLUMN     "feeSkipReason" TEXT,
ADD COLUMN     "feeSkippedAt" TIMESTAMPTZ(3),
ADD COLUMN     "feeSkippedById" UUID;

-- CreateIndex
CREATE INDEX "AdvanceDeposit_tenantId_appointmentId_idx" ON "AdvanceDeposit"("tenantId", "appointmentId");

-- AddForeignKey
ALTER TABLE "AdvanceDeposit" ADD CONSTRAINT "AdvanceDeposit_tenantId_appointmentId_fkey" FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "Appointment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== hand-written rules (docs/booking-fee.md) =====
ALTER TABLE "Appointment" ADD CONSTRAINT appointment_booking_fee_range CHECK ("bookingFee" IS NULL OR "bookingFee" > 0);
-- A skip is recorded in full (who, when, why) or not at all, and only where a fee was asked for.
ALTER TABLE "Appointment" ADD CONSTRAINT appointment_fee_skip_fields CHECK (
  ("feeSkippedAt" IS NULL AND "feeSkippedById" IS NULL AND "feeSkipReason" IS NULL AND "feeSkipNote" IS NULL)
  OR ("feeSkippedAt" IS NOT NULL AND "feeSkippedById" IS NOT NULL AND "feeSkipReason" IS NOT NULL AND "bookingFee" IS NOT NULL));

-- The fee asked for and any skip are fixed once recorded: a later change of the setting never alters an existing appointment.
CREATE OR REPLACE FUNCTION medos_appointment_fee_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."bookingFee" IS DISTINCT FROM OLD."bookingFee" THEN
    RAISE EXCEPTION 'The booking fee of an appointment cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."feeSkippedAt" IS NOT NULL AND (NEW."feeSkippedAt" IS DISTINCT FROM OLD."feeSkippedAt" OR NEW."feeSkippedById" IS DISTINCT FROM OLD."feeSkippedById"
     OR NEW."feeSkipReason" IS DISTINCT FROM OLD."feeSkipReason" OR NEW."feeSkipNote" IS DISTINCT FROM OLD."feeSkipNote") THEN
    RAISE EXCEPTION 'A skipped booking fee cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER appointment_fee_guard BEFORE UPDATE ON "Appointment" FOR EACH ROW EXECUTE FUNCTION medos_appointment_fee_guard();

-- A booking fee is paid for the appointment's own patient, at its own facility.
CREATE OR REPLACE FUNCTION medos_advance_appointment_scope() RETURNS trigger AS $$
DECLARE a record;
BEGIN
  IF NEW."appointmentId" IS NOT NULL THEN
    SELECT "patientId", "facilityId" INTO a FROM "Appointment" WHERE "tenantId" = NEW."tenantId" AND id = NEW."appointmentId";
    IF a."patientId" IS DISTINCT FROM NEW."patientId" OR a."facilityId" IS DISTINCT FROM NEW."facilityId" THEN
      RAISE EXCEPTION 'A booking fee must be paid for the appointment''s own patient and facility' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER advance_appointment_scope BEFORE INSERT ON "AdvanceDeposit" FOR EACH ROW EXECUTE FUNCTION medos_advance_appointment_scope();

-- Existing hospitals: Administrator and Manager roles can skip a booking fee (new hospitals get it from the role definitions).
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT "tenantId", id, 'BOOKING_FEE_SKIP' FROM "Role" WHERE name IN ('ADMINISTRATOR', 'MANAGER') AND "isSystem"
ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261029190000_booking_fee',
  'added', jsonb_build_object('ADMINISTRATOR', jsonb_build_array('BOOKING_FEE_SKIP'), 'MANAGER', jsonb_build_array('BOOKING_FEE_SKIP'))
)
FROM "Tenant" t;
