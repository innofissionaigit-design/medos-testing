-- Amending one medicine of a signed prescription (docs/prescriptions.md): the replaced medicine stays on the record, stopped, and a one-medicine
-- prescription of its own (with its own number) holds the replacement and points back at it.

-- AlterTable
ALTER TABLE "MedicationOrderItem" ADD COLUMN     "amendsItemId" UUID;

-- AddForeignKey
ALTER TABLE "MedicationOrderItem" ADD CONSTRAINT "MedicationOrderItem_tenantId_amendsItemId_fkey" FOREIGN KEY ("tenantId", "amendsItemId") REFERENCES "MedicationOrderItem"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- A medicine can be replaced once; replacing the replacement is a new link in the chain.
CREATE UNIQUE INDEX "MedicationOrderItem_replaced_once" ON "MedicationOrderItem" ("tenantId", "amendsItemId") WHERE "amendsItemId" IS NOT NULL;

-- The link is written once, when the replacement is made, and only to a stopped medicine of the same visit.
CREATE OR REPLACE FUNCTION medos_order_item_amends_guard() RETURNS trigger AS $$
DECLARE orig_status text; orig_enc uuid; new_enc uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."amendsItemId" IS DISTINCT FROM OLD."amendsItemId" THEN
      RAISE EXCEPTION 'The medicine a prescription item replaces cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."amendsItemId" IS NULL THEN RETURN NEW; END IF;
  IF NEW."amendsItemId" = NEW.id THEN
    RAISE EXCEPTION 'A medicine cannot replace itself' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT i.status::text, o."encounterId" INTO orig_status, orig_enc FROM "MedicationOrderItem" i JOIN "MedicationOrder" o ON o.id = i."orderId" AND o."tenantId" = i."tenantId"
    WHERE i.id = NEW."amendsItemId" AND i."tenantId" = NEW."tenantId";
  SELECT "encounterId" INTO new_enc FROM "MedicationOrder" WHERE id = NEW."orderId" AND "tenantId" = NEW."tenantId";
  IF orig_status IS DISTINCT FROM 'STOPPED' THEN
    RAISE EXCEPTION 'A medicine can be replaced only after the original is stopped' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF orig_enc IS DISTINCT FROM new_enc THEN
    RAISE EXCEPTION 'A replacement must be on the same visit as the medicine it replaces' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER medication_order_item_amends_guard BEFORE INSERT OR UPDATE ON "MedicationOrderItem" FOR EACH ROW EXECUTE FUNCTION medos_order_item_amends_guard();
