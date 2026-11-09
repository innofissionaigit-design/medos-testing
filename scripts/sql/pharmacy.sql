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
