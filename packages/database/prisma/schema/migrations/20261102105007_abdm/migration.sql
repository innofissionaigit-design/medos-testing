-- CreateEnum
CREATE TYPE "AbdmEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateTable
CREATE TABLE "AbdmConfig" (
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "environment" "AbdmEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "sessionUrl" TEXT,
    "clientId" TEXT,
    "clientSecretEnc" TEXT,
    "secretLast4" TEXT,
    "hfrId" TEXT,
    "lastTestAt" TIMESTAMPTZ(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "updatedById" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbdmConfig_pkey" PRIMARY KEY ("tenantId","facilityId")
);

-- CreateTable
CREATE TABLE "AbhaLink" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "abhaNumber" TEXT NOT NULL,
    "abhaAddress" TEXT,
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedById" UUID,
    "removedAt" TIMESTAMPTZ(3),
    "removeReason" TEXT,

    CONSTRAINT "AbhaLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AbhaLink_tenantId_patientId_idx" ON "AbhaLink"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "AbhaLink_tenantId_id_key" ON "AbhaLink"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "AbhaLink" ADD CONSTRAINT "AbhaLink_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- ABDM groundwork: docs/abdm.md. An ABHA number is on one live record at a time; removing it keeps the row and says why.

ALTER TABLE "AbdmConfig" ADD CONSTRAINT abdm_config_values CHECK (
  ("clientSecretEnc" IS NULL) = ("secretLast4" IS NULL) AND ("sessionUrl" IS NULL OR "sessionUrl" ~ '^https://' OR "sessionUrl" ~ '^http://(127\.0\.0\.1|localhost)[:/]') AND ("hfrId" IS NULL OR length(btrim("hfrId")) BETWEEN 3 AND 60));

ALTER TABLE "AbhaLink" ADD CONSTRAINT abha_link_values CHECK (
  "abhaNumber" ~ '^[0-9]{14}$' AND ("abhaAddress" IS NULL OR "abhaAddress" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,}@(abdm|sbx)$')
  AND (("removedAt" IS NULL) = ("removedById" IS NULL)) AND (("removedAt" IS NULL) = ("removeReason" IS NULL)) AND ("removeReason" IS NULL OR length(btrim("removeReason")) >= 5));
CREATE UNIQUE INDEX abha_one_live_per_number ON "AbhaLink" ("tenantId", "abhaNumber") WHERE "removedAt" IS NULL;
CREATE UNIQUE INDEX abha_one_live_per_patient ON "AbhaLink" ("tenantId", "patientId") WHERE "removedAt" IS NULL;
CREATE OR REPLACE FUNCTION medos_abha_link_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An ABHA record cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."patientId" <> OLD."patientId" OR NEW."abhaNumber" <> OLD."abhaNumber" OR NEW."abhaAddress" IS DISTINCT FROM OLD."abhaAddress" OR NEW."recordedById" <> OLD."recordedById" THEN
    RAISE EXCEPTION 'An ABHA record cannot be changed, only removed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."removedAt" IS NOT NULL THEN RAISE EXCEPTION 'A removed ABHA record cannot change' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER abha_link_guard BEFORE UPDATE OR DELETE ON "AbhaLink" FOR EACH ROW EXECUTE FUNCTION medos_abha_link_guard();

SELECT medos_enable_tenant_rls('"AbdmConfig"');
SELECT medos_enable_tenant_rls('"AbhaLink"');

