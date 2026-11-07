-- Radiology images (docs/radiology.md): PNG, JPEG and DICOM files attached to a study, stored in file storage, never deleted.

-- CreateTable
CREATE TABLE "RadImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "studyId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "description" TEXT,
    "status" "PatientFileStatus" NOT NULL DEFAULT 'ACTIVE',
    "uploadedById" UUID NOT NULL,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedById" UUID,
    "removedAt" TIMESTAMPTZ(3),
    "removeReason" TEXT,

    CONSTRAINT "RadImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RadImage_tenantId_studyId_status_uploadedAt_idx" ON "RadImage"("tenantId", "studyId", "status", "uploadedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RadImage_tenantId_id_key" ON "RadImage"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "RadImage" ADD CONSTRAINT "RadImage_tenantId_studyId_fkey" FOREIGN KEY ("tenantId", "studyId") REFERENCES "RadStudy"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Radiology images are written once. The only change allowed is ACTIVE -> REMOVED with who, when and why; nothing is ever deleted.
ALTER TABLE "RadImage" ADD CONSTRAINT rad_image_values CHECK (
  "sizeBytes" > 0 AND "sizeBytes" <= 10485760 AND "contentType" IN ('image/png', 'image/jpeg', 'application/dicom') AND length(btrim("fileName")) >= 1
  AND (description IS NULL OR length(description) <= 200)
  AND (status = 'ACTIVE' OR ("removedById" IS NOT NULL AND "removedAt" IS NOT NULL AND "removeReason" IS NOT NULL AND length(btrim("removeReason")) >= 5)));

CREATE OR REPLACE FUNCTION medos_rad_image_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "RadStudy" s WHERE s.id = NEW."studyId" AND s."tenantId" = NEW."tenantId" AND s."facilityId" = NEW."facilityId" AND s."patientId" = NEW."patientId") THEN
      RAISE EXCEPTION 'An image must belong to a study of the same patient and facility' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'removedById', 'removedAt', 'removeReason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'removedById', 'removedAt', 'removeReason']) THEN
    RAISE EXCEPTION 'A radiology image cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'REMOVED' AND NEW.status <> 'REMOVED' THEN
    RAISE EXCEPTION 'A removed radiology image cannot be restored; upload it again' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'REMOVED' AND (NEW."removedById" IS DISTINCT FROM OLD."removedById" OR NEW."removedAt" IS DISTINCT FROM OLD."removedAt" OR NEW."removeReason" IS DISTINCT FROM OLD."removeReason") THEN
    RAISE EXCEPTION 'The reason an image was removed cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rad_image_guard BEFORE INSERT OR UPDATE ON "RadImage" FOR EACH ROW EXECUTE FUNCTION medos_rad_image_guard();
CREATE TRIGGER rad_image_no_delete BEFORE DELETE ON "RadImage" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

SELECT medos_enable_tenant_rls('"RadImage"');
