-- ===== permission (data) =====
-- Changing a waiting patient's priority or marking an emergency gets its own permission, QUEUE_PRIORITY, instead of the broad QUEUE_MANAGE (which also cancels and requeues for any doctor).
-- Reception keeps the right for every queue; a doctor gets it for their own queue only (the server checks whose queue it is).
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r."id", 'QUEUE_PRIORITY' FROM "Role" r WHERE r."isSystem" AND r."name" IN ('DOCTOR', 'RECEPTIONIST')
ON CONFLICT ("roleId", "permission") DO NOTHING;

INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261105090000_queue_priority_permission',
  'added', jsonb_build_object('DOCTOR', jsonb_build_array('QUEUE_PRIORITY'), 'RECEPTIONIST', jsonb_build_array('QUEUE_PRIORITY'))
)
FROM "Tenant" t;
