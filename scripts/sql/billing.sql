-- ===== scope guards (optional references) =====
CREATE TRIGGER invoice_scope_encounter BEFORE INSERT OR UPDATE OF "encounterId" ON "Invoice" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Encounter', 'encounterId');
CREATE TRIGGER invoice_line_scope_service BEFORE INSERT OR UPDATE OF "serviceId" ON "InvoiceLine" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Service', 'serviceId');
CREATE TRIGGER receipt_scope_shift BEFORE INSERT OR UPDATE OF "shiftId" ON "Receipt" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('CashierShift', 'shiftId');
CREATE TRIGGER refund_scope_shift BEFORE INSERT OR UPDATE OF "shiftId" ON "Refund" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('CashierShift', 'shiftId');

-- ===== service catalogue =====
ALTER TABLE "Service" ADD CONSTRAINT service_price_nonneg CHECK (price >= 0);
ALTER TABLE "Service" ADD CONSTRAINT service_tax_range CHECK ("taxPercent" BETWEEN 0 AND 100);
ALTER TABLE "Service" ADD CONSTRAINT service_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$');

-- ===== invoices =====
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_amounts_nonneg CHECK (
  subtotal >= 0 AND "discountTotal" >= 0 AND "taxTotal" >= 0 AND total >= 0 AND "paidTotal" >= 0 AND "refundedTotal" >= 0 AND "creditedTotal" >= 0);
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_total_formula CHECK (total = subtotal - "discountTotal" + "taxTotal");
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_discount_le_subtotal CHECK ("discountTotal" <= subtotal);
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_refund_le_paid CHECK ("refundedTotal" <= "paidTotal");
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_credit_le_total CHECK ("creditedTotal" <= total);
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_draft_is_blank CHECK (
  status <> 'DRAFT' OR ("invoiceNumber" IS NULL AND "issuedAt" IS NULL AND "paidTotal" = 0 AND "refundedTotal" = 0 AND "creditedTotal" = 0));
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_issued_has_number CHECK (
  status IN ('DRAFT', 'CANCELLED') OR ("invoiceNumber" IS NOT NULL AND "issuedAt" IS NOT NULL AND "issuedById" IS NOT NULL AND total > 0));
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_cancel_has_reason CHECK (status NOT IN ('CANCELLED', 'REFUNDED') OR ("cancelledAt" IS NOT NULL OR status = 'REFUNDED'));

CREATE OR REPLACE FUNCTION medos_invoice_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW.kind <> OLD.kind
     OR NEW."encounterId" IS DISTINCT FROM OLD."encounterId" THEN
    RAISE EXCEPTION 'Invoice identity fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status::text, NEW.status::text) NOT IN (
    ('DRAFT', 'ISSUED'), ('DRAFT', 'CANCELLED'),
    ('ISSUED', 'PARTIALLY_PAID'), ('ISSUED', 'PAID'), ('ISSUED', 'CANCELLED'), ('ISSUED', 'REFUNDED'),
    ('PARTIALLY_PAID', 'ISSUED'), ('PARTIALLY_PAID', 'PAID'), ('PARTIALLY_PAID', 'CANCELLED'), ('PARTIALLY_PAID', 'REFUNDED'),
    ('PAID', 'ISSUED'), ('PAID', 'PARTIALLY_PAID'), ('PAID', 'CANCELLED'), ('PAID', 'REFUNDED')) THEN
    RAISE EXCEPTION 'Invalid invoice status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Once issued, the commercial content of the invoice is frozen.
  IF OLD.status <> 'DRAFT' AND (
       NEW.subtotal <> OLD.subtotal OR NEW."discountTotal" <> OLD."discountTotal" OR NEW."taxTotal" <> OLD."taxTotal" OR NEW.total <> OLD.total
       OR NEW."invoiceNumber" IS DISTINCT FROM OLD."invoiceNumber" OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" OR NEW."issuedById" IS DISTINCT FROM OLD."issuedById"
       OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW."createdById" <> OLD."createdById") THEN
    RAISE EXCEPTION 'An issued invoice cannot be changed; use a credit note, refund or cancellation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('CANCELLED', 'REFUNDED') AND (NEW."paidTotal" <> OLD."paidTotal" OR NEW."refundedTotal" <> OLD."refundedTotal" OR NEW."creditedTotal" <> OLD."creditedTotal") THEN
    RAISE EXCEPTION 'A cancelled invoice cannot take further money movements' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_guard BEFORE UPDATE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION medos_invoice_guard();
CREATE TRIGGER invoice_no_delete BEFORE DELETE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- Invoice lines can only be touched while the parent is a draft.
ALTER TABLE "InvoiceLine" ADD CONSTRAINT invoice_line_numbers CHECK (
  quantity > 0 AND "unitPrice" >= 0 AND "discountAmount" >= 0 AND "taxPercent" BETWEEN 0 AND 100 AND "taxAmount" >= 0 AND "lineTotal" >= 0 AND "lineNo" >= 1
  AND "discountAmount" <= round(quantity * "unitPrice", 2));
CREATE UNIQUE INDEX "InvoiceLine_source_once" ON "InvoiceLine" ("tenantId", "sourceType", "sourceId") WHERE "sourceId" IS NOT NULL;
CREATE OR REPLACE FUNCTION medos_invoice_line_guard() RETURNS trigger AS $$
DECLARE parent_status text; parent_id uuid;
BEGIN
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END;
  SELECT status::text INTO parent_status FROM "Invoice" WHERE id = parent_id;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of an issued invoice cannot be added, changed or removed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceLine" FOR EACH ROW EXECUTE FUNCTION medos_invoice_line_guard();

-- ===== money records are append-only =====
ALTER TABLE "Receipt" ADD CONSTRAINT receipt_total_positive CHECK (total > 0);
ALTER TABLE "Payment" ADD CONSTRAINT payment_amount_positive CHECK (amount > 0);
ALTER TABLE "Refund" ADD CONSTRAINT refund_amount_positive CHECK (amount > 0);
ALTER TABLE "CreditNote" ADD CONSTRAINT credit_amount_positive CHECK (amount > 0);
ALTER TABLE "Refund" ADD CONSTRAINT refund_has_reason CHECK (length(btrim(reason)) >= 3);
ALTER TABLE "CreditNote" ADD CONSTRAINT credit_has_reason CHECK (length(btrim(reason)) >= 3);
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON "Receipt" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER payment_immutable BEFORE UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER refund_immutable BEFORE UPDATE OR DELETE ON "Refund" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER credit_note_immutable BEFORE UPDATE OR DELETE ON "CreditNote" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== reconciliation enforced at commit =====
-- A receipt's total must equal the sum of its tender lines.
CREATE OR REPLACE FUNCTION medos_receipt_balanced() RETURNS trigger AS $$
DECLARE rid uuid; tender numeric; rtotal numeric;
BEGIN
  rid := CASE TG_TABLE_NAME WHEN 'Receipt' THEN NEW.id ELSE NEW."receiptId" END;
  SELECT total INTO rtotal FROM "Receipt" WHERE id = rid;
  SELECT COALESCE(SUM(amount), 0) INTO tender FROM "Payment" WHERE "receiptId" = rid;
  IF rtotal IS DISTINCT FROM tender THEN
    RAISE EXCEPTION 'Receipt total % does not equal its payment lines %', rtotal, tender USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER receipt_balanced AFTER INSERT ON "Receipt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_receipt_balanced();
CREATE CONSTRAINT TRIGGER payment_balanced AFTER INSERT ON "Payment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_receipt_balanced();

-- The invoice's running totals must equal the sums of its receipts, refunds and credit notes.
CREATE OR REPLACE FUNCTION medos_invoice_reconciled() RETURNS trigger AS $$
DECLARE iid uuid; inv record; p numeric; r numeric; c numeric;
BEGIN
  iid := CASE TG_TABLE_NAME WHEN 'Invoice' THEN NEW.id ELSE NEW."invoiceId" END;
  SELECT * INTO inv FROM "Invoice" WHERE id = iid;
  SELECT COALESCE(SUM(total), 0) INTO p FROM "Receipt" WHERE "invoiceId" = iid;
  SELECT COALESCE(SUM(amount), 0) INTO r FROM "Refund" WHERE "invoiceId" = iid;
  SELECT COALESCE(SUM(amount), 0) INTO c FROM "CreditNote" WHERE "invoiceId" = iid;
  IF inv."paidTotal" <> p OR inv."refundedTotal" <> r OR inv."creditedTotal" <> c THEN
    RAISE EXCEPTION 'Invoice % totals do not reconcile with receipts/refunds/credit notes', iid USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER invoice_reconciled AFTER INSERT OR UPDATE ON "Invoice" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_invoice_reconciled();
CREATE CONSTRAINT TRIGGER receipt_reconciles_invoice AFTER INSERT ON "Receipt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_invoice_reconciled();
CREATE CONSTRAINT TRIGGER refund_reconciles_invoice AFTER INSERT ON "Refund" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_invoice_reconciled();
CREATE CONSTRAINT TRIGGER credit_reconciles_invoice AFTER INSERT ON "CreditNote" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_invoice_reconciled();

-- ===== cashier shifts =====
CREATE UNIQUE INDEX "CashierShift_one_open_per_cashier" ON "CashierShift" ("tenantId", "facilityId", "cashierId") WHERE status = 'OPEN';
ALTER TABLE "CashierShift" ADD CONSTRAINT shift_opening_nonneg CHECK ("openingCash" >= 0);
ALTER TABLE "CashierShift" ADD CONSTRAINT shift_closed_complete CHECK (
  (status = 'OPEN' AND "closedAt" IS NULL AND "expectedCash" IS NULL AND "actualCash" IS NULL AND difference IS NULL)
  OR (status = 'CLOSED' AND "closedAt" IS NOT NULL AND "expectedCash" IS NOT NULL AND "actualCash" IS NOT NULL AND difference IS NOT NULL AND "actualCash" >= 0
      AND difference = "actualCash" - "expectedCash"));
CREATE OR REPLACE FUNCTION medos_shift_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'A closed cashier shift cannot be modified' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."cashierId" <> OLD."cashierId"
     OR NEW."openedAt" <> OLD."openedAt" OR NEW."openingCash" <> OLD."openingCash" THEN
    RAISE EXCEPTION 'Shift identity and opening balance are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER shift_guard BEFORE UPDATE ON "CashierShift" FOR EACH ROW EXECUTE FUNCTION medos_shift_guard();
CREATE TRIGGER shift_no_delete BEFORE DELETE ON "CashierShift" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
