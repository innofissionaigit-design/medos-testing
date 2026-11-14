-- Discharge flow (docs/discharge-flow.md): planned going-home date, reasons a patient is held up, the insurer's own clock,
-- and the ledger of reminders / escalations already sent. Whether a patient is fit to go home stays the doctor's alone.

-- CreateEnum
CREATE TYPE "DelayReason" AS ENUM ('WAITING_FOR_INSURANCE', 'FAMILY_ARRANGING_MONEY', 'SUMMARY_NOT_WRITTEN', 'WAITING_FOR_LAB_OR_REPORT', 'WAITING_FOR_MEDICINES', 'WAITING_FOR_DOCTOR', 'WAITING_FOR_TRANSPORT', 'PATIENT_OR_FAMILY_NOT_READY', 'OTHER');
CREATE TYPE "FlowClock" AS ENUM ('DISCHARGE', 'INSURER');
CREATE TYPE "FlowAlertLevel" AS ENUM ('REMINDER', 'ESCALATION_DEPARTMENT', 'ESCALATION_ADMINISTRATOR');

-- Notifications for reminders and escalations (not used in this migration).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DISCHARGE_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DISCHARGE_ESCALATION';

-- CreateTable
CREATE TABLE "DischargePlan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "expectedDate" DATE NOT NULL,
    "note" TEXT,
    "setById" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DischargePlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DischargeDelay" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "reason" "DelayReason" NOT NULL,
    "note" TEXT,
    "byId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DischargeDelay_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InsurerBillSend" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "byId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InsurerBillSend_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DischargeAlert" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "clock" "FlowClock" NOT NULL,
    "level" "FlowAlertLevel" NOT NULL,
    "stage" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DischargeAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DischargePlan_tenantId_id_key" ON "DischargePlan"("tenantId", "id");
CREATE UNIQUE INDEX "DischargePlan_admissionId_key" ON "DischargePlan"("admissionId");
CREATE UNIQUE INDEX "DischargePlan_tenantId_facilityId_admissionId_key" ON "DischargePlan"("tenantId", "facilityId", "admissionId");
CREATE UNIQUE INDEX "DischargeDelay_tenantId_id_key" ON "DischargeDelay"("tenantId", "id");
CREATE INDEX "DischargeDelay_tenantId_admissionId_stage_at_idx" ON "DischargeDelay"("tenantId", "admissionId", "stage", "at");
CREATE INDEX "DischargeDelay_tenantId_facilityId_at_idx" ON "DischargeDelay"("tenantId", "facilityId", "at");
CREATE UNIQUE INDEX "InsurerBillSend_tenantId_id_key" ON "InsurerBillSend"("tenantId", "id");
CREATE UNIQUE INDEX "InsurerBillSend_admissionId_key" ON "InsurerBillSend"("admissionId");
CREATE UNIQUE INDEX "InsurerBillSend_tenantId_facilityId_admissionId_key" ON "InsurerBillSend"("tenantId", "facilityId", "admissionId");
CREATE UNIQUE INDEX "DischargeAlert_tenantId_id_key" ON "DischargeAlert"("tenantId", "id");
CREATE UNIQUE INDEX "DischargeAlert_admissionId_clock_level_stage_key" ON "DischargeAlert"("admissionId", "clock", "level", "stage");
CREATE INDEX "DischargeAlert_tenantId_facilityId_sentAt_idx" ON "DischargeAlert"("tenantId", "facilityId", "sentAt");

-- AddForeignKey
ALTER TABLE "DischargePlan" ADD CONSTRAINT "DischargePlan_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DischargeDelay" ADD CONSTRAINT "DischargeDelay_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsurerBillSend" ADD CONSTRAINT "InsurerBillSend_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsurerBillSend" ADD CONSTRAINT "InsurerBillSend_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DischargeAlert" ADD CONSTRAINT "DischargeAlert_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
ALTER TABLE "DischargeDelay" ADD CONSTRAINT discharge_delay_note_length CHECK ("note" IS NULL OR length("note") <= 300);
ALTER TABLE "DischargeDelay" ADD CONSTRAINT discharge_delay_other_needs_note CHECK ("reason" <> 'OTHER' OR ("note" IS NOT NULL AND length(btrim("note")) >= 3));
ALTER TABLE "DischargePlan" ADD CONSTRAINT discharge_plan_note_length CHECK ("note" IS NULL OR length("note") <= 300);
ALTER TABLE "DischargeAlert" ADD CONSTRAINT discharge_alert_recipients CHECK ("recipients" >= 0);
-- Reasons, the insurer's start time and the alert ledger are part of the record: never changed or removed.
CREATE TRIGGER discharge_delay_immutable BEFORE UPDATE OR DELETE ON "DischargeDelay" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER insurer_bill_send_immutable BEFORE UPDATE OR DELETE ON "InsurerBillSend" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER discharge_alert_immutable BEFORE UPDATE OR DELETE ON "DischargeAlert" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"DischargePlan"');
SELECT medos_enable_tenant_rls('"DischargeDelay"');
SELECT medos_enable_tenant_rls('"InsurerBillSend"');
SELECT medos_enable_tenant_rls('"DischargeAlert"');

-- The background job asks which hospitals have patients waiting to go home (ids only; it then works under each hospital's own scope).
CREATE OR REPLACE FUNCTION medos_tenants_with_discharge_wait(p_now timestamptz) RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT c."tenantId" FROM "DischargeClearance" c
   WHERE c.step = 'MEDICALLY_FIT' AND c."at" > p_now - interval '7 days'
     AND NOT EXISTS (SELECT 1 FROM "AdmissionDeparture" d WHERE d."admissionId" = c."admissionId")
  UNION
  SELECT DISTINCT s."tenantId" FROM "InsurerBillSend" s WHERE s."sentAt" > p_now - interval '14 days';
$$;
REVOKE ALL ON FUNCTION medos_tenants_with_discharge_wait(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_tenants_with_discharge_wait(timestamptz) TO medos_app;

-- ===== who may do what: department heads (the manager) and the administrator receive escalations =====
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('MANAGER', 'DISCHARGE_ESCALATE_DEPT'), ('ADMINISTRATOR', 'DISCHARGE_ESCALATE_ADMIN')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration discharge_flow', 'added', jsonb_build_object(
  'MANAGER', jsonb_build_array('DISCHARGE_ESCALATE_DEPT'), 'ADMINISTRATOR', jsonb_build_array('DISCHARGE_ESCALATE_ADMIN')))
FROM "Tenant" t;
