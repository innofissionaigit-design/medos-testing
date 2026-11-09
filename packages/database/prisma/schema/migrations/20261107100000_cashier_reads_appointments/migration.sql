-- ===== permission (data) =====
-- The Cashier takes the booking fee ("Take fee", docs/booking-fee.md) from the Appointments list, but the built-in Cashier role could not open that list
-- (the page needs APPOINTMENT_READ), so the fee could only be taken by reception. The Cashier gets the READ permission only: it still cannot book,
-- change, cancel or check in an appointment (APPOINTMENT_CREATE / UPDATE / CANCEL stay with reception).
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r."id", 'APPOINTMENT_READ' FROM "Role" r WHERE r."isSystem" AND r."name" = 'CASHIER'
ON CONFLICT ("roleId", "permission") DO NOTHING;

INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261107100000_cashier_reads_appointments',
  'added', jsonb_build_object('CASHIER', jsonb_build_array('APPOINTMENT_READ'))
)
FROM "Tenant" t;
