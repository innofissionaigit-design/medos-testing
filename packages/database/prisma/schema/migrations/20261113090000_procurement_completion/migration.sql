-- Procurement completion (docs/procurement.md): store requests, wholly rejected deliveries, supplier debit notes, supplier payments, a second approval level on orders,
-- billing OT use to the patient, and physical stock counts.

CREATE TYPE "StockRequestStatus" AS ENUM ('REQUESTED', 'PARTIALLY_ISSUED', 'ISSUED', 'REJECTED', 'CANCELLED');
CREATE TYPE "DebitNoteStatus" AS ENUM ('RAISED', 'CREDITED');
CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED');

CREATE TABLE "StockRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenantId" UUID NOT NULL, "facilityId" UUID NOT NULL, "requestNumber" TEXT NOT NULL, "locationId" UUID NOT NULL,
    "status" "StockRequestStatus" NOT NULL DEFAULT 'REQUESTED', "note" TEXT, "requestedById" UUID NOT NULL, "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" UUID, "closedAt" TIMESTAMPTZ(3), "closeReason" TEXT, CONSTRAINT "StockRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockRequest_tenantId_id_key" ON "StockRequest"("tenantId", "id");
CREATE UNIQUE INDEX "StockRequest_tenantId_facilityId_requestNumber_key" ON "StockRequest"("tenantId", "facilityId", "requestNumber");
CREATE INDEX "StockRequest_tenantId_facilityId_status_requestedAt_idx" ON "StockRequest"("tenantId", "facilityId", "status", "requestedAt" DESC);
ALTER TABLE "StockRequest" ADD CONSTRAINT "StockRequest_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockRequest" ADD CONSTRAINT "StockRequest_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StockRequestItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenantId" UUID NOT NULL, "requestId" UUID NOT NULL, "lineNo" INTEGER NOT NULL, "medicineId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL, "issuedQuantity" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "StockRequestItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockRequestItem_tenantId_id_key" ON "StockRequestItem"("tenantId", "id");
CREATE UNIQUE INDEX "StockRequestItem_requestId_lineNo_key" ON "StockRequestItem"("requestId", "lineNo");
ALTER TABLE "StockRequestItem" ADD CONSTRAINT "StockRequestItem_tenantId_requestId_fkey" FOREIGN KEY ("tenantId", "requestId") REFERENCES "StockRequest"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockRequestItem" ADD CONSTRAINT "StockRequestItem_tenantId_medicineId_fkey" FOREIGN KEY ("tenantId", "medicineId") REFERENCES "Medicine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PurchaseRejection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenantId" UUID NOT NULL, "purchaseId" UUID NOT NULL, "lineNo" INTEGER NOT NULL, "medicineId" UUID NOT NULL, "poItemId" UUID,
    "quantity" INTEGER NOT NULL, "unitPrice" DECIMAL(12,2) NOT NULL, "gstPercent" DECIMAL(5,2) NOT NULL, "reason" TEXT NOT NULL, CONSTRAINT "PurchaseRejection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PurchaseRejection_tenantId_id_key" ON "PurchaseRejection"("tenantId", "id");
CREATE UNIQUE INDEX "PurchaseRejection_purchaseId_lineNo_key" ON "PurchaseRejection"("purchaseId", "lineNo");
ALTER TABLE "PurchaseRejection" ADD CONSTRAINT "PurchaseRejection_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "Purchase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRejection" ADD CONSTRAINT "PurchaseRejection_tenantId_medicineId_fkey" FOREIGN KEY ("tenantId", "medicineId") REFERENCES "Medicine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SupplierDebitNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenantId" UUID NOT NULL, "facilityId" UUID NOT NULL, "noteNumber" TEXT NOT NULL, "purchaseId" UUID NOT NULL, "supplierId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL, "reason" TEXT NOT NULL, "status" "DebitNoteStatus" NOT NULL DEFAULT 'RAISED', "createdById" UUID NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditedById" UUID, "creditedAt" TIMESTAMPTZ(3), "creditReference" TEXT, CONSTRAINT "SupplierDebitNote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupplierDebitNote_tenantId_id_key" ON "SupplierDebitNote"("tenantId", "id");
CREATE UNIQUE INDEX "SupplierDebitNote_tenantId_facilityId_noteNumber_key" ON "SupplierDebitNote"("tenantId", "facilityId", "noteNumber");
CREATE INDEX "SupplierDebitNote_tenantId_purchaseId_idx" ON "SupplierDebitNote"("tenantId", "purchaseId");
ALTER TABLE "SupplierDebitNote" ADD CONSTRAINT "SupplierDebitNote_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierDebitNote" ADD CONSTRAINT "SupplierDebitNote_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "Purchase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierDebitNote" ADD CONSTRAINT "SupplierDebitNote_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SupplierPayment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenantId" UUID NOT NULL, "facilityId" UUID NOT NULL, "purchaseId" UUID NOT NULL, "amount" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL, "reference" TEXT, "paidOn" DATE NOT NULL, "paidById" UUID NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupplierPayment_tenantId_id_key" ON "SupplierPayment"("tenantId", "id");
CREATE INDEX "SupplierPayment_tenantId_purchaseId_idx" ON "SupplierPayment"("tenantId", "purchaseId");
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "Purchase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StockCount" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenantId" UUID NOT NULL, "facilityId" UUID NOT NULL, "countNumber" TEXT NOT NULL, "locationId" UUID,
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN', "note" TEXT, "startedById" UUID NOT NULL, "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMPTZ(3), "decidedById" UUID, "decidedAt" TIMESTAMPTZ(3), "decisionNote" TEXT, CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockCount_tenantId_id_key" ON "StockCount"("tenantId", "id");
CREATE UNIQUE INDEX "StockCount_tenantId_facilityId_countNumber_key" ON "StockCount"("tenantId", "facilityId", "countNumber");
CREATE INDEX "StockCount_tenantId_facilityId_status_startedAt_idx" ON "StockCount"("tenantId", "facilityId", "status", "startedAt" DESC);
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StockCountItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenantId" UUID NOT NULL, "countId" UUID NOT NULL, "batchId" UUID NOT NULL, "medicineId" UUID NOT NULL,
    "systemQuantity" INTEGER NOT NULL, "countedQuantity" INTEGER, "reason" TEXT, CONSTRAINT "StockCountItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockCountItem_tenantId_id_key" ON "StockCountItem"("tenantId", "id");
CREATE UNIQUE INDEX "StockCountItem_countId_batchId_key" ON "StockCountItem"("countId", "batchId");
ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_tenantId_countId_fkey" FOREIGN KEY ("tenantId", "countId") REFERENCES "StockCount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "MedicineBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrder" ADD COLUMN "secondApprovedById" UUID, ADD COLUMN "secondApprovedAt" TIMESTAMPTZ(3);
ALTER TABLE "StockConsumption" ADD COLUMN "chargeId" UUID;
ALTER TABLE "StockLocationLedger" ADD COLUMN "countId" UUID;
ALTER TABLE "StockLocationLedger" DROP CONSTRAINT stock_location_ledger_cause;
ALTER TABLE "StockLocationLedger" ADD CONSTRAINT stock_location_ledger_cause CHECK ((("transferId" IS NOT NULL)::int + ("issueId" IS NOT NULL)::int + ("consumptionId" IS NOT NULL)::int + ("countId" IS NOT NULL)::int) = 1);

-- ===== Hand-written invariants =====
-- Order approvals: neither the maker nor the first approver is the second approver.
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT purchase_order_values;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT purchase_order_values CHECK (
  subtotal >= 0 AND "taxTotal" >= 0 AND total = subtotal + "taxTotal" AND (notes IS NULL OR length(notes) <= 500)
  AND (status NOT IN ('ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED') OR ("issuedById" IS NOT NULL AND "issuedAt" IS NOT NULL))
  AND (status NOT IN ('CANCELLED', 'CLOSED') OR ("closedById" IS NOT NULL AND "closedAt" IS NOT NULL AND "closeReason" IS NOT NULL AND length(btrim("closeReason")) >= 5))
  AND ("approvedById" IS NULL OR "approvedById" <> "createdById")
  AND ("secondApprovedById" IS NULL OR ("approvedById" IS NOT NULL AND "secondApprovedById" <> "createdById" AND "secondApprovedById" <> "approvedById")));

-- The approvals of an order are set once, while it is a draft or being issued, and never changed.
CREATE OR REPLACE FUNCTION medos_purchase_order_approval_guard() RETURNS trigger AS $$
BEGIN
  IF (OLD."approvedById" IS NOT NULL AND NEW."approvedById" IS DISTINCT FROM OLD."approvedById") OR (OLD."secondApprovedById" IS NOT NULL AND NEW."secondApprovedById" IS DISTINCT FROM OLD."secondApprovedById") THEN
    RAISE EXCEPTION 'The approvals of a purchase order cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_order_approval_guard BEFORE UPDATE ON "PurchaseOrder" FOR EACH ROW EXECUTE FUNCTION medos_purchase_order_approval_guard();

ALTER TABLE "StockRequestItem" ADD CONSTRAINT stock_request_item_values CHECK (quantity > 0 AND quantity <= 1000000 AND "issuedQuantity" >= 0 AND "issuedQuantity" <= quantity);
ALTER TABLE "StockRequest" ADD CONSTRAINT stock_request_values CHECK (
  (note IS NULL OR length(note) <= 500)
  AND (status NOT IN ('REJECTED', 'CANCELLED') OR ("closedById" IS NOT NULL AND "closedAt" IS NOT NULL AND "closeReason" IS NOT NULL AND length(btrim("closeReason")) >= 5)));
-- A request moves REQUESTED -> PARTIALLY_ISSUED -> ISSUED; REQUESTED or PARTIALLY_ISSUED -> CANCELLED (PARTIALLY: only what was not issued is dropped); REQUESTED -> REJECTED. Never deleted.
CREATE OR REPLACE FUNCTION medos_stock_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A stock request cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."requestNumber" <> OLD."requestNumber" OR NEW."locationId" <> OLD."locationId" OR NEW."requestedById" <> OLD."requestedById" THEN
    RAISE EXCEPTION 'The identity of a stock request cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'REQUESTED' AND NEW.status IN ('PARTIALLY_ISSUED', 'ISSUED', 'REJECTED', 'CANCELLED')) OR (OLD.status = 'PARTIALLY_ISSUED' AND NEW.status IN ('ISSUED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'A stock request cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_request_guard BEFORE UPDATE OR DELETE ON "StockRequest" FOR EACH ROW EXECUTE FUNCTION medos_stock_request_guard();
CREATE OR REPLACE FUNCTION medos_stock_request_item_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'The lines of a stock request cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF (to_jsonb(NEW) - 'issuedQuantity') IS DISTINCT FROM (to_jsonb(OLD) - 'issuedQuantity') OR NEW."issuedQuantity" < OLD."issuedQuantity" THEN
    RAISE EXCEPTION 'The lines of a stock request cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_request_item_guard BEFORE UPDATE OR DELETE ON "StockRequestItem" FOR EACH ROW EXECUTE FUNCTION medos_stock_request_item_guard();

ALTER TABLE "PurchaseRejection" ADD CONSTRAINT purchase_rejection_values CHECK (quantity > 0 AND quantity <= 1000000 AND "unitPrice" >= 0 AND "gstPercent" BETWEEN 0 AND 100 AND length(btrim(reason)) >= 5);
CREATE TRIGGER purchase_rejection_immutable BEFORE UPDATE OR DELETE ON "PurchaseRejection" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "SupplierDebitNote" ADD CONSTRAINT supplier_debit_note_values CHECK (
  amount > 0 AND length(btrim(reason)) >= 5
  AND (status = 'RAISED' OR ("creditedById" IS NOT NULL AND "creditedAt" IS NOT NULL AND "creditReference" IS NOT NULL AND length(btrim("creditReference")) >= 3)));
-- A debit note is credited once (RAISED -> CREDITED, with who, when and the supplier's reference); nothing else about it changes, and it is never deleted.
CREATE OR REPLACE FUNCTION medos_supplier_debit_note_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A debit note cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD.status = 'CREDITED' THEN RAISE EXCEPTION 'A credited debit note cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'creditedById', 'creditedAt', 'creditReference']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'creditedById', 'creditedAt', 'creditReference']) THEN
    RAISE EXCEPTION 'A debit note cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER supplier_debit_note_guard BEFORE UPDATE OR DELETE ON "SupplierDebitNote" FOR EACH ROW EXECUTE FUNCTION medos_supplier_debit_note_guard();

ALTER TABLE "SupplierPayment" ADD CONSTRAINT supplier_payment_values CHECK (amount > 0 AND (method = 'CASH' OR (reference IS NOT NULL AND length(btrim(reference)) >= 4)));
CREATE TRIGGER supplier_payment_immutable BEFORE UPDATE OR DELETE ON "SupplierPayment" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
-- A supplier is never paid more than their invoice leaves owing: the payments on a purchase never add up to more than its total.
CREATE OR REPLACE FUNCTION medos_supplier_payment_total() RETURNS trigger AS $$
DECLARE p numeric; paid numeric;
BEGIN
  SELECT total INTO p FROM "Purchase" WHERE id = NEW."purchaseId" AND "tenantId" = NEW."tenantId" FOR SHARE;
  SELECT COALESCE(SUM(amount), 0) INTO paid FROM "SupplierPayment" WHERE "purchaseId" = NEW."purchaseId" AND "tenantId" = NEW."tenantId";
  IF p IS NULL OR paid + NEW.amount > p THEN RAISE EXCEPTION 'The payments to a supplier cannot add up to more than the invoice' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER supplier_payment_total BEFORE INSERT ON "SupplierPayment" FOR EACH ROW EXECUTE FUNCTION medos_supplier_payment_total();

ALTER TABLE "StockCount" ADD CONSTRAINT stock_count_values CHECK (
  (note IS NULL OR length(note) <= 500)
  AND (status NOT IN ('SUBMITTED', 'APPROVED') OR "submittedAt" IS NOT NULL)
  AND (status <> 'APPROVED' OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL))
  AND (status <> 'CANCELLED' OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decisionNote" IS NOT NULL AND length(btrim("decisionNote")) >= 5))
  -- Whoever counted cannot approve the count.
  AND ("decidedById" IS NULL OR status = 'CANCELLED' OR "decidedById" <> "startedById"));
-- A count moves OPEN -> SUBMITTED -> APPROVED; OPEN or SUBMITTED -> CANCELLED. Never deleted.
CREATE OR REPLACE FUNCTION medos_stock_count_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A stock count cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."countNumber" <> OLD."countNumber" OR NEW."locationId" IS DISTINCT FROM OLD."locationId" OR NEW."startedById" <> OLD."startedById" THEN
    RAISE EXCEPTION 'The identity of a stock count cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'OPEN' AND NEW.status IN ('SUBMITTED', 'CANCELLED')) OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('APPROVED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'A stock count cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_count_guard BEFORE UPDATE OR DELETE ON "StockCount" FOR EACH ROW EXECUTE FUNCTION medos_stock_count_guard();
-- What was counted is entered while the count is open; the system quantity at the start never changes.
CREATE OR REPLACE FUNCTION medos_stock_count_item_guard() RETURNS trigger AS $$
DECLARE s text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'The lines of a stock count cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT status::text INTO s FROM "StockCount" WHERE id = NEW."countId" AND "tenantId" = NEW."tenantId";
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - ARRAY['countedQuantity', 'reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['countedQuantity', 'reason']) THEN RAISE EXCEPTION 'The system quantity of a count line cannot change' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF s IS DISTINCT FROM 'OPEN' THEN RAISE EXCEPTION 'The counts can only be entered while the count is open' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."countedQuantity" IS NOT NULL AND NEW."countedQuantity" < 0 THEN RAISE EXCEPTION 'A counted quantity cannot be negative' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_count_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "StockCountItem" FOR EACH ROW EXECUTE FUNCTION medos_stock_count_item_guard();

SELECT medos_enable_tenant_rls('"StockRequest"');
SELECT medos_enable_tenant_rls('"StockRequestItem"');
SELECT medos_enable_tenant_rls('"PurchaseRejection"');
SELECT medos_enable_tenant_rls('"SupplierDebitNote"');
SELECT medos_enable_tenant_rls('"SupplierPayment"');
SELECT medos_enable_tenant_rls('"StockCount"');
SELECT medos_enable_tenant_rls('"StockCountItem"');

-- ===== who may do what =====
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('MANAGER', 'SUPPLIER_PAY'), ('MANAGER', 'STOCK_COUNT_APPROVE'), ('ADMINISTRATOR', 'SUPPLIER_PAY'), ('ADMINISTRATOR', 'STOCK_COUNT_APPROVE'), ('ADMINISTRATOR', 'STOCK_COUNT'),
  ('PHARMACIST', 'STOCK_COUNT'), ('NURSE', 'STOCK_COUNT'), ('OT_COORDINATOR', 'STOCK_COUNT')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration procurement_completion', 'added', jsonb_build_object(
  'MANAGER', jsonb_build_array('SUPPLIER_PAY', 'STOCK_COUNT_APPROVE'), 'ADMINISTRATOR', jsonb_build_array('SUPPLIER_PAY', 'STOCK_COUNT_APPROVE', 'STOCK_COUNT'),
  'PHARMACIST', jsonb_build_array('STOCK_COUNT'), 'NURSE', jsonb_build_array('STOCK_COUNT'), 'OT_COORDINATOR', jsonb_build_array('STOCK_COUNT')))
FROM "Tenant" t;
