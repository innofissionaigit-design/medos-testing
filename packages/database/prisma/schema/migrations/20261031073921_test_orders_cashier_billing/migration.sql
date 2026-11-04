-- CreateEnum
CREATE TYPE "TestCategory" AS ENUM ('LABORATORY', 'RADIOLOGY', 'CARDIOLOGY', 'PROCEDURE');

-- CreateEnum
CREATE TYPE "TestOrderStatus" AS ENUM ('ORDERED', 'BILLED', 'CANCELLED');

-- CreateTable
CREATE TABLE "TestOrder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "category" "TestCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "serviceId" UUID,
    "source" TEXT NOT NULL DEFAULT 'DIGITAL',
    "scanId" UUID,
    "status" "TestOrderStatus" NOT NULL DEFAULT 'ORDERED',
    "invoiceId" UUID,
    "consultationVersion" INTEGER,
    "cancelReason" TEXT,
    "orderedById" UUID NOT NULL,
    "billedById" UUID,
    "billedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TestOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanTestReview" (
    "scanId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "reviewedById" UUID NOT NULL,
    "reviewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanTestReview_pkey" PRIMARY KEY ("scanId")
);

-- CreateIndex
CREATE INDEX "TestOrder_tenantId_facilityId_status_createdAt_idx" ON "TestOrder"("tenantId", "facilityId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TestOrder_tenantId_encounterId_idx" ON "TestOrder"("tenantId", "encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "TestOrder_tenantId_id_key" ON "TestOrder"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ScanTestReview_tenantId_facilityId_reviewedAt_idx" ON "ScanTestReview"("tenantId", "facilityId", "reviewedAt");

-- AddForeignKey
ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Tests the doctor advised (docs/test-orders.md): digital orders are written once per visit, billed or cancelled orders never change, nothing is deleted.
ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_source_check" CHECK (source IN ('DIGITAL', 'HANDWRITTEN'));
ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_name_check" CHECK (length(btrim(name)) BETWEEN 2 AND 120);
ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_state_check" CHECK (
  status = 'ORDERED'
  OR (status = 'BILLED' AND "invoiceId" IS NOT NULL AND "billedAt" IS NOT NULL AND "billedById" IS NOT NULL)
  OR (status = 'CANCELLED' AND "cancelReason" IS NOT NULL));
CREATE UNIQUE INDEX "TestOrder_digital_once" ON "TestOrder" ("tenantId", "encounterId", category, lower(name)) WHERE status <> 'CANCELLED' AND source = 'DIGITAL';

CREATE OR REPLACE FUNCTION medos_test_order_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Test orders are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'ORDERED' THEN
    RAISE EXCEPTION 'A billed or cancelled test order cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."encounterId" <> OLD."encounterId"
     OR NEW.category <> OLD.category OR NEW.name <> OLD.name OR NEW.source <> OLD.source OR NEW."orderedById" <> OLD."orderedById" THEN
    RAISE EXCEPTION 'What was ordered cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER test_order_guard BEFORE UPDATE OR DELETE ON "TestOrder" FOR EACH ROW EXECUTE FUNCTION medos_test_order_guard();
SELECT medos_enable_tenant_rls('"TestOrder"');

ALTER TABLE "ScanTestReview" ADD CONSTRAINT "ScanTestReview_outcome_check" CHECK (outcome IN ('BILLED', 'NONE'));
CREATE TRIGGER scan_test_review_no_update BEFORE UPDATE ON "ScanTestReview" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER scan_test_review_no_delete BEFORE DELETE ON "ScanTestReview" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"ScanTestReview"');

-- The Cashier bills the tests the doctor advised.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'TEST_BILL' FROM "Role" r WHERE r."isSystem" AND r.name = 'CASHIER'
ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration test_orders', 'added', jsonb_build_object('CASHIER', jsonb_build_array('TEST_BILL')))
FROM "Tenant" t;

