-- CreateEnum
CREATE TYPE "ShareTrigger" AS ENUM ('PAYMENT', 'REFUND');

-- CreateTable
CREATE TABLE "DoctorShareEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "trigger" "ShareTrigger" NOT NULL,
    "ruleId" UUID NOT NULL,
    "ruleMode" "ShareMode" NOT NULL,
    "collectedDelta" DECIMAL(14,2) NOT NULL,
    "doctorDelta" DECIMAL(14,2) NOT NULL,
    "hospitalDelta" DECIMAL(14,2) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoctorShareEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DoctorShareEntry_tenantId_encounterId_createdAt_idx" ON "DoctorShareEntry"("tenantId", "encounterId", "createdAt");

-- CreateIndex
CREATE INDEX "DoctorShareEntry_tenantId_facilityId_createdAt_idx" ON "DoctorShareEntry"("tenantId", "facilityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DoctorShareEntry_tenantId_practitionerId_createdAt_idx" ON "DoctorShareEntry"("tenantId", "practitionerId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DoctorShareEntry_tenantId_id_key" ON "DoctorShareEntry"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "DoctorShareEntry" ADD CONSTRAINT "DoctorShareEntry_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorShareEntry" ADD CONSTRAINT "DoctorShareEntry_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorShareEntry" ADD CONSTRAINT "DoctorShareEntry_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorShareEntry" ADD CONSTRAINT "DoctorShareEntry_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorShareEntry" ADD CONSTRAINT "DoctorShareEntry_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "DoctorShareRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- The doctor-share ledger (docs/earnings-and-reports.md): the three amounts of a line always add up, lines are never edited or deleted, and a line must
-- belong to a visit, bill, doctor and rule of the same hospital and facility.
ALTER TABLE "DoctorShareEntry" ADD CONSTRAINT doctor_share_entry_adds_up CHECK ("collectedDelta" = "doctorDelta" + "hospitalDelta");
CREATE TRIGGER doctor_share_entry_immutable BEFORE UPDATE OR DELETE ON "DoctorShareEntry" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE OR REPLACE FUNCTION medos_share_entry_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Encounter" e WHERE e.id = NEW."encounterId" AND e."tenantId" = NEW."tenantId" AND e."facilityId" = NEW."facilityId" AND e."patientId" = NEW."patientId" AND e."practitionerId" = NEW."practitionerId") THEN
    RAISE EXCEPTION 'A share entry must belong to a visit of the same hospital, facility, patient and doctor' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Invoice" i WHERE i.id = NEW."invoiceId" AND i."tenantId" = NEW."tenantId" AND i."facilityId" = NEW."facilityId" AND i."encounterId" = NEW."encounterId") THEN
    RAISE EXCEPTION 'A share entry must belong to a bill of the same visit' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "DoctorShareRule" r WHERE r.id = NEW."ruleId" AND r."tenantId" = NEW."tenantId" AND r."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'A share entry must use a rule of the same hospital and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER doctor_share_entry_scope BEFORE INSERT ON "DoctorShareEntry" FOR EACH ROW EXECUTE FUNCTION medos_share_entry_scope();
SELECT medos_enable_tenant_rls('"DoctorShareEntry"');

