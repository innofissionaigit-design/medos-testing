-- Refunding a bill that was paid from an advance puts that part back into the advance (docs/advance-payments.md).
-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "advanceReturned" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AdvanceReturn" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "useId" UUID NOT NULL,
    "depositId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvanceReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdvanceReturn_tenantId_useId_idx" ON "AdvanceReturn"("tenantId", "useId");

-- CreateIndex
CREATE INDEX "AdvanceReturn_tenantId_depositId_idx" ON "AdvanceReturn"("tenantId", "depositId");

-- CreateIndex
CREATE INDEX "AdvanceReturn_tenantId_refundId_idx" ON "AdvanceReturn"("tenantId", "refundId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceReturn_tenantId_id_key" ON "AdvanceReturn"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "AdvanceReturn" ADD CONSTRAINT "AdvanceReturn_tenantId_useId_fkey" FOREIGN KEY ("tenantId", "useId") REFERENCES "AdvanceUse"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceReturn" ADD CONSTRAINT "AdvanceReturn_tenantId_depositId_fkey" FOREIGN KEY ("tenantId", "depositId") REFERENCES "AdvanceDeposit"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceReturn" ADD CONSTRAINT "AdvanceReturn_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceReturn" ADD CONSTRAINT "AdvanceReturn_tenantId_refundId_fkey" FOREIGN KEY ("tenantId", "refundId") REFERENCES "Refund"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== hand-written rules (docs/advance-payments.md) =====
ALTER TABLE "Refund" ADD CONSTRAINT refund_advance_returned_range CHECK ("advanceReturned" >= 0 AND "advanceReturned" <= amount);
ALTER TABLE "AdvanceReturn" ADD CONSTRAINT advance_return_positive CHECK (amount > 0);
CREATE TRIGGER advance_return_immutable BEFORE UPDATE OR DELETE ON "AdvanceReturn" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- A balance is amount - used + returned - given back, and may never go below zero.
CREATE OR REPLACE FUNCTION medos_advance_not_overdrawn() RETURNS trigger AS $$
DECLARE dtotal numeric; used numeric; given numeric; back numeric;
BEGIN
  SELECT amount INTO dtotal FROM "AdvanceDeposit" WHERE id = NEW."depositId";
  SELECT COALESCE(SUM(amount), 0) INTO used FROM "AdvanceUse" WHERE "depositId" = NEW."depositId";
  SELECT COALESCE(SUM(amount), 0) INTO back FROM "AdvanceReturn" WHERE "depositId" = NEW."depositId";
  SELECT COALESCE(SUM(amount), 0) INTO given FROM "AdvanceRefund" WHERE "depositId" = NEW."depositId";
  IF used - back + given > dtotal THEN
    RAISE EXCEPTION 'Advance % is overdrawn: % used and given back against % received', NEW."depositId", used - back + given, dtotal USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- Nothing can be returned to an advance beyond what that use took from it.
CREATE OR REPLACE FUNCTION medos_advance_return_within_use() RETURNS trigger AS $$
DECLARE taken numeric; back numeric;
BEGIN
  SELECT amount INTO taken FROM "AdvanceUse" WHERE id = NEW."useId";
  SELECT COALESCE(SUM(amount), 0) INTO back FROM "AdvanceReturn" WHERE "useId" = NEW."useId";
  IF back > taken THEN
    RAISE EXCEPTION 'More returned (%) than was used (%) from advance use %', back, taken, NEW."useId" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER advance_return_within_use AFTER INSERT ON "AdvanceReturn" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION medos_advance_return_within_use();

-- A refund's "returned to advance" part equals the return rows written with it (checked at commit).
CREATE OR REPLACE FUNCTION medos_refund_advance_matches() RETURNS trigger AS $$
DECLARE rid uuid; claimed numeric; written numeric;
BEGIN
  IF TG_TABLE_NAME = 'Refund' THEN rid := NEW.id; ELSE rid := NEW."refundId"; END IF;
  SELECT "advanceReturned" INTO claimed FROM "Refund" WHERE id = rid;
  SELECT COALESCE(SUM(amount), 0) INTO written FROM "AdvanceReturn" WHERE "refundId" = rid;
  IF claimed IS DISTINCT FROM written THEN
    RAISE EXCEPTION 'Refund % says % went back to the advance but % was recorded', rid, claimed, written USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER refund_advance_matches AFTER INSERT ON "Refund" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_refund_advance_matches();
CREATE CONSTRAINT TRIGGER advance_return_matches_refund AFTER INSERT ON "AdvanceReturn" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_refund_advance_matches();

SELECT medos_enable_tenant_rls('"AdvanceReturn"');
