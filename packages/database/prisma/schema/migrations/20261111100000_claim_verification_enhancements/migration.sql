-- Claims (docs/claims.md): payer verification recorded on the claim, and enhancement requests (more authorisation asked from the insurer while the patient is admitted).

CREATE TYPE "ClaimVerification" AS ENUM ('VERIFIED', 'NOT_ELIGIBLE');
CREATE TYPE "EnhancementStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "Claim" ADD COLUMN "verification" "ClaimVerification", ADD COLUMN "verifiedAt" TIMESTAMPTZ(3), ADD COLUMN "verifiedById" UUID, ADD COLUMN "verificationRef" TEXT, ADD COLUMN "verificationNote" TEXT;

CREATE TABLE "ClaimEnhancement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "requestedAmount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "EnhancementStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAmount" DECIMAL(14,2),
    "decisionNote" TEXT,
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ClaimEnhancement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClaimEnhancement_tenantId_id_key" ON "ClaimEnhancement"("tenantId", "id");
CREATE INDEX "ClaimEnhancement_tenantId_claimId_requestedAt_idx" ON "ClaimEnhancement"("tenantId", "claimId", "requestedAt");
ALTER TABLE "ClaimEnhancement" ADD CONSTRAINT "ClaimEnhancement_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
ALTER TABLE "Claim" ADD CONSTRAINT claim_verification_values CHECK (
  (verification IS NULL AND "verifiedAt" IS NULL AND "verifiedById" IS NULL AND "verificationRef" IS NULL)
  OR (verification IS NOT NULL AND "verifiedAt" IS NOT NULL AND "verifiedById" IS NOT NULL AND "verificationRef" IS NOT NULL AND length(btrim("verificationRef")) >= 3));

ALTER TABLE "ClaimEnhancement" ADD CONSTRAINT claim_enhancement_values CHECK (
  "requestedAmount" > 0 AND length(btrim(reason)) >= 10
  AND ((status = 'PENDING' AND "approvedAmount" IS NULL AND "decidedById" IS NULL AND "decidedAt" IS NULL)
    OR (status = 'APPROVED' AND "approvedAmount" > 0 AND "approvedAmount" <= "requestedAmount" AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
    OR (status = 'REJECTED' AND "approvedAmount" IS NULL AND "decisionNote" IS NOT NULL AND length(btrim("decisionNote")) >= 5 AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)));
-- One request waits for the insurer at a time.
CREATE UNIQUE INDEX claim_enhancement_one_pending ON "ClaimEnhancement" ("tenantId", "claimId") WHERE status = 'PENDING';

-- A request is asked once and decided once: only PENDING -> APPROVED/REJECTED (with who, when) is allowed; a decided request is never changed or removed.
CREATE OR REPLACE FUNCTION medos_claim_enhancement_guard() RETURNS trigger AS $$
DECLARE c_status text; c_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An enhancement request cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status::text, type::text INTO c_status, c_type FROM "Claim" WHERE id = NEW."claimId" AND "tenantId" = NEW."tenantId";
    IF c_status IS DISTINCT FROM 'PREAUTH_APPROVED' OR c_type <> 'CASHLESS' THEN
      RAISE EXCEPTION 'More authorisation can only be asked for on a cashless claim whose pre-authorisation is approved' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'A decided enhancement request cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'approvedAmount', 'decisionNote', 'decidedById', 'decidedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approvedAmount', 'decisionNote', 'decidedById', 'decidedAt']) THEN
    RAISE EXCEPTION 'An enhancement request cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER claim_enhancement_guard BEFORE INSERT OR UPDATE OR DELETE ON "ClaimEnhancement" FOR EACH ROW EXECUTE FUNCTION medos_claim_enhancement_guard();

SELECT medos_enable_tenant_rls('"ClaimEnhancement"');
