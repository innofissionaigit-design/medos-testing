-- CreateEnum
CREATE TYPE "BedStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "AdmissionStatus" AS ENUM ('ADMITTED', 'DISCHARGED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChargeType" AS ENUM ('BED', 'DOCTOR_VISIT', 'PROCEDURE', 'MEDICINE', 'SERVICE');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('PENDING', 'BILLED', 'VOIDED');

-- CreateTable
CREATE TABLE "Ward" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Ward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "wardId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bed" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "wardId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "BedStatus" NOT NULL DEFAULT 'AVAILABLE',
    "active" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "dailyRate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Bed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Admission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "admissionNumber" TEXT NOT NULL,
    "consultantId" UUID NOT NULL,
    "departmentId" UUID,
    "admittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "AdmissionStatus" NOT NULL DEFAULT 'ADMITTED',
    "reason" TEXT,
    "dischargedAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Admission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BedAssignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "bedId" UUID NOT NULL,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMPTZ(3),
    "reason" TEXT,
    "dailyRate" DECIMAL(12,2) NOT NULL,
    "assignedById" UUID NOT NULL,

    CONSTRAINT "BedAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Charge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "type" "ChargeType" NOT NULL,
    "serviceId" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "taxPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "status" "ChargeStatus" NOT NULL DEFAULT 'PENDING',
    "sourceKey" TEXT,
    "chargedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chargedById" UUID NOT NULL,
    "invoiceId" UUID,
    "voidReason" TEXT,
    "voidedById" UUID,
    "voidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Charge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ward_tenantId_id_key" ON "Ward"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Ward_tenantId_facilityId_id_key" ON "Ward"("tenantId", "facilityId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Ward_tenantId_facilityId_code_key" ON "Ward"("tenantId", "facilityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Room_tenantId_id_key" ON "Room"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Room_tenantId_facilityId_id_key" ON "Room"("tenantId", "facilityId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Room_tenantId_facilityId_code_key" ON "Room"("tenantId", "facilityId", "code");

-- CreateIndex
CREATE INDEX "Bed_tenantId_facilityId_wardId_status_idx" ON "Bed"("tenantId", "facilityId", "wardId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Bed_tenantId_id_key" ON "Bed"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Bed_tenantId_facilityId_id_key" ON "Bed"("tenantId", "facilityId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Bed_tenantId_facilityId_code_key" ON "Bed"("tenantId", "facilityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Admission_encounterId_key" ON "Admission"("encounterId");

-- CreateIndex
CREATE INDEX "Admission_tenantId_facilityId_status_admittedAt_idx" ON "Admission"("tenantId", "facilityId", "status", "admittedAt" DESC);

-- CreateIndex
CREATE INDEX "Admission_tenantId_patientId_admittedAt_idx" ON "Admission"("tenantId", "patientId", "admittedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Admission_tenantId_id_key" ON "Admission"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Admission_tenantId_facilityId_id_key" ON "Admission"("tenantId", "facilityId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Admission_tenantId_facilityId_admissionNumber_key" ON "Admission"("tenantId", "facilityId", "admissionNumber");

-- CreateIndex
CREATE INDEX "BedAssignment_tenantId_admissionId_assignedAt_idx" ON "BedAssignment"("tenantId", "admissionId", "assignedAt");

-- CreateIndex
CREATE INDEX "BedAssignment_tenantId_bedId_assignedAt_idx" ON "BedAssignment"("tenantId", "bedId", "assignedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "BedAssignment_tenantId_id_key" ON "BedAssignment"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Charge_tenantId_admissionId_status_idx" ON "Charge"("tenantId", "admissionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Charge_tenantId_id_key" ON "Charge"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Charge_tenantId_sourceKey_key" ON "Charge"("tenantId", "sourceKey");

-- AddForeignKey
ALTER TABLE "Ward" ADD CONSTRAINT "Ward_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_tenantId_facilityId_wardId_fkey" FOREIGN KEY ("tenantId", "facilityId", "wardId") REFERENCES "Ward"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bed" ADD CONSTRAINT "Bed_tenantId_facilityId_wardId_fkey" FOREIGN KEY ("tenantId", "facilityId", "wardId") REFERENCES "Ward"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bed" ADD CONSTRAINT "Bed_tenantId_facilityId_roomId_fkey" FOREIGN KEY ("tenantId", "facilityId", "roomId") REFERENCES "Room"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Admission" ADD CONSTRAINT "Admission_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Admission" ADD CONSTRAINT "Admission_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Admission" ADD CONSTRAINT "Admission_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Admission" ADD CONSTRAINT "Admission_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Admission" ADD CONSTRAINT "Admission_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BedAssignment" ADD CONSTRAINT "BedAssignment_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BedAssignment" ADD CONSTRAINT "BedAssignment_tenantId_facilityId_bedId_fkey" FOREIGN KEY ("tenantId", "facilityId", "bedId") REFERENCES "Bed"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- ===== scope guards for single-column references =====
CREATE TRIGGER admission_scope_consultant BEFORE INSERT OR UPDATE OF "consultantId" ON "Admission" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Practitioner', 'consultantId');
CREATE TRIGGER admission_scope_department BEFORE INSERT OR UPDATE OF "departmentId" ON "Admission" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Department', 'departmentId');
CREATE TRIGGER admission_scope_encounter BEFORE INSERT OR UPDATE OF "encounterId" ON "Admission" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Encounter', 'encounterId');
CREATE TRIGGER charge_scope_service BEFORE INSERT OR UPDATE OF "serviceId" ON "Charge" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Service', 'serviceId');
CREATE TRIGGER charge_scope_invoice BEFORE INSERT OR UPDATE OF "invoiceId" ON "Charge" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Invoice', 'invoiceId');

-- ===== masters: wards / rooms / beds =====
ALTER TABLE "Ward" ADD CONSTRAINT ward_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$');
ALTER TABLE "Room" ADD CONSTRAINT room_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$');
ALTER TABLE "Bed" ADD CONSTRAINT bed_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$');
ALTER TABLE "Bed" ADD CONSTRAINT bed_rate_nonneg CHECK ("dailyRate" >= 0);
-- A retired bed must not be in use.
ALTER TABLE "Bed" ADD CONSTRAINT bed_inactive_not_occupied CHECK (active = 'ACTIVE' OR status NOT IN ('OCCUPIED', 'RESERVED'));

CREATE OR REPLACE FUNCTION medos_bed_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."wardId" <> OLD."wardId" OR NEW."roomId" <> OLD."roomId" THEN
    RAISE EXCEPTION 'A bed cannot move between rooms or wards' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status::text, NEW.status::text) NOT IN (
    ('AVAILABLE', 'OCCUPIED'), ('AVAILABLE', 'RESERVED'), ('AVAILABLE', 'MAINTENANCE'), ('AVAILABLE', 'CLEANING'),
    ('RESERVED', 'OCCUPIED'), ('RESERVED', 'AVAILABLE'), ('RESERVED', 'MAINTENANCE'),
    ('OCCUPIED', 'CLEANING'), ('OCCUPIED', 'AVAILABLE'),
    ('CLEANING', 'AVAILABLE'), ('CLEANING', 'MAINTENANCE'),
    ('MAINTENANCE', 'AVAILABLE'), ('MAINTENANCE', 'CLEANING')) THEN
    RAISE EXCEPTION 'Invalid bed status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER bed_guard BEFORE UPDATE ON "Bed" FOR EACH ROW EXECUTE FUNCTION medos_bed_guard();
CREATE TRIGGER ward_no_delete BEFORE DELETE ON "Ward" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER room_no_delete BEFORE DELETE ON "Room" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER bed_no_delete BEFORE DELETE ON "Bed" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== admissions =====
-- A patient has at most one current admission.
CREATE UNIQUE INDEX "Admission_one_active_per_patient" ON "Admission" ("tenantId", "patientId") WHERE status = 'ADMITTED';
ALTER TABLE "Admission" ADD CONSTRAINT admission_discharge_matches_status CHECK (
  (status = 'ADMITTED' AND "dischargedAt" IS NULL) OR (status = 'DISCHARGED' AND "dischargedAt" IS NOT NULL) OR status = 'CANCELLED');
ALTER TABLE "Admission" ADD CONSTRAINT admission_discharge_after_admit CHECK ("dischargedAt" IS NULL OR "dischargedAt" >= "admittedAt");
ALTER TABLE "Admission" ADD CONSTRAINT admission_cancel_has_reason CHECK (status <> 'CANCELLED' OR ("cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 3));

CREATE OR REPLACE FUNCTION medos_admission_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."encounterId" <> OLD."encounterId"
     OR NEW."admissionNumber" <> OLD."admissionNumber" OR NEW."admittedAt" <> OLD."admittedAt" THEN
    RAISE EXCEPTION 'Admission identity fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND OLD.status <> 'ADMITTED' THEN
    RAISE EXCEPTION 'A closed admission cannot be reopened' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER admission_guard BEFORE UPDATE ON "Admission" FOR EACH ROW EXECUTE FUNCTION medos_admission_guard();
CREATE TRIGGER admission_no_delete BEFORE DELETE ON "Admission" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== bed assignments: history is preserved, double-allocation is impossible =====
CREATE UNIQUE INDEX "BedAssignment_one_open_per_bed" ON "BedAssignment" ("tenantId", "bedId") WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "BedAssignment_one_open_per_admission" ON "BedAssignment" ("tenantId", "admissionId") WHERE "releasedAt" IS NULL;
ALTER TABLE "BedAssignment" ADD CONSTRAINT assignment_release_after_assign CHECK ("releasedAt" IS NULL OR "releasedAt" >= "assignedAt");
ALTER TABLE "BedAssignment" ADD CONSTRAINT assignment_rate_nonneg CHECK ("dailyRate" >= 0);
-- Overlapping stays in one bed are impossible even across closed assignments.
ALTER TABLE "BedAssignment" ADD CONSTRAINT assignment_no_bed_overlap EXCLUDE USING gist (
  "tenantId" WITH =, "bedId" WITH =, tstzrange("assignedAt", COALESCE("releasedAt", 'infinity'::timestamptz), '[)') WITH &&);
CREATE OR REPLACE FUNCTION medos_assignment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bed assignment history cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Only closing an open assignment is allowed.
  IF OLD."releasedAt" IS NOT NULL OR (to_jsonb(NEW) - 'releasedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'releasedAt') THEN
    RAISE EXCEPTION 'Bed assignment history cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER assignment_guard BEFORE UPDATE OR DELETE ON "BedAssignment" FOR EACH ROW EXECUTE FUNCTION medos_assignment_guard();

-- ===== charges =====
ALTER TABLE "Charge" ADD CONSTRAINT charge_numbers CHECK (quantity > 0 AND "unitPrice" >= 0 AND "taxPercent" BETWEEN 0 AND 100);
ALTER TABLE "Charge" ADD CONSTRAINT charge_billed_has_invoice CHECK ((status = 'BILLED') = ("invoiceId" IS NOT NULL));
ALTER TABLE "Charge" ADD CONSTRAINT charge_void_has_reason CHECK (status <> 'VOIDED' OR ("voidReason" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidedAt" IS NOT NULL));
CREATE OR REPLACE FUNCTION medos_charge_guard() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'invoiceId', 'voidReason', 'voidedById', 'voidedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'invoiceId', 'voidReason', 'voidedById', 'voidedAt']) THEN
    RAISE EXCEPTION 'A posted charge cannot be edited; void it and post a new one' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'A billed or voided charge cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER charge_guard BEFORE UPDATE ON "Charge" FOR EACH ROW EXECUTE FUNCTION medos_charge_guard();
CREATE TRIGGER charge_no_delete BEFORE DELETE ON "Charge" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

