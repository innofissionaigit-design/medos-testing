-- The patient's account statement (docs/patient-ledger.md) gets its own permission, LEDGER_READ, so the receptionist can be kept from it without losing access to bills.
-- Until now it needed INVOICE_READ. Every role that has INVOICE_READ keeps seeing it (custom roles too), except the built-in Receptionist role.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT rp."tenantId", rp."roleId", 'LEDGER_READ'
FROM "RolePermission" rp
JOIN "Role" r ON r."tenantId" = rp."tenantId" AND r.id = rp."roleId"
WHERE rp."permission" = 'INVOICE_READ' AND NOT (r.name = 'RECEPTIONIST' AND r."isSystem")
ON CONFLICT DO NOTHING;

INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration ledger_read_permission', 'added', jsonb_build_object(
  'every role with INVOICE_READ except the built-in RECEPTIONIST', jsonb_build_array('LEDGER_READ')))
FROM "Tenant" t;
