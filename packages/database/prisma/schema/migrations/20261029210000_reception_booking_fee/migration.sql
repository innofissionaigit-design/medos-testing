-- Reception settles booking fees at the front desk (docs/booking-fee.md): takes the fee (PAYMENT_CREATE, with its own cash shift:
-- CASHIER_SHIFT_MANAGE) or skips it for a special case with a configured reason (BOOKING_FEE_SKIP). Data only; new hospitals get it from SYSTEM_ROLES.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission
FROM "Role" r CROSS JOIN (VALUES ('PAYMENT_CREATE'), ('CASHIER_SHIFT_MANAGE'), ('BOOKING_FEE_SKIP')) AS p(permission)
WHERE r.name = 'RECEPTIONIST' AND r."isSystem"
ON CONFLICT DO NOTHING;

INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261029210000_reception_booking_fee',
  'added', jsonb_build_object('RECEPTIONIST', jsonb_build_array('PAYMENT_CREATE', 'CASHIER_SHIFT_MANAGE', 'BOOKING_FEE_SKIP'))
)
FROM "Tenant" t;
