

-- ===== Hand-written invariants =====
-- Consultations signed before tests were ordered at signing (docs/test-orders.md) have their tests only inside the signed note, so the Cashier never saw them.
-- This orders those tests, for consultations signed in the last 60 days, from the latest signed or amended version of each note. It only adds orders
-- that do not exist yet; nothing is changed or removed, and the doctor's note is untouched.
WITH latest AS (
  SELECT d."tenantId", d."facilityId", d."encounterId", e."patientId", d."currentVersion" AS version, d."signedById", v.content
  FROM "ClinicalDocument" d
  JOIN "Encounter" e ON e.id = d."encounterId" AND e."tenantId" = d."tenantId"
  JOIN "ClinicalDocumentVersion" v ON v."documentId" = d.id AND v."tenantId" = d."tenantId" AND v.version = d."currentVersion"
  WHERE d.kind = 'CONSULTATION' AND d.status IN ('SIGNED', 'AMENDED') AND d."signedAt" > now() - interval '60 days' AND d."signedById" IS NOT NULL
),
wanted AS (
  SELECT l."tenantId", l."facilityId", l."encounterId", l."patientId", l.version, l."signedById", x.category,
         btrim(regexp_replace(t.name, '\s+', ' ', 'g')) AS name
  FROM latest l
  CROSS JOIN LATERAL (VALUES ('investigationsAdvised', 'LABORATORY'), ('otherTestsAdvised', 'RADIOLOGY'), ('cardiologyAdvised', 'CARDIOLOGY'), ('proceduresAdvised', 'PROCEDURE')) AS x(field, category)
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(l.content -> x.field) = 'array' THEN l.content -> x.field ELSE '[]'::jsonb END) AS t(name)
),
dedup AS (
  SELECT DISTINCT ON ("tenantId", "encounterId", category, lower(name)) *
  FROM wanted WHERE length(name) BETWEEN 2 AND 120
  ORDER BY "tenantId", "encounterId", category, lower(name)
),
inserted AS (
  INSERT INTO "TestOrder" ("tenantId", "facilityId", "patientId", "encounterId", category, name, "serviceId", source, status, "consultationVersion", "orderedById", "updatedAt")
  SELECT w."tenantId", w."facilityId", w."patientId", w."encounterId", w.category::"TestCategory", w.name,
         (SELECT s.id FROM "Service" s WHERE s."tenantId" = w."tenantId" AND s."facilityId" = w."facilityId" AND s.status = 'ACTIVE' AND (lower(s.name) = lower(w.name) OR lower(s.code) = lower(w.name)) ORDER BY s."createdAt" LIMIT 1),
         'DIGITAL', 'ORDERED', w.version, w."signedById", now()
  FROM dedup w
  WHERE NOT EXISTS (SELECT 1 FROM "TestOrder" o WHERE o."tenantId" = w."tenantId" AND o."encounterId" = w."encounterId" AND o.source = 'DIGITAL' AND o.category = w.category::"TestCategory" AND lower(o.name) = lower(w.name) AND o.status <> 'CANCELLED')
  ON CONFLICT DO NOTHING
  RETURNING "tenantId"
)
INSERT INTO "AuditEvent" ("tenantId", "action", "entityType", "metadata")
SELECT "tenantId", 'TEST_ORDERS_BACKFILLED', 'Encounter', jsonb_build_object('source', 'migration backfill_test_orders', 'orders', count(*))
FROM inserted GROUP BY "tenantId";

