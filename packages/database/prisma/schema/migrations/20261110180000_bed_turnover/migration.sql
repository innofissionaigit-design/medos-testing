-- Discharge: bed turnover (docs/discharge-stages.md). When a discharge vacates a bed, a turnover is opened; housekeeping starts cleaning and marks
-- the bed ready. Each time is set once, in order, and never changed or removed.

-- CreateTable
CREATE TABLE "BedTurnover" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "bedId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "vacatedAt" TIMESTAMPTZ(3) NOT NULL,
    "cleaningStartedAt" TIMESTAMPTZ(3),
    "cleaningStartedById" UUID,
    "readyAt" TIMESTAMPTZ(3),
    "readyById" UUID,
    "autoReady" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BedTurnover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BedTurnover_tenantId_id_key" ON "BedTurnover"("tenantId", "id");
CREATE UNIQUE INDEX "BedTurnover_admissionId_key" ON "BedTurnover"("admissionId");
CREATE UNIQUE INDEX "BedTurnover_tenantId_facilityId_admissionId_key" ON "BedTurnover"("tenantId", "facilityId", "admissionId");
CREATE INDEX "BedTurnover_tenantId_facilityId_readyAt_idx" ON "BedTurnover"("tenantId", "facilityId", "readyAt");
CREATE INDEX "BedTurnover_tenantId_bedId_idx" ON "BedTurnover"("tenantId", "bedId");

-- AddForeignKey
ALTER TABLE "BedTurnover" ADD CONSTRAINT "BedTurnover_tenantId_facilityId_bedId_fkey" FOREIGN KEY ("tenantId", "facilityId", "bedId") REFERENCES "Bed"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BedTurnover" ADD CONSTRAINT "BedTurnover_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Vacated -> cleaning -> ready, in that order, each with who did it (an automatic ready has nobody).
ALTER TABLE "BedTurnover" ADD CONSTRAINT bed_turnover_order CHECK (
  ("cleaningStartedAt" IS NULL OR "cleaningStartedAt" >= "vacatedAt")
  AND ("readyAt" IS NULL OR ("cleaningStartedAt" IS NOT NULL AND "readyAt" >= "cleaningStartedAt"))
  AND (("cleaningStartedAt" IS NULL) = ("cleaningStartedById" IS NULL) OR "autoReady")
  AND (("readyAt" IS NULL) = ("readyById" IS NULL) OR "autoReady")
);
-- Each step is set once: an update may only fill an empty step, never change or clear one, and nothing else changes. Never deleted.
CREATE OR REPLACE FUNCTION medos_bed_turnover_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A bed turnover cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."facilityId" IS DISTINCT FROM OLD."facilityId" OR NEW."bedId" IS DISTINCT FROM OLD."bedId"
     OR NEW."admissionId" IS DISTINCT FROM OLD."admissionId" OR NEW."vacatedAt" IS DISTINCT FROM OLD."vacatedAt" OR NEW."autoReady" IS DISTINCT FROM OLD."autoReady"
     OR (OLD."cleaningStartedAt" IS NOT NULL AND (NEW."cleaningStartedAt" IS DISTINCT FROM OLD."cleaningStartedAt" OR NEW."cleaningStartedById" IS DISTINCT FROM OLD."cleaningStartedById"))
     OR (OLD."readyAt" IS NOT NULL AND (NEW."readyAt" IS DISTINCT FROM OLD."readyAt" OR NEW."readyById" IS DISTINCT FROM OLD."readyById")) THEN
    RAISE EXCEPTION 'A bed turnover step, once recorded, cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bed_turnover_guard BEFORE UPDATE OR DELETE ON "BedTurnover" FOR EACH ROW EXECUTE FUNCTION medos_bed_turnover_guard();
SELECT medos_enable_tenant_rls('"BedTurnover"');

-- ===== who may do what: the new housekeeping role, and the nurse (who already marks beds clean) =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, 'HOUSEKEEPING', true FROM "Tenant" t ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES ('HOUSEKEEPING', 'BED_HOUSEKEEPING'), ('NURSE', 'BED_HOUSEKEEPING')) AS p(role, permission)
  ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration bed_turnover', 'added', jsonb_build_object(
  'HOUSEKEEPING', jsonb_build_array('BED_HOUSEKEEPING'), 'NURSE', jsonb_build_array('BED_HOUSEKEEPING')))
FROM "Tenant" t;
