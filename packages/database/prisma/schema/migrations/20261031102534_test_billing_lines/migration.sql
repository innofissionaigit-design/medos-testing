-- CreateEnum
CREATE TYPE "BillingLineStatus" AS ENUM ('DRAFT', 'BILLED', 'DROPPED');

-- CreateTable
CREATE TABLE "TestBillingLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "testOrderId" UUID,
    "scanId" UUID,
    "name" TEXT NOT NULL,
    "category" "TestCategory" NOT NULL,
    "serviceId" UUID,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "taxPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "status" "BillingLineStatus" NOT NULL DEFAULT 'DRAFT',
    "invoiceId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TestBillingLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestBillingLine_tenantId_encounterId_status_idx" ON "TestBillingLine"("tenantId", "encounterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TestBillingLine_tenantId_id_key" ON "TestBillingLine"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "TestBillingLine" ADD CONSTRAINT "TestBillingLine_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestBillingLine" ADD CONSTRAINT "TestBillingLine_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- What the Cashier bills for a test is kept in its own lines; the doctor's test order is never edited (docs/test-orders.md).
-- A test the Cashier adds gets an order record when it is billed, marked as added by the Cashier.
ALTER TABLE "TestOrder" DROP CONSTRAINT "TestOrder_source_check";
ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_source_check" CHECK (source IN ('DIGITAL', 'HANDWRITTEN', 'CASHIER'));

ALTER TABLE "TestBillingLine" ADD CONSTRAINT "TestBillingLine_name_check" CHECK (length(btrim(name)) BETWEEN 2 AND 120);
ALTER TABLE "TestBillingLine" ADD CONSTRAINT "TestBillingLine_quantity_check" CHECK (quantity BETWEEN 1 AND 99);
ALTER TABLE "TestBillingLine" ADD CONSTRAINT "TestBillingLine_price_check" CHECK ("unitPrice" >= 0 AND (removed OR "unitPrice" > 0));
ALTER TABLE "TestBillingLine" ADD CONSTRAINT "TestBillingLine_tax_check" CHECK ("taxPercent" BETWEEN 0 AND 100);
ALTER TABLE "TestBillingLine" ADD CONSTRAINT "TestBillingLine_state_check" CHECK (status <> 'BILLED' OR ("invoiceId" IS NOT NULL AND NOT removed));
-- One line per doctor's order: the Cashier edits that line, never makes a second one.
CREATE UNIQUE INDEX "TestBillingLine_one_per_order" ON "TestBillingLine" ("tenantId", "testOrderId") WHERE "testOrderId" IS NOT NULL;

CREATE OR REPLACE FUNCTION medos_test_billing_line_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Billing lines are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'A billed or dropped billing line cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."encounterId" <> OLD."encounterId"
     OR NEW."createdById" <> OLD."createdById" OR NEW."scanId" IS DISTINCT FROM OLD."scanId"
     OR (OLD."testOrderId" IS NOT NULL AND NEW."testOrderId" IS DISTINCT FROM OLD."testOrderId") THEN
    RAISE EXCEPTION 'Who and what a billing line is for cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER test_billing_line_guard BEFORE UPDATE OR DELETE ON "TestBillingLine" FOR EACH ROW EXECUTE FUNCTION medos_test_billing_line_guard();
SELECT medos_enable_tenant_rls('"TestBillingLine"');

