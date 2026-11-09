-- Rolls back 20261029100000_privacy_consent_and_hsn. DESTROYS every consent record, data request and invoice-line HSN/SAC snapshot, and
-- every service SAC code: take a backup first (docs/backup.md). Run as the OWNER role, then remove the migration's row from "_prisma_migrations"
-- (or restore from backup) so the migration can be applied again later.
DROP TRIGGER IF EXISTS patient_consent_append_only ON "PatientConsent";
DROP TRIGGER IF EXISTS patient_data_request_no_delete ON "PatientDataRequest";
DROP TABLE IF EXISTS "PatientConsent";
DROP TABLE IF EXISTS "PatientDataRequest";
DROP FUNCTION IF EXISTS medos_consent_append_only();
DROP FUNCTION IF EXISTS medos_data_request_no_delete();
DROP TYPE IF EXISTS "ConsentPurpose";
DROP TYPE IF EXISTS "ConsentStatus";
DROP TYPE IF EXISTS "ConsentMethod";
DROP TYPE IF EXISTS "DataRequestType";
DROP TYPE IF EXISTS "DataRequestStatus";
ALTER TABLE "InvoiceLine" DROP CONSTRAINT IF EXISTS invoice_line_hsn_format;
ALTER TABLE "InvoiceLine" DROP COLUMN IF EXISTS "hsnSac";
ALTER TABLE "Service" DROP CONSTRAINT IF EXISTS service_sac_format;
ALTER TABLE "Service" DROP COLUMN IF EXISTS "sacCode";
DELETE FROM "RolePermission" WHERE permission = 'PRIVACY_MANAGE';
