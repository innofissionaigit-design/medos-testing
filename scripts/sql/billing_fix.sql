-- Corrective migration: use explicit IF branches instead of CASE over OLD/NEW records.
CREATE OR REPLACE FUNCTION medos_invoice_line_guard() RETURNS trigger AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status::text INTO parent_status FROM "Invoice" WHERE id = OLD."invoiceId";
  ELSE
    SELECT status::text INTO parent_status FROM "Invoice" WHERE id = NEW."invoiceId";
  END IF;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of an issued invoice cannot be added, changed or removed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION medos_receipt_balanced() RETURNS trigger AS $$
DECLARE rid uuid; tender numeric; rtotal numeric;
BEGIN
  IF TG_TABLE_NAME = 'Receipt' THEN
    rid := NEW.id;
  ELSE
    rid := NEW."receiptId";
  END IF;
  SELECT total INTO rtotal FROM "Receipt" WHERE id = rid;
  SELECT COALESCE(SUM(amount), 0) INTO tender FROM "Payment" WHERE "receiptId" = rid;
  IF rtotal IS DISTINCT FROM tender THEN
    RAISE EXCEPTION 'Receipt total % does not equal its payment lines %', rtotal, tender USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION medos_invoice_reconciled() RETURNS trigger AS $$
DECLARE iid uuid; inv record; p numeric; r numeric; c numeric;
BEGIN
  IF TG_TABLE_NAME = 'Invoice' THEN
    iid := NEW.id;
  ELSE
    iid := NEW."invoiceId";
  END IF;
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
