-- "Done but not billed" review (docs/missed-billing.md): a billing person's decision on one flag, and the BILLING role who makes it.

-- CreateTable
CREATE TABLE "MissedBillingReview" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "flagKey" TEXT NOT NULL,
    "flagType" TEXT NOT NULL,
    "patientId" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" DECIMAL(14,2),
    "reviewedById" UUID NOT NULL,
    "reviewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MissedBillingReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MissedBillingReview_tenantId_facilityId_flagKey_key" ON "MissedBillingReview"("tenantId", "facilityId", "flagKey");
CREATE UNIQUE INDEX "MissedBillingReview_tenantId_id_key" ON "MissedBillingReview"("tenantId", "id");
CREATE INDEX "MissedBillingReview_tenantId_facilityId_reviewedAt_idx" ON "MissedBillingReview"("tenantId", "facilityId", "reviewedAt" DESC);

-- AddForeignKey
ALTER TABLE "MissedBillingReview" ADD CONSTRAINT "MissedBillingReview_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
ALTER TABLE "MissedBillingReview"
  ADD CONSTRAINT missed_billing_decision CHECK ("decision" IN ('NOT_A_GAP', 'BILLED', 'WAIVED')),
  ADD CONSTRAINT missed_billing_reason CHECK (length(btrim("reason")) >= 5),
  ADD CONSTRAINT missed_billing_waiver_reason CHECK ("decision" <> 'WAIVED' OR length(btrim("reason")) >= 10),
  ADD CONSTRAINT missed_billing_amount CHECK ("amount" IS NULL OR "amount" >= 0),
  ADD CONSTRAINT missed_billing_flag_type CHECK ("flagType" IN ('TEST_NOT_BILLED', 'TEST_BILL_CANCELLED', 'MEDICINE_NOT_BILLED', 'BED_NIGHT_NOT_CHARGED', 'CONSULTATION_NO_FEE', 'PACKAGE_ITEM_BILLED_AGAIN', 'LATE_CHARGE_NOT_BILLED'));
-- A decision is part of the record: never changed or removed.
CREATE TRIGGER missed_billing_review_immutable BEFORE UPDATE OR DELETE ON "MissedBillingReview" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

SELECT medos_enable_tenant_rls('"MissedBillingReview"');

-- ===== who may do what =====
-- The new built-in BILLING role reviews the flags and raises the final bill; the manager and administrator may review too. Existing hospitals get the role.
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, 'BILLING', true FROM "Tenant" t ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('BILLING', 'MISSED_BILLING_READ'), ('BILLING', 'MISSED_BILLING_REVIEW'), ('BILLING', 'LEDGER_READ'), ('BILLING', 'APPOINTMENT_READ'), ('BILLING', 'CLAIM_READ'), ('BILLING', 'TEST_BILL'),
  ('BILLING', 'IPD_FINAL_BILL'), ('BILLING', 'CHARGE_CREATE'), ('BILLING', 'ADMISSION_READ'), ('BILLING', 'PATIENT_READ'), ('BILLING', 'INVOICE_READ'), ('BILLING', 'INVOICE_CREATE'),
  ('BILLING', 'INVOICE_ISSUE'), ('BILLING', 'REPORT_FINANCE'),
  ('MANAGER', 'MISSED_BILLING_READ'), ('MANAGER', 'MISSED_BILLING_REVIEW'), ('ADMINISTRATOR', 'MISSED_BILLING_READ'), ('ADMINISTRATOR', 'MISSED_BILLING_REVIEW')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration missed_billing_review', 'added', jsonb_build_object(
  'BILLING', jsonb_build_array('MISSED_BILLING_READ', 'MISSED_BILLING_REVIEW', 'LEDGER_READ', 'APPOINTMENT_READ', 'CLAIM_READ', 'TEST_BILL', 'IPD_FINAL_BILL', 'CHARGE_CREATE', 'ADMISSION_READ', 'PATIENT_READ', 'INVOICE_READ', 'INVOICE_CREATE', 'INVOICE_ISSUE', 'REPORT_FINANCE'),
  'MANAGER', jsonb_build_array('MISSED_BILLING_READ', 'MISSED_BILLING_REVIEW'), 'ADMINISTRATOR', jsonb_build_array('MISSED_BILLING_READ', 'MISSED_BILLING_REVIEW')))
FROM "Tenant" t;
