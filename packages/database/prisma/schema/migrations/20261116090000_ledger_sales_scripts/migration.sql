-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalAccount" ADD VALUE 'COST_OF_GOODS_SOLD';
ALTER TYPE "JournalAccount" ADD VALUE 'STOCK_ADJUSTMENT';

-- CreateTable
CREATE TABLE "AftercareScript" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AftercareScript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AftercareScript_tenantId_id_key" ON "AftercareScript"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AftercareScript_tenantId_facilityId_kind_key" ON "AftercareScript"("tenantId", "facilityId", "kind");

-- AddForeignKey
ALTER TABLE "AftercareScript" ADD CONSTRAINT "AftercareScript_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== call scripts =====
ALTER TABLE "AftercareScript" ADD CONSTRAINT aftercare_script_values CHECK (kind IN ('FIRST_CALL', 'CALL_BACK', 'BOOKING', 'DECLINED', 'FEEDBACK') AND length(btrim(body)) BETWEEN 10 AND 1500);
SELECT medos_enable_tenant_rls('"AftercareScript"');

-- Who may change the call scripts: managers and administrators.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'AFTERCARE_CONFIGURE' FROM "Role" r WHERE r."isSystem" AND r.name IN ('MANAGER', 'ADMINISTRATOR') ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration ledger_sales_scripts', 'added', jsonb_build_object('MANAGER', jsonb_build_array('AFTERCARE_CONFIGURE'), 'ADMINISTRATOR', jsonb_build_array('AFTERCARE_CONFIGURE')))
FROM "Tenant" t;
