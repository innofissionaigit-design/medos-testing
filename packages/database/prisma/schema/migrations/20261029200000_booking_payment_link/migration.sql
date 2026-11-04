-- Payment link and automatic cancellation for unpaid booking fees. New table only; nothing existing changes meaning.
-- CreateEnum
CREATE TYPE "PaymentLinkStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LinkSendStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "BookingPaymentLink" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "dueBy" TIMESTAMPTZ(3) NOT NULL,
    "status" "PaymentLinkStatus" NOT NULL DEFAULT 'PENDING',
    "sendStatus" "LinkSendStatus" NOT NULL DEFAULT 'PENDING',
    "sendAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextSendAt" TIMESTAMPTZ(3) NOT NULL,
    "sentAt" TIMESTAMPTZ(3),
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingPaymentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingPaymentLink_status_dueBy_idx" ON "BookingPaymentLink"("status", "dueBy");

-- CreateIndex
CREATE INDEX "BookingPaymentLink_status_sendStatus_nextSendAt_idx" ON "BookingPaymentLink"("status", "sendStatus", "nextSendAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingPaymentLink_tenantId_id_key" ON "BookingPaymentLink"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BookingPaymentLink_tenantId_appointmentId_key" ON "BookingPaymentLink"("tenantId", "appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingPaymentLink_token_key" ON "BookingPaymentLink"("token");

-- AddForeignKey
ALTER TABLE "BookingPaymentLink" ADD CONSTRAINT "BookingPaymentLink_tenantId_appointmentId_fkey" FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "Appointment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== hand-written rules (docs/booking-payment-link.md) =====
ALTER TABLE "BookingPaymentLink" ADD CONSTRAINT booking_payment_link_amount CHECK (amount > 0);
ALTER TABLE "BookingPaymentLink" ADD CONSTRAINT booking_payment_link_closed CHECK ((status = 'PENDING') = ("closedAt" IS NULL));

-- A link is settled once: paid, expired or cancelled links never become pending again, and what they were for never changes.
CREATE OR REPLACE FUNCTION medos_payment_link_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."appointmentId" <> OLD."appointmentId" OR NEW.amount <> OLD.amount OR NEW."dueBy" <> OLD."dueBy" OR NEW.token <> OLD.token THEN
    RAISE EXCEPTION 'A payment link cannot be changed after it is created' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'PENDING' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'A settled payment link cannot be reopened' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER booking_payment_link_guard BEFORE UPDATE ON "BookingPaymentLink" FOR EACH ROW EXECUTE FUNCTION medos_payment_link_guard();
CREATE TRIGGER booking_payment_link_no_delete BEFORE DELETE ON "BookingPaymentLink" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

SELECT medos_enable_tenant_rls('"BookingPaymentLink"');

-- The worker's way in: which hospitals have a link to send or a deadline that has passed (it then works one hospital at a time, like the reminder worker).
CREATE OR REPLACE FUNCTION medos_tenants_with_due_payment_links(p_now timestamptz) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT DISTINCT l."tenantId" FROM public."BookingPaymentLink" l
      WHERE l.status = 'PENDING' AND (l."dueBy" <= p_now OR (l."sendStatus" = 'PENDING' AND l."nextSendAt" <= p_now)) $$;
REVOKE ALL ON FUNCTION medos_tenants_with_due_payment_links(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_tenants_with_due_payment_links(timestamptz) TO medos_app;
