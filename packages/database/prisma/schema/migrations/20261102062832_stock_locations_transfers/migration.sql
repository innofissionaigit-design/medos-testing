-- CreateTable
CREATE TABLE "StockLocation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLocationBalance" (
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "medicineId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLocationBalance_pkey" PRIMARY KEY ("locationId","batchId")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "transferNumber" TEXT NOT NULL,
    "fromLocationId" UUID,
    "toLocationId" UUID,
    "reason" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "medicineId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "StockTransferItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLocationLedger" (
    "seq" BIGSERIAL NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "medicineId" UUID NOT NULL,
    "direction" "StockDirection" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "transferId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLocationLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockLocation_tenantId_facilityId_status_idx" ON "StockLocation"("tenantId", "facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_tenantId_id_key" ON "StockLocation"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_tenantId_facilityId_code_key" ON "StockLocation"("tenantId", "facilityId", "code");

-- CreateIndex
CREATE INDEX "StockLocationBalance_tenantId_facilityId_medicineId_idx" ON "StockLocationBalance"("tenantId", "facilityId", "medicineId");

-- CreateIndex
CREATE INDEX "StockLocationBalance_tenantId_batchId_idx" ON "StockLocationBalance"("tenantId", "batchId");

-- CreateIndex
CREATE INDEX "StockTransfer_tenantId_facilityId_createdAt_idx" ON "StockTransfer"("tenantId", "facilityId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_tenantId_id_key" ON "StockTransfer"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_tenantId_facilityId_transferNumber_key" ON "StockTransfer"("tenantId", "facilityId", "transferNumber");

-- CreateIndex
CREATE INDEX "StockTransferItem_tenantId_batchId_idx" ON "StockTransferItem"("tenantId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransferItem_transferId_batchId_key" ON "StockTransferItem"("transferId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocationLedger_seq_key" ON "StockLocationLedger"("seq");

-- CreateIndex
CREATE INDEX "StockLocationLedger_tenantId_locationId_batchId_seq_idx" ON "StockLocationLedger"("tenantId", "locationId", "batchId", "seq");

-- CreateIndex
CREATE INDEX "StockLocationLedger_tenantId_transferId_idx" ON "StockLocationLedger"("tenantId", "transferId");

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocationBalance" ADD CONSTRAINT "StockLocationBalance_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocationBalance" ADD CONSTRAINT "StockLocationBalance_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "MedicineBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_tenantId_fromLocationId_fkey" FOREIGN KEY ("tenantId", "fromLocationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_tenantId_toLocationId_fkey" FOREIGN KEY ("tenantId", "toLocationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_tenantId_transferId_fkey" FOREIGN KEY ("tenantId", "transferId") REFERENCES "StockTransfer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "MedicineBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocationLedger" ADD CONSTRAINT "StockLocationLedger_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocationLedger" ADD CONSTRAINT "StockLocationLedger_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "MedicineBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Stock locations and transfers (docs/stock-transfers.md). Names are unique in a facility whatever the capitals; stock never goes below zero; transfers and
-- every location movement are never edited or deleted; everything must belong to one hospital and facility; a location's balance equals its ledger at commit.
CREATE UNIQUE INDEX stock_location_name_unique ON "StockLocation" ("tenantId", "facilityId", lower(btrim(name)));
ALTER TABLE "StockLocation" ADD CONSTRAINT stock_location_text CHECK (length(btrim(name)) BETWEEN 2 AND 60 AND code ~ '^[A-Z0-9-]{2,16}$');
CREATE TRIGGER stock_location_no_delete BEFORE DELETE ON "StockLocation" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "StockLocationBalance" ADD CONSTRAINT stock_location_balance_nonneg CHECK (quantity >= 0);
CREATE TRIGGER stock_location_balance_no_delete BEFORE DELETE ON "StockLocationBalance" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "StockLocationLedger" ADD CONSTRAINT stock_location_ledger_positive CHECK (quantity > 0 AND "balanceAfter" >= 0);
CREATE TRIGGER stock_location_ledger_immutable BEFORE UPDATE OR DELETE ON "StockLocationLedger" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER stock_location_ledger_no_truncate BEFORE TRUNCATE ON "StockLocationLedger" FOR EACH STATEMENT EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "StockTransfer" ADD CONSTRAINT stock_transfer_places CHECK (("fromLocationId" IS NOT NULL OR "toLocationId" IS NOT NULL) AND "fromLocationId" IS DISTINCT FROM "toLocationId");
ALTER TABLE "StockTransfer" ADD CONSTRAINT stock_transfer_reason CHECK (length(btrim(reason)) >= 3);
CREATE TRIGGER stock_transfer_immutable BEFORE UPDATE OR DELETE ON "StockTransfer" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
ALTER TABLE "StockTransferItem" ADD CONSTRAINT stock_transfer_item_quantity CHECK (quantity > 0);
CREATE TRIGGER stock_transfer_item_immutable BEFORE UPDATE OR DELETE ON "StockTransferItem" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- Both places of a transfer, and every batch moved, belong to the transfer's facility.
CREATE OR REPLACE FUNCTION medos_stock_transfer_scope() RETURNS trigger AS $$
BEGIN
  IF NEW."fromLocationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "StockLocation" l WHERE l.id = NEW."fromLocationId" AND l."tenantId" = NEW."tenantId" AND l."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'A transfer must start from a location of the same facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."toLocationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "StockLocation" l WHERE l.id = NEW."toLocationId" AND l."tenantId" = NEW."tenantId" AND l."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'A transfer must end at a location of the same facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_transfer_scope BEFORE INSERT ON "StockTransfer" FOR EACH ROW EXECUTE FUNCTION medos_stock_transfer_scope();

CREATE OR REPLACE FUNCTION medos_stock_transfer_item_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "StockTransfer" t JOIN "MedicineBatch" b ON b.id = NEW."batchId" AND b."tenantId" = t."tenantId" AND b."facilityId" = t."facilityId" AND b."medicineId" = NEW."medicineId" WHERE t.id = NEW."transferId" AND t."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION 'A transferred batch must belong to the facility of the transfer' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_transfer_item_scope BEFORE INSERT ON "StockTransferItem" FOR EACH ROW EXECUTE FUNCTION medos_stock_transfer_item_scope();

-- A location's balance and ledger rows name a location and a batch of their own facility.
CREATE OR REPLACE FUNCTION medos_stock_location_row_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "StockLocation" l JOIN "MedicineBatch" b ON b.id = NEW."batchId" AND b."tenantId" = l."tenantId" AND b."facilityId" = l."facilityId" AND b."medicineId" = NEW."medicineId"
                 WHERE l.id = NEW."locationId" AND l."tenantId" = NEW."tenantId" AND l."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'Location stock must name a location and a batch of the same facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_location_balance_scope BEFORE INSERT ON "StockLocationBalance" FOR EACH ROW EXECUTE FUNCTION medos_stock_location_row_scope();
CREATE TRIGGER stock_location_ledger_scope BEFORE INSERT ON "StockLocationLedger" FOR EACH ROW EXECUTE FUNCTION medos_stock_location_row_scope();

-- The balance of a batch in a location must equal its ledger at commit.
CREATE OR REPLACE FUNCTION medos_stock_location_reconciled() RETURNS trigger AS $$
DECLARE bal integer; led bigint;
BEGIN
  SELECT quantity INTO bal FROM "StockLocationBalance" WHERE "locationId" = NEW."locationId" AND "batchId" = NEW."batchId";
  SELECT COALESCE(SUM(CASE direction WHEN 'IN' THEN quantity ELSE -quantity END), 0) INTO led FROM "StockLocationLedger" WHERE "locationId" = NEW."locationId" AND "batchId" = NEW."batchId";
  IF bal IS DISTINCT FROM led THEN
    RAISE EXCEPTION 'Location stock % does not match the ledger % for batch %', bal, led, NEW."batchId" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER stock_location_ledger_reconciled AFTER INSERT ON "StockLocationLedger" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_stock_location_reconciled();
CREATE CONSTRAINT TRIGGER stock_location_balance_reconciled AFTER INSERT OR UPDATE ON "StockLocationBalance" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medos_stock_location_reconciled();

SELECT medos_enable_tenant_rls('"StockLocation"');
SELECT medos_enable_tenant_rls('"StockLocationBalance"');
SELECT medos_enable_tenant_rls('"StockTransfer"');
SELECT medos_enable_tenant_rls('"StockTransferItem"');
SELECT medos_enable_tenant_rls('"StockLocationLedger"');

