-- CreateEnum
CREATE TYPE "AppointmentRequestStatus" AS ENUM ('PENDING', 'BOOKED', 'DECLINED', 'CANCELLED');

-- CreateTable
CREATE TABLE "PatientOtp" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "mobile" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientOtp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientSession" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "mobile" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "practitionerId" UUID,
    "preferredDate" DATE NOT NULL,
    "timeOfDay" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AppointmentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "handledById" UUID,
    "handledAt" TIMESTAMPTZ(3),
    "handleNote" TEXT,
    "appointmentId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AppointmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientOtp_tenantId_mobile_createdAt_idx" ON "PatientOtp"("tenantId", "mobile", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PatientOtp_tenantId_id_key" ON "PatientOtp"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PatientSession_tokenHash_key" ON "PatientSession"("tokenHash");

-- CreateIndex
CREATE INDEX "PatientSession_tenantId_mobile_idx" ON "PatientSession"("tenantId", "mobile");

-- CreateIndex
CREATE UNIQUE INDEX "PatientSession_tenantId_id_key" ON "PatientSession"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AppointmentRequest_tenantId_facilityId_status_createdAt_idx" ON "AppointmentRequest"("tenantId", "facilityId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AppointmentRequest_tenantId_patientId_idx" ON "AppointmentRequest"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentRequest_tenantId_id_key" ON "AppointmentRequest"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Patient app: docs/patient-app.md. Codes and sessions only ever move one way; a finished appointment request stays as it was.

ALTER TABLE "PatientOtp" ADD CONSTRAINT patient_otp_values CHECK (mobile ~ '^[6-9][0-9]{9}$' AND attempts >= 0 AND "expiresAt" > "createdAt");
CREATE OR REPLACE FUNCTION medos_patient_otp_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A sign-in code cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW.mobile <> OLD.mobile OR NEW."codeHash" <> OLD."codeHash" OR NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION 'A sign-in code cannot be changed, only used or counted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."consumedAt" IS NOT NULL AND NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt" THEN
    RAISE EXCEPTION 'A sign-in code that was used cannot be used again' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN RAISE EXCEPTION 'Wrong tries cannot be taken back' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER patient_otp_guard BEFORE UPDATE OR DELETE ON "PatientOtp" FOR EACH ROW EXECUTE FUNCTION medos_patient_otp_guard();

ALTER TABLE "PatientSession" ADD CONSTRAINT patient_session_values CHECK (mobile ~ '^[6-9][0-9]{9}$' AND "expiresAt" > "createdAt");
CREATE OR REPLACE FUNCTION medos_patient_session_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A patient session cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW.mobile <> OLD.mobile OR NEW."tokenHash" <> OLD."tokenHash" OR NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION 'A patient session cannot be changed except to record use or sign-out' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'A signed-out session cannot be revived' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER patient_session_guard BEFORE UPDATE OR DELETE ON "PatientSession" FOR EACH ROW EXECUTE FUNCTION medos_patient_session_guard();

ALTER TABLE "AppointmentRequest" ADD CONSTRAINT appointment_request_values CHECK (
  "timeOfDay" IN ('MORNING', 'AFTERNOON', 'EVENING', 'ANY') AND length(btrim(reason)) BETWEEN 3 AND 300
  AND (status <> 'PENDING' OR ("handledAt" IS NULL AND "handledById" IS NULL))
  AND (status NOT IN ('BOOKED', 'DECLINED') OR ("handledById" IS NOT NULL AND "handledAt" IS NOT NULL))
  AND (status <> 'DECLINED' OR ("handleNote" IS NOT NULL AND length(btrim("handleNote")) >= 3)));
CREATE OR REPLACE FUNCTION medos_appointment_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An appointment request cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."patientId" <> OLD."patientId" OR NEW."facilityId" <> OLD."facilityId" OR NEW.reason <> OLD.reason OR NEW."preferredDate" <> OLD."preferredDate" THEN
    RAISE EXCEPTION 'An appointment request cannot be changed, only answered or cancelled' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'PENDING' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'An answered or cancelled appointment request cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER appointment_request_guard BEFORE UPDATE OR DELETE ON "AppointmentRequest" FOR EACH ROW EXECUTE FUNCTION medos_appointment_request_guard();

SELECT medos_enable_tenant_rls('"PatientOtp"');
SELECT medos_enable_tenant_rls('"PatientSession"');
SELECT medos_enable_tenant_rls('"AppointmentRequest"');

