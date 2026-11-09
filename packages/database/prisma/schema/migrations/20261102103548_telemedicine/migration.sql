-- CreateEnum
CREATE TYPE "TeleconsultStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Teleconsult" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "TeleconsultStatus" NOT NULL DEFAULT 'SCHEDULED',
    "roomToken" TEXT NOT NULL,
    "consentAt" TIMESTAMPTZ(3),
    "doctorJoinedAt" TIMESTAMPTZ(3),
    "patientJoinedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Teleconsult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Teleconsult_roomToken_key" ON "Teleconsult"("roomToken");

-- CreateIndex
CREATE INDEX "Teleconsult_tenantId_facilityId_status_scheduledAt_idx" ON "Teleconsult"("tenantId", "facilityId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Teleconsult_tenantId_patientId_idx" ON "Teleconsult"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Teleconsult_tenantId_id_key" ON "Teleconsult"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "Teleconsult" ADD CONSTRAINT "Teleconsult_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Teleconsult" ADD CONSTRAINT "Teleconsult_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Telemedicine: docs/telemedicine.md. One live video consultation per appointment; it follows the order scheduled, in progress, completed; consent comes before the patient joins.

ALTER TABLE "Teleconsult" ADD CONSTRAINT teleconsult_values CHECK (
  length("roomToken") >= 24
  AND (status <> 'CANCELLED' OR ("cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 5))
  AND (status <> 'COMPLETED' OR "endedAt" IS NOT NULL)
  AND ("patientJoinedAt" IS NULL OR "consentAt" IS NOT NULL));
CREATE UNIQUE INDEX teleconsult_one_live ON "Teleconsult" ("tenantId", "appointmentId") WHERE status <> 'CANCELLED';
CREATE OR REPLACE FUNCTION medos_teleconsult_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Appointment" a WHERE a.id = NEW."appointmentId" AND a."tenantId" = NEW."tenantId" AND a."facilityId" = NEW."facilityId" AND a."patientId" = NEW."patientId"
                 AND a."practitionerId" = NEW."practitionerId" AND a."startAt" = NEW."scheduledAt") THEN
    RAISE EXCEPTION 'A video consultation must match the appointment: same patient, doctor, facility and time' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER teleconsult_scope BEFORE INSERT ON "Teleconsult" FOR EACH ROW EXECUTE FUNCTION medos_teleconsult_scope();
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
  IF OLD."consentAt" IS NOT NULL AND NEW."consentAt" IS DISTINCT FROM OLD."consentAt" THEN RAISE EXCEPTION 'The patient''s consent cannot be changed or removed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD."doctorJoinedAt" IS NOT NULL AND NEW."doctorJoinedAt" IS DISTINCT FROM OLD."doctorJoinedAt" THEN RAISE EXCEPTION 'When the doctor joined cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD."patientJoinedAt" IS NOT NULL AND NEW."patientJoinedAt" IS DISTINCT FROM OLD."patientJoinedAt" THEN RAISE EXCEPTION 'When the patient joined cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER teleconsult_guard BEFORE UPDATE OR DELETE ON "Teleconsult" FOR EACH ROW EXECUTE FUNCTION medos_teleconsult_guard();

SELECT medos_enable_tenant_rls('"Teleconsult"');

INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('DOCTOR', 'TELE_READ'), ('DOCTOR', 'TELE_CONDUCT'), ('RECEPTIONIST', 'TELE_READ'), ('RECEPTIONIST', 'TELE_MANAGE'), ('ADMINISTRATOR', 'TELE_READ'), ('ADMINISTRATOR', 'TELE_MANAGE'), ('MANAGER', 'TELE_READ')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration telemedicine', 'added', jsonb_build_object(
  'DOCTOR', jsonb_build_array('TELE_READ', 'TELE_CONDUCT'), 'RECEPTIONIST', jsonb_build_array('TELE_READ', 'TELE_MANAGE'), 'ADMINISTRATOR', jsonb_build_array('TELE_READ', 'TELE_MANAGE'), 'MANAGER', jsonb_build_array('TELE_READ')))
FROM "Tenant" t;

