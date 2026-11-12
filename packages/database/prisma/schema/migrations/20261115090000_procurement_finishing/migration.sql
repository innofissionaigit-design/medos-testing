-- CreateEnum
CREATE TYPE "TransmissionKind" AS ENUM ('ELIGIBILITY', 'CLAIM');

-- CreateEnum
CREATE TYPE "TransmissionStatus" AS ENUM ('SENT', 'FAILED', 'NOT_SENT');

-- CreateEnum
CREATE TYPE "JournalAccount" AS ENUM ('INVENTORY', 'GST_INPUT', 'SUPPLIER_PAYABLE', 'CONSUMPTION_EXPENSE', 'PURCHASE_RETURNS', 'CASH', 'BANK');

-- AlterTable
ALTER TABLE "AftercareTask" ADD COLUMN     "claimedUntil" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "PurchaseIndent" ADD COLUMN     "approvalsRequired" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "estimatedValue" DECIMAL(14,2),
ADD COLUMN     "firstApprovedAt" TIMESTAMPTZ(3),
ADD COLUMN     "firstApprovedById" UUID;

-- AlterTable
ALTER TABLE "SupplierPayment" ADD COLUMN     "runId" UUID;

-- CreateTable
CREATE TABLE "ClaimTransmission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "kind" "TransmissionKind" NOT NULL,
    "status" "TransmissionStatus" NOT NULL,
    "channel" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "externalRef" TEXT,
    "detail" TEXT,
    "sentById" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimTransmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPaymentRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "paidOn" DATE NOT NULL,
    "paidById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPaymentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" UUID NOT NULL,
    "entryDate" DATE NOT NULL,
    "narration" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "account" "JournalAccount" NOT NULL,
    "costCentre" TEXT,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaimTransmission_tenantId_claimId_at_idx" ON "ClaimTransmission"("tenantId", "claimId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimTransmission_tenantId_id_key" ON "ClaimTransmission"("tenantId", "id");

-- CreateIndex
CREATE INDEX "SupplierPaymentRun_tenantId_supplierId_paidOn_idx" ON "SupplierPaymentRun"("tenantId", "supplierId", "paidOn" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPaymentRun_tenantId_id_key" ON "SupplierPaymentRun"("tenantId", "id");

-- CreateIndex
CREATE INDEX "JournalEntry_tenantId_facilityId_entryDate_idx" ON "JournalEntry"("tenantId", "facilityId", "entryDate" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_tenantId_id_key" ON "JournalEntry"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_tenantId_sourceKey_key" ON "JournalEntry"("tenantId", "sourceKey");

-- CreateIndex
CREATE INDEX "JournalLine_tenantId_entryId_idx" ON "JournalLine"("tenantId", "entryId");

-- CreateIndex
CREATE INDEX "JournalLine_tenantId_account_idx" ON "JournalLine"("tenantId", "account");

-- AddForeignKey
ALTER TABLE "ClaimTransmission" ADD CONSTRAINT "ClaimTransmission_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_tenantId_runId_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "SupplierPaymentRun"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentRun" ADD CONSTRAINT "SupplierPaymentRun_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentRun" ADD CONSTRAINT "SupplierPaymentRun_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_tenantId_entryId_fkey" FOREIGN KEY ("tenantId", "entryId") REFERENCES "JournalEntry"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== rules the database holds on its own =====

-- A second level of approval on indents: the requester asks, a first approver (not the requester) approves, and a different second approver decides.
ALTER TABLE "PurchaseIndent" ADD CONSTRAINT purchase_indent_two_approvals CHECK (
  "approvalsRequired" IN (1, 2)
  AND ("estimatedValue" IS NULL OR "estimatedValue" >= 0)
  AND (("firstApprovedById" IS NULL) = ("firstApprovedAt" IS NULL))
  AND ("firstApprovedById" IS NULL OR "firstApprovedById" <> "requestedById")
  AND ("firstApprovedById" IS NULL OR "decidedById" IS NULL OR "decidedById" <> "firstApprovedById")
  AND (status NOT IN ('APPROVED', 'ORDERED') OR "approvalsRequired" = 1 OR "firstApprovedById" IS NOT NULL));
CREATE OR REPLACE FUNCTION medos_purchase_indent_two_approvals() RETURNS trigger AS $$
BEGIN
  IF OLD."firstApprovedById" IS NOT NULL AND (NEW."firstApprovedById" IS DISTINCT FROM OLD."firstApprovedById" OR NEW."firstApprovedAt" IS DISTINCT FROM OLD."firstApprovedAt") THEN
    RAISE EXCEPTION 'The first approval of an indent cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."approvalsRequired" <> OLD."approvalsRequired" AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'The approvals an indent needs are fixed when it is submitted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."firstApprovedById" IS NULL AND NEW."firstApprovedById" IS NOT NULL AND OLD.status <> 'SUBMITTED' THEN
    RAISE EXCEPTION 'Only a submitted indent can be given a first approval' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_indent_two_approvals BEFORE UPDATE ON "PurchaseIndent" FOR EACH ROW EXECUTE FUNCTION medos_purchase_indent_two_approvals();

-- A statement payment: the payments it was split into add up to exactly its total, and each is for this supplier's own invoice. Never edited or deleted.
ALTER TABLE "SupplierPaymentRun" ADD CONSTRAINT supplier_payment_run_values CHECK (total > 0 AND (reference IS NULL OR length(reference) <= 100));
CREATE TRIGGER supplier_payment_run_immutable BEFORE UPDATE OR DELETE ON "SupplierPaymentRun" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE OR REPLACE FUNCTION medos_supplier_payment_run_check() RETURNS trigger AS $$
DECLARE r record; paid numeric;
BEGIN
  IF NEW."runId" IS NULL THEN RETURN NULL; END IF;
  SELECT total, "supplierId" INTO r FROM "SupplierPaymentRun" WHERE id = NEW."runId" AND "tenantId" = NEW."tenantId";
  SELECT COALESCE(SUM(amount), 0) INTO paid FROM "SupplierPayment" WHERE "runId" = NEW."runId" AND "tenantId" = NEW."tenantId";
  IF paid <> r.total THEN RAISE EXCEPTION 'The payments of a supplier statement payment must add up to its total' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "Purchase" p WHERE p.id = NEW."purchaseId" AND p."tenantId" = NEW."tenantId" AND p."supplierId" = r."supplierId") THEN
    RAISE EXCEPTION 'A statement payment can only pay the supplier''s own invoices' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER supplier_payment_run_check AFTER INSERT ON "SupplierPayment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_supplier_payment_run_check();

-- The cost ledger: an entry has at least two lines, each line is a debit or a credit of a positive amount, and what an entry debits equals what it credits. Never edited or deleted.
ALTER TABLE "JournalLine" ADD CONSTRAINT journal_line_values CHECK (debit >= 0 AND credit >= 0 AND (debit > 0) <> (credit > 0));
ALTER TABLE "JournalEntry" ADD CONSTRAINT journal_entry_values CHECK (length(btrim(narration)) >= 3 AND length(narration) <= 300);
CREATE TRIGGER journal_entry_immutable BEFORE UPDATE OR DELETE ON "JournalEntry" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON "JournalLine" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE OR REPLACE FUNCTION medos_journal_balanced() RETURNS trigger AS $$
DECLARE d numeric; c numeric; n int;
BEGIN
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*) INTO d, c, n FROM "JournalLine" WHERE "entryId" = NEW."entryId" AND "tenantId" = NEW."tenantId";
  IF d <> c OR n < 2 THEN RAISE EXCEPTION 'A ledger entry must balance: debits % and credits % over % lines', d, c, n USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT ON "JournalLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_journal_balanced();

-- A transmission is a record of what was built and sent; never edited or deleted.
ALTER TABLE "ClaimTransmission" ADD CONSTRAINT claim_transmission_values CHECK (length(channel) BETWEEN 2 AND 40 AND ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599) AND (detail IS NULL OR length(detail) <= 500));
CREATE TRIGGER claim_transmission_immutable BEFORE UPDATE OR DELETE ON "ClaimTransmission" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

SELECT medos_enable_tenant_rls('"SupplierPaymentRun"');
SELECT medos_enable_tenant_rls('"JournalEntry"');
SELECT medos_enable_tenant_rls('"JournalLine"');
SELECT medos_enable_tenant_rls('"ClaimTransmission"');
