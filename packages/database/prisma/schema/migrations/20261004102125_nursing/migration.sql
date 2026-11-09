-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('ACTIVE', 'ENTERED_IN_ERROR');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('VITALS', 'MEDICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MarStatus" AS ENUM ('DUE', 'GIVEN', 'MISSED', 'HELD', 'REFUSED');

-- CreateEnum
CREATE TYPE "IoDirection" AS ENUM ('INTAKE', 'OUTPUT');

-- CreateEnum
CREATE TYPE "IoCategory" AS ENUM ('ORAL', 'IV', 'OTHER_INTAKE', 'URINE', 'DRAIN', 'VOMIT', 'OTHER_OUTPUT');

-- CreateTable
CREATE TABLE "NursingNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "note" TEXT NOT NULL,
    "addendumOfId" UUID,
    "status" "NoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "errorReason" TEXT,
    "errorById" UUID,
    "errorAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NursingNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NursingTask" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "assignedToId" UUID,
    "type" "TaskType" NOT NULL DEFAULT 'OTHER',
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "completedById" UUID,
    "completedAt" TIMESTAMPTZ(3),
    "closeNote" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NursingTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationAdministration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "medicationOrderItemId" UUID NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "MarStatus" NOT NULL DEFAULT 'DUE',
    "unscheduled" BOOLEAN NOT NULL DEFAULT false,
    "administeredAt" TIMESTAMPTZ(3),
    "administeredById" UUID,
    "remarks" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationAdministration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeOutput" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "direction" "IoDirection" NOT NULL,
    "category" "IoCategory" NOT NULL,
    "amount" DECIMAL(8,1) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'ml',
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" UUID NOT NULL,
    "status" "ObservationStatus" NOT NULL DEFAULT 'FINAL',
    "errorReason" TEXT,
    "errorById" UUID,
    "errorAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeOutput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NursingNote_tenantId_admissionId_createdAt_idx" ON "NursingNote"("tenantId", "admissionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NursingNote_tenantId_id_key" ON "NursingNote"("tenantId", "id");

-- CreateIndex
CREATE INDEX "NursingTask_tenantId_facilityId_status_dueAt_idx" ON "NursingTask"("tenantId", "facilityId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "NursingTask_tenantId_admissionId_status_idx" ON "NursingTask"("tenantId", "admissionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NursingTask_tenantId_id_key" ON "NursingTask"("tenantId", "id");

-- CreateIndex
CREATE INDEX "MedicationAdministration_tenantId_facilityId_status_schedul_idx" ON "MedicationAdministration"("tenantId", "facilityId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "MedicationAdministration_tenantId_admissionId_scheduledAt_idx" ON "MedicationAdministration"("tenantId", "admissionId", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "MedicationAdministration_tenantId_id_key" ON "MedicationAdministration"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MedicationAdministration_medicationOrderItemId_scheduledAt_key" ON "MedicationAdministration"("medicationOrderItemId", "scheduledAt");

-- CreateIndex
CREATE INDEX "IntakeOutput_tenantId_admissionId_recordedAt_idx" ON "IntakeOutput"("tenantId", "admissionId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeOutput_tenantId_id_key" ON "IntakeOutput"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "NursingNote" ADD CONSTRAINT "NursingNote_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingNote" ADD CONSTRAINT "NursingNote_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingNote" ADD CONSTRAINT "NursingNote_addendumOfId_fkey" FOREIGN KEY ("addendumOfId") REFERENCES "NursingNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingTask" ADD CONSTRAINT "NursingTask_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingTask" ADD CONSTRAINT "NursingTask_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationAdministration" ADD CONSTRAINT "MedicationAdministration_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationAdministration" ADD CONSTRAINT "MedicationAdministration_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationAdministration" ADD CONSTRAINT "MedicationAdministration_tenantId_medicationOrderItemId_fkey" FOREIGN KEY ("tenantId", "medicationOrderItemId") REFERENCES "MedicationOrderItem"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeOutput" ADD CONSTRAINT "IntakeOutput_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeOutput" ADD CONSTRAINT "IntakeOutput_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
CREATE TRIGGER nursing_note_scope_addendum BEFORE INSERT OR UPDATE OF "addendumOfId" ON "NursingNote" FOR EACH ROW EXECUTE FUNCTION medos_same_scope('NursingNote', 'addendumOfId');

-- ===== nursing notes: append-only =====
ALTER TABLE "NursingNote" ADD CONSTRAINT nursing_note_text CHECK (length(btrim(note)) >= 3);
CREATE OR REPLACE FUNCTION medos_nursing_note_guard() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) THEN
    RAISE EXCEPTION 'A nursing note cannot be edited; add an addendum' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'ACTIVE' AND NEW.status = 'ENTERED_IN_ERROR' AND NEW."errorReason" IS NOT NULL AND NEW."errorById" IS NOT NULL AND NEW."errorAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid nursing note status change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER nursing_note_guard BEFORE UPDATE ON "NursingNote" FOR EACH ROW EXECUTE FUNCTION medos_nursing_note_guard();
CREATE TRIGGER nursing_note_no_delete BEFORE DELETE ON "NursingNote" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== tasks =====
ALTER TABLE "NursingTask" ADD CONSTRAINT nursing_task_title CHECK (length(btrim(title)) >= 3);
ALTER TABLE "NursingTask" ADD CONSTRAINT nursing_task_close_complete CHECK (
  (status = 'PENDING' AND "completedAt" IS NULL AND "completedById" IS NULL) OR (status IN ('DONE', 'CANCELLED') AND "completedAt" IS NOT NULL AND "completedById" IS NOT NULL));
CREATE OR REPLACE FUNCTION medos_nursing_task_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'A closed task cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."admissionId" <> OLD."admissionId" OR NEW.title <> OLD.title OR NEW."dueAt" <> OLD."dueAt" OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'Task details cannot be changed; cancel it and create a new task' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER nursing_task_guard BEFORE UPDATE ON "NursingTask" FOR EACH ROW EXECUTE FUNCTION medos_nursing_task_guard();
CREATE TRIGGER nursing_task_no_delete BEFORE DELETE ON "NursingTask" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- ===== MAR: administration is a one-way, attributable event =====
ALTER TABLE "MedicationAdministration" ADD CONSTRAINT mar_status_complete CHECK (
  (status = 'DUE' AND "administeredAt" IS NULL AND "administeredById" IS NULL)
  OR (status = 'GIVEN' AND "administeredAt" IS NOT NULL AND "administeredById" IS NOT NULL)
  OR (status IN ('MISSED', 'HELD', 'REFUSED') AND "administeredById" IS NOT NULL AND remarks IS NOT NULL AND length(btrim(remarks)) >= 3));
CREATE OR REPLACE FUNCTION medos_mar_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Medication administration records cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'DUE' THEN
    RAISE EXCEPTION 'A recorded administration cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."admissionId" <> OLD."admissionId" OR NEW."medicationOrderItemId" <> OLD."medicationOrderItemId"
     OR NEW."scheduledAt" <> OLD."scheduledAt" OR NEW."patientId" <> OLD."patientId" OR NEW.unscheduled <> OLD.unscheduled THEN
    RAISE EXCEPTION 'Schedule fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER mar_guard BEFORE UPDATE OR DELETE ON "MedicationAdministration" FOR EACH ROW EXECUTE FUNCTION medos_mar_guard();

-- ===== intake / output: append-only with entered-in-error =====
ALTER TABLE "IntakeOutput" ADD CONSTRAINT io_amount CHECK (amount > 0 AND amount <= 20000);
ALTER TABLE "IntakeOutput" ADD CONSTRAINT io_category_matches_direction CHECK (
  (direction = 'INTAKE' AND category IN ('ORAL', 'IV', 'OTHER_INTAKE')) OR (direction = 'OUTPUT' AND category IN ('URINE', 'DRAIN', 'VOMIT', 'OTHER_OUTPUT')));
ALTER TABLE "IntakeOutput" ADD CONSTRAINT io_not_future CHECK ("recordedAt" <= now() + interval '5 minutes');
CREATE OR REPLACE FUNCTION medos_io_guard() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) THEN
    RAISE EXCEPTION 'Recorded intake/output cannot be modified' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'FINAL' AND NEW.status = 'ENTERED_IN_ERROR' AND NEW."errorReason" IS NOT NULL AND NEW."errorById" IS NOT NULL AND NEW."errorAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid intake/output status change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER io_guard BEFORE UPDATE ON "IntakeOutput" FOR EACH ROW EXECUTE FUNCTION medos_io_guard();
CREATE TRIGGER io_no_delete BEFORE DELETE ON "IntakeOutput" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

