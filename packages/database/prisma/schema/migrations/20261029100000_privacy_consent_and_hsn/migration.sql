-- Privacy records (consent, data requests) and HSN/SAC codes on invoice lines.
-- Records facts only; which consents are required, the notice wording, retention and the GST rules are pending reviewer decisions
-- (docs/reviews/pending-decisions.md).

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('PRIVACY_NOTICE_ACKNOWLEDGED', 'APPOINTMENT_REMINDERS');
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'WITHDRAWN');
CREATE TYPE "ConsentMethod" AS ENUM ('VERBAL', 'WRITTEN', 'DIGITAL');
CREATE TYPE "DataRequestType" AS ENUM ('ACCESS', 'CORRECTION', 'ERASURE', 'GRIEVANCE');
CREATE TYPE "DataRequestStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'REJECTED');

-- CreateTable
CREATE TABLE "PatientConsent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "method" "ConsentMethod" NOT NULL,
    "noticeVersion" TEXT,
    "note" TEXT,
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientConsent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PatientDataRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "type" "DataRequestType" NOT NULL,
    "status" "DataRequestStatus" NOT NULL DEFAULT 'OPEN',
    "details" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "dueOn" DATE,
    "resolution" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PatientDataRequest_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Service" ADD COLUMN "sacCode" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "hsnSac" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PatientConsent_tenantId_id_key" ON "PatientConsent"("tenantId", "id");
CREATE INDEX "PatientConsent_tenantId_patientId_purpose_recordedAt_idx" ON "PatientConsent"("tenantId", "patientId", "purpose", "recordedAt");
CREATE UNIQUE INDEX "PatientDataRequest_tenantId_id_key" ON "PatientDataRequest"("tenantId", "id");
CREATE INDEX "PatientDataRequest_tenantId_status_receivedOn_idx" ON "PatientDataRequest"("tenantId", "status", "receivedOn");
CREATE INDEX "PatientDataRequest_tenantId_patientId_idx" ON "PatientDataRequest"("tenantId", "patientId");

-- AddForeignKey
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PatientDataRequest" ADD CONSTRAINT "PatientDataRequest_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== hand-written rules =====
ALTER TABLE "Service" ADD CONSTRAINT service_sac_format CHECK ("sacCode" IS NULL OR "sacCode" ~ '^[0-9]{4,8}$');
ALTER TABLE "InvoiceLine" ADD CONSTRAINT invoice_line_hsn_format CHECK ("hsnSac" IS NULL OR "hsnSac" ~ '^[0-9]{4,8}$');

-- Consent history is append-only: a change of mind is a new row, never an edit.
CREATE OR REPLACE FUNCTION medos_consent_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Consent records cannot be changed or removed; record a new entry instead' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER patient_consent_append_only BEFORE UPDATE OR DELETE ON "PatientConsent" FOR EACH ROW EXECUTE FUNCTION medos_consent_append_only();

-- A data request is never deleted, and a closed one carries its outcome.
CREATE OR REPLACE FUNCTION medos_data_request_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Data requests cannot be removed' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER patient_data_request_no_delete BEFORE DELETE ON "PatientDataRequest" FOR EACH ROW EXECUTE FUNCTION medos_data_request_no_delete();
ALTER TABLE "PatientDataRequest" ADD CONSTRAINT data_request_closed_has_outcome CHECK (
  status NOT IN ('COMPLETED', 'REJECTED') OR (resolution IS NOT NULL AND length(btrim(resolution)) >= 5 AND "closedAt" IS NOT NULL AND "closedById" IS NOT NULL));
ALTER TABLE "PatientDataRequest" ADD CONSTRAINT data_request_open_has_no_outcome CHECK (
  status IN ('COMPLETED', 'REJECTED') OR "closedAt" IS NULL);

-- Hospital isolation (same as every other tenant table; see rls.md).
SELECT medos_enable_tenant_rls('"PatientConsent"');
SELECT medos_enable_tenant_rls('"PatientDataRequest"');

-- Existing hospitals: the system Administrator role gets the new permission (new hospitals get it from the role definition).
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT "tenantId", id, 'PRIVACY_MANAGE' FROM "Role" WHERE name = 'ADMINISTRATOR' AND "isSystem"
ON CONFLICT DO NOTHING;
