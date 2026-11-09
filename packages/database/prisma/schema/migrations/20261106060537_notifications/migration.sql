-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('CRITICAL_LAB_RESULT', 'CRITICAL_RAD_FINDING', 'QUEUE_PATIENT_ADDED', 'PRESCRIPTION_AT_PHARMACY', 'PHARMACY_BILL_WAITING', 'BOOKING_FROM_OUTSIDE', 'BOOKING_AUTO_CANCELLED');

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "recipientUserId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMPTZ(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_tenantId_recipientUserId_readAt_createdAt_idx" ON "Notification"("tenantId", "recipientUserId", "readAt", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_tenantId_id_key" ON "Notification"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_tenantId_recipientUserId_dedupeKey_key" ON "Notification"("tenantId", "recipientUserId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_recipientUserId_fkey" FOREIGN KEY ("tenantId", "recipientUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- ===== Hand-written invariants =====
-- Notifications (docs/notifications.md): tenant isolation like every tenant table, and a short pointer only.
ALTER TABLE "Notification" ADD CONSTRAINT notification_values CHECK (length(btrim("entityType")) BETWEEN 1 AND 40 AND ("dedupeKey" IS NULL OR length("dedupeKey") <= 200));
SELECT medos_enable_tenant_rls('"Notification"');

