-- CreateTable
CREATE TABLE "VisitConsultationBill" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitConsultationBill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VisitConsultationBill_invoiceId_key" ON "VisitConsultationBill"("invoiceId");

-- CreateIndex
CREATE INDEX "VisitConsultationBill_tenantId_facilityId_createdAt_idx" ON "VisitConsultationBill"("tenantId", "facilityId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "VisitConsultationBill_tenantId_encounterId_key" ON "VisitConsultationBill"("tenantId", "encounterId");

-- AddForeignKey
ALTER TABLE "VisitConsultationBill" ADD CONSTRAINT "VisitConsultationBill_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitConsultationBill" ADD CONSTRAINT "VisitConsultationBill_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== rules =====
-- The bill that covers a visit must be a paid OPD bill of the same patient and facility; once recorded it never changes and is never deleted.
CREATE OR REPLACE FUNCTION medos_visit_consultation_bill_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Encounter" e JOIN "Invoice" i ON i."tenantId" = e."tenantId" AND i."patientId" = e."patientId" AND i."facilityId" = e."facilityId"
                 WHERE e."tenantId" = NEW."tenantId" AND e.id = NEW."encounterId" AND e."facilityId" = NEW."facilityId" AND e.type = 'OPD' AND i.id = NEW."invoiceId" AND i.kind = 'OPD' AND i.status = 'PAID') THEN
    RAISE EXCEPTION 'A visit can only be covered by a paid OPD bill of the same patient and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER visit_consultation_bill_scope BEFORE INSERT ON "VisitConsultationBill" FOR EACH ROW EXECUTE FUNCTION medos_visit_consultation_bill_scope();
CREATE TRIGGER visit_consultation_bill_no_update BEFORE UPDATE ON "VisitConsultationBill" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER visit_consultation_bill_no_delete BEFORE DELETE ON "VisitConsultationBill" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"VisitConsultationBill"');