-- Advance payments (deposits). New tables only, plus one nullable column on Payment; nothing existing changes meaning.
-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "advanceUseId" UUID;

-- CreateTable
CREATE TABLE "AdvanceDeposit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "receivedById" UUID NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shiftId" UUID,

    CONSTRAINT "AdvanceDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvanceTender" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "depositId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,

    CONSTRAINT "AdvanceTender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvanceUse" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "depositId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "appliedById" UUID NOT NULL,
    "appliedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvanceUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvanceRefund" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "depositId" UUID NOT NULL,
    "refundNumber" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "reference" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shiftId" UUID,

    CONSTRAINT "AdvanceRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdvanceDeposit_tenantId_patientId_receivedAt_idx" ON "AdvanceDeposit"("tenantId", "patientId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "AdvanceDeposit_shiftId_idx" ON "AdvanceDeposit"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceDeposit_tenantId_id_key" ON "AdvanceDeposit"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceDeposit_tenantId_facilityId_receiptNumber_key" ON "AdvanceDeposit"("tenantId", "facilityId", "receiptNumber");

-- CreateIndex
CREATE INDEX "AdvanceTender_tenantId_depositId_idx" ON "AdvanceTender"("tenantId", "depositId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceTender_tenantId_id_key" ON "AdvanceTender"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AdvanceUse_tenantId_depositId_idx" ON "AdvanceUse"("tenantId", "depositId");

-- CreateIndex
CREATE INDEX "AdvanceUse_tenantId_invoiceId_idx" ON "AdvanceUse"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceUse_tenantId_id_key" ON "AdvanceUse"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AdvanceRefund_tenantId_depositId_idx" ON "AdvanceRefund"("tenantId", "depositId");

-- CreateIndex
CREATE INDEX "AdvanceRefund_shiftId_idx" ON "AdvanceRefund"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceRefund_tenantId_id_key" ON "AdvanceRefund"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceRefund_tenantId_facilityId_refundNumber_key" ON "AdvanceRefund"("tenantId", "facilityId", "refundNumber");

-- CreateIndex
CREATE INDEX "Payment_advanceUseId_idx" ON "Payment"("advanceUseId");

-- AddForeignKey
ALTER TABLE "AdvanceDeposit" ADD CONSTRAINT "AdvanceDeposit_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceDeposit" ADD CONSTRAINT "AdvanceDeposit_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "CashierShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceTender" ADD CONSTRAINT "AdvanceTender_tenantId_depositId_fkey" FOREIGN KEY ("tenantId", "depositId") REFERENCES "AdvanceDeposit"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceUse" ADD CONSTRAINT "AdvanceUse_tenantId_depositId_fkey" FOREIGN KEY ("tenantId", "depositId") REFERENCES "AdvanceDeposit"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceUse" ADD CONSTRAINT "AdvanceUse_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceUse" ADD CONSTRAINT "AdvanceUse_tenantId_receiptId_fkey" FOREIGN KEY ("tenantId", "receiptId") REFERENCES "Receipt"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRefund" ADD CONSTRAINT "AdvanceRefund_tenantId_depositId_fkey" FOREIGN KEY ("tenantId", "depositId") REFERENCES "AdvanceDeposit"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRefund" ADD CONSTRAINT "AdvanceRefund_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "CashierShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== hand-written rules (docs/advance-payments.md) =====
ALTER TABLE "AdvanceDeposit" ADD CONSTRAINT advance_deposit_positive CHECK (amount > 0);
ALTER TABLE "AdvanceTender" ADD CONSTRAINT advance_tender_positive CHECK (amount > 0);
ALTER TABLE "AdvanceUse" ADD CONSTRAINT advance_use_positive CHECK (amount > 0);
ALTER TABLE "AdvanceRefund" ADD CONSTRAINT advance_refund_positive CHECK (amount > 0);

-- Append-only, like receipts, payments and refunds: a mistake is corrected with a new row, never an edit.
CREATE TRIGGER advance_deposit_immutable BEFORE UPDATE OR DELETE ON "AdvanceDeposit" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER advance_tender_immutable BEFORE UPDATE OR DELETE ON "AdvanceTender" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER advance_use_immutable BEFORE UPDATE OR DELETE ON "AdvanceUse" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER advance_refund_immutable BEFORE UPDATE OR DELETE ON "AdvanceRefund" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- A deposit's total equals its tender lines (checked when the transaction commits, so the lines can be written after the header).
CREATE OR REPLACE FUNCTION medos_advance_balanced() RETURNS trigger AS $$
DECLARE did uuid; dtotal numeric; tender numeric;
BEGIN
  IF TG_TABLE_NAME = 'AdvanceDeposit' THEN did := NEW.id; ELSE did := NEW."depositId"; END IF;
  SELECT amount INTO dtotal FROM "AdvanceDeposit" WHERE id = did;
  SELECT COALESCE(SUM(amount), 0) INTO tender FROM "AdvanceTender" WHERE "depositId" = did;
  IF dtotal IS DISTINCT FROM tender THEN
    RAISE EXCEPTION 'Advance % does not equal its tender lines %', dtotal, tender USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER advance_deposit_balanced AFTER INSERT ON "AdvanceDeposit" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_advance_balanced();
CREATE CONSTRAINT TRIGGER advance_tender_balanced AFTER INSERT ON "AdvanceTender" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_advance_balanced();

-- An advance can never be used or refunded beyond what was received, whatever the application does.
CREATE OR REPLACE FUNCTION medos_advance_not_overdrawn() RETURNS trigger AS $$
DECLARE dtotal numeric; used numeric; given numeric;
BEGIN
  SELECT amount INTO dtotal FROM "AdvanceDeposit" WHERE id = NEW."depositId";
  SELECT COALESCE(SUM(amount), 0) INTO used FROM "AdvanceUse" WHERE "depositId" = NEW."depositId";
  SELECT COALESCE(SUM(amount), 0) INTO given FROM "AdvanceRefund" WHERE "depositId" = NEW."depositId";
  IF used + given > dtotal THEN
    RAISE EXCEPTION 'Advance % is overdrawn: % used and refunded against % received', NEW."depositId", used + given, dtotal USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER advance_use_not_overdrawn AFTER INSERT ON "AdvanceUse" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION medos_advance_not_overdrawn();
CREATE CONSTRAINT TRIGGER advance_refund_not_overdrawn AFTER INSERT ON "AdvanceRefund" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION medos_advance_not_overdrawn();

-- Hospital isolation (same as every other tenant table; see rls.md).
SELECT medos_enable_tenant_rls('"AdvanceDeposit"');
SELECT medos_enable_tenant_rls('"AdvanceTender"');
SELECT medos_enable_tenant_rls('"AdvanceUse"');
SELECT medos_enable_tenant_rls('"AdvanceRefund"');
