-- API clients: keys for outside systems and bots to book appointments through the API. New table, one flag on User.
-- CreateEnum
CREATE TYPE "ApiClientStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isService" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ApiClient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "abilities" TEXT[],
    "status" "ApiClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "revokeReason" TEXT,

    CONSTRAINT "ApiClient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiClient_tenantId_status_idx" ON "ApiClient"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_tenantId_id_key" ON "ApiClient"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_tenantId_name_key" ON "ApiClient"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_keyHash_key" ON "ApiClient"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_tenantId_userId_key" ON "ApiClient"("tenantId", "userId");

-- AddForeignKey
ALTER TABLE "ApiClient" ADD CONSTRAINT "ApiClient_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiClient" ADD CONSTRAINT "ApiClient_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiClient" ADD CONSTRAINT "ApiClient_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== hand-written rules (docs/integration-api.md) =====
ALTER TABLE "ApiClient" ADD CONSTRAINT api_client_name CHECK (length(btrim(name)) BETWEEN 2 AND 60);
ALTER TABLE "ApiClient" ADD CONSTRAINT api_client_revoked CHECK ((status = 'REVOKED') = ("revokedAt" IS NOT NULL));
-- The key, its owner and where it works never change; a revoked client is never reactivated (create a new one); clients are never deleted.
CREATE OR REPLACE FUNCTION medos_api_client_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."keyHash" <> OLD."keyHash" OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."userId" <> OLD."userId" OR NEW."roleId" <> OLD."roleId" THEN
    RAISE EXCEPTION 'An API client''s key, hospital, facility and identity cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'A revoked API client cannot be reactivated' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER api_client_guard BEFORE UPDATE ON "ApiClient" FOR EACH ROW EXECUTE FUNCTION medos_api_client_guard();
CREATE TRIGGER api_client_no_delete BEFORE DELETE ON "ApiClient" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

SELECT medos_enable_tenant_rls('"ApiClient"');

-- A key is presented without saying which hospital it belongs to; this narrow function finds it by the key's hash (the caller must hold the key),
-- like medos_resolve_refresh_token does for refresh tokens. Everything after it runs under that hospital's own scope.
CREATE OR REPLACE FUNCTION medos_resolve_api_key(p_hash text) RETURNS TABLE (tenant_id uuid, client_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT c."tenantId", c.id FROM public."ApiClient" c WHERE c."keyHash" = p_hash $$;
REVOKE ALL ON FUNCTION medos_resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_resolve_api_key(text) TO medos_app;

-- Permission to manage API clients: held by the Administrator role.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT "tenantId", id, 'ADMIN_INTEGRATIONS' FROM "Role" WHERE name = 'ADMINISTRATOR' AND "isSystem"
ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261029220000_api_clients', 'added', jsonb_build_object('ADMINISTRATOR', jsonb_build_array('ADMIN_INTEGRATIONS')))
FROM "Tenant" t;
