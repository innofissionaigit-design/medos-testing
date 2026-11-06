-- Attendance and leave (docs/payroll.md): daily attendance, leave types and leave applications, feeding the monthly payroll run.

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY');

-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "LeaveType" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "yearlyAllowance" DECIMAL(5,1),
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "leaveTypeId" UUID NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "days" DECIMAL(5,1),
    "reason" TEXT,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceDay" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "leaveRequestId" UUID,
    "note" TEXT,
    "markedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AttendanceDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_tenantId_id_key" ON "LeaveType"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_tenantId_facilityId_name_key" ON "LeaveType"("tenantId", "facilityId", "name");

-- CreateIndex
CREATE INDEX "LeaveRequest_tenantId_facilityId_status_fromDate_idx" ON "LeaveRequest"("tenantId", "facilityId", "status", "fromDate" DESC);

-- CreateIndex
CREATE INDEX "LeaveRequest_tenantId_employeeId_fromDate_idx" ON "LeaveRequest"("tenantId", "employeeId", "fromDate" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LeaveRequest_tenantId_id_key" ON "LeaveRequest"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AttendanceDay_tenantId_facilityId_date_idx" ON "AttendanceDay"("tenantId", "facilityId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDay_tenantId_id_key" ON "AttendanceDay"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDay_tenantId_employeeId_date_key" ON "AttendanceDay"("tenantId", "employeeId", "date");

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_tenantId_leaveTypeId_fkey" FOREIGN KEY ("tenantId", "leaveTypeId") REFERENCES "LeaveType"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_tenantId_leaveRequestId_fkey" FOREIGN KEY ("tenantId", "leaveRequestId") REFERENCES "LeaveRequest"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Leave types and leave applications are never deleted. An application is decided once; an approved one can only be cancelled. Attendance days are corrected (and
-- audited) by the application, but a month that has a live payroll run is frozen so the figures on its payslips always match the attendance they came from.

ALTER TABLE "LeaveType" ADD CONSTRAINT leave_type_values CHECK (length(btrim(name)) BETWEEN 2 AND 60 AND ("yearlyAllowance" IS NULL OR ("yearlyAllowance" >= 0 AND "yearlyAllowance" <= 366)));
CREATE TRIGGER leave_type_no_delete BEFORE DELETE ON "LeaveType" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "LeaveRequest" ADD CONSTRAINT leave_request_values CHECK (
  "toDate" >= "fromDate" AND extract(year FROM "toDate") = extract(year FROM "fromDate") AND "toDate" - "fromDate" < 366
  AND (days IS NULL OR (days > 0 AND days <= "toDate" - "fromDate" + 1))
  AND (reason IS NULL OR length(btrim(reason)) <= 300)
  AND (status <> 'APPROVED' OR (days IS NOT NULL AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL))
  AND (status <> 'REJECTED' OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decisionNote" IS NOT NULL AND length(btrim("decisionNote")) >= 3)));
-- Nobody decides their own leave: the person who decides must differ from the person who asked.
CREATE OR REPLACE FUNCTION medos_leave_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A leave application cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."employeeId" <> OLD."employeeId" OR NEW."leaveTypeId" <> OLD."leaveTypeId"
     OR NEW."fromDate" <> OLD."fromDate" OR NEW."toDate" <> OLD."toDate" OR NEW."requestedById" <> OLD."requestedById" THEN
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
CREATE TRIGGER leave_request_guard BEFORE UPDATE OR DELETE ON "LeaveRequest" FOR EACH ROW EXECUTE FUNCTION medos_leave_request_guard();

ALTER TABLE "AttendanceDay" ADD CONSTRAINT attendance_values CHECK (
  (status = 'ON_LEAVE') = ("leaveRequestId" IS NOT NULL) AND (note IS NULL OR length(btrim(note)) <= 200));
CREATE OR REPLACE FUNCTION medos_attendance_guard() RETURNS trigger AS $$
DECLARE d date; fac uuid; ten uuid;
BEGIN
  d := CASE WHEN TG_OP = 'DELETE' THEN OLD.date ELSE NEW.date END;
  fac := CASE WHEN TG_OP = 'DELETE' THEN OLD."facilityId" ELSE NEW."facilityId" END;
  ten := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
  IF TG_OP = 'UPDATE' AND (NEW."employeeId" <> OLD."employeeId" OR NEW.date <> OLD.date OR NEW."facilityId" <> OLD."facilityId") THEN
    RAISE EXCEPTION 'An attendance day cannot move to another person or date' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "PayrollRun" r WHERE r."tenantId" = ten AND r."facilityId" = fac AND r.month = date_trunc('month', d)::date AND r.status <> 'CANCELLED') THEN
    RAISE EXCEPTION 'Attendance of a month with a payroll run cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER attendance_guard BEFORE INSERT OR UPDATE OR DELETE ON "AttendanceDay" FOR EACH ROW EXECUTE FUNCTION medos_attendance_guard();

SELECT medos_enable_tenant_rls('"LeaveType"');
SELECT medos_enable_tenant_rls('"LeaveRequest"');
SELECT medos_enable_tenant_rls('"AttendanceDay"');

INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('PAYROLL_OFFICER', 'ATTENDANCE_MANAGE'), ('ADMINISTRATOR', 'LEAVE_APPROVE')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration attendance_leave', 'added', jsonb_build_object(
  'PAYROLL_OFFICER', jsonb_build_array('ATTENDANCE_MANAGE'), 'ADMINISTRATOR', jsonb_build_array('LEAVE_APPROVE')))
FROM "Tenant" t;
