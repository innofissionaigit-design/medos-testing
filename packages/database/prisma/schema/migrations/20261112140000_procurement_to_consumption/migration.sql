-- Procurement to consumption (docs/procurement.md): purchase indents with approval, purchase orders, goods receipt against an order with a quantity and quality check,
-- and stock consumption (OT and department use) with the cost posted.

CREATE TYPE "IndentStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'ORDERED', 'CANCELLED');
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'CLOSED');
CREATE TYPE "ConsumptionKind" AS ENUM ('PROCEDURE', 'DEPARTMENT_USE');

CREATE TABLE "PurchaseIndent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "indentNumber" TEXT NOT NULL,
    "status" "IndentStatus" NOT NULL DEFAULT 'DRAFT',
    "forLocationId" UUID,
    "note" TEXT,
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "cancelledById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    CONSTRAINT "PurchaseIndent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PurchaseIndent_tenantId_id_key" ON "PurchaseIndent"("tenantId", "id");
CREATE UNIQUE INDEX "PurchaseIndent_tenantId_facilityId_indentNumber_key" ON "PurchaseIndent"("tenantId", "facilityId", "indentNumber");
CREATE INDEX "PurchaseIndent_tenantId_facilityId_status_requestedAt_idx" ON "PurchaseIndent"("tenantId", "facilityId", "status", "requestedAt" DESC);
ALTER TABLE "PurchaseIndent" ADD CONSTRAINT "PurchaseIndent_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseIndent" ADD CONSTRAINT "PurchaseIndent_tenantId_forLocationId_fkey" FOREIGN KEY ("tenantId", "forLocationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PurchaseIndentItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "indentId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "medicineId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "orderedQuantity" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    CONSTRAINT "PurchaseIndentItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PurchaseIndentItem_tenantId_id_key" ON "PurchaseIndentItem"("tenantId", "id");
CREATE UNIQUE INDEX "PurchaseIndentItem_indentId_lineNo_key" ON "PurchaseIndentItem"("indentId", "lineNo");
ALTER TABLE "PurchaseIndentItem" ADD CONSTRAINT "PurchaseIndentItem_tenantId_indentId_fkey" FOREIGN KEY ("tenantId", "indentId") REFERENCES "PurchaseIndent"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseIndentItem" ADD CONSTRAINT "PurchaseIndentItem_tenantId_medicineId_fkey" FOREIGN KEY ("tenantId", "medicineId") REFERENCES "Medicine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "poNumber" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "indentId" UUID,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "expectedOn" DATE,
    "notes" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "taxTotal" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "issuedById" UUID,
    "issuedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "closeReason" TEXT,
    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_id_key" ON "PurchaseOrder"("tenantId", "id");
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_facilityId_poNumber_key" ON "PurchaseOrder"("tenantId", "facilityId", "poNumber");
CREATE INDEX "PurchaseOrder_tenantId_facilityId_status_createdAt_idx" ON "PurchaseOrder"("tenantId", "facilityId", "status", "createdAt" DESC);
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_indentId_fkey" FOREIGN KEY ("tenantId", "indentId") REFERENCES "PurchaseIndent"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PurchaseOrderItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "medicineId" UUID NOT NULL,
    "indentItemId" UUID,
    "quantity" INTEGER NOT NULL,
    "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
    "rate" DECIMAL(12,2) NOT NULL,
    "gstPercent" DECIMAL(5,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PurchaseOrderItem_tenantId_id_key" ON "PurchaseOrderItem"("tenantId", "id");
CREATE UNIQUE INDEX "PurchaseOrderItem_orderId_lineNo_key" ON "PurchaseOrderItem"("orderId", "lineNo");
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "PurchaseOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_tenantId_medicineId_fkey" FOREIGN KEY ("tenantId", "medicineId") REFERENCES "Medicine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_tenantId_indentItemId_fkey" FOREIGN KEY ("tenantId", "indentItemId") REFERENCES "PurchaseIndentItem"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Purchase" ADD COLUMN "purchaseOrderId" UUID;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseItem" ADD COLUMN "poItemId" UUID, ADD COLUMN "rejectedQuantity" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "rejectReason" TEXT;
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_tenantId_poItemId_fkey" FOREIGN KEY ("tenantId", "poItemId") REFERENCES "PurchaseOrderItem"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StockConsumption" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "medicineId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "kind" "ConsumptionKind" NOT NULL,
    "procedureId" UUID,
    "reason" TEXT,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "totalCost" DECIMAL(14,2) NOT NULL,
    "consumedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockConsumption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockConsumption_tenantId_id_key" ON "StockConsumption"("tenantId", "id");
CREATE INDEX "StockConsumption_tenantId_facilityId_createdAt_idx" ON "StockConsumption"("tenantId", "facilityId", "createdAt" DESC);
CREATE INDEX "StockConsumption_tenantId_procedureId_idx" ON "StockConsumption"("tenantId", "procedureId");
ALTER TABLE "StockConsumption" ADD CONSTRAINT "StockConsumption_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockConsumption" ADD CONSTRAINT "StockConsumption_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "MedicineBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockConsumption" ADD CONSTRAINT "StockConsumption_tenantId_procedureId_fkey" FOREIGN KEY ("tenantId", "procedureId") REFERENCES "Procedure"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockLocationLedger" ADD COLUMN "consumptionId" UUID;
ALTER TABLE "StockLocationLedger" DROP CONSTRAINT stock_location_ledger_cause;
ALTER TABLE "StockLocationLedger" ADD CONSTRAINT stock_location_ledger_cause CHECK ((("transferId" IS NOT NULL)::int + ("issueId" IS NOT NULL)::int + ("consumptionId" IS NOT NULL)::int) = 1);

-- ===== Hand-written invariants =====
ALTER TABLE "PurchaseIndentItem" ADD CONSTRAINT purchase_indent_item_values CHECK (quantity > 0 AND quantity <= 1000000 AND "orderedQuantity" >= 0 AND "orderedQuantity" <= quantity AND (note IS NULL OR length(note) <= 200));
ALTER TABLE "PurchaseIndent" ADD CONSTRAINT purchase_indent_values CHECK (
  (note IS NULL OR length(note) <= 500)
  AND (status NOT IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'ORDERED') OR "submittedAt" IS NOT NULL)
  AND (status NOT IN ('APPROVED', 'REJECTED', 'ORDERED') OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL))
  AND (status <> 'REJECTED' OR ("decisionNote" IS NOT NULL AND length(btrim("decisionNote")) >= 5))
  AND (status <> 'CANCELLED' OR ("cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL AND "cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 5))
  -- Whoever asks cannot be the one who approves.
  AND ("decidedById" IS NULL OR "decidedById" <> "requestedById"));

-- An indent moves DRAFT -> SUBMITTED -> APPROVED or REJECTED; APPROVED -> ORDERED once every line is on an order; DRAFT, SUBMITTED or APPROVED -> CANCELLED. It is never deleted, and
-- its requester and number never change. Its lines are edited only while it is a draft; afterwards only the ordered quantity of a line moves, and never back past zero.
CREATE OR REPLACE FUNCTION medos_purchase_indent_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A purchase indent cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."indentNumber" <> OLD."indentNumber" OR NEW."requestedById" <> OLD."requestedById" THEN
    RAISE EXCEPTION 'The identity of a purchase indent cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('SUBMITTED', 'CANCELLED')) OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED'))
       OR (OLD.status = 'APPROVED' AND NEW.status IN ('ORDERED', 'CANCELLED')) OR (OLD.status = 'ORDERED' AND NEW.status = 'APPROVED')) THEN
    RAISE EXCEPTION 'A purchase indent cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_indent_guard BEFORE UPDATE OR DELETE ON "PurchaseIndent" FOR EACH ROW EXECUTE FUNCTION medos_purchase_indent_guard();

CREATE OR REPLACE FUNCTION medos_purchase_indent_item_guard() RETURNS trigger AS $$
DECLARE s text;
BEGIN
  SELECT status::text INTO s FROM "PurchaseIndent" WHERE id = COALESCE(NEW."indentId", OLD."indentId") AND "tenantId" = COALESCE(NEW."tenantId", OLD."tenantId");
  IF TG_OP IN ('INSERT', 'DELETE') THEN
    IF s IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'The lines of an indent can only be changed while it is a draft' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF (to_jsonb(NEW) - 'orderedQuantity') IS DISTINCT FROM (to_jsonb(OLD) - 'orderedQuantity') THEN
    RAISE EXCEPTION 'The lines of an indent can only be changed while it is a draft' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_indent_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseIndentItem" FOR EACH ROW EXECUTE FUNCTION medos_purchase_indent_item_guard();

ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT purchase_order_item_values CHECK (quantity > 0 AND quantity <= 1000000 AND "receivedQuantity" >= 0 AND "receivedQuantity" <= quantity AND rate >= 0 AND "gstPercent" BETWEEN 0 AND 100 AND "lineTotal" >= 0);
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT purchase_order_values CHECK (
  subtotal >= 0 AND "taxTotal" >= 0 AND total = subtotal + "taxTotal" AND (notes IS NULL OR length(notes) <= 500)
  AND (status NOT IN ('ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED') OR ("issuedById" IS NOT NULL AND "issuedAt" IS NOT NULL))
  AND (status NOT IN ('CANCELLED', 'CLOSED') OR ("closedById" IS NOT NULL AND "closedAt" IS NOT NULL AND "closeReason" IS NOT NULL AND length(btrim("closeReason")) >= 5))
  -- An order that needed approval is approved by someone other than the person who made it.
  AND ("approvedById" IS NULL OR "approvedById" <> "createdById"));

-- An order moves DRAFT -> ISSUED -> PARTIALLY_RECEIVED -> RECEIVED; DRAFT or ISSUED -> CANCELLED (nothing received); ISSUED or PARTIALLY_RECEIVED -> CLOSED (short-closed). It is never
-- deleted, and its supplier, number and totals never change. Its lines are edited only while it is a draft; afterwards only what has been received moves, and only upwards.
CREATE OR REPLACE FUNCTION medos_purchase_order_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A purchase order cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."poNumber" <> OLD."poNumber" OR NEW."supplierId" <> OLD."supplierId" OR NEW."createdById" <> OLD."createdById"
     OR (OLD.status <> 'DRAFT' AND (NEW.subtotal <> OLD.subtotal OR NEW."taxTotal" <> OLD."taxTotal" OR NEW.total <> OLD.total)) THEN
    RAISE EXCEPTION 'An issued purchase order cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('ISSUED', 'CANCELLED')) OR (OLD.status = 'ISSUED' AND NEW.status IN ('PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'CLOSED'))
       OR (OLD.status = 'PARTIALLY_RECEIVED' AND NEW.status IN ('RECEIVED', 'CLOSED'))) THEN
    RAISE EXCEPTION 'A purchase order cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_order_guard BEFORE UPDATE OR DELETE ON "PurchaseOrder" FOR EACH ROW EXECUTE FUNCTION medos_purchase_order_guard();

CREATE OR REPLACE FUNCTION medos_purchase_order_item_guard() RETURNS trigger AS $$
DECLARE s text;
BEGIN
  SELECT status::text INTO s FROM "PurchaseOrder" WHERE id = COALESCE(NEW."orderId", OLD."orderId") AND "tenantId" = COALESCE(NEW."tenantId", OLD."tenantId");
  IF TG_OP IN ('INSERT', 'DELETE') THEN
    IF s IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'The lines of an order can only be changed while it is a draft' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF (to_jsonb(NEW) - 'receivedQuantity') IS DISTINCT FROM (to_jsonb(OLD) - 'receivedQuantity') OR NEW."receivedQuantity" < OLD."receivedQuantity" THEN
    RAISE EXCEPTION 'The lines of an order can only be changed while it is a draft' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_order_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseOrderItem" FOR EACH ROW EXECUTE FUNCTION medos_purchase_order_item_guard();

-- The quality check: a rejection needs its reason; a delivery against an order needs the order line.
ALTER TABLE "PurchaseItem" ADD CONSTRAINT purchase_item_quality CHECK ("rejectedQuantity" >= 0 AND ("rejectedQuantity" = 0 OR ("rejectReason" IS NOT NULL AND length(btrim("rejectReason")) >= 5)));

ALTER TABLE "StockConsumption" ADD CONSTRAINT stock_consumption_values CHECK (
  quantity > 0 AND "unitCost" >= 0 AND "totalCost" >= 0
  AND (kind <> 'PROCEDURE' OR "procedureId" IS NOT NULL) AND (kind <> 'DEPARTMENT_USE' OR ("procedureId" IS NULL AND reason IS NOT NULL AND length(btrim(reason)) >= 5)));
CREATE TRIGGER stock_consumption_immutable BEFORE UPDATE OR DELETE ON "StockConsumption" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

SELECT medos_enable_tenant_rls('"PurchaseIndent"');
SELECT medos_enable_tenant_rls('"PurchaseIndentItem"');
SELECT medos_enable_tenant_rls('"PurchaseOrder"');
SELECT medos_enable_tenant_rls('"PurchaseOrderItem"');
SELECT medos_enable_tenant_rls('"StockConsumption"');

-- ===== who may do what: the new Procurement role, and the new permissions for existing roles =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, 'PROCUREMENT', true FROM "Tenant" t ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('PROCUREMENT', 'PURCHASE_ORDER'), ('PROCUREMENT', 'PURCHASE_READ'), ('PROCUREMENT', 'STORES_INDENT'), ('PROCUREMENT', 'PHARMACY_READ'), ('PROCUREMENT', 'PHARMACY_PURCHASE'), ('PROCUREMENT', 'REPORT_PHARMACY'),
  ('PHARMACIST', 'STORES_INDENT'), ('PHARMACIST', 'PURCHASE_READ'), ('PHARMACIST', 'STOCK_CONSUME'),
  ('NURSE', 'STORES_INDENT'), ('OT_COORDINATOR', 'STORES_INDENT'), ('OT_COORDINATOR', 'STOCK_CONSUME'), ('OT_COORDINATOR', 'PHARMACY_READ'),
  ('MANAGER', 'PURCHASE_APPROVE'), ('MANAGER', 'PURCHASE_READ'),
  ('ADMINISTRATOR', 'PURCHASE_APPROVE'), ('ADMINISTRATOR', 'PURCHASE_ORDER'), ('ADMINISTRATOR', 'PURCHASE_READ'), ('ADMINISTRATOR', 'STORES_INDENT')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration procurement_to_consumption', 'added', jsonb_build_object(
  'PROCUREMENT', jsonb_build_array('PURCHASE_ORDER', 'PURCHASE_READ', 'STORES_INDENT', 'PHARMACY_READ', 'PHARMACY_PURCHASE', 'REPORT_PHARMACY'),
  'PHARMACIST', jsonb_build_array('STORES_INDENT', 'PURCHASE_READ', 'STOCK_CONSUME'), 'NURSE', jsonb_build_array('STORES_INDENT'),
  'OT_COORDINATOR', jsonb_build_array('STORES_INDENT', 'STOCK_CONSUME', 'PHARMACY_READ'), 'MANAGER', jsonb_build_array('PURCHASE_APPROVE', 'PURCHASE_READ'),
  'ADMINISTRATOR', jsonb_build_array('PURCHASE_APPROVE', 'PURCHASE_ORDER', 'PURCHASE_READ', 'STORES_INDENT')))
FROM "Tenant" t;
