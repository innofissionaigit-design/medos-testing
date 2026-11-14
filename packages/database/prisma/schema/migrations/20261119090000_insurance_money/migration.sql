-- Insurance money (docs/insurance-money.md): top-up policies and claims, room entitlement, package inclusions, what the insurer cut and why, insurer payments matched to
-- claims, overpayments and refunds, write-offs approved by a manager, follow-up tasks, and the estimate for the family.

-- CreateEnum
CREATE TYPE "PolicyTier" AS ENUM ('PRIMARY', 'TOPUP');
CREATE TYPE "DeductionCategory" AS ENUM ('NOT_COVERED', 'ROOM_RENT_LIMIT', 'PATIENT_COPAY', 'OVER_RATE', 'DEDUCTIBLE', 'OTHER');
CREATE TYPE "WriteOffStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "FollowUpKind" AS ENUM ('SHORT_PAYMENT', 'OVERPAYMENT_REFUND');
CREATE TYPE "FollowUpStatus" AS ENUM ('OPEN', 'DONE');

-- Existing tables
ALTER TABLE "PatientPolicy" ADD COLUMN "tier" "PolicyTier" NOT NULL DEFAULT 'PRIMARY', ADD COLUMN "roomEntitlement" TEXT, ADD COLUMN "roomRentLimit" DECIMAL(12,2);
ALTER TABLE "PatientPolicy" ADD CONSTRAINT policy_room_rent_limit CHECK ("roomRentLimit" IS NULL OR "roomRentLimit" >= 0);
ALTER TABLE "InsurerPackage" ADD COLUMN "includesImplants" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "includesConsumables" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "inclusions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], ADD COLUMN "exclusions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], ADD COLUMN "exclusionNote" TEXT;
-- Implants and consumables are inside the price unless the package says otherwise, openly.
ALTER TABLE "InsurerPackage" ADD CONSTRAINT package_exclusion_is_open CHECK (("includesImplants" AND "includesConsumables") OR length(btrim(coalesce("exclusionNote", ''))) >= 10);
ALTER TABLE "Claim" ADD COLUMN "tier" "PolicyTier" NOT NULL DEFAULT 'PRIMARY', ADD COLUMN "primaryClaimId" UUID;
ALTER TABLE "Claim" ADD CONSTRAINT claim_tier_primary CHECK (("tier" = 'TOPUP' AND "primaryClaimId" IS NOT NULL) OR ("tier" = 'PRIMARY' AND "primaryClaimId" IS NULL));
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_tenantId_primaryClaimId_fkey" FOREIGN KEY ("tenantId", "primaryClaimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A live claim holds its invoice, once for the main insurer and once for a top-up that covers what the main insurer leaves.
DROP INDEX IF EXISTS claim_one_per_invoice;
CREATE UNIQUE INDEX claim_one_per_invoice ON "Claim" ("tenantId", "invoiceId", "tier") WHERE "invoiceId" IS NOT NULL AND status NOT IN ('REJECTED', 'CLOSED');
CREATE UNIQUE INDEX claim_one_live_topup ON "Claim" ("tenantId", "primaryClaimId") WHERE "tier" = 'TOPUP' AND status NOT IN ('REJECTED', 'CLOSED');
ALTER TABLE "ClaimSettlement" ADD COLUMN "paymentId" UUID;

-- CreateTable
CREATE TABLE "ClaimDeduction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "category" "DeductionCategory" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaimDeduction_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "InsurerPayment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "insurerId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InsurerPayment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "InsurerOverpayment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "insurerId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "claimId" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InsurerOverpayment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "InsurerRefund" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "overpaymentId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT NOT NULL,
    "refundedOn" DATE NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InsurerRefund_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ClaimWriteOff" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "WriteOffStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    CONSTRAINT "ClaimWriteOff_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ClaimFollowUp" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "kind" "FollowUpKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneById" UUID,
    "doneAt" TIMESTAMPTZ(3),
    "doneNote" TEXT,
    CONSTRAINT "ClaimFollowUp_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ClaimEstimate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "packageId" UUID,
    "days" INTEGER NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaimEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaimDeduction_tenantId_id_key" ON "ClaimDeduction"("tenantId", "id");
CREATE INDEX "ClaimDeduction_tenantId_claimId_idx" ON "ClaimDeduction"("tenantId", "claimId");
CREATE UNIQUE INDEX "InsurerPayment_tenantId_id_key" ON "InsurerPayment"("tenantId", "id");
CREATE UNIQUE INDEX "InsurerPayment_tenantId_insurerId_reference_key" ON "InsurerPayment"("tenantId", "insurerId", "reference");
CREATE INDEX "InsurerPayment_tenantId_facilityId_receivedOn_idx" ON "InsurerPayment"("tenantId", "facilityId", "receivedOn");
CREATE UNIQUE INDEX "InsurerOverpayment_tenantId_id_key" ON "InsurerOverpayment"("tenantId", "id");
CREATE INDEX "InsurerOverpayment_tenantId_insurerId_idx" ON "InsurerOverpayment"("tenantId", "insurerId");
CREATE UNIQUE INDEX "InsurerRefund_tenantId_id_key" ON "InsurerRefund"("tenantId", "id");
CREATE INDEX "InsurerRefund_tenantId_overpaymentId_idx" ON "InsurerRefund"("tenantId", "overpaymentId");
CREATE UNIQUE INDEX "ClaimWriteOff_tenantId_id_key" ON "ClaimWriteOff"("tenantId", "id");
CREATE INDEX "ClaimWriteOff_tenantId_claimId_status_idx" ON "ClaimWriteOff"("tenantId", "claimId", "status");
CREATE UNIQUE INDEX "ClaimFollowUp_tenantId_id_key" ON "ClaimFollowUp"("tenantId", "id");
CREATE INDEX "ClaimFollowUp_tenantId_facilityId_status_createdAt_idx" ON "ClaimFollowUp"("tenantId", "facilityId", "status", "createdAt");
CREATE UNIQUE INDEX "ClaimEstimate_tenantId_id_key" ON "ClaimEstimate"("tenantId", "id");
CREATE INDEX "ClaimEstimate_tenantId_patientId_idx" ON "ClaimEstimate"("tenantId", "patientId");

-- AddForeignKey
ALTER TABLE "ClaimDeduction" ADD CONSTRAINT "ClaimDeduction_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsurerPayment" ADD CONSTRAINT "InsurerPayment_tenantId_insurerId_fkey" FOREIGN KEY ("tenantId", "insurerId") REFERENCES "Insurer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimSettlement" ADD CONSTRAINT "ClaimSettlement_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "InsurerPayment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsurerOverpayment" ADD CONSTRAINT "InsurerOverpayment_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "InsurerPayment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsurerRefund" ADD CONSTRAINT "InsurerRefund_tenantId_overpaymentId_fkey" FOREIGN KEY ("tenantId", "overpaymentId") REFERENCES "InsurerOverpayment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimWriteOff" ADD CONSTRAINT "ClaimWriteOff_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimFollowUp" ADD CONSTRAINT "ClaimFollowUp_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimEstimate" ADD CONSTRAINT "ClaimEstimate_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
ALTER TABLE "ClaimDeduction" ADD CONSTRAINT deduction_positive CHECK ("amount" > 0), ADD CONSTRAINT deduction_note_length CHECK ("note" IS NULL OR length("note") <= 300),
  ADD CONSTRAINT deduction_other_needs_note CHECK ("category" <> 'OTHER' OR length(btrim(coalesce("note", ''))) >= 3);
ALTER TABLE "InsurerPayment" ADD CONSTRAINT insurer_payment_positive CHECK ("amount" > 0);
ALTER TABLE "InsurerOverpayment" ADD CONSTRAINT insurer_overpayment_positive CHECK ("amount" > 0);
ALTER TABLE "InsurerRefund" ADD CONSTRAINT insurer_refund_positive CHECK ("amount" > 0);
ALTER TABLE "ClaimWriteOff" ADD CONSTRAINT write_off_positive CHECK ("amount" > 0), ADD CONSTRAINT write_off_reason CHECK (length(btrim("reason")) >= 10),
  ADD CONSTRAINT write_off_decided CHECK (("status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL) OR ("status" <> 'PENDING' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL));
-- Only one write-off waits at a time for a claim.
CREATE UNIQUE INDEX claim_write_off_one_pending ON "ClaimWriteOff" ("tenantId", "claimId") WHERE "status" = 'PENDING';
ALTER TABLE "ClaimFollowUp" ADD CONSTRAINT follow_up_positive CHECK ("amount" > 0),
  ADD CONSTRAINT follow_up_done CHECK (("status" = 'OPEN' AND "doneById" IS NULL AND "doneAt" IS NULL) OR ("status" = 'DONE' AND "doneById" IS NOT NULL AND "doneAt" IS NOT NULL));
ALTER TABLE "ClaimEstimate" ADD CONSTRAINT estimate_total_not_negative CHECK ("total" >= 0 AND "days" >= 0);

-- Money received, cuts, refunds and estimates are part of the record: never changed or removed.
CREATE TRIGGER claim_deduction_immutable BEFORE UPDATE OR DELETE ON "ClaimDeduction" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER insurer_payment_immutable BEFORE UPDATE OR DELETE ON "InsurerPayment" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER insurer_overpayment_immutable BEFORE UPDATE OR DELETE ON "InsurerOverpayment" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER insurer_refund_immutable BEFORE UPDATE OR DELETE ON "InsurerRefund" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER claim_estimate_immutable BEFORE UPDATE OR DELETE ON "ClaimEstimate" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- A write-off is decided once, by someone other than the person who asked; nothing else about it changes.
CREATE OR REPLACE FUNCTION medos_write_off_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A write-off cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD."status" <> 'PENDING' THEN RAISE EXCEPTION 'A decided write-off cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."decidedById" = OLD."requestedById" THEN RAISE EXCEPTION 'A write-off must be decided by someone other than the person who asked for it' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."amount" <> OLD."amount" OR NEW."reason" <> OLD."reason" OR NEW."claimId" <> OLD."claimId" OR NEW."requestedById" <> OLD."requestedById" OR NEW."requestedAt" <> OLD."requestedAt" THEN
    RAISE EXCEPTION 'Only the decision of a write-off can be recorded' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER claim_write_off_guard BEFORE UPDATE OR DELETE ON "ClaimWriteOff" FOR EACH ROW EXECUTE FUNCTION medos_write_off_guard();

-- A follow-up is marked done once; nothing else about it changes.
CREATE OR REPLACE FUNCTION medos_follow_up_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A follow-up cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD."status" <> 'OPEN' THEN RAISE EXCEPTION 'A finished follow-up cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."amount" <> OLD."amount" OR NEW."note" <> OLD."note" OR NEW."claimId" <> OLD."claimId" OR NEW."kind" <> OLD."kind" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Only completing a follow-up can be recorded' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER claim_follow_up_guard BEFORE UPDATE OR DELETE ON "ClaimFollowUp" FOR EACH ROW EXECUTE FUNCTION medos_follow_up_guard();

SELECT medos_enable_tenant_rls('"ClaimDeduction"');
SELECT medos_enable_tenant_rls('"InsurerPayment"');
SELECT medos_enable_tenant_rls('"InsurerOverpayment"');
SELECT medos_enable_tenant_rls('"InsurerRefund"');
SELECT medos_enable_tenant_rls('"ClaimWriteOff"');
SELECT medos_enable_tenant_rls('"ClaimFollowUp"');
SELECT medos_enable_tenant_rls('"ClaimEstimate"');

-- ===== who may do what: a manager (or the administrator) approves a write-off =====
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'CLAIM_WRITEOFF_APPROVE' FROM "Role" r WHERE r.name IN ('MANAGER', 'ADMINISTRATOR') AND r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration insurance_money', 'added', jsonb_build_object(
  'MANAGER', jsonb_build_array('CLAIM_WRITEOFF_APPROVE'), 'ADMINISTRATOR', jsonb_build_array('CLAIM_WRITEOFF_APPROVE')))
FROM "Tenant" t;
