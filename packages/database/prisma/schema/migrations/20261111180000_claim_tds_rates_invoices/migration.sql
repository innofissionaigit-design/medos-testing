-- Claims (docs/claims.md): TDS on insurer payments, insurer rate cards and packages, and several invoices on one claim.

-- ===== TDS on settlements =====
ALTER TABLE "ClaimSettlement" ADD COLUMN "tdsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "ClaimSettlement" ADD CONSTRAINT claim_settlement_tds CHECK ("tdsAmount" >= 0);
-- Settlements (cash received plus tax deducted at source) add up to no more than the approved amount, and only for an approved claim.
CREATE OR REPLACE FUNCTION medos_claim_settlement_total() RETURNS trigger AS $$
DECLARE c RECORD; total numeric;
BEGIN
  SELECT status, "approvedAmount" INTO c FROM "Claim" WHERE id = NEW."claimId" AND "tenantId" = NEW."tenantId" FOR SHARE;
  IF c.status IS DISTINCT FROM 'APPROVED' THEN RAISE EXCEPTION 'Money can only be received on an approved claim' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT COALESCE(SUM(amount + "tdsAmount"), 0) INTO total FROM "ClaimSettlement" WHERE "claimId" = NEW."claimId";
  IF total + NEW.amount + NEW."tdsAmount" > c."approvedAmount" THEN RAISE EXCEPTION 'Settlements cannot add up to more than the approved amount' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ===== rate cards and packages =====
CREATE TABLE "InsurerRate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "insurerId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "status" "PayerStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "InsurerRate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InsurerRate_tenantId_id_key" ON "InsurerRate"("tenantId", "id");
CREATE UNIQUE INDEX "InsurerRate_tenantId_insurerId_serviceId_key" ON "InsurerRate"("tenantId", "insurerId", "serviceId");
ALTER TABLE "InsurerRate" ADD CONSTRAINT "InsurerRate_tenantId_insurerId_fkey" FOREIGN KEY ("tenantId", "insurerId") REFERENCES "Insurer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsurerRate" ADD CONSTRAINT "InsurerRate_tenantId_serviceId_fkey" FOREIGN KEY ("tenantId", "serviceId") REFERENCES "Service"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsurerRate" ADD CONSTRAINT insurer_rate_values CHECK (price >= 0);
CREATE TRIGGER insurer_rate_no_delete BEFORE DELETE ON "InsurerRate" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

CREATE TABLE "InsurerPackage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "insurerId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "status" "PayerStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "InsurerPackage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InsurerPackage_tenantId_id_key" ON "InsurerPackage"("tenantId", "id");
CREATE UNIQUE INDEX "InsurerPackage_tenantId_insurerId_code_key" ON "InsurerPackage"("tenantId", "insurerId", "code");
ALTER TABLE "InsurerPackage" ADD CONSTRAINT "InsurerPackage_tenantId_insurerId_fkey" FOREIGN KEY ("tenantId", "insurerId") REFERENCES "Insurer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsurerPackage" ADD CONSTRAINT insurer_package_values CHECK (price > 0 AND length(btrim(code)) BETWEEN 1 AND 30 AND length(btrim(name)) BETWEEN 2 AND 120);
CREATE TRIGGER insurer_package_no_delete BEFORE DELETE ON "InsurerPackage" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "Claim" ADD COLUMN "packageId" UUID, ADD COLUMN "packageName" TEXT, ADD COLUMN "packagePrice" DECIMAL(14,2);
ALTER TABLE "Claim" ADD CONSTRAINT claim_package_values CHECK (
  ("packageId" IS NULL AND "packageName" IS NULL AND "packagePrice" IS NULL) OR ("packageId" IS NOT NULL AND "packageName" IS NOT NULL AND "packagePrice" > 0));

-- ===== several invoices on one claim =====
CREATE TABLE "ClaimInvoice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaimInvoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClaimInvoice_tenantId_id_key" ON "ClaimInvoice"("tenantId", "id");
CREATE UNIQUE INDEX "ClaimInvoice_tenantId_claimId_invoiceId_key" ON "ClaimInvoice"("tenantId", "claimId", "invoiceId");
CREATE INDEX "ClaimInvoice_tenantId_invoiceId_idx" ON "ClaimInvoice"("tenantId", "invoiceId");
ALTER TABLE "ClaimInvoice" ADD CONSTRAINT "ClaimInvoice_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimInvoice" ADD CONSTRAINT "ClaimInvoice_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A further invoice joins a submitted claim (or one under query) once: it must be the same patient's issued invoice, not the claim's main invoice and not held by another live claim.
-- The link is never changed or removed.
CREATE OR REPLACE FUNCTION medos_claim_invoice_guard() RETURNS trigger AS $$
DECLARE c RECORD; i RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'The invoices of a claim cannot be changed or removed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT status::text AS status, "patientId", "facilityId", "invoiceId" INTO c FROM "Claim" WHERE id = NEW."claimId" AND "tenantId" = NEW."tenantId";
  IF c.status IS NULL OR c.status NOT IN ('SUBMITTED', 'QUERY') OR c."invoiceId" IS NULL THEN
    RAISE EXCEPTION 'More invoices can only be added to a submitted claim, or one under query' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT status::text AS status, "patientId", "facilityId" INTO i FROM "Invoice" WHERE id = NEW."invoiceId" AND "tenantId" = NEW."tenantId";
  IF i.status IS NULL OR i."patientId" <> c."patientId" OR i."facilityId" <> c."facilityId" OR i.status NOT IN ('ISSUED', 'PARTIALLY_PAID', 'PAID') THEN
    RAISE EXCEPTION 'A claim can only cover issued invoices of the same patient and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."invoiceId" = c."invoiceId"
     OR EXISTS (SELECT 1 FROM "Claim" o WHERE o."tenantId" = NEW."tenantId" AND o."invoiceId" = NEW."invoiceId" AND o.status NOT IN ('REJECTED', 'CLOSED'))
     OR EXISTS (SELECT 1 FROM "ClaimInvoice" l JOIN "Claim" o ON o.id = l."claimId" AND o."tenantId" = l."tenantId" WHERE l."tenantId" = NEW."tenantId" AND l."invoiceId" = NEW."invoiceId" AND l."claimId" <> NEW."claimId" AND o.status NOT IN ('REJECTED', 'CLOSED')) THEN
    RAISE EXCEPTION 'This invoice already has a claim in progress' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER claim_invoice_guard BEFORE INSERT OR UPDATE OR DELETE ON "ClaimInvoice" FOR EACH ROW EXECUTE FUNCTION medos_claim_invoice_guard();

SELECT medos_enable_tenant_rls('"InsurerRate"');
SELECT medos_enable_tenant_rls('"InsurerPackage"');
SELECT medos_enable_tenant_rls('"ClaimInvoice"');
