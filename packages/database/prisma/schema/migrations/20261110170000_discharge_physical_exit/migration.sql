-- Discharge: physical exit (docs/discharge-stages.md). The ward nurse or patient transport confirms when a discharged patient actually left:
-- the time, how (walked, wheelchair, stretcher, ambulance, or the body released), and who escorted them. One record per admission, never changed.

-- CreateEnum
CREATE TYPE "DepartureMode" AS ENUM ('WALKED', 'WHEELCHAIR', 'STRETCHER', 'AMBULANCE', 'BODY_RELEASED');

-- CreateTable
CREATE TABLE "AdmissionDeparture" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "departedAt" TIMESTAMPTZ(3) NOT NULL,
    "mode" "DepartureMode" NOT NULL,
    "escortedBy" TEXT,
    "note" TEXT,
    "confirmedById" UUID NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionDeparture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionDeparture_tenantId_id_key" ON "AdmissionDeparture"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionDeparture_admissionId_key" ON "AdmissionDeparture"("admissionId");

-- AddForeignKey
ALTER TABLE "AdmissionDeparture" ADD CONSTRAINT "AdmissionDeparture_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- A departure is part of the record: it is never changed or removed. It cannot be recorded as happening after it was confirmed.
ALTER TABLE "AdmissionDeparture" ADD CONSTRAINT departure_not_in_future CHECK ("departedAt" <= "confirmedAt" + interval '5 minutes');
ALTER TABLE "AdmissionDeparture" ADD CONSTRAINT departure_text_lengths CHECK (("escortedBy" IS NULL OR length("escortedBy") <= 120) AND ("note" IS NULL OR length("note") <= 300));
CREATE TRIGGER admission_departure_immutable BEFORE UPDATE OR DELETE ON "AdmissionDeparture" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"AdmissionDeparture"');

-- ===== who may do what: the ward nurse and the new patient transport role confirm the departure =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, 'PATIENT_TRANSPORT', true FROM "Tenant" t ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('PATIENT_TRANSPORT', 'DISCHARGE_DEPARTURE_CONFIRM'), ('PATIENT_TRANSPORT', 'ADMISSION_READ'), ('PATIENT_TRANSPORT', 'PATIENT_READ'),
  ('NURSE', 'DISCHARGE_DEPARTURE_CONFIRM')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration discharge_physical_exit', 'added', jsonb_build_object(
  'PATIENT_TRANSPORT', jsonb_build_array('DISCHARGE_DEPARTURE_CONFIRM', 'ADMISSION_READ', 'PATIENT_READ'), 'NURSE', jsonb_build_array('DISCHARGE_DEPARTURE_CONFIRM')))
FROM "Tenant" t;
