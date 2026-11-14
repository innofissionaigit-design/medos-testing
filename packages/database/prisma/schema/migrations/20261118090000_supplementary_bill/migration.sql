-- Supplementary bills (docs/discharge-flow.md): a charge that arrives after the final bill is issued goes on its own small invoice, so the first bill is never altered.
CREATE TABLE "SupplementaryBill" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "charges" INTEGER NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplementaryBill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupplementaryBill_tenantId_id_key" ON "SupplementaryBill"("tenantId", "id");
CREATE UNIQUE INDEX "SupplementaryBill_invoiceId_key" ON "SupplementaryBill"("invoiceId");
CREATE UNIQUE INDEX "SupplementaryBill_admissionId_sequence_key" ON "SupplementaryBill"("admissionId", "sequence");
ALTER TABLE "SupplementaryBill" ADD CONSTRAINT "SupplementaryBill_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplementaryBill" ADD CONSTRAINT "SupplementaryBill_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplementaryBill" ADD CONSTRAINT supplementary_bill_positive CHECK ("sequence" >= 1 AND "charges" >= 1);
CREATE TRIGGER supplementary_bill_immutable BEFORE UPDATE OR DELETE ON "SupplementaryBill" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"SupplementaryBill"');
