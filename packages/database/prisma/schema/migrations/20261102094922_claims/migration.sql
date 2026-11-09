-- CreateEnum
CREATE TYPE "PayerKind" AS ENUM ('INSURER', 'TPA', 'GOVERNMENT', 'CORPORATE');

-- CreateEnum
CREATE TYPE "PayerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('CASHLESS', 'REIMBURSEMENT');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('DRAFT', 'PREAUTH_PENDING', 'PREAUTH_APPROVED', 'SUBMITTED', 'QUERY', 'APPROVED', 'REJECTED', 'SETTLED', 'CLOSED');

-- CreateTable
CREATE TABLE "Insurer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PayerKind" NOT NULL DEFAULT 'INSURER',
    "contact" TEXT,
    "status" "PayerStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Insurer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientPolicy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "insurerId" UUID NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "memberId" TEXT,
    "holderName" TEXT,
    "validFrom" DATE NOT NULL,
    "validTo" DATE NOT NULL,
    "sumInsured" DECIMAL(14,2),
    "status" "PayerStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PatientPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "encounterId" UUID,
    "invoiceId" UUID,
    "claimNumber" TEXT NOT NULL,
    "type" "ClaimType" NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "diagnosis" TEXT,
    "preauthRequested" DECIMAL(14,2),
    "preauthApproved" DECIMAL(14,2),
    "claimedAmount" DECIMAL(14,2),
    "approvedAmount" DECIMAL(14,2),
    "settledAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "closeReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "fromStatus" "ClaimStatus",
    "toStatus" "ClaimStatus" NOT NULL,
    "amount" DECIMAL(14,2),
    "note" TEXT,
    "actorId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimSettlement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "receiptId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Insurer_tenantId_id_key" ON "Insurer"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Insurer_tenantId_name_key" ON "Insurer"("tenantId", "name");

-- CreateIndex
CREATE INDEX "PatientPolicy_tenantId_patientId_idx" ON "PatientPolicy"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientPolicy_tenantId_id_key" ON "PatientPolicy"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PatientPolicy_tenantId_patientId_insurerId_policyNumber_key" ON "PatientPolicy"("tenantId", "patientId", "insurerId", "policyNumber");

-- CreateIndex
CREATE INDEX "Claim_tenantId_facilityId_status_updatedAt_idx" ON "Claim"("tenantId", "facilityId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Claim_tenantId_patientId_idx" ON "Claim"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_tenantId_id_key" ON "Claim"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_tenantId_facilityId_claimNumber_key" ON "Claim"("tenantId", "facilityId", "claimNumber");

-- CreateIndex
CREATE INDEX "ClaimEvent_tenantId_claimId_at_idx" ON "ClaimEvent"("tenantId", "claimId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimEvent_tenantId_id_key" ON "ClaimEvent"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ClaimSettlement_tenantId_claimId_idx" ON "ClaimSettlement"("tenantId", "claimId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimSettlement_tenantId_id_key" ON "ClaimSettlement"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "PatientPolicy" ADD CONSTRAINT "PatientPolicy_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientPolicy" ADD CONSTRAINT "PatientPolicy_tenantId_insurerId_fkey" FOREIGN KEY ("tenantId", "insurerId") REFERENCES "Insurer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_tenantId_policyId_fkey" FOREIGN KEY ("tenantId", "policyId") REFERENCES "PatientPolicy"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimEvent" ADD CONSTRAINT "ClaimEvent_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimSettlement" ADD CONSTRAINT "ClaimSettlement_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Insurance claims: docs/claims.md. A claim follows one issued invoice; the amounts only ever move in the allowed order; settlements and the timeline are append-only.

ALTER TABLE "Insurer" ADD CONSTRAINT insurer_values CHECK (length(btrim(name)) BETWEEN 2 AND 120);
ALTER TABLE "PatientPolicy" ADD CONSTRAINT policy_values CHECK (length(btrim("policyNumber")) BETWEEN 3 AND 60 AND "validFrom" <= "validTo" AND ("sumInsured" IS NULL OR "sumInsured" >= 0));
CREATE TRIGGER insurer_no_delete BEFORE DELETE ON "Insurer" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER policy_no_delete BEFORE DELETE ON "PatientPolicy" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "Claim" ADD CONSTRAINT claim_amounts CHECK (
  ("preauthRequested" IS NULL OR "preauthRequested" > 0) AND ("preauthApproved" IS NULL OR "preauthApproved" > 0)
  AND ("claimedAmount" IS NULL OR "claimedAmount" > 0) AND ("approvedAmount" IS NULL OR ("approvedAmount" > 0 AND "claimedAmount" IS NOT NULL AND "approvedAmount" <= "claimedAmount"))
  AND "settledAmount" >= 0 AND ("settledAmount" = 0 OR ("approvedAmount" IS NOT NULL AND "settledAmount" <= "approvedAmount")));
ALTER TABLE "Claim" ADD CONSTRAINT claim_state CHECK (
  (status NOT IN ('SUBMITTED', 'QUERY', 'APPROVED', 'SETTLED') OR ("invoiceId" IS NOT NULL AND "claimedAmount" IS NOT NULL))
  AND (status NOT IN ('APPROVED', 'SETTLED') OR "approvedAmount" IS NOT NULL)
  AND (status <> 'SETTLED' OR "settledAmount" = "approvedAmount")
  AND (status NOT IN ('REJECTED', 'CLOSED') OR ("closeReason" IS NOT NULL AND length(btrim("closeReason")) >= 5))
  AND (status NOT IN ('PREAUTH_PENDING', 'PREAUTH_APPROVED') OR type = 'CASHLESS')
  AND (status <> 'PREAUTH_APPROVED' OR "preauthApproved" IS NOT NULL));
-- A live claim holds its invoice: the same invoice cannot be claimed twice, until the first claim is rejected or closed.
CREATE UNIQUE INDEX claim_one_per_invoice ON "Claim" ("tenantId", "invoiceId") WHERE "invoiceId" IS NOT NULL AND status NOT IN ('REJECTED', 'CLOSED');

CREATE OR REPLACE FUNCTION medos_claim_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "PatientPolicy" p WHERE p.id = NEW."policyId" AND p."tenantId" = NEW."tenantId" AND p."patientId" = NEW."patientId") THEN
    RAISE EXCEPTION 'A claim must use a policy of the same patient' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."invoiceId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Invoice" i WHERE i.id = NEW."invoiceId" AND i."tenantId" = NEW."tenantId" AND i."facilityId" = NEW."facilityId" AND i."patientId" = NEW."patientId") THEN
    RAISE EXCEPTION 'A claim must be for an invoice of the same patient and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER claim_scope BEFORE INSERT OR UPDATE OF "invoiceId", "policyId" ON "Claim" FOR EACH ROW EXECUTE FUNCTION medos_claim_scope();

CREATE OR REPLACE FUNCTION medos_claim_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A claim cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."claimNumber" <> OLD."claimNumber" OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'A claim cannot be moved to another patient, facility or kind' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('SETTLED', 'CLOSED', 'REJECTED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'A finished claim cannot change its status' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."settledAmount" < OLD."settledAmount" THEN
    RAISE EXCEPTION 'Money received on a claim cannot be taken back' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."invoiceId" IS NOT NULL AND NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" AND OLD.status NOT IN ('QUERY') THEN
    RAISE EXCEPTION 'The invoice of a submitted claim cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER claim_guard BEFORE UPDATE OR DELETE ON "Claim" FOR EACH ROW EXECUTE FUNCTION medos_claim_guard();

CREATE TRIGGER claim_event_immutable BEFORE UPDATE OR DELETE ON "ClaimEvent" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
ALTER TABLE "ClaimSettlement" ADD CONSTRAINT claim_settlement_values CHECK (amount > 0 AND length(btrim(reference)) >= 4);
CREATE TRIGGER claim_settlement_immutable BEFORE UPDATE OR DELETE ON "ClaimSettlement" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
-- Settlements add up to no more than the approved amount, and only for an approved claim.
CREATE OR REPLACE FUNCTION medos_claim_settlement_total() RETURNS trigger AS $$
DECLARE c RECORD; total numeric;
BEGIN
  SELECT status, "approvedAmount" INTO c FROM "Claim" WHERE id = NEW."claimId" AND "tenantId" = NEW."tenantId" FOR SHARE;
  IF c.status IS DISTINCT FROM 'APPROVED' THEN RAISE EXCEPTION 'Money can only be received on an approved claim' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO total FROM "ClaimSettlement" WHERE "claimId" = NEW."claimId";
  IF total + NEW.amount > c."approvedAmount" THEN RAISE EXCEPTION 'Settlements cannot add up to more than the approved amount' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER claim_settlement_total BEFORE INSERT ON "ClaimSettlement" FOR EACH ROW EXECUTE FUNCTION medos_claim_settlement_total();

SELECT medos_enable_tenant_rls('"Insurer"');
SELECT medos_enable_tenant_rls('"PatientPolicy"');
SELECT medos_enable_tenant_rls('"Claim"');
SELECT medos_enable_tenant_rls('"ClaimEvent"');
SELECT medos_enable_tenant_rls('"ClaimSettlement"');

INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, 'CLAIMS_OFFICER', true FROM "Tenant" t ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('CLAIMS_OFFICER', 'CLAIM_READ'), ('CLAIMS_OFFICER', 'CLAIM_MANAGE'), ('CLAIMS_OFFICER', 'CLAIM_SETTLE'), ('CLAIMS_OFFICER', 'CLAIM_MASTERS'), ('CLAIMS_OFFICER', 'PATIENT_READ'), ('CLAIMS_OFFICER', 'INVOICE_READ'),
  ('ADMINISTRATOR', 'CLAIM_READ'), ('ADMINISTRATOR', 'CLAIM_MASTERS'), ('MANAGER', 'CLAIM_READ'), ('CASHIER', 'CLAIM_READ'), ('RECEPTIONIST', 'CLAIM_READ')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration claims', 'added', jsonb_build_object(
  'CLAIMS_OFFICER', jsonb_build_array('CLAIM_READ', 'CLAIM_MANAGE', 'CLAIM_SETTLE', 'CLAIM_MASTERS', 'PATIENT_READ', 'INVOICE_READ'),
  'ADMINISTRATOR', jsonb_build_array('CLAIM_READ', 'CLAIM_MASTERS'), 'MANAGER', jsonb_build_array('CLAIM_READ'), 'CASHIER', jsonb_build_array('CLAIM_READ'), 'RECEPTIONIST', jsonb_build_array('CLAIM_READ')))
FROM "Tenant" t;

