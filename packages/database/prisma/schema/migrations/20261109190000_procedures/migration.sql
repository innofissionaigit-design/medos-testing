-- Operation theatre and procedures (docs/procedures.md): a procedure planned for an admitted patient, the implants and consumables used in it, a new
-- discharge stage "OT / procedure", and a new OT_COORDINATOR role.

-- AlterEnum: the new discharge stage sits before the final bill.
ALTER TYPE "ClearanceStep" ADD VALUE IF NOT EXISTS 'OT_PROCEDURE' BEFORE 'BILLING';

-- CreateEnum
CREATE TYPE "ProcedureStatus" AS ENUM ('PLANNED', 'PERFORMED', 'FINALISED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProcedureItemKind" AS ENUM ('IMPLANT', 'CONSUMABLE');

-- CreateTable
CREATE TABLE "Procedure" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3),
    "surgeonId" UUID,
    "status" "ProcedureStatus" NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "plannedById" UUID NOT NULL,
    "plannedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedById" UUID,
    "performedAt" TIMESTAMPTZ(3),
    "finalisedById" UUID,
    "finalisedAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "chargeId" UUID,

    CONSTRAINT "Procedure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcedureItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "procedureId" UUID NOT NULL,
    "kind" "ProcedureItemKind" NOT NULL,
    "serviceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "serialNo" TEXT,
    "chargeId" UUID NOT NULL,
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMPTZ(3),
    "removedById" UUID,
    "removeReason" TEXT,

    CONSTRAINT "ProcedureItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Procedure_tenantId_id_key" ON "Procedure"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Procedure_tenantId_admissionId_status_idx" ON "Procedure"("tenantId", "admissionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProcedureItem_tenantId_id_key" ON "ProcedureItem"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ProcedureItem_tenantId_procedureId_idx" ON "ProcedureItem"("tenantId", "procedureId");

-- AddForeignKey
ALTER TABLE "Procedure" ADD CONSTRAINT "Procedure_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcedureItem" ADD CONSTRAINT "ProcedureItem_tenantId_procedureId_fkey" FOREIGN KEY ("tenantId", "procedureId") REFERENCES "Procedure"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Each state carries the facts that make it true.
ALTER TABLE "Procedure" ADD CONSTRAINT procedure_state_facts CHECK (
  (status = 'PLANNED' AND "performedAt" IS NULL AND "finalisedAt" IS NULL AND "cancelledAt" IS NULL)
  OR (status = 'PERFORMED' AND "performedAt" IS NOT NULL AND "performedById" IS NOT NULL AND "chargeId" IS NOT NULL AND "finalisedAt" IS NULL AND "cancelledAt" IS NULL)
  OR (status = 'FINALISED' AND "performedAt" IS NOT NULL AND "chargeId" IS NOT NULL AND "finalisedAt" IS NOT NULL AND "finalisedById" IS NOT NULL AND "cancelledAt" IS NULL)
  OR (status = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 3 AND "performedAt" IS NULL)
);
ALTER TABLE "ProcedureItem" ADD CONSTRAINT procedure_item_quantity CHECK (quantity BETWEEN 1 AND 999);
-- An implant is traced by its serial or lot number.
ALTER TABLE "ProcedureItem" ADD CONSTRAINT procedure_item_implant_serial CHECK (kind <> 'IMPLANT' OR ("serialNo" IS NOT NULL AND length(btrim("serialNo")) >= 2));
ALTER TABLE "ProcedureItem" ADD CONSTRAINT procedure_item_removed CHECK (
  ("removedAt" IS NULL AND "removedById" IS NULL AND "removeReason" IS NULL)
  OR ("removedAt" IS NOT NULL AND "removedById" IS NOT NULL AND "removeReason" IS NOT NULL AND length(btrim("removeReason")) >= 3));

-- A procedure moves one way: planned, performed, finalised (or planned, cancelled), and a finalised or cancelled one never changes again.
CREATE OR REPLACE FUNCTION medos_procedure_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."admissionId" <> OLD."admissionId" OR NEW."patientId" <> OLD."patientId"
     OR NEW."serviceId" <> OLD."serviceId" OR NEW."plannedById" <> OLD."plannedById" THEN
    RAISE EXCEPTION 'A procedure''s admission, patient and service cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('FINALISED', 'CANCELLED') THEN
    RAISE EXCEPTION 'A finalised or cancelled procedure cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'PLANNED' AND NEW.status IN ('PERFORMED', 'CANCELLED')) OR (OLD.status = 'PERFORMED' AND NEW.status = 'FINALISED')) THEN
    RAISE EXCEPTION 'A procedure cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER procedure_guard BEFORE UPDATE ON "Procedure" FOR EACH ROW EXECUTE FUNCTION medos_procedure_guard();
CREATE TRIGGER procedure_no_delete BEFORE DELETE ON "Procedure" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- Implants and consumables can only be recorded or removed while the procedure is planned or performed; after that the record is frozen.
-- Removing an item only fills in who removed it, when and why; nothing else about it changes.
CREATE OR REPLACE FUNCTION medos_procedure_item_guard() RETURNS trigger AS $$
DECLARE st "ProcedureStatus";
BEGIN
  SELECT status INTO st FROM "Procedure" WHERE "tenantId" = NEW."tenantId" AND id = NEW."procedureId";
  IF st IS NULL OR st NOT IN ('PLANNED', 'PERFORMED') THEN
    RAISE EXCEPTION 'Implants and consumables cannot be changed once the procedure is finalised or cancelled' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."removedAt" IS NOT NULL THEN RAISE EXCEPTION 'A removed item cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."procedureId" <> OLD."procedureId" OR NEW.kind <> OLD.kind OR NEW."serviceId" <> OLD."serviceId" OR NEW.name <> OLD.name
       OR NEW.quantity <> OLD.quantity OR NEW."serialNo" IS DISTINCT FROM OLD."serialNo" OR NEW."chargeId" <> OLD."chargeId" OR NEW."recordedById" <> OLD."recordedById" THEN
      RAISE EXCEPTION 'An item can only be removed, not edited' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER procedure_item_guard BEFORE INSERT OR UPDATE ON "ProcedureItem" FOR EACH ROW EXECUTE FUNCTION medos_procedure_item_guard();
CREATE TRIGGER procedure_item_no_delete BEFORE DELETE ON "ProcedureItem" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

SELECT medos_enable_tenant_rls('"Procedure"');
SELECT medos_enable_tenant_rls('"ProcedureItem"');

-- ===== who may do what: the OT_COORDINATOR role, and procedure permissions for the roles that need them =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, 'OT_COORDINATOR', true FROM "Tenant" t ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('OT_COORDINATOR', 'PROCEDURE_READ'), ('OT_COORDINATOR', 'PROCEDURE_PLAN'), ('OT_COORDINATOR', 'PROCEDURE_MANAGE'), ('OT_COORDINATOR', 'PATIENT_READ'), ('OT_COORDINATOR', 'ADMISSION_READ'),
  ('DOCTOR', 'PROCEDURE_READ'), ('DOCTOR', 'PROCEDURE_PLAN'),
  ('RMO', 'PROCEDURE_READ'), ('RMO', 'PROCEDURE_PLAN'),
  ('NURSE', 'PROCEDURE_READ')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration procedures', 'added', jsonb_build_object(
  'OT_COORDINATOR', jsonb_build_array('PROCEDURE_READ', 'PROCEDURE_PLAN', 'PROCEDURE_MANAGE', 'PATIENT_READ', 'ADMISSION_READ'),
  'DOCTOR', jsonb_build_array('PROCEDURE_READ', 'PROCEDURE_PLAN'), 'RMO', jsonb_build_array('PROCEDURE_READ', 'PROCEDURE_PLAN'), 'NURSE', jsonb_build_array('PROCEDURE_READ')))
FROM "Tenant" t;
