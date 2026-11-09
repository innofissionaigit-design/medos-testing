-- CreateEnum
CREATE TYPE "AiProviderKind" AS ENUM ('ANTHROPIC', 'HTTP');

-- CreateEnum
CREATE TYPE "AiTask" AS ENUM ('HISTORY_SUMMARY', 'VISIT_ADVICE');

-- CreateEnum
CREATE TYPE "AiDraftStatus" AS ENUM ('DRAFT', 'USED', 'DISCARDED');

-- CreateTable
CREATE TABLE "AiConfig" (
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "kind" "AiProviderKind" NOT NULL,
    "url" TEXT,
    "model" TEXT,
    "apiKeyEnc" TEXT,
    "keyLast4" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "dataAckAt" TIMESTAMPTZ(3),
    "dataAckById" UUID,
    "lastTestAt" TIMESTAMPTZ(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "updatedById" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiConfig_pkey" PRIMARY KEY ("tenantId","facilityId")
);

-- CreateTable
CREATE TABLE "AiDraft" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "task" "AiTask" NOT NULL,
    "status" "AiDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "outputText" TEXT NOT NULL,
    "inputChars" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMPTZ(3),
    "edited" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AiDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiDraft_tenantId_encounterId_requestedAt_idx" ON "AiDraft"("tenantId", "encounterId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "AiDraft_tenantId_requestedById_requestedAt_idx" ON "AiDraft"("tenantId", "requestedById", "requestedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AiDraft_tenantId_id_key" ON "AiDraft"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- AI assistant: docs/ai-assistant.md. A draft is a record of what the AI wrote; only its review can change, and only once.

ALTER TABLE "AiConfig" ADD CONSTRAINT ai_config_values CHECK (
  ("apiKeyEnc" IS NULL) = ("keyLast4" IS NULL) AND "timeoutMs" BETWEEN 1000 AND 120000
  AND (url IS NULL OR url ~ '^https://' OR url ~ '^http://(127\.0\.0\.1|localhost)[:/]')
  AND (kind <> 'HTTP' OR url IS NOT NULL) AND (kind <> 'ANTHROPIC' OR (model IS NOT NULL AND length(btrim(model)) >= 3))
  AND (("dataAckAt" IS NULL) = ("dataAckById" IS NULL)));

ALTER TABLE "AiDraft" ADD CONSTRAINT ai_draft_values CHECK (length(btrim("outputText")) >= 1 AND "inputChars" >= 0 AND (status = 'DRAFT') = ("reviewedAt" IS NULL) AND (edited = false OR status = 'USED'));
CREATE OR REPLACE FUNCTION medos_ai_draft_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An AI draft record cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."encounterId" <> OLD."encounterId"
     OR NEW.task <> OLD.task OR NEW."outputText" <> OLD."outputText" OR NEW."inputChars" <> OLD."inputChars" OR NEW.provider <> OLD.provider OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW."requestedById" <> OLD."requestedById" OR NEW."requestedAt" <> OLD."requestedAt" THEN
    RAISE EXCEPTION 'What the AI wrote cannot be changed; only the review is recorded' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'A reviewed AI draft cannot change' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ai_draft_guard BEFORE UPDATE OR DELETE ON "AiDraft" FOR EACH ROW EXECUTE FUNCTION medos_ai_draft_guard();

SELECT medos_enable_tenant_rls('"AiConfig"');
SELECT medos_enable_tenant_rls('"AiDraft"');

INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES ('DOCTOR', 'AI_USE'), ('ADMINISTRATOR', 'AI_CONFIGURE')) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration ai', 'added', jsonb_build_object('DOCTOR', jsonb_build_array('AI_USE'), 'ADMINISTRATOR', jsonb_build_array('AI_CONFIGURE')))
FROM "Tenant" t;

