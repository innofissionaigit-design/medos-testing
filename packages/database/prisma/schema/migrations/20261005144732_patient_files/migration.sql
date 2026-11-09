-- CreateEnum
CREATE TYPE "PatientFileKind" AS ENUM ('PHOTO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "PatientFileStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateTable
CREATE TABLE "PatientFile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "kind" "PatientFileKind" NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "PatientFileStatus" NOT NULL DEFAULT 'ACTIVE',
    "uploadedById" UUID NOT NULL,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedById" UUID,
    "removedAt" TIMESTAMPTZ(3),
    "removeReason" TEXT,

    CONSTRAINT "PatientFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientFile_tenantId_patientId_status_uploadedAt_idx" ON "PatientFile"("tenantId", "patientId", "status", "uploadedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PatientFile_tenantId_id_key" ON "PatientFile"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "PatientFile" ADD CONSTRAINT "PatientFile_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Patient files are immutable records: only ACTIVE -> REMOVED (with who/when/why) may change; nothing is ever deleted.
CREATE OR REPLACE FUNCTION medos_patient_file_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW.kind <> OLD.kind
     OR NEW.title <> OLD.title OR NEW."fileName" <> OLD."fileName" OR NEW."contentType" <> OLD."contentType" OR NEW."sizeBytes" <> OLD."sizeBytes"
     OR NEW.sha256 <> OLD.sha256 OR NEW."storageKey" <> OLD."storageKey" OR NEW."uploadedById" <> OLD."uploadedById" OR NEW."uploadedAt" <> OLD."uploadedAt" THEN
    RAISE EXCEPTION 'Stored files cannot be modified' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'ACTIVE' AND NEW.status = 'REMOVED') THEN
    RAISE EXCEPTION 'Invalid file status transition' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'REMOVED' AND (NEW."removedById" IS NULL OR NEW."removedAt" IS NULL OR NEW."removeReason" IS NULL) THEN
    RAISE EXCEPTION 'Removal requires reason, user and time' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'REMOVED' THEN
    RAISE EXCEPTION 'A removed file cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER patient_file_guard BEFORE UPDATE ON "PatientFile" FOR EACH ROW EXECUTE FUNCTION medos_patient_file_guard();
CREATE TRIGGER patient_file_no_delete BEFORE DELETE ON "PatientFile" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

-- At most one active profile photo per patient.
CREATE UNIQUE INDEX "PatientFile_one_active_photo" ON "PatientFile" ("tenantId", "patientId") WHERE kind = 'PHOTO' AND status = 'ACTIVE';

ALTER TABLE "PatientFile" ADD CONSTRAINT patient_file_size CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 10485760);
ALTER TABLE "PatientFile" ADD CONSTRAINT patient_file_type CHECK ("contentType" IN ('image/png', 'image/jpeg', 'application/pdf'));
ALTER TABLE "PatientFile" ADD CONSTRAINT patient_file_photo_is_image CHECK (kind <> 'PHOTO' OR "contentType" IN ('image/png', 'image/jpeg'));

