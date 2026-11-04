import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
interface StudyView { state: string; study: { id: string; accessionNumber: string; modality: string; hasCritical: boolean; criticalAcknowledged: boolean; currentVersion: number } | null; reports: { version: number; kind: string; findings: string; impression: string; reason: string | null; signedBy: string | null }[] }

describe("radiology: studies, reports, amendments and critical findings", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: User; let cashier: User; let tech: User; let radiologist: User; let nurse: User; let pharm: User; let bRadiologist: User; let bTech: User;
  let d1: TestDoctor; let d2: TestDoctor;
  let xray: { id: string; name: string };

  const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;
  const mkService = async (name: string) => (await t.api("post", "/services", a.admin.token).send({ code: code("R"), name, category: "INVESTIGATION", price: "400", taxPercent: 0 })).body.data as { id: string; name: string };
  /** A visit whose doctor advised the scan, signed, and billed by the cashier: radiology sees it. */
  const billed = async (test = xray, doc = d1) => {
    const patient = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, doc, patient.id);
    await t.api("post", `/queue/${v.queueId}/start`, doc.token);
    const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Cough for two weeks", otherTestsAdvised: [test.name] } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doc.token).send({ text: "Cough", type: "PROVISIONAL" });
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doc.token).send({ version: c.body.data.version, acknowledgeAllergyWarnings: true })).status, 200);
    const order = await t.prisma.testOrder.findFirstOrThrow({ where: { encounterId: v.encounterId, category: "RADIOLOGY" } });
    const r = await t.api("post", "/test-orders/bill", cashier.token).send({ encounterId: v.encounterId, orders: [{ orderId: order.id, serviceId: test.id }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient, encounterId: v.encounterId, orderId: order.id };
  };
  const perform = (orderId: string, tok = tech.token, body: Record<string, unknown> = { modality: "XRAY", bodyPart: "Chest PA" }) => t.api("post", `/rad/orders/${orderId}/study`, tok).send(body);
  const study = async (orderId: string, tok = tech.token) => (await t.api("get", `/rad/orders/${orderId}/study`, tok)).body.data as StudyView;
  const report = (studyId: string, tok = radiologist.token, body: Record<string, unknown> = {}) => t.api("post", `/rad/studies/${studyId}/report`, tok).send({ findings: "Clear lung fields. Normal heart size.", impression: "Normal chest radiograph", critical: false, ...body });
  const performed = async () => { const o = await billed(); const s = await perform(o.orderId); assert.equal(s.status, 201, JSON.stringify(s.body)); return { ...o, studyId: s.body.data.id as string }; };
  const reported = async (body: Record<string, unknown> = {}) => { const x = await performed(); assert.equal((await report(x.studyId, radiologist.token, body)).status, 200); return x; };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("rad-a"); b = await t.makeTenant("rad-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]); cashier = await t.makeUser(a, ["CASHIER"]); tech = await t.makeUser(a, ["RADIOGRAPHER"]); radiologist = await t.makeUser(a, ["RADIOLOGIST"]);
    nurse = await t.makeUser(a, ["NURSE"]); pharm = await t.makeUser(a, ["PHARMACIST"]); bRadiologist = await t.makeUser(b, ["RADIOLOGIST"]); bTech = await t.makeUser(b, ["RADIOGRAPHER"]);
    d1 = await makeDoctor(t, a); d2 = await makeDoctor(t, a);
    xray = await mkService("Chest X-ray");
  });
  after(async () => { await t.close(); });

  it("only billed radiology tests reach the work list; the radiographer performs a study and it gets its accession number; one study per test", async () => {
    const patient = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, d1, patient.id);
    await t.api("post", `/queue/${v.queueId}/start`, d1.token);
    const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, d1.token).send({ content: { chiefComplaint: "Cough", otherTestsAdvised: [xray.name] } });
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, d1.token).send({ text: "Cough", type: "PROVISIONAL" });
    await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, d1.token).send({ version: c.body.data.version, acknowledgeAllergyWarnings: true });
    const order = await t.prisma.testOrder.findFirstOrThrow({ where: { encounterId: v.encounterId, category: "RADIOLOGY" } });
    assert.equal((await perform(order.id)).status, 404, "not billed yet");
    assert.equal((await t.api("post", "/test-orders/bill", cashier.token).send({ encounterId: v.encounterId, orders: [{ orderId: order.id, serviceId: xray.id }] })).status, 201);
    const w = (await t.api("get", "/rad/worklist?state=WAITING_STUDY&pageSize=100", tech.token)).body.data;
    const item = w.items.find((i: { testOrderId: string }) => i.testOrderId === order.id);
    assert.deepEqual([item.state, item.accessionNumber, item.test], ["WAITING_STUDY", null, xray.name]);
    const s = await perform(order.id);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.match(s.body.data.accessionNumber, /^RAD-\d{4}-\d{6}$/);
    assert.equal((await perform(order.id)).status, 409, "already performed");
    const view = await study(order.id);
    assert.deepEqual([view.state, view.study?.modality, view.reports.length], ["PERFORMED", "XRAY", 0]);
    const after = (await t.api("get", "/rad/worklist?state=PERFORMED&pageSize=100", tech.token)).body.data.items.find((i: { testOrderId: string }) => i.testOrderId === order.id);
    assert.deepEqual([after.state, after.bodyPart], ["PERFORMED", "Chest PA"]);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "RAD_STUDY_PERFORMED", entityId: s.body.data.id } }));
    // a laboratory test never reaches radiology
    const lab = await t.prisma.testOrder.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: patient.id, encounterId: v.encounterId, category: "LABORATORY", name: "CBC", orderedById: d1.userId } });
    assert.equal((await perform(lab.id)).status, 404);
  });

  it("who may do what: reception, doctors and nurses cannot perform or report; other hospitals see nothing", async () => {
    const o = await billed();
    for (const bad of [{ modality: "PET", bodyPart: "Chest" }, { modality: "XRAY", bodyPart: "x" }, { modality: "XRAY", bodyPart: "Chest", extra: 1 }, {}]) assert.equal((await perform(o.orderId, tech.token, bad)).status, 400, JSON.stringify(bad));
    for (const [who, tok] of [["reception", rec.token], ["doctor", d1.token], ["nurse", nurse.token], ["pharmacist", pharm.token], ["radiologist", radiologist.token]] as const) assert.equal((await perform(o.orderId, tok)).status, 403, who);
    assert.equal((await perform(o.orderId, bTech.token)).status, 404, "another hospital's test");
    assert.equal((await perform(randomUUID())).status, 404);
    assert.equal((await t.api("get", "/rad/worklist", rec.token)).status, 403);
    assert.equal((await t.api("get", "/rad/worklist")).status, 401);
    assert.equal(((await t.api("get", "/rad/worklist?pageSize=100", bTech.token)).body.data.items as unknown[]).length, 0);
    assert.equal((await t.api("get", "/rad/worklist?state=NOPE", tech.token)).status, 400);
    const s = (await perform(o.orderId)).body.data;
    for (const [who, tok] of [["technician", tech.token], ["doctor", d1.token], ["reception", rec.token], ["nurse", nurse.token]] as const) assert.equal((await report(s.id, tok)).status, 403, who);
    assert.equal((await report(s.id, bRadiologist.token)).status, 404);
    assert.equal((await t.api("get", `/rad/orders/${o.orderId}/study`, bRadiologist.token)).status, 404);
    assert.equal((await t.api("get", `/rad/orders/${o.orderId}/study`, rec.token)).status, 403);
  });

  it("the radiologist signs a report; it cannot be signed twice, needs findings and an impression, and can be found by accession number", async () => {
    const x = await performed();
    for (const bad of [{ findings: "ok" }, { impression: "" }, { critical: "yes" }, { extra: 1 }]) assert.equal((await report(x.studyId, radiologist.token, bad)).status, 400, JSON.stringify(bad));
    const r = await report(x.studyId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.data.currentVersion, r.body.data.hasCritical], [1, false]);
    assert.equal((await report(x.studyId)).status, 409, "already reported");
    const view = await study(x.orderId);
    assert.deepEqual([view.state, view.reports[0]?.kind, view.reports[0]?.impression], ["REPORTED", "SIGNED", "Normal chest radiograph"]);
    assert.ok(view.reports[0]?.signedBy);
    const acc = view.study!.accessionNumber;
    const found = (await t.api("get", `/rad/worklist?q=${acc}`, tech.token)).body.data.items as { testOrderId: string; state: string }[];
    assert.deepEqual(found.map((i) => [i.testOrderId, i.state]), [[x.orderId, "REPORTED"]]);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "RAD_REPORT_SIGNED", entityId: x.studyId } }));
  });

  it("amending needs a reason and the current version; earlier versions are kept", async () => {
    const x = await reported();
    const body = (over: Record<string, unknown> = {}) => ({ expectedVersion: 1, findings: "Small right pleural effusion.", impression: "Right pleural effusion", critical: false, reason: "Missed finding on first read", ...over });
    assert.equal((await t.api("post", `/rad/studies/${x.studyId}/amend`, radiologist.token).send(body({ reason: "no" }))).status, 400);
    for (const [who, tok] of [["technician", tech.token], ["doctor", d1.token], ["reception", rec.token]] as const) assert.equal((await t.api("post", `/rad/studies/${x.studyId}/amend`, tok).send(body())).status, 403, who);
    assert.equal((await t.api("post", `/rad/studies/${x.studyId}/amend`, radiologist.token).send(body({ expectedVersion: 4 }))).status, 409);
    const unsigned = await performed();
    assert.equal((await t.api("post", `/rad/studies/${unsigned.studyId}/amend`, radiologist.token).send(body())).status, 409, "nothing signed to amend");
    const am = await t.api("post", `/rad/studies/${x.studyId}/amend`, radiologist.token).send(body());
    assert.equal(am.status, 200, JSON.stringify(am.body));
    assert.equal(am.body.data.currentVersion, 2);
    const view = await study(x.orderId);
    assert.deepEqual(view.reports.map((r) => [r.version, r.kind]), [[2, "AMENDED"], [1, "SIGNED"]]);
    assert.equal(view.reports[1]!.impression, "Normal chest radiograph", "the first report still says what it said");
    assert.equal(view.reports[0]!.reason, "Missed finding on first read");
    assert.equal((await t.api("post", `/rad/studies/${x.studyId}/amend`, radiologist.token).send(body())).status, 409, "version 1 is no longer current");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "RAD_REPORT_AMENDED", entityId: x.studyId } }));
  });

  it("a critical finding is flagged for the doctor and listed until the doctor of the visit acknowledges it; amending to critical asks again", async () => {
    const x = await reported({ findings: "Large tension pneumothorax on the left.", impression: "Tension pneumothorax", critical: true });
    const list = (await t.api("get", "/rad/critical", tech.token)).body.data as { studyId: string }[];
    assert.ok(list.some((c) => c.studyId === x.studyId));
    assert.ok(((await t.api("get", "/rad/worklist?state=CRITICAL&pageSize=100", tech.token)).body.data.items as { testOrderId: string; critical: boolean }[]).some((i) => i.testOrderId === x.orderId && i.critical));
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "RAD_CRITICAL_FINDING", entityId: x.studyId } }));
    assert.equal((await t.api("post", `/rad/studies/${x.studyId}/acknowledge`, d2.token)).status, 404, "another doctor's patient");
    assert.equal((await t.api("post", `/rad/studies/${x.studyId}/acknowledge`, rec.token)).status, 403);
    assert.equal((await t.api("post", `/rad/studies/${x.studyId}/acknowledge`, bRadiologist.token)).status, 404);
    assert.equal((await t.api("post", `/rad/studies/${x.studyId}/acknowledge`, d1.token)).status, 200);
    assert.equal((await t.api("post", `/rad/studies/${x.studyId}/acknowledge`, d1.token)).status, 409, "already acknowledged");
    assert.equal(((await t.api("get", "/rad/critical", tech.token)).body.data as { studyId: string }[]).some((c) => c.studyId === x.studyId), false);
    const amend = (critical: boolean, v: number) => t.api("post", `/rad/studies/${x.studyId}/amend`, radiologist.token).send({ expectedVersion: v, findings: "Pneumothorax larger than first reported.", impression: "Enlarging pneumothorax", critical, reason: "Repeat film shows progression" });
    assert.equal((await amend(true, 1)).status, 200);
    assert.equal(((await t.api("get", "/rad/critical", tech.token)).body.data as { studyId: string }[]).some((c) => c.studyId === x.studyId), true, "the doctor must see the new report");
    assert.equal((await amend(false, 2)).status, 200);
    assert.equal(((await t.api("get", "/rad/critical", tech.token)).body.data as { studyId: string }[]).some((c) => c.studyId === x.studyId), false);
    const normal = await reported();
    assert.equal((await t.api("post", `/rad/studies/${normal.studyId}/acknowledge`, d1.token)).status, 409, "nothing critical");
  });

  it("the doctor of the visit sees where each scan stands and the report; others do not; the report prints once signed", async () => {
    const o = await performed();
    let rows = (await t.api("get", `/encounters/${o.encounterId}/radiology`, d1.token)).body.data as { state: string; report: { impression: string } | null }[];
    assert.deepEqual(rows.map((r) => [r.state, r.report]), [["PERFORMED", null]]);
    assert.equal((await t.api("get", `/print/radiology-reports/${o.orderId}`, d1.token)).status, 409, "not signed yet");
    assert.equal((await report(o.studyId)).status, 200);
    rows = (await t.api("get", `/encounters/${o.encounterId}/radiology`, d1.token)).body.data;
    assert.deepEqual([rows[0]!.state, rows[0]!.report?.impression], ["REPORTED", "Normal chest radiograph"]);
    assert.equal((await t.api("get", `/encounters/${o.encounterId}/radiology`, d2.token)).status, 404);
    assert.equal((await t.api("get", `/encounters/${o.encounterId}/radiology`, rec.token)).status, 403);
    assert.equal((await t.api("get", `/encounters/${o.encounterId}/radiology`, bRadiologist.token)).status, 404);
    const first = await t.api("get", `/print/radiology-reports/${o.orderId}`, d1.token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    for (const text of ["Radiology report", xray.name, "Chest PA", "Normal chest radiograph", "Clear lung fields"]) assert.ok(first.text.includes(text), text);
    assert.match((await t.api("get", `/print/radiology-reports/${o.orderId}`, d1.token)).text, /DUPLICATE COPY/);
    assert.equal((await t.api("get", `/print/radiology-reports/${o.orderId}`, d2.token)).status, 404);
    assert.equal((await t.api("get", `/print/radiology-reports/${o.orderId}`, rec.token)).status, 403);
    assert.equal((await t.api("get", `/print/radiology-reports/${o.orderId}`, bRadiologist.token)).status, 404);
    await t.api("post", `/rad/studies/${o.studyId}/amend`, radiologist.token).send({ expectedVersion: 1, findings: "Small left effusion.", impression: "Left pleural effusion", critical: false, reason: "Addendum after review" });
    assert.match((await t.api("get", `/print/radiology-reports/${o.orderId}`, d1.token)).text, /AMENDED REPORT/);
  });

  it("DATABASE: studies and reports cannot be rewritten or deleted; versions follow each other; a study belongs to a billed radiology test of the same patient", async () => {
    const x = await reported();
    const ver = await t.prisma.radReportVersion.findFirstOrThrow({ where: { studyId: x.studyId } });
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "RadReportVersion" SET impression = 'changed' WHERE id = '${ver.id}'::uuid`), /append-only/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "RadReportVersion" WHERE id = '${ver.id}'::uuid`), /append-only/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "RadStudy" WHERE id = '${x.studyId}'::uuid`), /cannot be deleted/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "RadStudy" SET status = 'PERFORMED', "currentVersion" = 0 WHERE id = '${x.studyId}'::uuid`), /only move forward/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "RadStudy" SET "currentVersion" = 5 WHERE id = '${x.studyId}'::uuid`), /one version at a time/);
    const vals = `'${a.tenantId}'::uuid, '${x.studyId}'::uuid, 'Some findings', 'Some impression', '${radiologist.id}'::uuid`;
    const base = `"tenantId", "studyId", findings, impression, "signedById"`;
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "RadReportVersion" (${base}, version, kind, reason) VALUES (${vals}, 3, 'AMENDED', 'Skipping version two')`), /without gaps/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "RadReportVersion" (${base}, version, kind) VALUES (${vals}, 2, 'AMENDED')`), /rad_version_kind|check constraint/i);
    const patient = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, d1, patient.id);
    const unbilled = await t.prisma.testOrder.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: patient.id, encounterId: v.encounterId, category: "RADIOLOGY", name: "Unbilled scan", orderedById: d1.userId } });
    const cols = `"tenantId", "facilityId", "patientId", "encounterId", "testOrderId", "accessionNumber", modality, "bodyPart", "performedById"`;
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "RadStudy" (${cols}) VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${patient.id}'::uuid, '${v.encounterId}'::uuid, '${unbilled.id}'::uuid, 'RAD-RAW-1', 'XRAY', 'Chest', '${tech.id}'::uuid)`), /billed radiology test/);
    const other = await registerPatient(t, rec.token);
    const o = await billed();
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "RadStudy" (${cols}) VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${other.id}'::uuid, '${o.encounterId}'::uuid, '${o.orderId}'::uuid, 'RAD-RAW-2', 'XRAY', 'Chest', '${tech.id}'::uuid)`), /same patient/);
  });

  it("concurrency: two radiographers performing the same study make one; two radiologists signing make one report", async () => {
    const o = await billed();
    const [s1, s2] = await Promise.all([perform(o.orderId), perform(o.orderId, tech.token, { modality: "XRAY", bodyPart: "Chest lateral" })]);
    assert.deepEqual([s1.status, s2.status].sort(), [201, 409], JSON.stringify([s1.body, s2.body]));
    const id = (s1.status === 201 ? s1 : s2).body.data.id as string;
    const [r1, r2] = await Promise.all([report(id), report(id, radiologist.token, { impression: "A different impression" })]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409], JSON.stringify([r1.body, r2.body]));
    assert.equal(await t.prisma.radReportVersion.count({ where: { studyId: id } }), 1);
    assert.equal(await t.prisma.radStudy.count({ where: { testOrderId: o.orderId } }), 1);
  });

  it("the radiology roles exist with the permissions they need", async () => {
    for (const [role, perms] of [["RADIOGRAPHER", ["RAD_READ", "RAD_PERFORM"]], ["RADIOLOGIST", ["RAD_READ", "RAD_REPORT"]]] as const) {
      const r = await t.prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, name: role, isSystem: true }, include: { permissions: true } });
      for (const p of perms) assert.ok(r.permissions.some((x) => x.permission === p), `${role} has ${p}`);
    }
  });
});
