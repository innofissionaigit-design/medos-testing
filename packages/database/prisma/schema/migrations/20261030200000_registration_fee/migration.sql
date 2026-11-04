-- CreateEnum
CREATE TYPE "RegistrationFeeStatus" AS ENUM ('PENDING', 'PAID', 'EXEMPTED');

-- AlterEnum
ALTER TYPE "InvoiceKind" ADD VALUE 'REGISTRATION';

-- CreateTable
CREATE TABLE "PatientRegistration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "status" "RegistrationFeeStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(14,2) NOT NULL,
    "invoiceId" UUID,
    "exemptionReason" TEXT,
    "exemptedById" UUID,
    "settledAt" TIMESTAMPTZ(3),
    "settledById" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PatientRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatientRegistration_invoiceId_key" ON "PatientRegistration"("invoiceId");

-- CreateIndex
CREATE INDEX "PatientRegistration_tenantId_facilityId_createdAt_idx" ON "PatientRegistration"("tenantId", "facilityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PatientRegistration_tenantId_facilityId_status_idx" ON "PatientRegistration"("tenantId", "facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PatientRegistration_tenantId_patientId_key" ON "PatientRegistration"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientRegistration_tenantId_id_key" ON "PatientRegistration"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "PatientRegistration" ADD CONSTRAINT "PatientRegistration_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientRegistration" ADD CONSTRAINT "PatientRegistration_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientRegistration" ADD CONSTRAINT "PatientRegistration_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== rules =====
-- A registration fee row is PENDING (collect or exempt it), PAID (with the bill that holds the receipt) or EXEMPTED (with who and why). Settled rows are final.
ALTER TABLE "PatientRegistration" ADD CONSTRAINT patient_registration_amount CHECK (amount > 0);
ALTER TABLE "PatientRegistration" ADD CONSTRAINT patient_registration_state CHECK (
  (status = 'PENDING' AND "invoiceId" IS NULL AND "exemptionReason" IS NULL AND "exemptedById" IS NULL AND "settledAt" IS NULL AND "settledById" IS NULL)
  OR (status = 'PAID' AND "invoiceId" IS NOT NULL AND "exemptionReason" IS NULL AND "exemptedById" IS NULL AND "settledAt" IS NOT NULL AND "settledById" IS NOT NULL)
  OR (status = 'EXEMPTED' AND "invoiceId" IS NULL AND length(btrim(coalesce("exemptionReason", ''))) >= 3 AND "exemptedById" IS NOT NULL AND "settledAt" IS NOT NULL AND "settledById" IS NOT NULL));

CREATE OR REPLACE FUNCTION medos_patient_registration_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW.amount <> OLD.amount OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'A registration fee record cannot be changed, only settled' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'PENDING' AND (NEW.status <> OLD.status OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" OR NEW."exemptionReason" IS DISTINCT FROM OLD."exemptionReason"
     OR NEW."exemptedById" IS DISTINCT FROM OLD."exemptedById" OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt" OR NEW."settledById" IS DISTINCT FROM OLD."settledById") THEN
    RAISE EXCEPTION 'A settled registration fee cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER patient_registration_guard BEFORE UPDATE ON "PatientRegistration" FOR EACH ROW EXECUTE FUNCTION medos_patient_registration_guard();
CREATE TRIGGER patient_registration_no_delete BEFORE DELETE ON "PatientRegistration" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- The bill of a paid registration must be that patient's registration bill, and the patient must belong to the same hospital.
CREATE OR REPLACE FUNCTION medos_patient_registration_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Patient" p WHERE p."tenantId" = NEW."tenantId" AND p.id = NEW."patientId") THEN
    RAISE EXCEPTION 'The registration must belong to a patient of the same hospital' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."invoiceId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Invoice" i WHERE i.id = NEW."invoiceId" AND i."tenantId" = NEW."tenantId" AND i."patientId" = NEW."patientId" AND i.kind = 'REGISTRATION') THEN
    RAISE EXCEPTION 'The bill of a registration fee must be that patient''s registration bill' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER patient_registration_scope BEFORE INSERT OR UPDATE OF "invoiceId" ON "PatientRegistration" FOR EACH ROW EXECUTE FUNCTION medos_patient_registration_scope();

SELECT medos_enable_tenant_rls('"PatientRegistration"');

-- Authorised fee exemptions: administrators, managers and the front desk (each exemption needs a listed reason and is audited and reported).
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'REGISTRATION_FEE_EXEMPT' FROM "Role" r WHERE r."isSystem" AND r.name IN ('ADMINISTRATOR', 'MANAGER', 'RECEPTIONIST')
ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261030200000_registration_fee', 'added', jsonb_build_object('ADMINISTRATOR', jsonb_build_array('REGISTRATION_FEE_EXEMPT'), 'MANAGER', jsonb_build_array('REGISTRATION_FEE_EXEMPT'), 'RECEPTIONIST', jsonb_build_array('REGISTRATION_FEE_EXEMPT')))
FROM "Tenant" t;