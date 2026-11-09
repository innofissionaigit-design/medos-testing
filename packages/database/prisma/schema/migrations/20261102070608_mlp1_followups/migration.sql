-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutKind" AS ENUM ('PAYMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('RECEIVED', 'IN_TRANSIT', 'CANCELLED');

-- AlterTable
ALTER TABLE "ApiClient" ADD COLUMN     "allowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "StockLocationLedger" ADD COLUMN     "issueId" UUID,
ALTER COLUMN "transferId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "StockTransfer" ADD COLUMN     "closeNote" TEXT,
ADD COLUMN     "receivedAt" TIMESTAMPTZ(3),
ADD COLUMN     "receivedById" UUID,
ADD COLUMN     "status" "StockTransferStatus" NOT NULL DEFAULT 'RECEIVED';

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "secretLast4" TEXT NOT NULL,
    "events" TEXT[],
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "appointmentId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorPayout" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "payoutNumber" TEXT NOT NULL,
    "kind" "PayoutKind" NOT NULL DEFAULT 'PAYMENT',
    "reversesId" UUID,
    "grossAmount" DECIMAL(14,2) NOT NULL,
    "tdsPercent" DECIMAL(5,2) NOT NULL,
    "tdsAmount" DECIMAL(14,2) NOT NULL,
    "netAmount" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "paidAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoctorPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrescriptionDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "shareId" UUID,
    "channel" TEXT NOT NULL,
    "toMask" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerName" TEXT,
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),

    CONSTRAINT "PrescriptionDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLocationIssue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "medicineId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "admissionId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "chargeId" UUID,
    "remarks" TEXT,
    "issuedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLocationIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEndpoint_tenantId_id_key" ON "WebhookEndpoint"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEndpoint_tenantId_clientId_key" ON "WebhookEndpoint"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_tenantId_endpointId_createdAt_idx" ON "WebhookDelivery"("tenantId", "endpointId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_tenantId_id_key" ON "WebhookDelivery"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorPayout_reversesId_key" ON "DoctorPayout"("reversesId");

-- CreateIndex
CREATE INDEX "DoctorPayout_tenantId_practitionerId_createdAt_idx" ON "DoctorPayout"("tenantId", "practitionerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DoctorPayout_tenantId_facilityId_createdAt_idx" ON "DoctorPayout"("tenantId", "facilityId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DoctorPayout_tenantId_id_key" ON "DoctorPayout"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorPayout_tenantId_facilityId_payoutNumber_key" ON "DoctorPayout"("tenantId", "facilityId", "payoutNumber");

-- CreateIndex
CREATE INDEX "PrescriptionDelivery_status_nextAttemptAt_idx" ON "PrescriptionDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PrescriptionDelivery_tenantId_encounterId_createdAt_idx" ON "PrescriptionDelivery"("tenantId", "encounterId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionDelivery_tenantId_id_key" ON "PrescriptionDelivery"("tenantId", "id");

-- CreateIndex
CREATE INDEX "StockLocationIssue_tenantId_admissionId_createdAt_idx" ON "StockLocationIssue"("tenantId", "admissionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "StockLocationIssue_tenantId_locationId_createdAt_idx" ON "StockLocationIssue"("tenantId", "locationId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "StockLocationIssue_tenantId_id_key" ON "StockLocationIssue"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "ApiClient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_tenantId_endpointId_fkey" FOREIGN KEY ("tenantId", "endpointId") REFERENCES "WebhookEndpoint"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorPayout" ADD CONSTRAINT "DoctorPayout_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorPayout" ADD CONSTRAINT "DoctorPayout_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorPayout" ADD CONSTRAINT "DoctorPayout_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "DoctorPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionDelivery" ADD CONSTRAINT "PrescriptionDelivery_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocationIssue" ADD CONSTRAINT "StockLocationIssue_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "StockLocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocationIssue" ADD CONSTRAINT "StockLocationIssue_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "MedicineBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocationIssue" ADD CONSTRAINT "StockLocationIssue_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Doctor payouts, two-step stock transfers, nurses drawing from a ward store, integration webhooks and the IP allow-list, automatic prescription delivery.

-- ===== Doctor payouts (docs/doctor-payouts.md) =====
-- A payment voucher pays a positive share with tax deducted at source no more than the share; a reversal mirrors one voucher with every amount negated.
ALTER TABLE "DoctorPayout" ADD CONSTRAINT doctor_payout_amounts CHECK (
  ("kind" = 'PAYMENT' AND "reversesId" IS NULL AND "grossAmount" > 0 AND "tdsAmount" >= 0 AND "tdsAmount" <= "grossAmount" AND "tdsPercent" BETWEEN 0 AND 100 AND "netAmount" = "grossAmount" - "tdsAmount")
  OR ("kind" = 'REVERSAL' AND "reversesId" IS NOT NULL AND "grossAmount" < 0 AND "tdsAmount" <= 0 AND "tdsAmount" >= "grossAmount" AND "tdsPercent" BETWEEN 0 AND 100 AND "netAmount" = "grossAmount" - "tdsAmount"));
CREATE TRIGGER doctor_payout_immutable BEFORE UPDATE OR DELETE ON "DoctorPayout" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE OR REPLACE FUNCTION medos_doctor_payout_scope() RETURNS trigger AS $$
DECLARE o record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Practitioner" p WHERE p.id = NEW."practitionerId" AND p."tenantId" = NEW."tenantId" AND p."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'A payout must be to a doctor of the same hospital and facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.kind = 'REVERSAL' THEN
    SELECT * INTO o FROM "DoctorPayout" WHERE id = NEW."reversesId" AND "tenantId" = NEW."tenantId";
    IF NOT FOUND OR o.kind <> 'PAYMENT' OR o."facilityId" <> NEW."facilityId" OR o."practitionerId" <> NEW."practitionerId"
       OR NEW."grossAmount" <> -o."grossAmount" OR NEW."tdsAmount" <> -o."tdsAmount" OR NEW."netAmount" <> -o."netAmount" THEN
      RAISE EXCEPTION 'A reversal must mirror one payment voucher of the same doctor, amount for amount' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER doctor_payout_scope BEFORE INSERT ON "DoctorPayout" FOR EACH ROW EXECUTE FUNCTION medos_doctor_payout_scope();

-- ===== Two-step stock transfers and issues from a location (docs/stock-transfers.md) =====
-- A transfer is still never deleted or rewritten. The one change allowed is the close of a transfer that is in transit: received, or sent back (cancelled).
DROP TRIGGER stock_transfer_immutable ON "StockTransfer";
CREATE OR REPLACE FUNCTION medos_stock_transfer_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stock transfers are append-only and cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'IN_TRANSIT' AND NEW.status IN ('RECEIVED', 'CANCELLED')
     AND NEW.id = OLD.id AND NEW."tenantId" = OLD."tenantId" AND NEW."facilityId" = OLD."facilityId" AND NEW."transferNumber" = OLD."transferNumber"
     AND NEW."fromLocationId" IS NOT DISTINCT FROM OLD."fromLocationId" AND NEW."toLocationId" IS NOT DISTINCT FROM OLD."toLocationId"
     AND NEW.reason = OLD.reason AND NEW."createdById" = OLD."createdById" AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Stock transfers are append-only: only a transfer that is in transit can be received or sent back' USING ERRCODE = 'integrity_constraint_violation';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_transfer_guard BEFORE UPDATE OR DELETE ON "StockTransfer" FOR EACH ROW EXECUTE FUNCTION medos_stock_transfer_guard();
ALTER TABLE "StockTransfer" ADD CONSTRAINT stock_transfer_open CHECK (status <> 'IN_TRANSIT' OR ("receivedAt" IS NULL AND "receivedById" IS NULL));

-- A location ledger line is caused by exactly one thing: a transfer, or an issue to a patient.
ALTER TABLE "StockLocationLedger" ADD CONSTRAINT stock_location_ledger_cause CHECK (("transferId" IS NOT NULL) <> ("issueId" IS NOT NULL));

ALTER TABLE "StockLocationIssue" ADD CONSTRAINT stock_location_issue_quantity CHECK (quantity > 0);
CREATE TRIGGER stock_location_issue_immutable BEFORE UPDATE OR DELETE ON "StockLocationIssue" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE OR REPLACE FUNCTION medos_stock_location_issue_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "StockLocation" l JOIN "MedicineBatch" b ON b.id = NEW."batchId" AND b."tenantId" = l."tenantId" AND b."facilityId" = l."facilityId" AND b."medicineId" = NEW."medicineId"
                 WHERE l.id = NEW."locationId" AND l."tenantId" = NEW."tenantId" AND l."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'An issue must name a location and a batch of the same facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Admission" a WHERE a.id = NEW."admissionId" AND a."tenantId" = NEW."tenantId" AND a."facilityId" = NEW."facilityId" AND a."patientId" = NEW."patientId") THEN
    RAISE EXCEPTION 'An issue must be for an admission of the same facility and patient' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_location_issue_scope BEFORE INSERT ON "StockLocationIssue" FOR EACH ROW EXECUTE FUNCTION medos_stock_location_issue_scope();

-- ===== Integration webhooks (docs/integration-api.md) =====
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT webhook_endpoint_url CHECK (url ~ '^https?://[^ ]+$' AND length(url) <= 500);
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT webhook_endpoint_events CHECK (cardinality(events) >= 1 AND events <@ ARRAY['appointment.booked', 'appointment.moved', 'appointment.cancelled']::text[]);
CREATE OR REPLACE FUNCTION medos_webhook_endpoint_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ApiClient" c WHERE c.id = NEW."clientId" AND c."tenantId" = NEW."tenantId" AND c."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'A webhook must belong to an integration of the same facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER webhook_endpoint_scope BEFORE INSERT ON "WebhookEndpoint" FOR EACH ROW EXECUTE FUNCTION medos_webhook_endpoint_scope();
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT webhook_delivery_attempts CHECK (attempts >= 0);
CREATE TRIGGER webhook_delivery_no_delete BEFORE DELETE ON "WebhookDelivery" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== Prescription delivery (docs/prescriptions.md) =====
ALTER TABLE "PrescriptionDelivery" ADD CONSTRAINT prescription_delivery_values CHECK (channel IN ('WHATSAPP', 'SMS') AND trigger IN ('AUTO', 'MANUAL') AND attempts >= 0);
CREATE TRIGGER prescription_delivery_no_delete BEFORE DELETE ON "PrescriptionDelivery" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- The background workers ask which hospitals have something due, then serve each hospital under its own scope (docs/rls.md), as the reminder worker does.
CREATE OR REPLACE FUNCTION medos_tenants_with_due_webhooks(p_now timestamptz) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT DISTINCT d."tenantId" FROM public."WebhookDelivery" d WHERE d.status = 'PENDING' AND d."nextAttemptAt" <= p_now $$;
CREATE OR REPLACE FUNCTION medos_tenants_with_due_prescription_deliveries(p_now timestamptz) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT DISTINCT d."tenantId" FROM public."PrescriptionDelivery" d WHERE d.status = 'PENDING' AND d."nextAttemptAt" <= p_now $$;
REVOKE ALL ON FUNCTION medos_tenants_with_due_webhooks(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION medos_tenants_with_due_prescription_deliveries(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_tenants_with_due_webhooks(timestamptz) TO medos_app;
GRANT EXECUTE ON FUNCTION medos_tenants_with_due_prescription_deliveries(timestamptz) TO medos_app;

SELECT medos_enable_tenant_rls('"DoctorPayout"');
SELECT medos_enable_tenant_rls('"StockLocationIssue"');
SELECT medos_enable_tenant_rls('"WebhookEndpoint"');
SELECT medos_enable_tenant_rls('"WebhookDelivery"');
SELECT medos_enable_tenant_rls('"PrescriptionDelivery"');

