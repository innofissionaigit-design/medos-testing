-- DropIndex
DROP INDEX "PatientIdentifier_value_prefix";

-- CreateIndex
CREATE INDEX "Patient_mobile_trgm" ON "Patient" USING GIN ("mobile" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "PatientIdentifier_value_trgm" ON "PatientIdentifier" USING GIN ("value" gin_trgm_ops);

-- ===== Hand-written invariants =====
-- (Prisma-managed GIN trigram indexes replace the text_pattern_ops btree indexes created earlier.)
DROP INDEX IF EXISTS "Patient_mobile_prefix";

