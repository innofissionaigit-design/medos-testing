-- Pharmacy generates the bill; the Cashier collects every payment (docs/billing-roles.md).
-- The Pharmacist role no longer holds the rights to create or issue bills by hand, take payments, or run a cash shift.
-- Hospitals that gave these to a custom role on purpose are not touched: only the built-in Pharmacist role changes.
DELETE FROM "RolePermission" rp
USING "Role" r
WHERE rp."roleId" = r.id AND rp."tenantId" = r."tenantId" AND r."isSystem" AND r.name = 'PHARMACIST'
  AND rp.permission IN ('PAYMENT_CREATE', 'CASHIER_SHIFT_MANAGE', 'INVOICE_CREATE', 'INVOICE_ISSUE');

INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261030120000_pharmacy_bills_cashier_collects',
  'removed', jsonb_build_object('PHARMACIST', jsonb_build_array('PAYMENT_CREATE', 'CASHIER_SHIFT_MANAGE', 'INVOICE_CREATE', 'INVOICE_ISSUE')))
FROM "Tenant" t;
