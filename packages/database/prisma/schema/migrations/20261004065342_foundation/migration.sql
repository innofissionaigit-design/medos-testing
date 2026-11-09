-- CreateEnum
CREATE TYPE "ActiveStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ResetPolicy" AS ENUM ('NEVER', 'YEARLY');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Facility" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "district" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFacility" (
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,

    CONSTRAINT "UserFacility_pkey" PRIMARY KEY ("userId","facilityId")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "tenantId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permission")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "replacedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "requestId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NumberSequenceConfig" (
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "resetPolicy" "ResetPolicy" NOT NULL DEFAULT 'NEVER',

    CONSTRAINT "NumberSequenceConfig_pkey" PRIMARY KEY ("tenantId","facilityId","type")
);

-- CreateTable
CREATE TABLE "NumberSequence" (
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL DEFAULT '',
    "lastValue" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "NumberSequence_pkey" PRIMARY KEY ("tenantId","facilityId","type","periodKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_code_key" ON "Tenant"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Facility_tenantId_id_key" ON "Facility"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Facility_tenantId_code_key" ON "Facility"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_id_key" ON "User"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_username_key" ON "User"("tenantId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");

-- CreateIndex
CREATE INDEX "UserFacility_tenantId_facilityId_idx" ON "UserFacility"("tenantId", "facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_id_key" ON "Role"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_name_key" ON "Role"("tenantId", "name");

-- CreateIndex
CREATE INDEX "UserRole_tenantId_roleId_idx" ON "UserRole"("tenantId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_tenantId_userId_idx" ON "RefreshToken"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_entityType_entityId_idx" ON "AuditEvent"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_action_createdAt_idx" ON "AuditEvent"("tenantId", "action", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Facility" ADD CONSTRAINT "Facility_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFacility" ADD CONSTRAINT "UserFacility_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFacility" ADD CONSTRAINT "UserFacility_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberSequenceConfig" ADD CONSTRAINT "NumberSequenceConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberSequenceConfig" ADD CONSTRAINT "NumberSequenceConfig_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberSequence" ADD CONSTRAINT "NumberSequence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberSequence" ADD CONSTRAINT "NumberSequence_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== Hand-written invariants (not expressible in Prisma) =====

-- Audit log is append-only: no UPDATE, DELETE or TRUNCATE.
CREATE OR REPLACE FUNCTION medos_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "Tenant" ADD CONSTRAINT tenant_code_format CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,31}$');
ALTER TABLE "Facility" ADD CONSTRAINT facility_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$');
ALTER TABLE "User" ADD CONSTRAINT user_failed_login_nonneg CHECK ("failedLoginCount" >= 0);
ALTER TABLE "NumberSequence" ADD CONSTRAINT number_sequence_nonneg CHECK ("lastValue" >= 0);
ALTER TABLE "NumberSequenceConfig" ADD CONSTRAINT number_config_padding CHECK (padding BETWEEN 1 AND 12);