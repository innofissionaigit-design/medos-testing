-- CreateTable
CREATE TABLE "PrescriptionScanPage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "scanId" UUID NOT NULL,
    "pageNo" INTEGER NOT NULL,
    "fileId" UUID NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'UPLOADED',
    "ocrProvider" TEXT,
    "ocrText" TEXT,
    "ocrConfidence" DECIMAL(5,4),
    "ocrError" TEXT,
    "ocrAttempts" INTEGER NOT NULL DEFAULT 0,
    "ocrAt" TIMESTAMPTZ(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrescriptionScanPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrescriptionShare" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "recipientMask" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "lastOpenedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PrescriptionShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrescriptionScanPage_tenantId_scanId_idx" ON "PrescriptionScanPage"("tenantId", "scanId");

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionScanPage_tenantId_id_key" ON "PrescriptionScanPage"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionScanPage_tenantId_fileId_key" ON "PrescriptionScanPage"("tenantId", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionScanPage_scanId_pageNo_key" ON "PrescriptionScanPage"("scanId", "pageNo");

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionShare_tokenHash_key" ON "PrescriptionShare"("tokenHash");

-- CreateIndex
CREATE INDEX "PrescriptionShare_tenantId_encounterId_createdAt_idx" ON "PrescriptionShare"("tenantId", "encounterId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionShare_tenantId_id_key" ON "PrescriptionShare"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "PrescriptionScanPage" ADD CONSTRAINT "PrescriptionScanPage_tenantId_scanId_fkey" FOREIGN KEY ("tenantId", "scanId") REFERENCES "PrescriptionScan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionScanPage" ADD CONSTRAINT "PrescriptionScanPage_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "PatientFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionShare" ADD CONSTRAINT "PrescriptionShare_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionShare" ADD CONSTRAINT "PrescriptionShare_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== rules =====
-- Further pages: only for a scan that is not approved yet, same patient and facility as the scan, pages 2 to 10, and OCR text is kept as returned.
ALTER TABLE "PrescriptionScanPage" ADD CONSTRAINT prescription_scan_page_no CHECK ("pageNo" BETWEEN 2 AND 10);
CREATE OR REPLACE FUNCTION medos_prescription_scan_page_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A prescription page cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "PrescriptionScan" s WHERE s."tenantId" = NEW."tenantId" AND s.id = NEW."scanId" AND s."facilityId" = NEW."facilityId" AND s."approvedAt" IS NULL) THEN
      RAISE EXCEPTION 'A page can only be added to a prescription scan of the same facility that has not been approved' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "PrescriptionScan" s JOIN "PatientFile" f ON f."tenantId" = s."tenantId" AND f.id = NEW."fileId" AND f."patientId" = s."patientId" WHERE s."tenantId" = NEW."tenantId" AND s.id = NEW."scanId") THEN
      RAISE EXCEPTION 'A page must use a file of the same patient as the scan' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."ocrText" IS NOT NULL AND NEW."ocrText" IS DISTINCT FROM OLD."ocrText" THEN
    RAISE EXCEPTION 'The OCR text of a page cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."scanId" <> OLD."scanId" OR NEW."fileId" <> OLD."fileId" OR NEW."pageNo" <> OLD."pageNo" THEN
    RAISE EXCEPTION 'A page cannot be moved' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER prescription_scan_page_guard BEFORE INSERT OR UPDATE OR DELETE ON "PrescriptionScanPage" FOR EACH ROW EXECUTE FUNCTION medos_prescription_scan_page_guard();
SELECT medos_enable_tenant_rls('"PrescriptionScanPage"');

-- Shared links: only a hash of the secret is stored; a link is ACTIVE or REVOKED (never reopened), and its identity never changes.
ALTER TABLE "PrescriptionShare" ADD CONSTRAINT prescription_share_status CHECK (status IN ('ACTIVE', 'REVOKED'));
ALTER TABLE "PrescriptionShare" ADD CONSTRAINT prescription_share_revoked CHECK ((status = 'REVOKED') = ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL));
ALTER TABLE "PrescriptionShare" ADD CONSTRAINT prescription_share_expiry CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '31 days');
CREATE OR REPLACE FUNCTION medos_prescription_share_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."encounterId" <> OLD."encounterId" OR NEW."patientId" <> OLD."patientId" OR NEW."tokenHash" <> OLD."tokenHash" OR NEW."expiresAt" <> OLD."expiresAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'A shared prescription link cannot be changed, only revoked' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'A revoked link cannot be reopened' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER prescription_share_guard BEFORE UPDATE ON "PrescriptionShare" FOR EACH ROW EXECUTE FUNCTION medos_prescription_share_guard();
CREATE TRIGGER prescription_share_no_delete BEFORE DELETE ON "PrescriptionShare" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
SELECT medos_enable_tenant_rls('"PrescriptionShare"');

-- The patient opens a link without signing in, so the hospital is found from the link's hash (the caller must hold the link). Everything after it runs under that hospital's own scope.
CREATE OR REPLACE FUNCTION medos_resolve_prescription_share(p_hash text) RETURNS TABLE (tenant_id uuid, share_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT s."tenantId", s.id FROM public."PrescriptionShare" s WHERE s."tokenHash" = p_hash $$;
REVOKE ALL ON FUNCTION medos_resolve_prescription_share(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_resolve_prescription_share(text) TO medos_app;

-- Sharing a prescription with the patient: doctors and the front desk.
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, 'PRESCRIPTION_SHARE' FROM "Role" r WHERE r."isSystem" AND r.name IN ('DOCTOR', 'RECEPTIONIST')
ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object(
  'source', 'migration 20261030160000_more_tests_pages_share', 'added', jsonb_build_object('DOCTOR', jsonb_build_array('PRESCRIPTION_SHARE'), 'RECEPTIONIST', jsonb_build_array('PRESCRIPTION_SHARE')))
FROM "Tenant" t;