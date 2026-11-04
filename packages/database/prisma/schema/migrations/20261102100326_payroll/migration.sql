-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "Employee" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "userId" UUID,
    "employeeCode" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "department" TEXT,
    "joinedOn" DATE NOT NULL,
    "exitedOn" DATE,
    "bankAccount" TEXT,
    "ifsc" TEXT,
    "pan" TEXT,
    "uan" TEXT,
    "esiNumber" TEXT,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryStructure" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "basic" DECIMAL(14,2) NOT NULL,
    "hra" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherAllowance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "pfApplicable" BOOLEAN NOT NULL DEFAULT true,
    "esiApplicable" BOOLEAN NOT NULL DEFAULT true,
    "ptApplicable" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "gross" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "employerCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "paidById" UUID,
    "paidAt" TIMESTAMPTZ(3),
    "paidOn" DATE,
    "payReference" TEXT,
    "cancelReason" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payslip" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "structureId" UUID NOT NULL,
    "daysInMonth" INTEGER NOT NULL,
    "lopDays" DECIMAL(5,1) NOT NULL DEFAULT 0,
    "basic" DECIMAL(14,2) NOT NULL,
    "hra" DECIMAL(14,2) NOT NULL,
    "otherAllowance" DECIMAL(14,2) NOT NULL,
    "bonus" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gross" DECIMAL(14,2) NOT NULL,
    "pfEmployee" DECIMAL(14,2) NOT NULL,
    "esiEmployee" DECIMAL(14,2) NOT NULL,
    "professionalTax" DECIMAL(14,2) NOT NULL,
    "tds" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherDeduction" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(14,2) NOT NULL,
    "net" DECIMAL(14,2) NOT NULL,
    "pfEmployer" DECIMAL(14,2) NOT NULL,
    "esiEmployer" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Employee_tenantId_facilityId_status_idx" ON "Employee"("tenantId", "facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_id_key" ON "Employee"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_employeeCode_key" ON "Employee"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryStructure_tenantId_id_key" ON "SalaryStructure"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryStructure_tenantId_employeeId_effectiveFrom_key" ON "SalaryStructure"("tenantId", "employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PayrollRun_tenantId_facilityId_month_idx" ON "PayrollRun"("tenantId", "facilityId", "month" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_tenantId_id_key" ON "PayrollRun"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_tenantId_id_key" ON "Payslip"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_tenantId_runId_employeeId_key" ON "Payslip"("tenantId", "runId", "employeeId");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryStructure" ADD CONSTRAINT "SalaryStructure_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_tenantId_runId_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "PayrollRun"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_tenantId_structureId_fkey" FOREIGN KEY ("tenantId", "structureId") REFERENCES "SalaryStructure"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Payroll: docs/payroll.md. Structures are append-only; a run is checked, approved and paid in that order and is frozen once approved; a payslip is frozen with it.

ALTER TABLE "Employee" ADD CONSTRAINT employee_values CHECK (length(btrim("employeeCode")) BETWEEN 2 AND 30 AND length(btrim("fullName")) >= 2 AND length(btrim(designation)) >= 2 AND ("exitedOn" IS NULL OR "exitedOn" >= "joinedOn"));
CREATE TRIGGER employee_no_delete BEFORE DELETE ON "Employee" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE UNIQUE INDEX employee_one_per_user ON "Employee" ("tenantId", "userId") WHERE "userId" IS NOT NULL;

ALTER TABLE "SalaryStructure" ADD CONSTRAINT structure_values CHECK (basic > 0 AND hra >= 0 AND "otherAllowance" >= 0);
CREATE TRIGGER structure_immutable BEFORE UPDATE OR DELETE ON "SalaryStructure" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- One live run per facility and month (a cancelled draft frees the month).
CREATE UNIQUE INDEX payroll_run_one_per_month ON "PayrollRun" ("tenantId", "facilityId", month) WHERE status <> 'CANCELLED';
ALTER TABLE "PayrollRun" ADD CONSTRAINT payroll_run_values CHECK (
  month = date_trunc('month', month)::date AND gross >= 0 AND deductions >= 0 AND net >= 0 AND "employerCost" >= 0
  AND (status NOT IN ('APPROVED', 'PAID') OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL))
  AND (status <> 'PAID' OR ("paidById" IS NOT NULL AND "paidAt" IS NOT NULL AND "paidOn" IS NOT NULL))
  AND (status <> 'CANCELLED' OR ("cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 5)));
CREATE OR REPLACE FUNCTION medos_payroll_run_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A payroll run cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW.month <> OLD.month OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'A payroll run cannot change its month or facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('PAID', 'CANCELLED') THEN RAISE EXCEPTION 'A paid or cancelled payroll run cannot change' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD.status = 'APPROVED' AND (NEW.status <> 'PAID' OR NEW.gross <> OLD.gross OR NEW.net <> OLD.net OR NEW.deductions <> OLD.deductions OR NEW."employerCost" <> OLD."employerCost") THEN
    RAISE EXCEPTION 'An approved payroll run can only be marked paid; its amounts are fixed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' AND NEW."approvedById" = OLD."createdById" THEN
    RAISE EXCEPTION 'A payroll run must be approved by someone other than the person who prepared it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'PAID' THEN RAISE EXCEPTION 'A payroll run must be approved before it is paid' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_run_guard BEFORE UPDATE OR DELETE ON "PayrollRun" FOR EACH ROW EXECUTE FUNCTION medos_payroll_run_guard();

ALTER TABLE "Payslip" ADD CONSTRAINT payslip_values CHECK (
  "daysInMonth" BETWEEN 28 AND 31 AND "lopDays" >= 0 AND "lopDays" <= "daysInMonth" AND basic >= 0 AND hra >= 0 AND "otherAllowance" >= 0 AND bonus >= 0
  AND "pfEmployee" >= 0 AND "esiEmployee" >= 0 AND "professionalTax" >= 0 AND tds >= 0 AND "otherDeduction" >= 0 AND "pfEmployer" >= 0 AND "esiEmployer" >= 0
  AND gross = basic + hra + "otherAllowance" + bonus
  AND "totalDeductions" = "pfEmployee" + "esiEmployee" + "professionalTax" + tds + "otherDeduction"
  AND net = gross - "totalDeductions" AND net >= 0);
-- A payslip belongs to its employee's structure and run; it changes only while the run is a draft.
CREATE OR REPLACE FUNCTION medos_payslip_guard() RETURNS trigger AS $$
DECLARE st text; rid uuid;
BEGIN
  rid := CASE WHEN TG_OP = 'INSERT' THEN NEW."runId" ELSE OLD."runId" END;
  SELECT status::text INTO st FROM "PayrollRun" WHERE id = rid AND "tenantId" = COALESCE(NEW."tenantId", OLD."tenantId");
  IF st IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'The payslips of a payroll run that is not a draft cannot change' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM "SalaryStructure" s WHERE s.id = NEW."structureId" AND s."tenantId" = NEW."tenantId" AND s."employeeId" = NEW."employeeId") THEN
    RAISE EXCEPTION 'A payslip must use a salary structure of the same employee' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."runId" <> OLD."runId" OR NEW."employeeId" <> OLD."employeeId" OR NEW."structureId" <> OLD."structureId") THEN
    RAISE EXCEPTION 'A payslip cannot move to another run, employee or structure' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payslip_guard BEFORE INSERT OR UPDATE OR DELETE ON "Payslip" FOR EACH ROW EXECUTE FUNCTION medos_payslip_guard();

SELECT medos_enable_tenant_rls('"Employee"');
SELECT medos_enable_tenant_rls('"SalaryStructure"');
SELECT medos_enable_tenant_rls('"PayrollRun"');
SELECT medos_enable_tenant_rls('"Payslip"');

INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, 'PAYROLL_OFFICER', true FROM "Tenant" t ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('PAYROLL_OFFICER', 'PAYROLL_READ'), ('PAYROLL_OFFICER', 'PAYROLL_MANAGE'), ('ADMINISTRATOR', 'PAYROLL_READ'), ('ADMINISTRATOR', 'PAYROLL_APPROVE')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration payroll', 'added', jsonb_build_object(
  'PAYROLL_OFFICER', jsonb_build_array('PAYROLL_READ', 'PAYROLL_MANAGE'), 'ADMINISTRATOR', jsonb_build_array('PAYROLL_READ', 'PAYROLL_APPROVE')))
FROM "Tenant" t;

