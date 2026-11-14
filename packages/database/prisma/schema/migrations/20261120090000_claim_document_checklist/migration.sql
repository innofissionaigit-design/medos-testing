-- Claim documents checklist (docs/claim-checklist.md): the documents each insurer requires, and a manager's waiver of one document on one claim.

-- CreateTable
CREATE TABLE "InsurerRequiredDocument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "insurerId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "claimType" "ClaimType",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "InsurerRequiredDocument_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ClaimDocumentWaiver" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "waivedById" UUID NOT NULL,
    "waivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaimDocumentWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InsurerRequiredDocument_tenantId_id_key" ON "InsurerRequiredDocument"("tenantId", "id");
CREATE INDEX "InsurerRequiredDocument_tenantId_insurerId_active_idx" ON "InsurerRequiredDocument"("tenantId", "insurerId", "active");
CREATE UNIQUE INDEX "ClaimDocumentWaiver_tenantId_id_key" ON "ClaimDocumentWaiver"("tenantId", "id");
CREATE INDEX "ClaimDocumentWaiver_tenantId_claimId_idx" ON "ClaimDocumentWaiver"("tenantId", "claimId");

-- AddForeignKey
ALTER TABLE "InsurerRequiredDocument" ADD CONSTRAINT "InsurerRequiredDocument_tenantId_insurerId_fkey" FOREIGN KEY ("tenantId", "insurerId") REFERENCES "Insurer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimDocumentWaiver" ADD CONSTRAINT "ClaimDocumentWaiver_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
ALTER TABLE "InsurerRequiredDocument" ADD CONSTRAINT required_document_label CHECK (length(btrim("label")) BETWEEN 2 AND 60);
-- One requirement per insurer, document name (any capitals) and claim type.
CREATE UNIQUE INDEX insurer_required_document_unique_any ON "InsurerRequiredDocument" ("tenantId", "insurerId", lower(btrim("label"))) WHERE "claimType" IS NULL;
CREATE UNIQUE INDEX insurer_required_document_unique_type ON "InsurerRequiredDocument" ("tenantId", "insurerId", lower(btrim("label")), "claimType") WHERE "claimType" IS NOT NULL;
ALTER TABLE "ClaimDocumentWaiver" ADD CONSTRAINT waiver_reason CHECK (length(btrim("reason")) >= 10), ADD CONSTRAINT waiver_label CHECK (length(btrim("label")) >= 2);
CREATE UNIQUE INDEX claim_document_waiver_unique ON "ClaimDocumentWaiver" ("tenantId", "claimId", lower(btrim("label")));
-- A waiver is part of the record: never changed or removed.
CREATE TRIGGER claim_document_waiver_immutable BEFORE UPDATE OR DELETE ON "ClaimDocumentWaiver" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
-- A requirement is switched off, not deleted; only its on/off state changes.
CREATE OR REPLACE FUNCTION medos_required_document_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A required document cannot be deleted, switch it off instead' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."label" <> OLD."label" OR NEW."claimType" IS DISTINCT FROM OLD."claimType" OR NEW."insurerId" <> OLD."insurerId" THEN
    RAISE EXCEPTION 'Only switching a required document on or off can be recorded' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER insurer_required_document_guard BEFORE UPDATE OR DELETE ON "InsurerRequiredDocument" FOR EACH ROW EXECUTE FUNCTION medos_required_document_guard();

SELECT medos_enable_tenant_rls('"InsurerRequiredDocument"');
SELECT medos_enable_tenant_rls('"ClaimDocumentWaiver"');

-- ===== who may do what: a manager (or the administrator) may waive a required document on one claim =====
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'CLAIM_DOCUMENT_WAIVE' FROM "Role" r WHERE r.name IN ('MANAGER', 'ADMINISTRATOR') AND r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration claim_document_checklist', 'added', jsonb_build_object(
  'MANAGER', jsonb_build_array('CLAIM_DOCUMENT_WAIVE'), 'ADMINISTRATOR', jsonb_build_array('CLAIM_DOCUMENT_WAIVE')))
FROM "Tenant" t;
