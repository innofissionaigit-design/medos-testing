-- Claims (docs/claims.md): non-payable items (charges the insurer will not pay, left to the patient) and appeals against a rejected claim.

CREATE TYPE "AppealStatus" AS ENUM ('PENDING', 'OVERTURNED', 'UPHELD');

CREATE TABLE "ClaimNonPayable" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "PatientFileStatus" NOT NULL DEFAULT 'ACTIVE',
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedById" UUID,
    "removedAt" TIMESTAMPTZ(3),
    "removeReason" TEXT,

    CONSTRAINT "ClaimNonPayable_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClaimNonPayable_tenantId_id_key" ON "ClaimNonPayable"("tenantId", "id");
CREATE INDEX "ClaimNonPayable_tenantId_claimId_status_idx" ON "ClaimNonPayable"("tenantId", "claimId", "status");
ALTER TABLE "ClaimNonPayable" ADD CONSTRAINT "ClaimNonPayable_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ClaimAppeal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAmount" DECIMAL(14,2),
    "decisionNote" TEXT,
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ClaimAppeal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClaimAppeal_tenantId_id_key" ON "ClaimAppeal"("tenantId", "id");
CREATE INDEX "ClaimAppeal_tenantId_claimId_requestedAt_idx" ON "ClaimAppeal"("tenantId", "claimId", "requestedAt");
ALTER TABLE "ClaimAppeal" ADD CONSTRAINT "ClaimAppeal_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
ALTER TABLE "ClaimNonPayable" ADD CONSTRAINT claim_non_payable_values CHECK (
  amount > 0 AND length(btrim(description)) BETWEEN 3 AND 120 AND length(btrim(reason)) >= 5
  AND (status = 'ACTIVE' OR ("removedById" IS NOT NULL AND "removedAt" IS NOT NULL AND "removeReason" IS NOT NULL AND length(btrim("removeReason")) >= 5)));

-- Non-payable items change what the claim asks for, so they are added and removed only before the claim goes to the insurer (or while it is back with the desk on a query).
CREATE OR REPLACE FUNCTION medos_claim_non_payable_guard() RETURNS trigger AS $$
DECLARE c_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A non-payable item cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT status::text INTO c_status FROM "Claim" WHERE id = NEW."claimId" AND "tenantId" = NEW."tenantId";
  IF c_status IS NULL OR c_status NOT IN ('DRAFT', 'PREAUTH_PENDING', 'PREAUTH_APPROVED', 'QUERY') THEN
    RAISE EXCEPTION 'Non-payable items can only be changed before the claim is submitted, or while it is under query' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['status', 'removedById', 'removedAt', 'removeReason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'removedById', 'removedAt', 'removeReason']) THEN
      RAISE EXCEPTION 'A non-payable item cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'REMOVED' THEN RAISE EXCEPTION 'A removed non-payable item cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER claim_non_payable_guard BEFORE INSERT OR UPDATE OR DELETE ON "ClaimNonPayable" FOR EACH ROW EXECUTE FUNCTION medos_claim_non_payable_guard();

ALTER TABLE "ClaimAppeal" ADD CONSTRAINT claim_appeal_values CHECK (
  length(btrim(reason)) >= 10
  AND ((status = 'PENDING' AND "approvedAmount" IS NULL AND "decidedById" IS NULL AND "decidedAt" IS NULL)
    OR (status = 'OVERTURNED' AND "approvedAmount" > 0 AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
    OR (status = 'UPHELD' AND "approvedAmount" IS NULL AND "decisionNote" IS NOT NULL AND length(btrim("decisionNote")) >= 5 AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)));
CREATE UNIQUE INDEX claim_appeal_one_pending ON "ClaimAppeal" ("tenantId", "claimId") WHERE status = 'PENDING';

-- An appeal is made against a rejected claim that had been submitted (it has its invoice and claimed amount), and decided once.
CREATE OR REPLACE FUNCTION medos_claim_appeal_guard() RETURNS trigger AS $$
DECLARE c_status text; c_invoice uuid; c_claimed numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An appeal cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status::text, "invoiceId", "claimedAmount" INTO c_status, c_invoice, c_claimed FROM "Claim" WHERE id = NEW."claimId" AND "tenantId" = NEW."tenantId";
    IF c_status IS DISTINCT FROM 'REJECTED' OR c_invoice IS NULL OR c_claimed IS NULL THEN
      RAISE EXCEPTION 'An appeal can only be made against a claim the insurer rejected after it was submitted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING' THEN RAISE EXCEPTION 'A decided appeal cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'approvedAmount', 'decisionNote', 'decidedById', 'decidedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approvedAmount', 'decisionNote', 'decidedById', 'decidedAt']) THEN
    RAISE EXCEPTION 'An appeal cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER claim_appeal_guard BEFORE INSERT OR UPDATE OR DELETE ON "ClaimAppeal" FOR EACH ROW EXECUTE FUNCTION medos_claim_appeal_guard();

-- A rejected claim stays rejected, except when an appeal against it was overturned: then it becomes approved again (never any other change of a finished claim).
CREATE OR REPLACE FUNCTION medos_claim_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A claim cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."claimNumber" <> OLD."claimNumber" OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'A claim cannot be moved to another patient, facility or kind' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('SETTLED', 'CLOSED', 'REJECTED') AND NEW.status <> OLD.status
     AND NOT (OLD.status = 'REJECTED' AND NEW.status = 'APPROVED' AND EXISTS (SELECT 1 FROM "ClaimAppeal" a WHERE a."claimId" = OLD.id AND a."tenantId" = OLD."tenantId" AND a.status = 'OVERTURNED')) THEN
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

SELECT medos_enable_tenant_rls('"ClaimNonPayable"');
SELECT medos_enable_tenant_rls('"ClaimAppeal"');
