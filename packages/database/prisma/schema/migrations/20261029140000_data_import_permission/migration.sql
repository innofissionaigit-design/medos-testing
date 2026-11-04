-- Bulk CSV import (patients, medicines, opening stock, service price list): a new permission held by the Administrator role.
-- Data only: permissions are plain strings, so there is no schema change. New hospitals get it from SYSTEM_ROLES
-- (packages/shared/src/permissions.ts). System roles cannot be edited through the API, so nothing is overwritten.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT "tenantId", id, 'DATA_IMPORT' FROM "Role" WHERE name = 'ADMINISTRATOR' AND "isSystem"
ON CONFLICT DO NOTHING;

INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261029140000_data_import_permission',
  'added', jsonb_build_object('ADMINISTRATOR', jsonb_build_array('DATA_IMPORT'))
)
FROM "Tenant" t;
