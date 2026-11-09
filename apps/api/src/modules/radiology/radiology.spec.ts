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
    // The doctor of the visit is told once (notifications.md); another doctor is not.
    assert.equal(await t.prisma.notification.count({ where: { tenantId: a.tenantId, recipientUserId: d1.userId, type: "CRITICAL_RAD_FINDING", entityId: x.studyId } }), 1);
    assert.equal(await t.prisma.notification.count({ where: { tenantId: a.tenantId, recipientUserId: d2.userId, entityId: x.studyId } }), 0);
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

  it("images: PNG, JPEG and DICOM files are attached to a study; the content is checked; the imaging staff add and remove; a removed image stays on the record", async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not-really-pixels")]);
    const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("not-really-jpeg")]);
    const DCM = Buffer.concat([Buffer.alloc(128), Buffer.from("DICM"), Buffer.from("not-really-dicom")]);
    const x = await performed();
    const up = (studyId: string, tok: string, body: Buffer | string, type: string, query: Record<string, string> = { filename: "chest.png" }) => t.api("post", `/rad/studies/${studyId}/images`, tok).query(query).set("Content-Type", type).send(body);

    const ok = await up(x.studyId, tech.token, PNG, "image/png", { filename: "chest-pa.png", description: "PA view" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.data.contentType, ok.body.data.fileName, ok.body.data.description, ok.body.data.sizeBytes], ["image/png", "chest-pa.png", "PA view", PNG.length]);
    assert.equal((await up(x.studyId, tech.token, JPG, "image/jpeg", { filename: "lateral.jpg" })).status, 201);
    const dcm = await up(x.studyId, tech.token, DCM, "application/dicom", { filename: "slice-01.dcm" });
    assert.equal(dcm.status, 201, JSON.stringify(dcm.body));

    // who may add, and what is refused
    assert.equal((await up(x.studyId, radiologist.token, PNG, "image/png")).status, 403, "the radiologist reports; the radiographer adds images");
    assert.equal((await up(x.studyId, nurse.token, PNG, "image/png")).status, 403);
    assert.equal((await up(x.studyId, rec.token, PNG, "image/png")).status, 403);
    assert.equal((await up(x.studyId, bTech.token, PNG, "image/png")).status, 404, "another hospital's staff cannot reach this study");
    assert.equal((await up(x.studyId, tech.token, "<html><script>alert(1)</script></html>", "image/png")).status, 415, "HTML disguised as an image");
    assert.equal((await up(x.studyId, tech.token, PNG, "image/jpeg")).status, 415, "type must match the content");
    assert.equal((await up(x.studyId, tech.token, Buffer.concat([Buffer.from("DICM"), Buffer.alloc(200)]), "application/dicom")).status, 415, "DICM must sit after the 128-byte preamble");
    assert.equal((await up(x.studyId, tech.token, Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]), "image/png")).status, 413, "over 10 MB");
    assert.equal((await up(x.studyId, tech.token, PNG, "image/png", { filename: "" })).status, 400);
    assert.equal((await up(randomUUID(), tech.token, PNG, "image/png")).status, 404);

    // who may look
    const list = await t.api("get", `/rad/studies/${x.studyId}/images`, radiologist.token);
    assert.deepEqual(list.body.data.map((i: { fileName: string }) => i.fileName), ["chest-pa.png", "lateral.jpg", "slice-01.dcm"]);
    assert.equal((await t.api("get", `/rad/studies/${x.studyId}/images`, d1.token)).status, 200, "the doctor of the visit");
    assert.equal((await t.api("get", `/rad/studies/${x.studyId}/images`, d2.token)).status, 404, "another doctor's patient");
    assert.equal((await t.api("get", `/rad/studies/${x.studyId}/images`, bRadiologist.token)).status, 404, "another hospital");
    assert.equal((await t.api("get", `/rad/studies/${x.studyId}/images`, rec.token)).status, 403);

    const pngId = ok.body.data.id as string;
    const got = await t.api("get", `/rad/images/${pngId}/content`, radiologist.token).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    assert.equal(got.status, 200);
    assert.deepEqual([got.headers["content-type"], got.headers["x-content-type-options"], got.headers["cache-control"]], ["image/png", "nosniff", "private, no-store"]);
    assert.ok((got.body as Buffer).equals(PNG), "the same bytes come back");
    assert.match(String((await t.api("get", `/rad/images/${dcm.body.data.id}/content`, d1.token)).headers["content-disposition"]), /^attachment/, "DICOM downloads rather than opening in the browser");
    assert.equal((await t.api("get", `/rad/images/${pngId}/content`, d2.token)).status, 404);
    assert.equal((await t.api("get", `/rad/images/${pngId}/content`, bRadiologist.token)).status, 404);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "RAD_IMAGE_VIEWED", entityId: pngId, actorUserId: radiologist.id } }), "opening an image is audited");

    // removing: a reason, the imaging staff only, and the record stays
    assert.equal((await t.api("post", `/rad/images/${pngId}/remove`, radiologist.token).send({ reason: "Wrong patient image" })).status, 403);
    assert.equal((await t.api("post", `/rad/images/${pngId}/remove`, tech.token).send({ reason: "no" })).status, 400);
    assert.equal((await t.api("post", `/rad/images/${pngId}/remove`, bTech.token).send({ reason: "Wrong patient image" })).status, 404);
    assert.equal((await t.api("post", `/rad/images/${pngId}/remove`, tech.token).send({ reason: "Wrong patient image" })).status, 200);
    assert.equal((await t.api("post", `/rad/images/${pngId}/remove`, tech.token).send({ reason: "Wrong patient image" })).status, 409);
    assert.equal((await t.api("get", `/rad/images/${pngId}/content`, tech.token)).status, 404, "a removed image no longer opens");
    assert.equal((await t.api("get", `/rad/studies/${x.studyId}/images`, tech.token)).body.data.length, 2);
    const row = await t.prisma.radImage.findFirstOrThrow({ where: { id: pngId } });
    assert.deepEqual([row.status, row.removeReason, row.removedById], ["REMOVED", "Wrong patient image", tech.id], "kept, with who and why");
    const actions = (await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: pngId } })).map((e) => e.action).sort();
    assert.deepEqual(actions, ["RAD_IMAGE_ADDED", "RAD_IMAGE_REMOVED", "RAD_IMAGE_VIEWED"]);

    // database rules
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "RadImage" WHERE id = '${pngId}'::uuid`), /append-only/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "RadImage" SET "fileName" = 'other.png' WHERE id = '${pngId}'::uuid`), /cannot be edited/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "RadImage" SET status = 'ACTIVE' WHERE id = '${pngId}'::uuid`), /cannot be restored/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "RadImage" SET "removeReason" = 'Changed my mind later' WHERE id = '${pngId}'::uuid`), /cannot be changed/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "RadImage" ("tenantId", "facilityId", "patientId", "studyId", "fileName", "contentType", "sizeBytes", sha256, "storageKey", "uploadedById") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${randomUUID()}'::uuid, '${x.studyId}'::uuid, 'x.png', 'image/png', 10, 'abc', 'k', '${tech.id}'::uuid)`), /same patient and facility/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "RadImage" ("tenantId", "facilityId", "patientId", "studyId", "fileName", "contentType", "sizeBytes", sha256, "storageKey", "uploadedById") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${x.patient.id}'::uuid, '${x.studyId}'::uuid, 'x.svg', 'image/svg+xml', 10, 'abc', 'k', '${tech.id}'::uuid)`), /check/i);
  });

  it("images: a study holds at most 20; removing one makes room", async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("x")]);
    const x = await performed();
    const up = () => t.api("post", `/rad/studies/${x.studyId}/images`, tech.token).query({ filename: "k.png" }).set("Content-Type", "image/png").send(PNG);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) { const r = await up(); assert.equal(r.status, 201, JSON.stringify(r.body)); ids.push(r.body.data.id as string); }
    assert.equal((await up()).status, 409);
    assert.equal((await t.api("post", `/rad/images/${ids[0]}/remove`, tech.token).send({ reason: "Duplicate image" })).status, 200);
    assert.equal((await up()).status, 201);
  });

  it("the radiology roles exist with the permissions they need", async () => {
    for (const [role, perms] of [["RADIOGRAPHER", ["RAD_READ", "RAD_PERFORM"]], ["RADIOLOGIST", ["RAD_READ", "RAD_REPORT"]]] as const) {
      const r = await t.prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, name: role, isSystem: true }, include: { permissions: true } });
      for (const p of perms) assert.ok(r.permissions.some((x) => x.permission === p), `${role} has ${p}`);
    }
  });

  it("signing a report emails the patient that one is ready (never what it says), with their agreement", async () => {
    assert.equal((await t.api("put", "/settings/EMAIL_ENABLED", a.admin.token).send({ value: true })).status, 200);
    try {
      const x = await performed();
      const patientId = (await t.prisma.testOrder.findFirstOrThrow({ where: { id: x.orderId }, select: { encounter: { select: { patientId: true } } } })).encounter.patientId;
      const address = `rad${uniqueWord(6)}@example.org`.toLowerCase();
      await t.prisma.patient.update({ where: { id: patientId }, data: { email: address } });
      await t.prisma.patientConsent.create({ data: { tenantId: a.tenantId, patientId, purpose: "EMAIL_MESSAGES", status: "GRANTED", method: "VERBAL", recordedById: rec.id } });
      assert.equal((await report(x.studyId, radiologist.token, { findings: "Tension pneumothorax on the left.", impression: "Pneumothorax", critical: true })).status, 200);
      const mail = await t.prisma.emailOutbox.findMany({ where: { tenantId: a.tenantId, patientId } });
      assert.equal(mail.length, 1);
      assert.deepEqual([mail[0]!.templateKey, mail[0]!.toAddress, mail[0]!.entityType, mail[0]!.entityId], ["REPORT_READY", address, "RadStudy", x.studyId]);
      assert.ok(!/pneumothorax|tension/i.test(mail[0]!.bodyText + mail[0]!.subject), "no finding in the email, not even a critical one");
    } finally {
      await t.api("put", "/settings/EMAIL_ENABLED", a.admin.token).send({ value: false });
    }
  });

});
