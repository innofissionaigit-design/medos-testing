-- CreateEnum
CREATE TYPE "AftercareStatus" AS ENUM ('PENDING', 'BOOKED', 'COMPLETED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ContactOutcome" AS ENUM ('BOOKED', 'CALL_AGAIN', 'NO_ANSWER', 'WRONG_NUMBER', 'DECLINED', 'ALREADY_VISITED');

-- CreateEnum
CREATE TYPE "FeedbackChannel" AS ENUM ('PHONE', 'IN_PERSON', 'FORM');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ComplaintSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "AftercareTask" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "dueDate" DATE NOT NULL,
    "adviceNote" TEXT,
    "status" "AftercareStatus" NOT NULL DEFAULT 'PENDING',
    "assignedToId" UUID,
    "appointmentId" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextCallAt" TIMESTAMPTZ(3),
    "reminderSentAt" TIMESTAMPTZ(3),
    "reminderAttempts" INTEGER NOT NULL DEFAULT 0,
    "reminderNextAt" TIMESTAMPTZ(3),
    "reminderError" TEXT,
    "closeReason" TEXT,
    "closedById" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AftercareTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactAttempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "outcome" "ContactOutcome" NOT NULL,
    "note" TEXT,
    "nextCallAt" TIMESTAMPTZ(3),
    "durationSeconds" INTEGER,
    "byId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientFeedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "admissionId" UUID,
    "taskId" UUID,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "channel" "FeedbackChannel" NOT NULL,
    "recordedById" UUID NOT NULL,
    "viaLink" BOOLEAN NOT NULL DEFAULT false,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Complaint" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "complaintNumber" TEXT NOT NULL,
    "patientId" UUID,
    "feedbackId" UUID,
    "taskId" UUID,
    "category" TEXT NOT NULL,
    "severity" "ComplaintSeverity" NOT NULL DEFAULT 'MEDIUM',
    "description" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "ownerId" UUID,
    "resolution" TEXT,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "escalatedAt" TIMESTAMPTZ(3),
    "escalatedToId" UUID,
    "escalationReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplaintNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "complaintId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "byId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplaintNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "sentAt" TIMESTAMPTZ(3),
    "usedAt" TIMESTAMPTZ(3),
    "feedbackId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AftercareTask_tenantId_facilityId_status_dueDate_idx" ON "AftercareTask"("tenantId", "facilityId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "AftercareTask_tenantId_patientId_idx" ON "AftercareTask"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "AftercareTask_tenantId_id_key" ON "AftercareTask"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AftercareTask_tenantId_admissionId_key" ON "AftercareTask"("tenantId", "admissionId");

-- CreateIndex
CREATE INDEX "ContactAttempt_tenantId_taskId_at_idx" ON "ContactAttempt"("tenantId", "taskId", "at");

-- CreateIndex
CREATE INDEX "PatientFeedback_tenantId_facilityId_recordedAt_idx" ON "PatientFeedback"("tenantId", "facilityId", "recordedAt" DESC);

-- CreateIndex
CREATE INDEX "PatientFeedback_tenantId_patientId_idx" ON "PatientFeedback"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientFeedback_tenantId_id_key" ON "PatientFeedback"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Complaint_tenantId_facilityId_status_createdAt_idx" ON "Complaint"("tenantId", "facilityId", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_tenantId_id_key" ON "Complaint"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_tenantId_facilityId_complaintNumber_key" ON "Complaint"("tenantId", "facilityId", "complaintNumber");

-- CreateIndex
CREATE INDEX "ComplaintNote_tenantId_complaintId_at_idx" ON "ComplaintNote"("tenantId", "complaintId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackRequest_tokenHash_key" ON "FeedbackRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "FeedbackRequest_tenantId_taskId_idx" ON "FeedbackRequest"("tenantId", "taskId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackRequest_tenantId_id_key" ON "FeedbackRequest"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "AftercareTask" ADD CONSTRAINT "AftercareTask_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AftercareTask" ADD CONSTRAINT "AftercareTask_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AftercareTask" ADD CONSTRAINT "AftercareTask_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AftercareTask" ADD CONSTRAINT "AftercareTask_tenantId_appointmentId_fkey" FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "Appointment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactAttempt" ADD CONSTRAINT "ContactAttempt_tenantId_taskId_fkey" FOREIGN KEY ("tenantId", "taskId") REFERENCES "AftercareTask"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientFeedback" ADD CONSTRAINT "PatientFeedback_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientFeedback" ADD CONSTRAINT "PatientFeedback_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientFeedback" ADD CONSTRAINT "PatientFeedback_tenantId_facilityId_admissionId_fkey" FOREIGN KEY ("tenantId", "facilityId", "admissionId") REFERENCES "Admission"("tenantId", "facilityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientFeedback" ADD CONSTRAINT "PatientFeedback_tenantId_taskId_fkey" FOREIGN KEY ("tenantId", "taskId") REFERENCES "AftercareTask"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_feedbackId_fkey" FOREIGN KEY ("tenantId", "feedbackId") REFERENCES "PatientFeedback"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_taskId_fkey" FOREIGN KEY ("tenantId", "taskId") REFERENCES "AftercareTask"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintNote" ADD CONSTRAINT "ComplaintNote_tenantId_complaintId_fkey" FOREIGN KEY ("tenantId", "complaintId") REFERENCES "Complaint"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackRequest" ADD CONSTRAINT "FeedbackRequest_tenantId_taskId_fkey" FOREIGN KEY ("tenantId", "taskId") REFERENCES "AftercareTask"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== rules the database holds on its own (docs/aftercare.md) =====
ALTER TABLE "AftercareTask" ADD CONSTRAINT aftercare_task_values CHECK (
  attempts >= 0
  AND ("adviceNote" IS NULL OR length("adviceNote") <= 500)
  AND (status <> 'BOOKED' OR "appointmentId" IS NOT NULL)
  AND (status <> 'COMPLETED' OR ("appointmentId" IS NOT NULL AND "completedAt" IS NOT NULL))
  AND (status <> 'CLOSED' OR ("closedById" IS NOT NULL AND "closedAt" IS NOT NULL AND "closeReason" IS NOT NULL AND length(btrim("closeReason")) >= 3))
  AND (status <> 'PENDING' OR "appointmentId" IS NULL));

-- The patient on a task is the admission's patient, and a booked review is the same patient's.
CREATE OR REPLACE FUNCTION medos_aftercare_task_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A follow-up task cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "Admission" a WHERE a.id = NEW."admissionId" AND a."tenantId" = NEW."tenantId" AND a."patientId" = NEW."patientId") THEN
      RAISE EXCEPTION 'The follow-up task must be for the admission''s own patient' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId" OR NEW."admissionId" <> OLD."admissionId" THEN
      RAISE EXCEPTION 'The identity of a follow-up task cannot change' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
      (OLD.status = 'PENDING' AND NEW.status IN ('BOOKED', 'CLOSED')) OR (OLD.status = 'BOOKED' AND NEW.status IN ('COMPLETED', 'PENDING', 'CLOSED'))) THEN
      RAISE EXCEPTION 'A follow-up task cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status IN ('COMPLETED', 'CLOSED') AND (NEW.status <> OLD.status OR NEW."dueDate" <> OLD."dueDate" OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId") THEN
      RAISE EXCEPTION 'A finished follow-up task cannot change' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW."appointmentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Appointment" ap WHERE ap.id = NEW."appointmentId" AND ap."tenantId" = NEW."tenantId" AND ap."patientId" = NEW."patientId") THEN
    RAISE EXCEPTION 'The review visit must be for the same patient' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER aftercare_task_guard BEFORE INSERT OR UPDATE OR DELETE ON "AftercareTask" FOR EACH ROW EXECUTE FUNCTION medos_aftercare_task_guard();

-- The review follows its appointment: when the visit is completed the task is completed; when it is cancelled or missed the patient is due a call again.
CREATE OR REPLACE FUNCTION medos_aftercare_follows_appointment() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'COMPLETED' THEN
    UPDATE "AftercareTask" SET status = 'COMPLETED', "completedAt" = now(), "updatedAt" = now() WHERE "tenantId" = NEW."tenantId" AND "appointmentId" = NEW.id AND status = 'BOOKED';
  ELSIF NEW.status IN ('CANCELLED', 'NO_SHOW') THEN
    UPDATE "AftercareTask" SET status = 'PENDING', "appointmentId" = NULL, "nextCallAt" = now(), "updatedAt" = now() WHERE "tenantId" = NEW."tenantId" AND "appointmentId" = NEW.id AND status = 'BOOKED';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER appointment_aftercare AFTER UPDATE OF status ON "Appointment" FOR EACH ROW EXECUTE FUNCTION medos_aftercare_follows_appointment();

ALTER TABLE "ContactAttempt" ADD CONSTRAINT contact_attempt_values CHECK ((note IS NULL OR length(note) <= 500) AND (outcome <> 'CALL_AGAIN' OR "nextCallAt" IS NOT NULL));
CREATE TRIGGER contact_attempt_immutable BEFORE UPDATE OR DELETE ON "ContactAttempt" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "PatientFeedback" ADD CONSTRAINT patient_feedback_values CHECK (rating BETWEEN 1 AND 5 AND (comment IS NULL OR length(comment) <= 1000));
CREATE TRIGGER patient_feedback_immutable BEFORE UPDATE OR DELETE ON "PatientFeedback" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE OR REPLACE FUNCTION medos_feedback_patient() RETURNS trigger AS $$
BEGIN
  IF NEW."admissionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Admission" a WHERE a.id = NEW."admissionId" AND a."tenantId" = NEW."tenantId" AND a."patientId" = NEW."patientId") THEN
    RAISE EXCEPTION 'The feedback must be for the admission''s own patient' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER patient_feedback_patient BEFORE INSERT ON "PatientFeedback" FOR EACH ROW EXECUTE FUNCTION medos_feedback_patient();

ALTER TABLE "Complaint" ADD CONSTRAINT complaint_values CHECK (
  length(btrim(category)) BETWEEN 2 AND 60 AND length(btrim(description)) BETWEEN 10 AND 2000
  AND (status NOT IN ('RESOLVED', 'CLOSED') OR (resolution IS NOT NULL AND length(btrim(resolution)) >= 10 AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL))
  AND (status <> 'CLOSED' OR "closedAt" IS NOT NULL));
CREATE OR REPLACE FUNCTION medos_complaint_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A complaint cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD.status = 'CLOSED' THEN RAISE EXCEPTION 'A closed complaint cannot change' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."complaintNumber" <> OLD."complaintNumber" OR NEW."patientId" IS DISTINCT FROM OLD."patientId" OR NEW."createdById" <> OLD."createdById" OR NEW.description <> OLD.description THEN
    RAISE EXCEPTION 'What was complained about cannot be changed; add a note instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'OPEN' AND NEW.status IN ('IN_PROGRESS', 'RESOLVED')) OR (OLD.status = 'IN_PROGRESS' AND NEW.status = 'RESOLVED')
    OR (OLD.status = 'RESOLVED' AND NEW.status IN ('CLOSED', 'IN_PROGRESS'))) THEN
    RAISE EXCEPTION 'A complaint cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER complaint_guard BEFORE UPDATE OR DELETE ON "Complaint" FOR EACH ROW EXECUTE FUNCTION medos_complaint_guard();

ALTER TABLE "ComplaintNote" ADD CONSTRAINT complaint_note_values CHECK (length(btrim(note)) BETWEEN 2 AND 1000);
CREATE TRIGGER complaint_note_immutable BEFORE UPDATE OR DELETE ON "ComplaintNote" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

SELECT medos_enable_tenant_rls('"AftercareTask"');
SELECT medos_enable_tenant_rls('"ContactAttempt"');
SELECT medos_enable_tenant_rls('"PatientFeedback"');
SELECT medos_enable_tenant_rls('"Complaint"');
SELECT medos_enable_tenant_rls('"ComplaintNote"');

-- ===== who may do what: care coordinator and patient relations roles, and the new permissions for existing roles =====
INSERT INTO "Role" ("tenantId", name, "isSystem") SELECT t.id, r.name, true FROM "Tenant" t CROSS JOIN (VALUES ('CARE_COORDINATOR'), ('PATIENT_RELATIONS')) AS r(name) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("tenantId", "roleId", "permission")
SELECT r."tenantId", r.id, p.permission FROM "Role" r JOIN (VALUES
  ('CARE_COORDINATOR', 'AFTERCARE_MANAGE'), ('CARE_COORDINATOR', 'FEEDBACK_RECORD'), ('CARE_COORDINATOR', 'PATIENT_READ'), ('CARE_COORDINATOR', 'APPOINTMENT_READ'), ('CARE_COORDINATOR', 'ADMISSION_READ'),
  ('PATIENT_RELATIONS', 'COMPLAINT_MANAGE'), ('PATIENT_RELATIONS', 'COMPLAINT_READ'), ('PATIENT_RELATIONS', 'FEEDBACK_RECORD'), ('PATIENT_RELATIONS', 'PATIENT_READ'),
  ('RECEPTIONIST', 'FEEDBACK_RECORD'), ('NURSE', 'FEEDBACK_RECORD'),
  ('MANAGER', 'COMPLAINT_READ'), ('MANAGER', 'COMPLAINT_MANAGE'), ('MANAGER', 'AFTERCARE_MANAGE'),
  ('ADMINISTRATOR', 'AFTERCARE_MANAGE'), ('ADMINISTRATOR', 'FEEDBACK_RECORD'), ('ADMINISTRATOR', 'COMPLAINT_READ'), ('ADMINISTRATOR', 'COMPLAINT_MANAGE')
) AS p(role, permission) ON p.role = r.name WHERE r."isSystem" ON CONFLICT DO NOTHING;
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT t."id", 'SYSTEM_ROLE_PERMISSIONS_CHANGED', 'Role', jsonb_build_object('source', 'migration aftercare', 'added', jsonb_build_object(
  'CARE_COORDINATOR', jsonb_build_array('AFTERCARE_MANAGE', 'FEEDBACK_RECORD', 'PATIENT_READ', 'APPOINTMENT_READ', 'ADMISSION_READ'),
  'PATIENT_RELATIONS', jsonb_build_array('COMPLAINT_MANAGE', 'COMPLAINT_READ', 'FEEDBACK_RECORD', 'PATIENT_READ'),
  'RECEPTIONIST', jsonb_build_array('FEEDBACK_RECORD'), 'NURSE', jsonb_build_array('FEEDBACK_RECORD'),
  'MANAGER', jsonb_build_array('COMPLAINT_READ', 'COMPLAINT_MANAGE', 'AFTERCARE_MANAGE'),
  'ADMINISTRATOR', jsonb_build_array('AFTERCARE_MANAGE', 'FEEDBACK_RECORD', 'COMPLAINT_READ', 'COMPLAINT_MANAGE')))
FROM "Tenant" t;

-- ===== telephone calls, automatic texts, the patient's own feedback link, complaint deadlines =====
ALTER TABLE "ContactAttempt" ADD CONSTRAINT contact_attempt_duration CHECK ("durationSeconds" IS NULL OR "durationSeconds" BETWEEN 0 AND 14400);
ALTER TABLE "AftercareTask" ADD CONSTRAINT aftercare_task_reminder CHECK ("reminderAttempts" BETWEEN 0 AND 10 AND ("reminderSentAt" IS NULL OR "reminderAttempts" >= 1));
ALTER TABLE "Complaint" ADD CONSTRAINT complaint_deadline CHECK ("dueAt" >= "createdAt" AND ("escalatedAt" IS NULL OR "escalationReason" IS NOT NULL));

ALTER TABLE "FeedbackRequest" ADD CONSTRAINT feedback_request_values CHECK ("expiresAt" > "createdAt" AND ("usedAt" IS NULL) = ("feedbackId" IS NULL));
-- A link is used once. Only its "texted" and "used" marks ever change, and a used link never changes again. Never deleted.
CREATE OR REPLACE FUNCTION medos_feedback_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A feedback link cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."taskId" <> OLD."taskId" OR NEW."tokenHash" <> OLD."tokenHash" OR NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION 'A feedback link cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."usedAt" IS NOT NULL THEN RAISE EXCEPTION 'This feedback link has already been used' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER feedback_request_guard BEFORE UPDATE OR DELETE ON "FeedbackRequest" FOR EACH ROW EXECUTE FUNCTION medos_feedback_request_guard();
SELECT medos_enable_tenant_rls('"FeedbackRequest"');

-- The patient opens a link without signing in, so the hospital is found from the link's hash (the caller must hold the link).
CREATE OR REPLACE FUNCTION medos_resolve_feedback_request(p_hash text) RETURNS TABLE (tenant_id uuid, request_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT f."tenantId", f.id FROM public."FeedbackRequest" f WHERE f."tokenHash" = p_hash $$;
REVOKE ALL ON FUNCTION medos_resolve_feedback_request(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_resolve_feedback_request(text) TO medos_app;

-- The worker finds the hospitals that have after-discharge work to do (a text due, a feedback link to send, a complaint past its deadline); it then serves each under its own scope.
CREATE OR REPLACE FUNCTION medos_tenants_with_aftercare_work(p_now timestamptz) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT t."tenantId" FROM public."AftercareTask" t
   WHERE (t.status = 'PENDING' AND t."reminderSentAt" IS NULL AND t."reminderAttempts" < 3 AND t."dueDate" <= (p_now::date + 30) AND (t."reminderNextAt" IS NULL OR t."reminderNextAt" <= p_now))
      OR (t.status = 'COMPLETED' AND t."completedAt" > p_now - interval '7 days' AND NOT EXISTS (SELECT 1 FROM public."FeedbackRequest" f WHERE f."tenantId" = t."tenantId" AND f."taskId" = t.id))
  UNION
  SELECT c."tenantId" FROM public."Complaint" c WHERE c.status IN ('OPEN', 'IN_PROGRESS') AND c."dueAt" <= p_now AND c."escalatedAt" IS NULL
$$;
REVOKE ALL ON FUNCTION medos_tenants_with_aftercare_work(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medos_tenants_with_aftercare_work(timestamptz) TO medos_app;
