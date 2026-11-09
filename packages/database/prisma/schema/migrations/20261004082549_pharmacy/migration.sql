-- CreateEnum
CREATE TYPE "DosageForm" AS ENUM ('TABLET', 'CAPSULE', 'SYRUP', 'INJECTION', 'OINTMENT', 'DROPS', 'INHALER', 'SACHET', 'OTHER');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "StockTxnType" AS ENUM ('PURCHASE', 'SALE', 'PATIENT_RETURN', 'PURCHASE_RETURN', 'ADJUSTMENT', 'DAMAGE', 'TRANSFER');

-- CreateEnum
CREATE TYPE "StockDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('RECEIVED', 'PARTIALLY_RETURNED', 'RETURNED');

-- CreateEnum
CREATE TYPE "DispenseStatus" AS ENUM ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED');

-- AlterTable
ALTER TABLE "MedicationOrderItem" ADD COLUMN     "medicineId" UUID;

-- CreateTable
CREATE TABLE "Medicine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "brandName" TEXT NOT NULL,
    "genericName" TEXT NOT NULL,
    "strength" TEXT,
    "dosageForm" "DosageForm" NOT NULL,
    "manufacturer" TEXT,
    "hsnCode" TEXT,
    "gstPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "reorderLevel" INTEGER NOT NULL DEFAULT 0,
    "identityKey" TEXT NOT NULL,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Medicine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "address" TEXT,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicineBatch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "medicineId" UUID NOT NULL,
    "batchNo" TEXT NOT NULL,
    "expiryDate" DATE NOT NULL,
    "mrp" DECIMAL(12,2) NOT NULL,
    "purchasePrice" DECIMAL(12,2) NOT NULL,
    "sellingPrice" DECIMAL(12,2) NOT NULL,
    "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
    "status" "BatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "blockReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MedicineBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "medicineId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("batchId")
);

-- CreateTable
CREATE TABLE "StockLedger" (
    "seq" BIGSERIAL NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "medicineId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "type" "StockTxnType" NOT NULL,
    "direction" "StockDirection" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "sourceType" TEXT,
    "sourceId" UUID,
    "reason" TEXT,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "purchaseNumber" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "supplierInvoiceNo" TEXT NOT NULL,
    "supplierInvoiceDate" DATE NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'RECEIVED',
    "subtotal" DECIMAL(14,2) NOT NULL,
    "taxTotal" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "receivedById" UUID NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "medicineId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "purchasePrice" DECIMAL(12,2) NOT NULL,
    "mrp" DECIMAL(12,2) NOT NULL,
    "sellingPrice" DECIMAL(12,2) NOT NULL,
    "gstPercent" DECIMAL(5,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "returnedQuantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReturn" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "purchaseId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReturnItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "returnId" UUID NOT NULL,
    "purchaseItemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "PurchaseReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispense" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "medicationOrderId" UUID,
    "dispenseNumber" TEXT NOT NULL,
    "status" "DispenseStatus" NOT NULL DEFAULT 'COMPLETED',
    "invoiceId" UUID,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "taxTotal" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "dispensedById" UUID NOT NULL,
    "dispensedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dispense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispenseItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "dispenseId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "medicationOrderItemId" UUID,
    "medicineId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "taxPercent" DECIMAL(5,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "returnedQuantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DispenseItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Medicine_brandName_trgm" ON "Medicine" USING GIN ("brandName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Medicine_genericName_trgm" ON "Medicine" USING GIN ("genericName" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "Medicine_tenantId_id_key" ON "Medicine"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Medicine_tenantId_identityKey_key" ON "Medicine"("tenantId", "identityKey");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_id_key" ON "Supplier"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_name_key" ON "Supplier"("tenantId", "name");

-- CreateIndex
CREATE INDEX "MedicineBatch_tenantId_facilityId_medicineId_expiryDate_idx" ON "MedicineBatch"("tenantId", "facilityId", "medicineId", "expiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "MedicineBatch_tenantId_id_key" ON "MedicineBatch"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MedicineBatch_tenantId_facilityId_medicineId_batchNo_key" ON "MedicineBatch"("tenantId", "facilityId", "medicineId", "batchNo");

-- CreateIndex
CREATE INDEX "StockBalance_tenantId_facilityId_medicineId_idx" ON "StockBalance"("tenantId", "facilityId", "medicineId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_tenantId_batchId_key" ON "StockBalance"("tenantId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLedger_seq_key" ON "StockLedger"("seq");

-- CreateIndex
CREATE INDEX "StockLedger_tenantId_batchId_seq_idx" ON "StockLedger"("tenantId", "batchId", "seq");

-- CreateIndex
CREATE INDEX "StockLedger_tenantId_facilityId_medicineId_createdAt_idx" ON "StockLedger"("tenantId", "facilityId", "medicineId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "StockLedger_tenantId_sourceType_sourceId_idx" ON "StockLedger"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "Purchase_tenantId_facilityId_receivedAt_idx" ON "Purchase"("tenantId", "facilityId", "receivedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_tenantId_id_key" ON "Purchase"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_tenantId_facilityId_purchaseNumber_key" ON "Purchase"("tenantId", "facilityId", "purchaseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_tenantId_supplierId_supplierInvoiceNo_key" ON "Purchase"("tenantId", "supplierId", "supplierInvoiceNo");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseItem_tenantId_id_key" ON "PurchaseItem"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseItem_purchaseId_lineNo_key" ON "PurchaseItem"("purchaseId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturn_tenantId_id_key" ON "PurchaseReturn"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturn_tenantId_facilityId_returnNumber_key" ON "PurchaseReturn"("tenantId", "facilityId", "returnNumber");

-- CreateIndex
CREATE INDEX "PurchaseReturnItem_purchaseItemId_idx" ON "PurchaseReturnItem"("purchaseItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturnItem_tenantId_id_key" ON "PurchaseReturnItem"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Dispense_tenantId_facilityId_dispensedAt_idx" ON "Dispense"("tenantId", "facilityId", "dispensedAt" DESC);

-- CreateIndex
CREATE INDEX "Dispense_tenantId_patientId_dispensedAt_idx" ON "Dispense"("tenantId", "patientId", "dispensedAt" DESC);

-- CreateIndex
CREATE INDEX "Dispense_tenantId_medicationOrderId_idx" ON "Dispense"("tenantId", "medicationOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispense_tenantId_id_key" ON "Dispense"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Dispense_tenantId_facilityId_dispenseNumber_key" ON "Dispense"("tenantId", "facilityId", "dispenseNumber");

-- CreateIndex
CREATE INDEX "DispenseItem_tenantId_batchId_idx" ON "DispenseItem"("tenantId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "DispenseItem_tenantId_id_key" ON "DispenseItem"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DispenseItem_dispenseId_lineNo_key" ON "DispenseItem"("dispenseId", "lineNo");

-- AddForeignKey
ALTER TABLE "MedicationOrderItem" ADD CONSTRAINT "MedicationOrderItem_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Medicine" ADD CONSTRAINT "Medicine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicineBatch" ADD CONSTRAINT "MedicineBatch_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicineBatch" ADD CONSTRAINT "MedicineBatch_tenantId_medicineId_fkey" FOREIGN KEY ("tenantId", "medicineId") REFERENCES "Medicine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "MedicineBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedger" ADD CONSTRAINT "StockLedger_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "MedicineBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "Purchase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_tenantId_medicineId_fkey" FOREIGN KEY ("tenantId", "medicineId") REFERENCES "Medicine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "Purchase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "PurchaseReturn"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispense" ADD CONSTRAINT "Dispense_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispense" ADD CONSTRAINT "Dispense_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispense" ADD CONSTRAINT "Dispense_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispense" ADD CONSTRAINT "Dispense_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispense" ADD CONSTRAINT "Dispense_medicationOrderId_fkey" FOREIGN KEY ("medicationOrderId") REFERENCES "MedicationOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispenseItem" ADD CONSTRAINT "DispenseItem_tenantId_dispenseId_fkey" FOREIGN KEY ("tenantId", "dispenseId") REFERENCES "Dispense"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispenseItem" ADD CONSTRAINT "DispenseItem_tenantId_medicineId_fkey" FOREIGN KEY ("tenantId", "medicineId") REFERENCES "Medicine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- ===== scope guards =====
CREATE TRIGGER order_item_scope_medicine BEFORE INSERT OR UPDATE OF "medicineId" ON "MedicationOrderItem" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Medicine', 'medicineId');
CREATE TRIGGER dispense_scope_invoice BEFORE INSERT OR UPDATE OF "invoiceId" ON "Dispense" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Invoice', 'invoiceId');
CREATE TRIGGER dispense_scope_order BEFORE INSERT OR UPDATE OF "medicationOrderId" ON "Dispense" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('MedicationOrder', 'medicationOrderId');
CREATE TRIGGER dispense_scope_encounter BEFORE INSERT OR UPDATE OF "encounterId" ON "Dispense" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Encounter', 'encounterId');

-- ===== masters =====
ALTER TABLE "Medicine" ADD CONSTRAINT medicine_gst_range CHECK ("gstPercent" BETWEEN 0 AND 100);
ALTER TABLE "Medicine" ADD CONSTRAINT medicine_reorder_nonneg CHECK ("reorderLevel" >= 0);
ALTER TABLE "Medicine" ADD CONSTRAINT medicine_names_present CHECK (length(btrim("brandName")) > 0 AND length(btrim("genericName")) > 0);
CREATE TRIGGER medicine_no_delete BEFORE DELETE ON "Medicine" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER supplier_no_delete BEFORE DELETE ON "Supplier" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "MedicineBatch" ADD CONSTRAINT batch_prices CHECK ("mrp" >= 0 AND "purchasePrice" >= 0 AND "sellingPrice" >= 0 AND "sellingPrice" <= "mrp");
ALTER TABLE "MedicineBatch" ADD CONSTRAINT batch_received_nonneg CHECK ("receivedQuantity" >= 0);
ALTER TABLE "MedicineBatch" ADD CONSTRAINT batch_block_has_reason CHECK (status = 'ACTIVE' OR ("blockReason" IS NOT NULL AND length(btrim("blockReason")) >= 3));
CREATE OR REPLACE FUNCTION medos_batch_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."medicineId" <> OLD."medicineId"
     OR NEW."batchNo" <> OLD."batchNo" OR NEW."expiryDate" <> OLD."expiryDate" OR NEW.mrp <> OLD.mrp
     OR NEW."purchasePrice" <> OLD."purchasePrice" OR NEW."sellingPrice" <> OLD."sellingPrice" THEN
    RAISE EXCEPTION 'Batch identity, expiry and prices are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."receivedQuantity" < OLD."receivedQuantity" THEN
    RAISE EXCEPTION 'Received quantity cannot decrease' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER batch_guard BEFORE UPDATE ON "MedicineBatch" FOR EACH ROW EXECUTE FUNCTION medos_batch_guard();
CREATE TRIGGER batch_no_delete BEFORE DELETE ON "MedicineBatch" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== stock balance and ledger =====
ALTER TABLE "StockBalance" ADD CONSTRAINT stock_balance_nonneg CHECK (quantity >= 0);
CREATE TRIGGER stock_balance_no_delete BEFORE DELETE ON "StockBalance" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "StockLedger" ADD CONSTRAINT ledger_quantity_positive CHECK (quantity > 0 AND "balanceAfter" >= 0);
ALTER TABLE "StockLedger" ADD CONSTRAINT ledger_direction_matches_type CHECK (
  (type IN ('PURCHASE', 'PATIENT_RETURN') AND direction = 'IN')
  OR (type IN ('SALE', 'PURCHASE_RETURN', 'DAMAGE') AND direction = 'OUT')
  OR type IN ('ADJUSTMENT', 'TRANSFER'));
ALTER TABLE "StockLedger" ADD CONSTRAINT ledger_adjustment_has_reason CHECK (type NOT IN ('ADJUSTMENT', 'DAMAGE') OR (reason IS NOT NULL AND length(btrim(reason)) >= 5));
CREATE TRIGGER stock_ledger_immutable BEFORE UPDATE OR DELETE ON "StockLedger" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER stock_ledger_no_truncate BEFORE TRUNCATE ON "StockLedger" FOR EACH STATEMENT EXECUTE FUNCTION medos_forbid_mutation();

-- Expired or blocked batches can never be sold.
CREATE OR REPLACE FUNCTION medos_ledger_sale_guard() RETURNS trigger AS $$
DECLARE b record; today date;
BEGIN
  IF NEW.type = 'SALE' THEN
    SELECT mb."expiryDate", mb.status, f.timezone INTO b
    FROM "MedicineBatch" mb JOIN "Facility" f ON f.id = mb."facilityId" AND f."tenantId" = mb."tenantId"
    WHERE mb.id = NEW."batchId";
    today := (now() AT TIME ZONE b.timezone)::date;
    IF b."expiryDate" < today THEN
      RAISE EXCEPTION 'Batch has expired and cannot be dispensed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF b.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Batch is blocked and cannot be dispensed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER stock_ledger_sale_guard BEFORE INSERT ON "StockLedger" FOR EACH ROW EXECUTE FUNCTION medos_ledger_sale_guard();

-- The materialised balance must equal the ledger at commit, for every batch touched.
CREATE OR REPLACE FUNCTION medos_stock_reconciled() RETURNS trigger AS $$
DECLARE bal integer; led bigint;
BEGIN
  SELECT quantity INTO bal FROM "StockBalance" WHERE "batchId" = NEW."batchId";
  SELECT COALESCE(SUM(CASE direction WHEN 'IN' THEN quantity ELSE -quantity END), 0) INTO led FROM "StockLedger" WHERE "batchId" = NEW."batchId";
  IF bal IS DISTINCT FROM led THEN
    RAISE EXCEPTION 'Stock balance % does not match the ledger % for batch %', bal, led, NEW."batchId" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER stock_ledger_reconciled AFTER INSERT ON "StockLedger" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_stock_reconciled();
CREATE CONSTRAINT TRIGGER stock_balance_reconciled AFTER INSERT OR UPDATE ON "StockBalance" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_stock_reconciled();

-- ===== procurement =====
ALTER TABLE "Purchase" ADD CONSTRAINT purchase_amounts CHECK (subtotal >= 0 AND "taxTotal" >= 0 AND total = subtotal + "taxTotal");
ALTER TABLE "PurchaseItem" ADD CONSTRAINT purchase_item_numbers CHECK (quantity > 0 AND "purchasePrice" >= 0 AND mrp >= 0 AND "sellingPrice" >= 0 AND "sellingPrice" <= mrp AND "gstPercent" BETWEEN 0 AND 100 AND "lineTotal" >= 0 AND "returnedQuantity" BETWEEN 0 AND quantity AND "lineNo" >= 1);
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT purchase_return_reason CHECK (length(btrim(reason)) >= 5 AND total > 0);
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT purchase_return_item_numbers CHECK (quantity > 0 AND amount >= 0);
CREATE TRIGGER purchase_return_immutable BEFORE UPDATE OR DELETE ON "PurchaseReturn" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER purchase_return_item_immutable BEFORE UPDATE OR DELETE ON "PurchaseReturnItem" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

CREATE OR REPLACE FUNCTION medos_purchase_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.subtotal <> OLD.subtotal OR NEW."taxTotal" <> OLD."taxTotal" OR NEW.total <> OLD.total OR NEW."purchaseNumber" <> OLD."purchaseNumber"
     OR NEW."supplierId" <> OLD."supplierId" OR NEW."supplierInvoiceNo" <> OLD."supplierInvoiceNo" OR NEW."facilityId" <> OLD."facilityId" THEN
    RAISE EXCEPTION 'A received purchase cannot be changed; use a purchase return' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status::text, NEW.status::text) NOT IN (('RECEIVED', 'PARTIALLY_RETURNED'), ('RECEIVED', 'RETURNED'), ('PARTIALLY_RETURNED', 'RETURNED')) THEN
    RAISE EXCEPTION 'Invalid purchase status transition' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_guard BEFORE UPDATE ON "Purchase" FOR EACH ROW EXECUTE FUNCTION medos_purchase_guard();
CREATE TRIGGER purchase_no_delete BEFORE DELETE ON "Purchase" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

CREATE OR REPLACE FUNCTION medos_purchase_item_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Purchase items cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'returnedQuantity') IS DISTINCT FROM (to_jsonb(OLD) - 'returnedQuantity') OR NEW."returnedQuantity" < OLD."returnedQuantity" THEN
    RAISE EXCEPTION 'Purchase items cannot be changed; use a purchase return' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_item_guard BEFORE UPDATE OR DELETE ON "PurchaseItem" FOR EACH ROW EXECUTE FUNCTION medos_purchase_item_guard();

-- ===== dispensing =====
ALTER TABLE "Dispense" ADD CONSTRAINT dispense_amounts CHECK (subtotal >= 0 AND "taxTotal" >= 0 AND total >= 0);
ALTER TABLE "DispenseItem" ADD CONSTRAINT dispense_item_numbers CHECK (quantity > 0 AND "unitPrice" >= 0 AND "taxPercent" BETWEEN 0 AND 100 AND "lineTotal" >= 0 AND "returnedQuantity" BETWEEN 0 AND quantity AND "lineNo" >= 1);

CREATE OR REPLACE FUNCTION medos_dispense_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.subtotal <> OLD.subtotal OR NEW."taxTotal" <> OLD."taxTotal" OR NEW.total <> OLD.total OR NEW."dispenseNumber" <> OLD."dispenseNumber"
     OR NEW."patientId" <> OLD."patientId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."dispensedById" <> OLD."dispensedById"
     OR NEW."medicationOrderId" IS DISTINCT FROM OLD."medicationOrderId" THEN
    RAISE EXCEPTION 'A completed dispense cannot be changed; record a return' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status::text, NEW.status::text) NOT IN (('COMPLETED', 'PARTIALLY_RETURNED'), ('COMPLETED', 'RETURNED'), ('PARTIALLY_RETURNED', 'RETURNED')) THEN
    RAISE EXCEPTION 'Invalid dispense status transition' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER dispense_guard BEFORE UPDATE ON "Dispense" FOR EACH ROW EXECUTE FUNCTION medos_dispense_guard();
CREATE TRIGGER dispense_no_delete BEFORE DELETE ON "Dispense" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

CREATE OR REPLACE FUNCTION medos_dispense_item_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Dispense items cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'returnedQuantity') IS DISTINCT FROM (to_jsonb(OLD) - 'returnedQuantity') OR NEW."returnedQuantity" < OLD."returnedQuantity" THEN
    RAISE EXCEPTION 'Dispense items cannot be changed; record a return' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER dispense_item_guard BEFORE UPDATE OR DELETE ON "DispenseItem" FOR EACH ROW EXECUTE FUNCTION medos_dispense_item_guard();

