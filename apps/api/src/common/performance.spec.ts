import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { patientBody, startApp, type TestApp, type TestTenant } from "../test/harness";

const PATIENTS = 30_000;
const AUDIT = 60_000;
const BUDGET_MS = 1_500; // generous: catches missing indexes / accidental table scans, not micro-regressions

describe("performance at realistic volume", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;

  const timed = async (fn: () => Promise<{ status: number }>): Promise<number> => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const s = process.hrtime.bigint();
      const r = await fn();
      assert.equal(r.status, 200);
      best = Math.min(best, Number(process.hrtime.bigint() - s) / 1e6);
    }
    return best;
  };
  const plan = async (sql: string): Promise<string> => {
    const rows = await t.prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${sql}`);
    return rows.map((r) => r["QUERY PLAN"]).join("\n");
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("perf-a");
    b = await t.makeTenant("perf-b");
    // other tenants' rows must not slow or leak into tenant A's queries
    for (const [tenant, n] of [[a, PATIENTS], [b, 2_000]] as const) {
      await t.prisma.$executeRawUnsafe(`
        INSERT INTO "Patient" ("tenantId", "registeredFacilityId", "firstName", "lastName", "searchName", gender, mobile, "estimatedAgeYears", "ageRecordedOn", "createdById", "updatedAt", "createdAt")
        SELECT '${tenant.tenantId}'::uuid, '${tenant.facilityId}'::uuid, 'Person' || chr(97 + (g % 26)) || (g % 977), 'Surname' || (g % 1313), lower('Person' || chr(97 + (g % 26)) || (g % 977) || ' Surname' || (g % 1313)),
               'MALE', '9' || lpad((830000000 + g)::text, 9, '0'), 30, current_date, '${tenant.admin.id}'::uuid, now(), now() - (g || ' seconds')::interval
        FROM generate_series(1, ${n}) g`);
      await t.prisma.$executeRawUnsafe(`
        INSERT INTO "PatientIdentifier" ("tenantId", "patientId", type, value)
        SELECT "tenantId", id, 'MRN', 'PERF-' || substr("tenantId"::text, 1, 4) || '-' || lpad((row_number() OVER (PARTITION BY "tenantId" ORDER BY "createdAt"))::text, 7, '0')
        FROM "Patient" WHERE "tenantId" = '${tenant.tenantId}'::uuid`);
    }
    await t.prisma.$executeRawUnsafe(`
      INSERT INTO "AuditEvent" ("tenantId", "facilityId", "actorUserId", action, "entityType", "entityId", metadata, "createdAt")
      SELECT '${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${a.admin.id}'::uuid, 'PERF_EVENT', 'Thing', 'thing-' || (g % 500), '{}'::jsonb, now() - (g || ' seconds')::interval
      FROM generate_series(1, ${AUDIT}) g`);
    await t.prisma.$executeRawUnsafe(`ANALYZE "Patient"`);
    await t.prisma.$executeRawUnsafe(`ANALYZE "PatientIdentifier"`);
    await t.prisma.$executeRawUnsafe(`ANALYZE "AuditEvent"`);
  });
  after(async () => { await t.close(); });

  it("global patient search by MRN, mobile and name stays fast with tens of thousands of patients", async () => {
    const mrn = (await t.prisma.patientIdentifier.findFirstOrThrow({ where: { tenantId: a.tenantId, value: { startsWith: "PERF-" } }, orderBy: { value: "asc" }, skip: 12_345 })).value;
    const byMrn = await timed(() => t.api("get", "/patients", a.admin.token).query({ q: mrn }));
    const byMobile = await timed(() => t.api("get", "/patients", a.admin.token).query({ q: "9830123" }));
    const byName = await timed(() => t.api("get", "/patients", a.admin.token).query({ q: "persona 12" }));
    for (const [what, ms] of [["MRN", byMrn], ["mobile", byMobile], ["name", byName]] as const) assert.ok(ms < BUDGET_MS, `search by ${what} took ${Math.round(ms)} ms`);
    const r = await t.api("get", "/patients", a.admin.token).query({ q: mrn });
    assert.equal(r.body.data.length, 1, "MRN search finds exactly the one patient");
  });

  it("search results never include another tenant's patients, even for the same text", async () => {
    const r = await t.api("get", "/patients", b.admin.token).query({ q: "9830" });
    assert.ok(r.status === 200);
    const ids = new Set((await t.prisma.patient.findMany({ where: { tenantId: b.tenantId }, select: { id: true } })).map((x) => x.id));
    assert.ok(r.body.data.every((p: { id: string }) => ids.has(p.id)));
  });

  it("list endpoints are paginated and capped", async () => {
    const r = await t.api("get", "/patients", a.admin.token).query({ q: "person", pageSize: 25 });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.length <= 25);
    assert.equal((await t.api("get", "/patients", a.admin.token).query({ q: "person", pageSize: 5000 })).status, 400);
    const ms = await timed(() => t.api("get", "/audit-events", a.admin.token).query({ pageSize: 50 }));
    assert.ok(ms < BUDGET_MS, `audit list took ${Math.round(ms)} ms`);
  });

  it("audit lookups by entity and by action use indexes rather than scanning the whole table", async () => {
    const byEntity = await timed(() => t.api("get", "/audit-events", a.admin.token).query({ entityType: "Thing", entityId: "thing-42" }));
    assert.ok(byEntity < BUDGET_MS, `audit by entity took ${Math.round(byEntity)} ms`);
    const p = await plan(`SELECT * FROM "AuditEvent" WHERE "tenantId" = '${a.tenantId}'::uuid AND "entityType" = 'Thing' AND "entityId" = 'thing-42' ORDER BY "createdAt" DESC LIMIT 50`);
    assert.ok(!/Seq Scan on "AuditEvent"/.test(p), `audit entity lookup scans the table:\n${p}`);
    const p2 = await plan(`SELECT * FROM "AuditEvent" WHERE "tenantId" = '${a.tenantId}'::uuid ORDER BY "createdAt" DESC LIMIT 50`);
    assert.ok(!/Seq Scan on "AuditEvent"/.test(p2), `audit recent list scans the table:\n${p2}`);
  });

  it("core hot paths are index-backed: patient by mobile, MRN lookup, duplicate probe", async () => {
    const mobile = (await t.prisma.patient.findFirstOrThrow({ where: { tenantId: a.tenantId }, skip: 777 })).mobile!;
    const p1 = await plan(`SELECT id FROM "Patient" WHERE "tenantId" = '${a.tenantId}'::uuid AND mobile = '${mobile}'`);
    assert.ok(!/Seq Scan on "Patient"/.test(p1), p1);
    const p2 = await plan(`SELECT "patientId" FROM "PatientIdentifier" WHERE "tenantId" = '${a.tenantId}'::uuid AND type = 'MRN' AND value = 'PERF-X-0000001'`);
    assert.ok(!/Seq Scan on "PatientIdentifier"/.test(p2), p2);
    const usable = await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN SELECT id FROM "Patient" WHERE "tenantId" = '${a.tenantId}'::uuid AND "searchName" % 'persona 12 surname 5'`);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    assert.ok(/Index|Bitmap/.test(usable), `the trigram index cannot serve the similarity probe:\n${usable}`);
    const s = process.hrtime.bigint();
    const reg = await t.api("post", "/patients", (await t.makeUser(a, ["RECEPTIONIST"])).token).send(patientBody({ firstName: "Personb", lastName: "Surnamenine" }));
    assert.ok(reg.status === 201 || reg.status === 409, `registration returned ${reg.status}`);
    assert.ok(Number(process.hrtime.bigint() - s) / 1e6 < BUDGET_MS * 2, "registration with duplicate detection is too slow at 30k patients");
  });
});
