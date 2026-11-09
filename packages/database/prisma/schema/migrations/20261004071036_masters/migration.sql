-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Practitioner" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "userId" UUID,
    "departmentId" UUID,
    "displayName" TEXT NOT NULL,
    "specialty" TEXT,
    "registrationNo" TEXT,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Practitioner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Department_tenantId_facilityId_status_idx" ON "Department"("tenantId", "facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Department_tenantId_id_key" ON "Department"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Department_tenantId_facilityId_code_key" ON "Department"("tenantId", "facilityId", "code");

-- CreateIndex
CREATE INDEX "Practitioner_tenantId_facilityId_status_idx" ON "Practitioner"("tenantId", "facilityId", "status");

-- CreateIndex
CREATE INDEX "Practitioner_departmentId_idx" ON "Practitioner"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Practitioner_tenantId_id_key" ON "Practitioner"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Practitioner_tenantId_facilityId_userId_key" ON "Practitioner"("tenantId", "facilityId", "userId");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Practitioner" ADD CONSTRAINT "Practitioner_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Practitioner" ADD CONSTRAINT "Practitioner_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Practitioner" ADD CONSTRAINT "Practitioner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Practitioner" ADD CONSTRAINT "Practitioner_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== Hand-written invariants =====

-- Generic scope guard for OPTIONAL references (Prisma cannot model optional composite FKs).
-- Usage: CREATE TRIGGER ... EXECUTE FUNCTION medos_same_scope('<ParentTable>', '<fkColumn>');
-- Rejects a reference whose parent belongs to another tenant, or (when both rows have a
-- facilityId) to another facility.
CREATE OR REPLACE FUNCTION medos_same_scope() RETURNS trigger AS $$
DECLARE
  parent_table text := TG_ARGV[0];
  col text := TG_ARGV[1];
  ref uuid;
  parent jsonb;
  child jsonb := to_jsonb(NEW);
BEGIN
  ref := NULLIF(child->>col, '')::uuid;
  IF ref IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT to_jsonb(p) FROM %I p WHERE p.id = $1', parent_table) INTO parent USING ref;
  IF parent IS NULL OR parent->>'tenantId' IS DISTINCT FROM child->>'tenantId' THEN
    RAISE EXCEPTION 'Invalid reference %.% -> %', TG_TABLE_NAME, col, parent_table USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF parent ? 'facilityId' AND child ? 'facilityId'
     AND parent->>'facilityId' IS NOT NULL AND child->>'facilityId' IS NOT NULL
     AND parent->>'facilityId' IS DISTINCT FROM child->>'facilityId' THEN
    RAISE EXCEPTION 'Cross-facility reference %.% -> %', TG_TABLE_NAME, col, parent_table USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER practitioner_scope_user BEFORE INSERT OR UPDATE OF "userId" ON "Practitioner"
  FOR EACH ROW EXECUTE FUNCTION medos_same_scope('User', 'userId');
CREATE TRIGGER practitioner_scope_department BEFORE INSERT OR UPDATE OF "departmentId" ON "Practitioner"
  FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Department', 'departmentId');

ALTER TABLE "Department" ADD CONSTRAINT department_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$');