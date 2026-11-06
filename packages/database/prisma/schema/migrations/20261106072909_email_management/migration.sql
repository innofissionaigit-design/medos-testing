-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "EmailSuppressionReason" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINT', 'MANUAL');

-- AlterEnum
ALTER TYPE "ConsentPurpose" ADD VALUE 'EMAIL_MESSAGES';

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "email" TEXT;

-- CreateTable
CREATE TABLE "EmailOutbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "templateKey" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "patientId" UUID,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "entityType" TEXT,
    "entityId" UUID,
    "dedupeKey" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "templateKey" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "reason" "EmailSuppressionReason" NOT NULL,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailOutbox_status_nextAttemptAt_idx" ON "EmailOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_tenantId_createdAt_idx" ON "EmailOutbox"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "EmailOutbox_tenantId_patientId_idx" ON "EmailOutbox"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailOutbox_tenantId_id_key" ON "EmailOutbox"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EmailOutbox_tenantId_dedupeKey_key" ON "EmailOutbox"("tenantId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_tenantId_templateKey_language_key" ON "EmailTemplate"("tenantId", "templateKey", "language");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_tenantId_address_key" ON "EmailSuppression"("tenantId", "address");

-- AddForeignKey
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Email management (docs/email.md): isolation by hospital like every tenant table, and the rules the database itself keeps.

ALTER TABLE "Patient" ADD CONSTRAINT patient_email_format CHECK ("email" IS NULL OR (length("email") <= 254 AND "email" ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'));

-- What is queued is a plain, lower-case address and a one-line subject: nothing that could add headers, and bounded sizes.
ALTER TABLE "EmailOutbox" ADD CONSTRAINT email_outbox_values CHECK (
  length("toAddress") BETWEEN 5 AND 254 AND "toAddress" = lower("toAddress") AND "toAddress" ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
  AND "subject" !~ '[\r\n]' AND length("subject") BETWEEN 1 AND 200
  AND length("bodyText") BETWEEN 1 AND 8000
  AND "language" IN ('en', 'bn', 'hi')
  AND attempts >= 0
  AND (status <> 'SENT' OR "sentAt" IS NOT NULL));
ALTER TABLE "EmailTemplate" ADD CONSTRAINT email_template_values CHECK (
  "language" IN ('en', 'bn', 'hi') AND "subject" !~ '[\r\n]' AND length("subject") BETWEEN 1 AND 200 AND length("body") BETWEEN 1 AND 4000 AND version >= 1);
ALTER TABLE "EmailSuppression" ADD CONSTRAINT email_suppression_values CHECK ("address" = lower("address") AND length("address") BETWEEN 5 AND 254);

-- The patient an email is about must be the same hospital's.
CREATE TRIGGER email_outbox_scope_patient BEFORE INSERT OR UPDATE OF "patientId" ON "EmailOutbox" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Patient', 'patientId');

SELECT medos_enable_tenant_rls('"EmailOutbox"');
SELECT medos_enable_tenant_rls('"EmailTemplate"');
SELECT medos_enable_tenant_rls('"EmailSuppression"');

-- ===== permission (data) =====
-- Two new permissions for the Administrator role of every hospital: set up email (EMAIL_MANAGE) and read the delivery log (EMAIL_LOG_READ).
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r."id", p.perm FROM "Role" r CROSS JOIN (VALUES ('EMAIL_MANAGE'), ('EMAIL_LOG_READ')) AS p(perm) WHERE r."isSystem" AND r."name" = 'ADMINISTRATOR'
ON CONFLICT ("roleId", "permission") DO NOTHING;

INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration email_management',
  'added', jsonb_build_object('ADMINISTRATOR', jsonb_build_array('EMAIL_MANAGE', 'EMAIL_LOG_READ'))
)
FROM "Tenant" t;

