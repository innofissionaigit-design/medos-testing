-- Discharge: post-discharge (docs/discharge-stages.md). The Medical Records Department confirms the record of a discharged stay is complete;
-- claims and receivables are tracked from the claim and the final bill. One completion per admission, never changed or removed.

-- CreateTable
CREATE TABLE "MedicalRecordCompletion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "completedById" UUID NOT NULL,
    "note" TEXT,
    "completedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicalRecordCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MedicalRecordCompletion_tenantId_id_key" ON "MedicalRecordCompletion"("tenantId", "id");
CREATE UNIQUE INDEX "MedicalRecordCompletion_admissionId_key" ON "MedicalRecordCompletion"("admissionId");
CREATE UNIQUE INDEX "MedicalRecordCompletion_tenantId_facilityId_admissionId_key" ON "MedicalRecordCompletion"("tenantId", "facilityId", "admissionId");

-- AddForeignKey
ALTER TABLE "MedicalRecordCompletion" ADD CONSTRAINT "MedicalRecordCompletion_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
ALTER TABLE "MedicalRecordCompletion" ADD CONSTRAINT record_completion_note_length CHECK ("note" IS NULL OR length("note") <= 300);
CREATE TRIGGER medical_record_completion_immutable BEFORE UPDATE OR DELETE ON "MedicalRecordCompletion" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"MedicalRecordCompletion"');

-- ===== who may do what: the new Medical Records Department role =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, 'MEDICAL_RECORDS', true FROM "Tenant" t ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('MEDICAL_RECORDS', 'MRD_RECORD_COMPLETE'), ('MEDICAL_RECORDS', 'ADMISSION_READ'), ('MEDICAL_RECORDS', 'PATIENT_READ'), ('MEDICAL_RECORDS', 'CONSULTATION_READ')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration post_discharge_records', 'added', jsonb_build_object(
  'MEDICAL_RECORDS', jsonb_build_array('MRD_RECORD_COMPLETE', 'ADMISSION_READ', 'PATIENT_READ', 'CONSULTATION_READ')))
FROM "Tenant" t;
