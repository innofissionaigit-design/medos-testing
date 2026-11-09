-- Per-area report permissions. REPORT_READ keeps meaning "every report"; REPORT_OPD, REPORT_FINANCE, REPORT_IPD and
-- REPORT_PHARMACY each grant one area. Brings existing tenants' system roles in line with SYSTEM_ROLES
-- (packages/shared/src/permissions.ts). System roles cannot be edited through the API, so no customisation is overwritten.
-- Data only: permissions are plain strings, so there is no schema change.

INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r."id", g.permission
FROM "Role" r
JOIN (VALUES
  ('RECEPTIONIST', 'REPORT_OPD'), ('RECEPTIONIST', 'REPORT_IPD'),
  ('DOCTOR', 'REPORT_OPD'), ('DOCTOR', 'REPORT_IPD'),
  ('NURSE', 'REPORT_IPD'),
  ('CASHIER', 'REPORT_FINANCE'),
  ('PHARMACIST', 'REPORT_PHARMACY')
) AS g(role, permission) ON g.role = r."name"
WHERE r."isSystem"
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- Pharmacists now see pharmacy reports only (previously every report, including hospital-wide collections).
DELETE FROM "RolePermission" rp
USING "Role" r
WHERE rp."roleId" = r."id" AND rp."tenantId" = r."tenantId" AND r."isSystem" AND r."name" = 'PHARMACIST' AND rp."permission" = 'REPORT_READ';

-- Audit trail (CLAUDE.md §13): one event per tenant recording the system-role permission change.
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261026100000_report_permissions',
  'added', jsonb_build_object(
    'RECEPTIONIST', jsonb_build_array('REPORT_OPD', 'REPORT_IPD'),
    'DOCTOR', jsonb_build_array('REPORT_OPD', 'REPORT_IPD'),
    'NURSE', jsonb_build_array('REPORT_IPD'),
    'CASHIER', jsonb_build_array('REPORT_FINANCE'),
    'PHARMACIST', jsonb_build_array('REPORT_PHARMACY')),
  'removed', jsonb_build_object('PHARMACIST', jsonb_build_array('REPORT_READ'))
)
FROM "Tenant" t;
