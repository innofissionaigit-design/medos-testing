-- Final IPD bills are raised by billing staff and administrators only (docs/billing-roles.md).
-- Reception was given INVOICE_ISSUE to take payments at the desk (20261030230000), which also opened the final bill of an admission. The final bill now has its own permission.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'IPD_FINAL_BILL' FROM "Role" r WHERE r."isSystem" AND r.name IN ('CASHIER', 'ADMINISTRATOR')
ON CONFLICT DO NOTHING;
-- A hospital's own roles keep the access they had: those that could create and issue bills (never Reception).
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'IPD_FINAL_BILL' FROM "Role" r
WHERE NOT r."isSystem"
  AND EXISTS (SELECT 1 FROM "RolePermission" p WHERE p."roleId" = r.id AND p."permission" = 'INVOICE_CREATE')
  AND EXISTS (SELECT 1 FROM "RolePermission" p WHERE p."roleId" = r.id AND p."permission" = 'INVOICE_ISSUE')
ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261031100000_ipd_final_bill_permission', 'added', jsonb_build_object('CASHIER', jsonb_build_array('IPD_FINAL_BILL'), 'ADMINISTRATOR', jsonb_build_array('IPD_FINAL_BILL')))
FROM "Tenant" t;
