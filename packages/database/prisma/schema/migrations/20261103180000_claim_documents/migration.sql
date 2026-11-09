-- Claim documents (docs/claims.md): supporting documents attached to an insurance claim, stored in file storage, never deleted.

-- CreateTable
CREATE TABLE "ClaimDocument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "label" TEXT NOT NULL,
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

    CONSTRAINT "ClaimDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaimDocument_tenantId_claimId_status_uploadedAt_idx" ON "ClaimDocument"("tenantId", "claimId", "status", "uploadedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimDocument_tenantId_id_key" ON "ClaimDocument"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "ClaimDocument" ADD CONSTRAINT "ClaimDocument_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "Claim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Claim documents are written once. The only change allowed is ACTIVE -> REMOVED with who, when and why; nothing is ever deleted. Documents are added to, and removed
-- from, a claim that is still open: a rejected, settled or closed claim keeps the documents it had.
ALTER TABLE "ClaimDocument" ADD CONSTRAINT claim_document_values CHECK (
  "sizeBytes" > 0 AND "sizeBytes" <= 5242880 AND "contentType" IN ('image/png', 'image/jpeg', 'application/pdf') AND length(btrim("fileName")) >= 1 AND length(btrim(label)) BETWEEN 2 AND 60
  AND (status = 'ACTIVE' OR ("removedById" IS NOT NULL AND "removedAt" IS NOT NULL AND "removeReason" IS NOT NULL AND length(btrim("removeReason")) >= 5)));

CREATE OR REPLACE FUNCTION medos_claim_document_guard() RETURNS trigger AS $$
DECLARE c_status text; c_patient uuid; c_facility uuid; cid uuid;
BEGIN
  cid := NEW."claimId";
  SELECT status::text, "patientId", "facilityId" INTO c_status, c_patient, c_facility FROM "Claim" WHERE id = cid AND "tenantId" = NEW."tenantId";
  IF TG_OP = 'INSERT' THEN
    IF c_status IS NULL OR c_patient <> NEW."patientId" OR c_facility <> NEW."facilityId" THEN
      RAISE EXCEPTION 'A document must belong to a claim of the same patient and facility' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF c_status IN ('REJECTED', 'SETTLED', 'CLOSED') THEN
      RAISE EXCEPTION 'Documents cannot be added to a finished claim' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'removedById', 'removedAt', 'removeReason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'removedById', 'removedAt', 'removeReason']) THEN
    RAISE EXCEPTION 'A claim document cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'REMOVED' AND NEW.status <> 'REMOVED' THEN
    RAISE EXCEPTION 'A removed claim document cannot be restored; upload it again' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'REMOVED' AND (NEW."removedById" IS DISTINCT FROM OLD."removedById" OR NEW."removedAt" IS DISTINCT FROM OLD."removedAt" OR NEW."removeReason" IS DISTINCT FROM OLD."removeReason") THEN
    RAISE EXCEPTION 'The reason a document was removed cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'REMOVED' AND c_status IN ('REJECTED', 'SETTLED', 'CLOSED') THEN
    RAISE EXCEPTION 'Documents of a finished claim cannot be removed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER claim_document_guard BEFORE INSERT OR UPDATE ON "ClaimDocument" FOR EACH ROW EXECUTE FUNCTION medos_claim_document_guard();
CREATE TRIGGER claim_document_no_delete BEFORE DELETE ON "ClaimDocument" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

SELECT medos_enable_tenant_rls('"ClaimDocument"');
