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
