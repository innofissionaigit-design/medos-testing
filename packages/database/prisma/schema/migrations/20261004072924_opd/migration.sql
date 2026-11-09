-- CreateEnum
CREATE TYPE "EncounterType" AS ENUM ('OPD', 'IPD');

-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AppointmentType" AS ENUM ('CONSULTATION', 'FOLLOW_UP', 'PROCEDURE');

-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('SCHEDULED', 'WALK_IN');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'CHECKED_IN', 'WAITING', 'IN_CONSULTATION', 'COMPLETED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QueuePriority" AS ENUM ('NORMAL', 'PRIORITY', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('WAITING', 'CALLED', 'IN_CONSULTATION', 'COMPLETED', 'SKIPPED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Encounter" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterNumber" TEXT NOT NULL,
    "type" "EncounterType" NOT NULL,
    "status" "EncounterStatus" NOT NULL DEFAULT 'ACTIVE',
    "departmentId" UUID,
    "practitionerId" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PractitionerSchedule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "slotMinutes" INTEGER NOT NULL DEFAULT 15,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PractitionerSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "departmentId" UUID,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "type" "AppointmentType" NOT NULL DEFAULT 'CONSULTATION',
    "source" "AppointmentSource" NOT NULL DEFAULT 'SCHEDULED',
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "notes" TEXT,
    "overbooked" BOOLEAN NOT NULL DEFAULT false,
    "overbookReason" TEXT,
    "cancelReason" TEXT,
    "encounterId" UUID,
    "createdById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "practitionerId" UUID NOT NULL,
    "departmentId" UUID,
    "appointmentId" UUID,
    "tokenDate" DATE NOT NULL,
    "tokenNumber" INTEGER NOT NULL,
    "priority" "QueuePriority" NOT NULL DEFAULT 'NORMAL',
    "status" "QueueStatus" NOT NULL DEFAULT 'WAITING',
    "checkedInAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calledAt" TIMESTAMPTZ(3),
    "consultationStartedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Encounter_tenantId_patientId_startedAt_idx" ON "Encounter"("tenantId", "patientId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "Encounter_tenantId_facilityId_type_status_idx" ON "Encounter"("tenantId", "facilityId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_tenantId_id_key" ON "Encounter"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_tenantId_facilityId_id_key" ON "Encounter"("tenantId", "facilityId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_tenantId_facilityId_encounterNumber_key" ON "Encounter"("tenantId", "facilityId", "encounterNumber");

-- CreateIndex
CREATE INDEX "PractitionerSchedule_tenantId_facilityId_practitionerId_day_idx" ON "PractitionerSchedule"("tenantId", "facilityId", "practitionerId", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "PractitionerSchedule_tenantId_id_key" ON "PractitionerSchedule"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_encounterId_key" ON "Appointment"("encounterId");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_facilityId_startAt_idx" ON "Appointment"("tenantId", "facilityId", "startAt");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_practitionerId_startAt_idx" ON "Appointment"("tenantId", "practitionerId", "startAt");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_patientId_startAt_idx" ON "Appointment"("tenantId", "patientId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_tenantId_id_key" ON "Appointment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "QueueEntry_encounterId_key" ON "QueueEntry"("encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "QueueEntry_appointmentId_key" ON "QueueEntry"("appointmentId");

-- CreateIndex
CREATE INDEX "QueueEntry_tenantId_facilityId_tokenDate_status_idx" ON "QueueEntry"("tenantId", "facilityId", "tokenDate", "status");

-- CreateIndex
CREATE INDEX "QueueEntry_tenantId_practitionerId_tokenDate_status_idx" ON "QueueEntry"("tenantId", "practitionerId", "tokenDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "QueueEntry_tenantId_id_key" ON "QueueEntry"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "QueueEntry_tenantId_facilityId_practitionerId_tokenDate_tok_key" ON "QueueEntry"("tenantId", "facilityId", "practitionerId", "tokenDate", "tokenNumber");

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerSchedule" ADD CONSTRAINT "PractitionerSchedule_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerSchedule" ADD CONSTRAINT "PractitionerSchedule_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ===== scope guards for single-column references (tenant + facility consistency) =====
CREATE TRIGGER encounter_scope_department BEFORE INSERT OR UPDATE OF "departmentId" ON "Encounter" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Department', 'departmentId');
CREATE TRIGGER encounter_scope_practitioner BEFORE INSERT OR UPDATE OF "practitionerId" ON "Encounter" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Practitioner', 'practitionerId');
CREATE TRIGGER schedule_scope_practitioner BEFORE INSERT OR UPDATE OF "practitionerId" ON "PractitionerSchedule" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Practitioner', 'practitionerId');
CREATE TRIGGER appointment_scope_practitioner BEFORE INSERT OR UPDATE OF "practitionerId" ON "Appointment" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Practitioner', 'practitionerId');
CREATE TRIGGER appointment_scope_department BEFORE INSERT OR UPDATE OF "departmentId" ON "Appointment" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Department', 'departmentId');
CREATE TRIGGER appointment_scope_encounter BEFORE INSERT OR UPDATE OF "encounterId" ON "Appointment" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Encounter', 'encounterId');
CREATE TRIGGER queue_scope_practitioner BEFORE INSERT OR UPDATE OF "practitionerId" ON "QueueEntry" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Practitioner', 'practitionerId');
CREATE TRIGGER queue_scope_department BEFORE INSERT OR UPDATE OF "departmentId" ON "QueueEntry" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Department', 'departmentId');
CREATE TRIGGER queue_scope_encounter BEFORE INSERT OR UPDATE OF "encounterId" ON "QueueEntry" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Encounter', 'encounterId');
CREATE TRIGGER queue_scope_appointment BEFORE INSERT OR UPDATE OF "appointmentId" ON "QueueEntry" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('Appointment', 'appointmentId');

-- ===== encounters =====
ALTER TABLE "Encounter" ADD CONSTRAINT encounter_end_after_start CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");
ALTER TABLE "Encounter" ADD CONSTRAINT encounter_end_matches_status CHECK (
  (status = 'ACTIVE' AND "endedAt" IS NULL) OR (status IN ('COMPLETED', 'CANCELLED') AND "endedAt" IS NOT NULL));

CREATE OR REPLACE FUNCTION medos_encounter_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId"
     OR NEW.type <> OLD.type OR NEW."encounterNumber" <> OLD."encounterNumber" THEN
    RAISE EXCEPTION 'Encounter identity fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'ACTIVE' AND NEW.status IN ('COMPLETED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'Invalid encounter status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER encounter_guard BEFORE UPDATE ON "Encounter" FOR EACH ROW EXECUTE FUNCTION medos_encounter_guard();
CREATE TRIGGER encounter_no_delete BEFORE DELETE ON "Encounter" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== schedules =====
ALTER TABLE "PractitionerSchedule" ADD CONSTRAINT schedule_day CHECK ("dayOfWeek" BETWEEN 0 AND 6);
ALTER TABLE "PractitionerSchedule" ADD CONSTRAINT schedule_minutes CHECK ("startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute");
ALTER TABLE "PractitionerSchedule" ADD CONSTRAINT schedule_slot CHECK ("slotMinutes" BETWEEN 5 AND 120);

-- ===== appointments =====
ALTER TABLE "Appointment" ADD CONSTRAINT appointment_time_order CHECK ("endAt" > "startAt" AND "endAt" - "startAt" <= interval '8 hours');
-- A practitioner cannot be double-booked unless the booking is a deliberate, authorised overbooking.
ALTER TABLE "Appointment" ADD CONSTRAINT appointment_no_practitioner_overlap EXCLUDE USING gist (
  "tenantId" WITH =, "practitionerId" WITH =, tstzrange("startAt", "endAt", '[)') WITH &&
) WHERE (status IN ('BOOKED', 'CHECKED_IN', 'WAITING', 'IN_CONSULTATION') AND NOT overbooked);
-- A patient cannot be in two live appointments at the same time (never overridable).
ALTER TABLE "Appointment" ADD CONSTRAINT appointment_no_patient_overlap EXCLUDE USING gist (
  "tenantId" WITH =, "patientId" WITH =, tstzrange("startAt", "endAt", '[)') WITH &&
) WHERE (status IN ('BOOKED', 'CHECKED_IN', 'WAITING', 'IN_CONSULTATION'));

CREATE OR REPLACE FUNCTION medos_appointment_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" THEN
    RAISE EXCEPTION 'Appointment identity fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status::text, NEW.status::text) NOT IN (
    ('BOOKED', 'CHECKED_IN'), ('BOOKED', 'CANCELLED'), ('BOOKED', 'NO_SHOW'),
    ('CHECKED_IN', 'WAITING'), ('CHECKED_IN', 'CANCELLED'),
    ('WAITING', 'IN_CONSULTATION'), ('WAITING', 'CANCELLED'),
    ('IN_CONSULTATION', 'COMPLETED')) THEN
    RAISE EXCEPTION 'Invalid appointment status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('COMPLETED', 'NO_SHOW', 'CANCELLED') AND (NEW."startAt" <> OLD."startAt" OR NEW."endAt" <> OLD."endAt" OR NEW."practitionerId" <> OLD."practitionerId") THEN
    RAISE EXCEPTION 'Closed appointments cannot be rescheduled' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER appointment_guard BEFORE UPDATE ON "Appointment" FOR EACH ROW EXECUTE FUNCTION medos_appointment_guard();
CREATE TRIGGER appointment_no_delete BEFORE DELETE ON "Appointment" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== queue =====
ALTER TABLE "QueueEntry" ADD CONSTRAINT queue_token_positive CHECK ("tokenNumber" > 0);
-- A practitioner is in consultation with at most one patient at a time.
CREATE UNIQUE INDEX "QueueEntry_one_active_consultation" ON "QueueEntry" ("tenantId", "practitionerId") WHERE status = 'IN_CONSULTATION';

CREATE OR REPLACE FUNCTION medos_queue_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId"
     OR NEW."encounterId" <> OLD."encounterId" OR NEW."tokenNumber" <> OLD."tokenNumber" OR NEW."tokenDate" <> OLD."tokenDate" THEN
    RAISE EXCEPTION 'Queue identity fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status::text, NEW.status::text) NOT IN (
    ('WAITING', 'CALLED'), ('WAITING', 'SKIPPED'), ('WAITING', 'CANCELLED'), ('WAITING', 'IN_CONSULTATION'),
    ('CALLED', 'IN_CONSULTATION'), ('CALLED', 'WAITING'), ('CALLED', 'SKIPPED'), ('CALLED', 'CANCELLED'),
    ('SKIPPED', 'WAITING'), ('SKIPPED', 'CANCELLED'),
    ('IN_CONSULTATION', 'COMPLETED')) THEN
    RAISE EXCEPTION 'Invalid queue status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER queue_guard BEFORE UPDATE ON "QueueEntry" FOR EACH ROW EXECUTE FUNCTION medos_queue_guard();
CREATE TRIGGER queue_no_delete BEFORE DELETE ON "QueueEntry" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

