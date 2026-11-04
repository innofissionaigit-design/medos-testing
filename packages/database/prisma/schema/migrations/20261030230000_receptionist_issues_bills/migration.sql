-- Reception takes the OPD consultation payment before a visit starts (docs/opd-payment.md): it creates the bill, issues it and receives the payment.
-- Until now the Receptionist role could create a draft bill and take payments but could not issue a bill, so a payment could not be taken at the desk.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'INVOICE_ISSUE' FROM "Role" r WHERE r."isSystem" AND r.name = 'RECEPTIONIST'
ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261030230000_receptionist_issues_bills', 'added', jsonb_build_object('RECEPTIONIST', jsonb_build_array('INVOICE_ISSUE')))
FROM "Tenant" t;
