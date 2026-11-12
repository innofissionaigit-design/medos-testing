-- Discharge: financial release (docs/discharge-stages.md). The last stage clears by itself once final billing is reconciled; otherwise an authorised
-- billing / finance person records an exception, with a reason, and the discharge may go ahead with money still outstanding.
ALTER TYPE "ClearanceStep" ADD VALUE IF NOT EXISTS 'FINANCIAL_RELEASE' AFTER 'BILLING';

-- ===== who may do what: the manager (billing / finance) authorises a financial-release exception =====
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'DISCHARGE_FINANCIAL_EXCEPTION' FROM "Role" r WHERE r.name = 'MANAGER' AND r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration discharge_financial_release', 'added', jsonb_build_object('MANAGER', jsonb_build_array('DISCHARGE_FINANCIAL_EXCEPTION')))
FROM "Tenant" t;
