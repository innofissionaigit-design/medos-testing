-- Payroll extras (docs/payroll.md): half-day leave, carry-forward of leave, a holiday calendar, and arrears on payslips.

-- AlterTable
ALTER TABLE "AttendanceDay" ADD COLUMN     "halfDay" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "halfDay" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "LeaveType" ADD COLUMN     "carryForwardMax" DECIMAL(5,1) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payslip" ADD COLUMN     "arrears" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "arrearsNote" TEXT;

-- CreateTable
CREATE TABLE "PayrollHoliday" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayslipArrearsCover" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "payslipId" UUID NOT NULL,
    "coveredPayslipId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayslipArrearsCover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollHoliday_tenantId_id_key" ON "PayrollHoliday"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollHoliday_tenantId_facilityId_date_key" ON "PayrollHoliday"("tenantId", "facilityId", "date");

-- CreateIndex
CREATE INDEX "PayslipArrearsCover_tenantId_coveredPayslipId_idx" ON "PayslipArrearsCover"("tenantId", "coveredPayslipId");

-- CreateIndex
CREATE INDEX "PayslipArrearsCover_tenantId_payslipId_idx" ON "PayslipArrearsCover"("tenantId", "payslipId");

-- CreateIndex
CREATE UNIQUE INDEX "PayslipArrearsCover_tenantId_id_key" ON "PayslipArrearsCover"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "PayslipArrearsCover" ADD CONSTRAINT "PayslipArrearsCover_tenantId_payslipId_fkey" FOREIGN KEY ("tenantId", "payslipId") REFERENCES "Payslip"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipArrearsCover" ADD CONSTRAINT "PayslipArrearsCover_tenantId_coveredPayslipId_fkey" FOREIGN KEY ("tenantId", "coveredPayslipId") REFERENCES "Payslip"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Payroll extras (docs/payroll.md): half-day leave, carry-forward of leave, the holiday calendar and arrears.

ALTER TABLE "LeaveType" ADD CONSTRAINT leave_type_carry CHECK ("carryForwardMax" >= 0 AND "carryForwardMax" <= 366 AND ("yearlyAllowance" IS NOT NULL OR "carryForwardMax" = 0));
ALTER TABLE "LeaveRequest" ADD CONSTRAINT leave_request_half CHECK (NOT "halfDay" OR ("fromDate" = "toDate" AND (days IS NULL OR days = 0.5)));
ALTER TABLE "AttendanceDay" ADD CONSTRAINT attendance_half CHECK (NOT "halfDay" OR status = 'ON_LEAVE');

-- Whether the leave is a half day can no longer change after it is applied for.
CREATE OR REPLACE FUNCTION medos_leave_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A leave application cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."employeeId" <> OLD."employeeId" OR NEW."leaveTypeId" <> OLD."leaveTypeId"
     OR NEW."fromDate" <> OLD."fromDate" OR NEW."toDate" <> OLD."toDate" OR NEW."halfDay" <> OLD."halfDay" OR NEW."requestedById" <> OLD."requestedById" THEN
    RAISE EXCEPTION 'A leave application cannot change its person, type or dates' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('REJECTED', 'CANCELLED') THEN RAISE EXCEPTION 'A rejected or cancelled leave application cannot change' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD.status = 'APPROVED' AND (NEW.status <> 'CANCELLED' OR NEW.days IS DISTINCT FROM OLD.days OR NEW."decidedById" IS DISTINCT FROM OLD."decidedById") THEN
    RAISE EXCEPTION 'An approved leave application can only be cancelled' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED') AND NEW."decidedById" = OLD."requestedById" THEN
    RAISE EXCEPTION 'Leave must be decided by someone other than the person who asked for it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Arrears are part of gross pay (they are not a deduction base; see docs/payroll.md).
ALTER TABLE "Payslip" DROP CONSTRAINT payslip_values;
ALTER TABLE "Payslip" ADD CONSTRAINT payslip_values CHECK (
  "daysInMonth" BETWEEN 28 AND 31 AND "lopDays" >= 0 AND "lopDays" <= "daysInMonth" AND basic >= 0 AND hra >= 0 AND "otherAllowance" >= 0 AND bonus >= 0 AND arrears >= 0
  AND "pfEmployee" >= 0 AND "esiEmployee" >= 0 AND "professionalTax" >= 0 AND tds >= 0 AND "otherDeduction" >= 0 AND "pfEmployer" >= 0 AND "esiEmployer" >= 0
  AND gross = basic + hra + "otherAllowance" + bonus + arrears
  AND "totalDeductions" = "pfEmployee" + "esiEmployee" + "professionalTax" + tds + "otherDeduction"
  AND net = gross - "totalDeductions" AND net >= 0 AND ("arrearsNote" IS NULL OR length("arrearsNote") <= 200));

-- The holiday calendar: a holiday is never edited; adding or removing one in a month that has a live payroll run is refused so payslips keep matching the sheet.
ALTER TABLE "PayrollHoliday" ADD CONSTRAINT holiday_values CHECK (length(btrim(name)) BETWEEN 2 AND 80);
CREATE OR REPLACE FUNCTION medos_holiday_guard() RETURNS trigger AS $$
DECLARE d date; fac uuid; ten uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'A holiday cannot be edited; remove it and add it again' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  d := CASE WHEN TG_OP = 'DELETE' THEN OLD.date ELSE NEW.date END;
  fac := CASE WHEN TG_OP = 'DELETE' THEN OLD."facilityId" ELSE NEW."facilityId" END;
  ten := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
  IF EXISTS (SELECT 1 FROM "PayrollRun" r WHERE r."tenantId" = ten AND r."facilityId" = fac AND r.month = date_trunc('month', d)::date AND r.status <> 'CANCELLED') THEN
    RAISE EXCEPTION 'Holidays of a month with a payroll run cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER holiday_guard BEFORE INSERT OR UPDATE OR DELETE ON "PayrollHoliday" FOR EACH ROW EXECUTE FUNCTION medos_holiday_guard();

-- Arrears cover: written once, while the paying payslip's run is a draft. It must be for the same employee's earlier, approved month, and an earlier month's payslip
-- is covered at most once by a run that is not cancelled (a cancelled run frees it again).
ALTER TABLE "PayslipArrearsCover" ADD CONSTRAINT arrears_cover_values CHECK (amount > 0 AND "payslipId" <> "coveredPayslipId");
CREATE TRIGGER arrears_cover_immutable BEFORE UPDATE OR DELETE ON "PayslipArrearsCover" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE OR REPLACE FUNCTION medos_arrears_cover_guard() RETURNS trigger AS $$
DECLARE pay_run text; pay_month date; pay_emp uuid; cov_run text; cov_month date; cov_emp uuid;
BEGIN
  SELECT r.status::text, r.month, p."employeeId" INTO pay_run, pay_month, pay_emp FROM "Payslip" p JOIN "PayrollRun" r ON r.id = p."runId" AND r."tenantId" = p."tenantId" WHERE p.id = NEW."payslipId" AND p."tenantId" = NEW."tenantId";
  SELECT r.status::text, r.month, p."employeeId" INTO cov_run, cov_month, cov_emp FROM "Payslip" p JOIN "PayrollRun" r ON r.id = p."runId" AND r."tenantId" = p."tenantId" WHERE p.id = NEW."coveredPayslipId" AND p."tenantId" = NEW."tenantId";
  IF pay_run IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'Arrears can only be added to a payslip of a draft payroll run' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF cov_emp IS DISTINCT FROM pay_emp THEN RAISE EXCEPTION 'Arrears must be for the same employee' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF cov_run NOT IN ('APPROVED', 'PAID') OR cov_month >= pay_month THEN RAISE EXCEPTION 'Arrears are for an earlier month whose payroll was approved' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('arrears-cover:' || NEW."coveredPayslipId"::text, 0));
  IF EXISTS (SELECT 1 FROM "PayslipArrearsCover" c JOIN "Payslip" p ON p.id = c."payslipId" AND p."tenantId" = c."tenantId" JOIN "PayrollRun" r ON r.id = p."runId" AND r."tenantId" = p."tenantId"
             WHERE c."tenantId" = NEW."tenantId" AND c."coveredPayslipId" = NEW."coveredPayslipId" AND r.status <> 'CANCELLED') THEN
    RAISE EXCEPTION 'The arrears for that month have already been added to a payslip' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER arrears_cover_guard BEFORE INSERT ON "PayslipArrearsCover" FOR EACH ROW EXECUTE FUNCTION medos_arrears_cover_guard();

SELECT medos_enable_tenant_rls('"PayrollHoliday"');
SELECT medos_enable_tenant_rls('"PayslipArrearsCover"');
