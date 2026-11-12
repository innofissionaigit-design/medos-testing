-- Discharge summary: the RMO verifies a signed summary (docs/discharge-stages.md); a new RMO role also prepares the draft.

-- CreateTable
CREATE TABLE "DischargeSummaryVerification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "verifiedById" UUID NOT NULL,
    "note" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DischargeSummaryVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DischargeSummaryVerification_tenantId_id_key" ON "DischargeSummaryVerification"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DischargeSummaryVerification_documentId_version_key" ON "DischargeSummaryVerification"("documentId", "version");

-- AddForeignKey
ALTER TABLE "DischargeSummaryVerification" ADD CONSTRAINT "DischargeSummaryVerification_tenantId_facilityId_admission_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DischargeSummaryVerification" ADD CONSTRAINT "DischargeSummaryVerification_tenantId_documentId_fkey" FOREIGN KEY ("tenantId", "documentId") REFERENCES "ClinicalDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- A verification is part of the record: it can never be changed or removed. An amended summary is a newer version and needs its own row.
ALTER TABLE "DischargeSummaryVerification" ADD CONSTRAINT summary_verification_version CHECK (version >= 1);
CREATE TRIGGER summary_verification_immutable BEFORE UPDATE OR DELETE ON "DischargeSummaryVerification" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"DischargeSummaryVerification"');

-- ===== who may do what: the new RMO role (prepares the draft, verifies the signed copy; never signs) =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, 'RMO', true FROM "Tenant" t ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('RMO', 'DATA_SCOPE_WARD'), ('RMO', 'PATIENT_READ'), ('RMO', 'ADMISSION_READ'), ('RMO', 'CONSULTATION_READ'), ('RMO', 'CONSULTATION_CREATE'), ('RMO', 'CONSULTATION_VERIFY'),
  ('RMO', 'VITALS_READ'), ('RMO', 'VITALS_CREATE'), ('RMO', 'PRESCRIPTION_READ'), ('RMO', 'NURSING_READ'), ('RMO', 'LAB_READ'), ('RMO', 'RAD_READ'), ('RMO', 'REPORT_IPD')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration discharge_summary_verification', 'added', jsonb_build_object(
  'RMO', jsonb_build_array('DATA_SCOPE_WARD', 'PATIENT_READ', 'ADMISSION_READ', 'CONSULTATION_READ', 'CONSULTATION_CREATE', 'CONSULTATION_VERIFY', 'VITALS_READ', 'VITALS_CREATE', 'PRESCRIPTION_READ', 'NURSING_READ', 'LAB_READ', 'RAD_READ', 'REPORT_IPD')))
FROM "Tenant" t;
