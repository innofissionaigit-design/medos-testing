-- Discharge: a new clearance stage for insurance (docs/discharge-stages.md). The TPA desk keeps the claim documents and the authorisation up to date; the stage reconciles itself
-- from the claim linked to the admission, and a doctor can waive it with a reason (a self-pay patient).
ALTER TYPE "ClearanceStep" ADD VALUE IF NOT EXISTS 'INSURANCE' BEFORE 'BILLING';

-- ===== who may do what: the TPA desk (claims officer) can open an admission to start the claim and to see the insurance stage =====
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'ADMISSION_READ' FROM "Role" r WHERE r.name = 'CLAIMS_OFFICER' AND r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration discharge_insurance_step', 'added', jsonb_build_object('CLAIMS_OFFICER', jsonb_build_array('ADMISSION_READ')))
FROM "Tenant" t;
