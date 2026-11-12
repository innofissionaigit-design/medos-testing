-- Housekeeping requests for any area, and medical-record retention reviews (docs/housekeeping.md, docs/record-retention.md).

CREATE TYPE "HousekeepingKind" AS ENUM ('CLEANING', 'MAINTENANCE', 'WASTE', 'LINEN', 'OTHER');
CREATE TYPE "HousekeepingPriority" AS ENUM ('ROUTINE', 'URGENT');
CREATE TYPE "HousekeepingStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');
CREATE TYPE "RetentionDecision" AS ENUM ('HOLD', 'CLEAR_FOR_ARCHIVE');

CREATE TABLE "HousekeepingRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "kind" "HousekeepingKind" NOT NULL,
    "priority" "HousekeepingPriority" NOT NULL DEFAULT 'ROUTINE',
    "location" TEXT NOT NULL,
    "description" TEXT,
    "status" "HousekeepingStatus" NOT NULL DEFAULT 'OPEN',
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedById" UUID,
    "startedAt" TIMESTAMPTZ(3),
    "doneById" UUID,
    "doneAt" TIMESTAMPTZ(3),
    "doneNote" TEXT,
    "cancelledById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    CONSTRAINT "HousekeepingRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HousekeepingRequest_tenantId_id_key" ON "HousekeepingRequest"("tenantId", "id");
CREATE INDEX "HousekeepingRequest_tenantId_facilityId_status_requestedAt_idx" ON "HousekeepingRequest"("tenantId", "facilityId", "status", "requestedAt");
CREATE INDEX "HousekeepingRequest_tenantId_requestedById_requestedAt_idx" ON "HousekeepingRequest"("tenantId", "requestedById", "requestedAt");
ALTER TABLE "HousekeepingRequest" ADD CONSTRAINT "HousekeepingRequest_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RecordRetentionReview" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "decision" "RetentionDecision" NOT NULL,
    "retainUntil" DATE,
    "note" TEXT NOT NULL,
    "decidedById" UUID NOT NULL,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecordRetentionReview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecordRetentionReview_tenantId_id_key" ON "RecordRetentionReview"("tenantId", "id");
CREATE INDEX "RecordRetentionReview_tenantId_encounterId_decidedAt_idx" ON "RecordRetentionReview"("tenantId", "encounterId", "decidedAt");
CREATE INDEX "RecordRetentionReview_tenantId_facilityId_decidedAt_idx" ON "RecordRetentionReview"("tenantId", "facilityId", "decidedAt");
ALTER TABLE "RecordRetentionReview" ADD CONSTRAINT "RecordRetentionReview_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
ALTER TABLE "HousekeepingRequest" ADD CONSTRAINT housekeeping_request_values CHECK (
  length(btrim(location)) BETWEEN 2 AND 120 AND (description IS NULL OR length(description) <= 300)
  AND (status <> 'IN_PROGRESS' OR ("startedById" IS NOT NULL AND "startedAt" IS NOT NULL))
  AND (status <> 'DONE' OR ("startedById" IS NOT NULL AND "doneById" IS NOT NULL AND "doneAt" IS NOT NULL))
  AND (status <> 'CANCELLED' OR ("cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL AND "cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 5))
  AND (status IN ('DONE') OR ("doneById" IS NULL AND "doneAt" IS NULL AND "doneNote" IS NULL))
  AND (status = 'CANCELLED' OR ("cancelledById" IS NULL AND "cancelledAt" IS NULL AND "cancelReason" IS NULL)));

-- A request is never deleted. Its job, place and requester never change; its status moves OPEN -> IN_PROGRESS -> DONE, or to CANCELLED from OPEN or IN_PROGRESS, and a finished request is final.
CREATE OR REPLACE FUNCTION medos_housekeeping_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A housekeeping request cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'startedById', 'startedAt', 'doneById', 'doneAt', 'doneNote', 'cancelledById', 'cancelledAt', 'cancelReason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'startedById', 'startedAt', 'doneById', 'doneAt', 'doneNote', 'cancelledById', 'cancelledAt', 'cancelReason']) THEN
    RAISE EXCEPTION 'A housekeeping request cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'A housekeeping request step cannot be changed' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'OPEN' AND NEW.status IN ('IN_PROGRESS', 'CANCELLED')) OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('DONE', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'A housekeeping request cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER housekeeping_request_guard BEFORE UPDATE OR DELETE ON "HousekeepingRequest" FOR EACH ROW EXECUTE FUNCTION medos_housekeeping_request_guard();

ALTER TABLE "RecordRetentionReview" ADD CONSTRAINT record_retention_review_values CHECK (
  length(btrim(note)) BETWEEN 5 AND 300 AND (decision = 'HOLD' OR "retainUntil" IS NULL));
CREATE TRIGGER record_retention_review_immutable BEFORE UPDATE OR DELETE ON "RecordRetentionReview" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
-- A review is about a finished visit of the same hospital and facility.
CREATE OR REPLACE FUNCTION medos_record_retention_scope() RETURNS trigger AS $$
DECLARE e RECORD;
BEGIN
  SELECT status::text AS status, "facilityId" INTO e FROM "Encounter" WHERE id = NEW."encounterId" AND "tenantId" = NEW."tenantId";
  IF e.status IS DISTINCT FROM 'COMPLETED' OR e."facilityId" <> NEW."facilityId" THEN
    RAISE EXCEPTION 'A retention review is about a completed visit of the same facility' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER record_retention_scope BEFORE INSERT ON "RecordRetentionReview" FOR EACH ROW EXECUTE FUNCTION medos_record_retention_scope();

SELECT medos_enable_tenant_rls('"HousekeepingRequest"');
SELECT medos_enable_tenant_rls('"RecordRetentionReview"');

-- ===== who may do what =====
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('HOUSEKEEPING', 'HOUSEKEEPING_MANAGE'),
  ('NURSE', 'HOUSEKEEPING_REQUEST'), ('RECEPTIONIST', 'HOUSEKEEPING_REQUEST'), ('MANAGER', 'HOUSEKEEPING_REQUEST'), ('MANAGER', 'HOUSEKEEPING_MANAGE'),
  ('ADMINISTRATOR', 'HOUSEKEEPING_REQUEST'), ('ADMINISTRATOR', 'HOUSEKEEPING_MANAGE'),
  ('MEDICAL_RECORDS', 'MRD_RETENTION'), ('ADMINISTRATOR', 'MRD_RETENTION')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration housekeeping_requests_record_retention', 'added', jsonb_build_object(
  'HOUSEKEEPING', jsonb_build_array('HOUSEKEEPING_MANAGE'), 'NURSE', jsonb_build_array('HOUSEKEEPING_REQUEST'), 'RECEPTIONIST', jsonb_build_array('HOUSEKEEPING_REQUEST'),
  'MANAGER', jsonb_build_array('HOUSEKEEPING_REQUEST', 'HOUSEKEEPING_MANAGE'), 'ADMINISTRATOR', jsonb_build_array('HOUSEKEEPING_REQUEST', 'HOUSEKEEPING_MANAGE', 'MRD_RETENTION'),
  'MEDICAL_RECORDS', jsonb_build_array('MRD_RETENTION')))
FROM "Tenant" t;
