-- Invoice tax split and round-off (docs/gst-and-rounding.md). Whether tax is split into equal CGST and SGST halves, and whether the total is rounded to the
-- whole rupee, is decided when the invoice is created (from facility settings) and recorded on it, so an issued invoice never changes under a different rule.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "roundOff" DECIMAL(4,2) NOT NULL DEFAULT 0,
ADD COLUMN     "roundsToRupee" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taxSplit" BOOLEAN NOT NULL DEFAULT false;

-- ===== Hand-written invariants =====
-- The total now includes the round-off. Older invoices have a round-off of 0, so the old formula still holds for them.
ALTER TABLE "Invoice" DROP CONSTRAINT invoice_total_formula;
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_total_formula CHECK (total = subtotal - "discountTotal" + "taxTotal" + "roundOff");
-- A round-off is at most 50 paise either way, exists only when the invoice rounds, and then leaves a whole-rupee total.
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_round_off CHECK (
  "roundOff" BETWEEN -0.50 AND 0.50 AND ("roundsToRupee" OR "roundOff" = 0) AND (NOT "roundsToRupee" OR total = round(total, 0)));

-- The two switches are part of the invoice's identity: fixed at creation, and the round-off is frozen with the rest of the amounts once issued.
CREATE OR REPLACE FUNCTION medos_invoice_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW.kind <> OLD.kind
     OR NEW."encounterId" IS DISTINCT FROM OLD."encounterId" OR NEW."taxSplit" <> OLD."taxSplit" OR NEW."roundsToRupee" <> OLD."roundsToRupee" THEN
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
       NEW.subtotal <> OLD.subtotal OR NEW."discountTotal" <> OLD."discountTotal" OR NEW."taxTotal" <> OLD."taxTotal" OR NEW."roundOff" <> OLD."roundOff" OR NEW.total <> OLD.total
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

-- On an invoice that splits tax, every line's tax is an even number of paise, so CGST and SGST are exactly equal halves.
CREATE OR REPLACE FUNCTION medos_invoice_line_guard() RETURNS trigger AS $$
DECLARE parent_status text; parent_id uuid; parent_split boolean;
BEGIN
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END;
  SELECT status::text, "taxSplit" INTO parent_status, parent_split FROM "Invoice" WHERE id = parent_id;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of an issued invoice cannot be added, changed or removed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP <> 'DELETE' AND parent_split AND MOD(NEW."taxAmount" * 100, 2) <> 0 THEN
    RAISE EXCEPTION 'On an invoice that splits tax, each line''s tax must divide into equal CGST and SGST' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
