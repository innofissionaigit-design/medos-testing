-- CreateTable
CREATE TABLE "UserDepartment" (
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDepartment_pkey" PRIMARY KEY ("userId","departmentId")
);

-- CreateIndex
CREATE INDEX "UserDepartment_tenantId_departmentId_idx" ON "UserDepartment"("tenantId", "departmentId");

-- AddForeignKey
ALTER TABLE "UserDepartment" ADD CONSTRAINT "UserDepartment_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDepartment" ADD CONSTRAINT "UserDepartment_tenantId_departmentId_fkey" FOREIGN KEY ("tenantId", "departmentId") REFERENCES "Department"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Which departments a staff member belongs to; row-level security like every hospital-owned table.
SELECT medos_enable_tenant_rls('"UserDepartment"');

-- Organisation-wide data access: the Administrator role sees every department, doctor, patient and report.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'DATA_SCOPE_ALL' FROM "Role" r WHERE r."isSystem" AND r.name = 'ADMINISTRATOR'
ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration data_scope', 'added', jsonb_build_object('ADMINISTRATOR', jsonb_build_array('DATA_SCOPE_ALL')))
FROM "Tenant" t;

