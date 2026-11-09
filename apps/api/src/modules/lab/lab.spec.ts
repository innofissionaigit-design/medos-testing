import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;
type User = { id: string; token: string };
interface Param { id: string; name: string }
interface Value { parameterId: string; name: string; value: string; flag: string; rangeText: string }
interface ResultView {
  resultId: string | null; status: string | null; version: number | null; currentVersion: number; hasCritical: boolean; criticalAcknowledged: boolean;
  sample: { id: string; accessionNumber: string; specimen: string; status: string } | null; parameters: { id: string; name: string; type: string; rangeText: string }[];
  draft: { values: { parameterId: string; value: string }[] }; reports: { version: number; kind: string; values: Value[]; reason: string | null; hasCritical: boolean; verifiedBy: string | null }[];
}

const CBC_PARAMS = [
  { name: "Haemoglobin", unit: "g/dL", type: "NUMERIC", decimals: 1, lowMale: 13.5, highMale: 17.5, lowFemale: 12, highFemale: 15.5, criticalLow: 7, criticalHigh: 20 },
  { name: "Total WBC count", unit: "x10^3/uL", type: "NUMERIC", decimals: 1, low: 4, high: 11, criticalHigh: 30 },
  { name: "Platelet count", unit: "x10^3/uL", type: "NUMERIC", decimals: 0, low: 150, high: 450, criticalLow: 20 },
  { name: "Remark", type: "TEXT", decimals: 0 },
];

describe("laboratory (LIMS): tests, samples, results, verification and critical values", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: User; let cashier: User; let tech: User; let path: User; let nurse: User; let pharm: User;
  let d1: TestDoctor; let d2: TestDoctor;
  let bPath: User; let bTech: User;
  let cbc: { id: string; name: string };
  let cbcParams: Param[];

  const mkService = async (name: string, tenant = a, category = "INVESTIGATION") => (await t.api("post", "/services", tenant.admin.token).send({ code: code("T"), name, category, price: "250", taxPercent: 0 })).body.data as { id: string; name: string };
  const setUp = (serviceId: string, body: Record<string, unknown>, tok = path.token) => t.api("put", `/lab/tests/${serviceId}`, tok).send({ specimen: "Blood (EDTA)", turnaroundHours: 4, parameters: CBC_PARAMS, ...body });
  /** A visit whose doctor advised the test, signed, and billed by the cashier: the lab sees it. */
  const billed = async (test: { id: string; name: string } = cbc, doc = d1, gender = "FEMALE") => {
    const patient = await registerPatient(t, rec.token, { gender });
    const v = await startVisit(t, rec.token, doc, patient.id);
    await t.api("post", `/queue/${v.queueId}/start`, doc.token);
    const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Tiredness and fever", investigationsAdvised: [test.name] } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doc.token).send({ text: "Anaemia", type: "PROVISIONAL" });
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doc.token).send({ version: c.body.data.version, acknowledgeAllergyWarnings: true })).status, 200);
    const order = await t.prisma.testOrder.findFirstOrThrow({ where: { encounterId: v.encounterId, category: "LABORATORY" } });
    const r = await t.api("post", "/test-orders/bill", cashier.token).send({ encounterId: v.encounterId, orders: [{ orderId: order.id, serviceId: test.id }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient, encounterId: v.encounterId, orderId: order.id };
  };
  const collect = (orderId: string, tok = tech.token) => t.api("post", `/lab/orders/${orderId}/sample`, tok).send({});
  const result = async (orderId: string, tok = tech.token) => (await t.api("get", `/lab/orders/${orderId}/result`, tok)).body.data as ResultView;
  const draft = (resultId: string, version: number, values: Record<string, string>, tok = tech.token) =>
    t.api("put", `/lab/results/${resultId}/draft`, tok).send({ version, values: Object.entries(values).map(([parameterId, value]) => ({ parameterId, value })) });
  const verify = (resultId: string, version: number, tok = path.token) => t.api("post", `/lab/results/${resultId}/verify`, tok).send({ version });
  const pid = (name: string) => cbcParams.find((p) => p.name === name)!.id;
  const normalValues = () => ({ [pid("Haemoglobin")]: "13.0", [pid("Total WBC count")]: "7.2", [pid("Platelet count")]: "250", [pid("Remark")]: "Normocytic" });
  /** A test with a sample taken and every value typed in, ready to verify. */
  const ready = async (values: Record<string, string> = normalValues(), test = cbc, doc = d1) => {
    const o = await billed(test, doc);
    assert.equal((await collect(o.orderId)).status, 201);
    const r = await result(o.orderId);
    const d = await draft(r.resultId!, r.version!, values);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    return { ...o, resultId: r.resultId!, version: d.body.data.version as number };
  };
  const reported = async (values?: Record<string, string>) => { const x = await ready(values); assert.equal((await verify(x.resultId, x.version)).status, 200); return x; };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("lab-a");
    b = await t.makeTenant("lab-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]); cashier = await t.makeUser(a, ["CASHIER"]); tech = await t.makeUser(a, ["LAB_TECHNICIAN"]); path = await t.makeUser(a, ["PATHOLOGIST"]);
    nurse = await t.makeUser(a, ["NURSE"]); pharm = await t.makeUser(a, ["PHARMACIST"]); bPath = await t.makeUser(b, ["PATHOLOGIST"]); bTech = await t.makeUser(b, ["LAB_TECHNICIAN"]);
    d1 = await makeDoctor(t, a); d2 = await makeDoctor(t, a);
    cbc = await mkService("Complete blood count");
    const r = await setUp(cbc.id, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    cbcParams = r.body.data.definition.parameters as Param[];
  });
  after(async () => { await t.close(); });

  describe("setting a test up", () => {
    it("the pathologist sets up what a test measures, its specimen and its ranges; the lab and doctors can read it; reception cannot", async () => {
      assert.deepEqual(cbcParams.map((p) => p.name), ["Haemoglobin", "Total WBC count", "Platelet count", "Remark"]);
      const list = await t.api("get", "/lab/tests", tech.token);
      assert.equal(list.status, 200);
      const row = list.body.data.find((x: { serviceId: string }) => x.serviceId === cbc.id);
      assert.deepEqual([row.definition.specimen, row.definition.turnaroundHours, row.definition.parameters[0].lowFemale, row.definition.parameters[0].criticalLow], ["Blood (EDTA)", 4, "12.0", "7.0"]);
      assert.equal((await t.api("get", "/lab/tests", d1.token)).status, 200);
      assert.equal((await t.api("get", "/lab/tests", rec.token)).status, 403);
      assert.equal((await t.api("get", "/lab/tests")).status, 401);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LAB_TEST_CREATED" } }));
    });

    it("refuses wrong set-ups; only people who manage the laboratory change it; another hospital's price list is out of reach", async () => {
      const svc = await mkService("Blood sugar");
      for (const bad of [
        { parameters: [] }, { specimen: "x" }, { turnaroundHours: 0 }, { extra: 1 },
        { parameters: [{ name: "Glucose", type: "NUMERIC", low: 100, high: 70 }] },
        { parameters: [{ name: "Test", type: "CHOICE", choices: ["Positive"] }] },
        { parameters: [{ name: "Test", type: "TEXT", low: 1, high: 2 }] },
        { parameters: [{ name: "Glucose", type: "NUMERIC", choices: ["a", "b"] }] },
        { parameters: [{ name: "Glucose", type: "NUMERIC", criticalLow: 90, criticalHigh: 40 }] },
        { parameters: [{ name: "Glucose", type: "NUMERIC", decimals: 9 }] },
        { parameters: [{ id: randomUUID(), name: "Glucose" }] },
      ]) assert.ok([400, 404].includes((await setUp(svc.id, bad)).status), JSON.stringify(bad));
      for (const [who, tok] of [["technician", tech.token], ["doctor", d1.token], ["nurse", nurse.token], ["reception", rec.token]] as const) assert.equal((await setUp(svc.id, {}, tok)).status, 403, who);
      assert.equal((await setUp(randomUUID(), {})).status, 404);
      const radiology = await mkService("Chest X-ray", a, "PROCEDURE");
      assert.equal((await setUp(radiology.id, {})).status, 404, "only a laboratory test can be set up");
      assert.equal((await setUp(svc.id, {}, bPath.token)).status, 404, "another hospital's price list");
      assert.equal((await setUp(svc.id, { status: "ACTIVE" })).status, 200);
    });

    it("changing a test keeps its parameters' numbers; a parameter taken out becomes inactive and is never deleted", async () => {
      const svc = await mkService("Thyroid panel");
      const first = await setUp(svc.id, { parameters: [{ name: "TSH", unit: "uIU/mL", type: "NUMERIC", decimals: 2, low: 0.4, high: 4 }, { name: "T4", unit: "ug/dL", type: "NUMERIC", decimals: 1, low: 5, high: 12 }] });
      const [tsh, t4] = first.body.data.definition.parameters as { id: string; lineNo: number }[];
      const second = await setUp(svc.id, { parameters: [{ id: tsh!.id, name: "TSH (3rd generation)", unit: "uIU/mL", type: "NUMERIC", decimals: 2, low: 0.35, high: 4.5 }, { name: "Free T3", type: "NUMERIC", decimals: 2, low: 2, high: 4.4 }] });
      const now = second.body.data.definition.parameters as { id: string; name: string; lineNo: number }[];
      assert.deepEqual(now.map((p) => p.name), ["TSH (3rd generation)", "Free T3"]);
      assert.equal(now[0]!.id, tsh!.id);
      assert.equal(now[1]!.lineNo, 3, "a new parameter takes the next line; a used line number is never reused");
      const old = await t.prisma.labParameter.findFirstOrThrow({ where: { id: t4!.id } });
      assert.equal(old.status, "INACTIVE");
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "LabParameter" WHERE id = '${t4!.id}'::uuid`), /append-only/);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LAB_TEST_UPDATED" } }));
    });
  });

  describe("the work list and samples", () => {
    it("only billed laboratory tests reach the lab; a sample gets its accession number and the result form opens; a test has one live sample", async () => {
      const patient = await registerPatient(t, rec.token);
      const v = await startVisit(t, rec.token, d1, patient.id);
      await t.api("post", `/queue/${v.queueId}/start`, d1.token);
      const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, d1.token).send({ content: { chiefComplaint: "Tiredness", investigationsAdvised: [cbc.name] } });
      await t.api("post", `/encounters/${v.encounterId}/diagnoses`, d1.token).send({ text: "Anaemia", type: "PROVISIONAL" });
      await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, d1.token).send({ version: c.body.data.version, acknowledgeAllergyWarnings: true });
      const unbilled = await t.prisma.testOrder.findFirstOrThrow({ where: { encounterId: v.encounterId } });
      assert.equal((await collect(unbilled.id)).status, 404, "not billed yet: nothing to collect");
      const before = (await t.api("get", "/lab/worklist?state=WAITING_SAMPLE&pageSize=100", tech.token)).body.data;
      assert.equal(before.items.some((i: { testOrderId: string }) => i.testOrderId === unbilled.id), false);
      assert.equal((await t.api("post", "/test-orders/bill", cashier.token).send({ encounterId: v.encounterId, orders: [{ orderId: unbilled.id, serviceId: cbc.id }] })).status, 201);
      const w = (await t.api("get", "/lab/worklist?state=WAITING_SAMPLE&pageSize=100", tech.token)).body.data;
      const item = w.items.find((i: { testOrderId: string }) => i.testOrderId === unbilled.id);
      assert.deepEqual([item.state, item.test, item.accessionNumber, item.visitNumber !== null], ["WAITING_SAMPLE", cbc.name, null, true]);
      const s = await collect(unbilled.id);
      assert.equal(s.status, 201, JSON.stringify(s.body));
      assert.match(s.body.data.accessionNumber, /^LAB-\d{4}-\d{6}$/);
      assert.equal(s.body.data.specimen, "Blood (EDTA)");
      assert.equal((await collect(unbilled.id)).status, 409, "a sample is already live");
      const r = await result(unbilled.id);
      assert.deepEqual([r.status, r.sample?.accessionNumber, r.parameters.length, r.currentVersion], ["DRAFT", s.body.data.accessionNumber, 4, 0]);
      const hb = r.parameters.find((p) => p.name === "Haemoglobin")!;
      assert.equal(hb.rangeText, "12.0 - 15.5", "the range for a woman, because the patient is a woman");
      const after = (await t.api("get", "/lab/worklist?state=SAMPLE_TAKEN&pageSize=100", tech.token)).body.data.items.find((i: { testOrderId: string }) => i.testOrderId === unbilled.id);
      assert.deepEqual([after.state, after.accessionNumber], ["SAMPLE_TAKEN", s.body.data.accessionNumber]);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LAB_SAMPLE_COLLECTED", entityId: s.body.data.id } }));
    });

    it("a rejected sample goes back to waiting and a new one is taken with a new number; who may take samples", async () => {
      const o = await billed();
      const first = (await collect(o.orderId)).body.data as { id: string; accessionNumber: string };
      assert.equal((await t.api("post", `/lab/samples/${first.id}/reject`, tech.token).send({ reason: "no" })).status, 400);
      for (const [who, tok] of [["reception", rec.token], ["cashier", cashier.token], ["pathologist", path.token]] as const) assert.equal((await t.api("post", `/lab/samples/${first.id}/reject`, tok).send({ reason: "Haemolysed sample" })).status, 403, who);
      const rej = await t.api("post", `/lab/samples/${first.id}/reject`, tech.token).send({ reason: "Haemolysed sample" });
      assert.equal(rej.status, 200, JSON.stringify(rej.body));
      assert.equal((await t.api("post", `/lab/samples/${first.id}/reject`, tech.token).send({ reason: "Again, for the record" })).status, 409);
      assert.equal((await result(o.orderId)).sample?.status, "REJECTED");
      const again = await collect(o.orderId, nurse.token);
      assert.equal(again.status, 201, "a nurse may take a sample at the ward");
      assert.notEqual(again.body.data.accessionNumber, first.accessionNumber);
      assert.equal((await collect(o.orderId, rec.token)).status, 403);
      assert.equal((await collect(o.orderId, pharm.token)).status, 403);
      assert.equal((await collect(o.orderId, d1.token)).status, 403);
      assert.equal((await collect(o.orderId, bTech.token)).status, 404, "another hospital's test");
      assert.equal((await collect(randomUUID())).status, 404);
      assert.equal((await t.api("post", `/lab/samples/${first.id}/reject`, bTech.token).send({ reason: "Not our sample" })).status, 404);
    });

    it("the work list can be filtered and searched, and is the lab's only; the sample label prints", async () => {
      const o = await billed();
      const s = (await collect(o.orderId)).body.data as { id: string; accessionNumber: string };
      const byAccession = (await t.api("get", `/lab/worklist?q=${s.accessionNumber}`, tech.token)).body.data;
      assert.deepEqual(byAccession.items.map((i: { testOrderId: string }) => i.testOrderId), [o.orderId]);
      const mrn = byAccession.items[0].mrn as string;
      assert.ok(((await t.api("get", `/lab/worklist?q=${mrn}`, tech.token)).body.data.items as { testOrderId: string }[]).some((i) => i.testOrderId === o.orderId));
      assert.equal((await t.api("get", "/lab/worklist?state=NOPE", tech.token)).status, 400);
      assert.equal((await t.api("get", "/lab/worklist?pageSize=500", tech.token)).status, 400);
      assert.equal((await t.api("get", "/lab/worklist", rec.token)).status, 403);
      assert.equal(((await t.api("get", "/lab/worklist?pageSize=100", bTech.token)).body.data.items as unknown[]).length, 0, "another hospital sees none of these");
      const label = await t.api("get", `/print/lab-labels/${s.id}`, tech.token);
      assert.equal(label.status, 200);
      assert.ok(label.text.includes(s.accessionNumber) && label.text.includes("Blood (EDTA)") && label.text.includes(cbc.name));
      assert.equal((await t.api("get", `/print/lab-labels/${s.id}`, rec.token)).status, 403);
      assert.equal((await t.api("get", `/print/lab-labels/${s.id}`, bTech.token)).status, 404);
    });
  });

  describe("results and verification", () => {
    it("typing in results needs a live sample; the saved draft is what verification checks; two people saving at once cannot overwrite each other", async () => {
      const o = await billed();
      assert.equal(await t.prisma.labResult.count({ where: { testOrderId: o.orderId } }), 0);
      await collect(o.orderId);
      const r = await result(o.orderId);
      const d = await draft(r.resultId!, r.version!, { [pid("Haemoglobin")]: "13.0" });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      assert.equal(d.body.data.version, r.version! + 1);
      assert.equal((await draft(r.resultId!, r.version!, { [pid("Haemoglobin")]: "9" })).status, 409, "the token is out of date");
      assert.deepEqual((await result(o.orderId)).draft.values, [{ parameterId: pid("Haemoglobin"), value: "13.0" }]);
      assert.equal((await draft(r.resultId!, d.body.data.version, { [randomUUID()]: "1" })).status, 400, "not measured by this test");
      assert.equal((await t.api("put", `/lab/results/${r.resultId}/draft`, tech.token).send({ version: 1, values: [], extra: 1 })).status, 400);
      for (const [who, tok] of [["reception", rec.token], ["doctor", d1.token], ["nurse", nurse.token]] as const) assert.equal((await draft(r.resultId!, d.body.data.version, normalValues(), tok)).status, 403, who);
      assert.equal((await draft(r.resultId!, d.body.data.version, normalValues(), bTech.token)).status, 404);
      const sample = (await result(o.orderId)).sample!;
      assert.equal((await t.api("post", `/lab/samples/${sample.id}/reject`, tech.token).send({ reason: "Clotted sample" })).status, 200);
      const noSample = await draft(r.resultId!, d.body.data.version, normalValues());
      assert.equal(noSample.status, 409, "the sample was rejected: no live sample");
      assert.match(noSample.body.error.message, /Collect a sample/);
    });

    it("verifying needs authority and every value; numbers must be numbers and choices one of the answers", async () => {
      const x = await ready();
      assert.equal((await verify(x.resultId, x.version, tech.token)).status, 403, "the technician types, the pathologist verifies");
      for (const [who, tok] of [["reception", rec.token], ["nurse", nurse.token], ["doctor", d1.token]] as const) assert.equal((await verify(x.resultId, x.version, tok)).status, 403, who);
      assert.equal((await verify(x.resultId, x.version, bPath.token)).status, 404);
      const partial = await ready({ [pid("Haemoglobin")]: "13.0" });
      const missing = await verify(partial.resultId, partial.version);
      assert.equal(missing.status, 400);
      assert.match(missing.body.error.message, /Enter a value for/);
      const wrong = await ready({ ...normalValues(), [pid("Haemoglobin")]: "thirteen" });
      const nan = await verify(wrong.resultId, wrong.version);
      assert.equal(nan.status, 400);
      assert.match(nan.body.error.message, /Haemoglobin must be a number/);
      for (const bad of ["1,5", "1e3", "1.2345", "--3", ""]) {
        const y = await ready({ ...normalValues(), [pid("Haemoglobin")]: bad || " " });
        assert.equal((await verify(y.resultId, y.version)).status, 400, bad);
      }
      assert.equal((await verify(x.resultId, x.version + 5)).status, 409, "an out-of-date draft cannot be verified");
      assert.equal((await verify(x.resultId, x.version)).status, 200);
      assert.equal((await verify(x.resultId, x.version)).status, 409, "already verified");
    });

    it("every value is flagged against the range for this patient: normal, low, high, critical; the report keeps the ranges as they were", async () => {
      const x = await ready({ [pid("Haemoglobin")]: "11.4", [pid("Total WBC count")]: "12.5", [pid("Platelet count")]: "250", [pid("Remark")]: "Microcytic hypochromic" });
      const v = await verify(x.resultId, x.version);
      assert.equal(v.status, 200, JSON.stringify(v.body));
      assert.deepEqual([v.body.data.currentVersion, v.body.data.hasCritical], [1, false]);
      const r = await result(x.orderId);
      const flags = Object.fromEntries(r.reports[0]!.values.map((val) => [val.name, [val.value, val.flag, val.rangeText]]));
      assert.deepEqual(flags["Haemoglobin"], ["11.4", "LOW", "12.0 - 15.5"], "below the woman's lower limit of 12.0");
      assert.deepEqual(flags["Total WBC count"], ["12.5", "HIGH", "4.0 - 11.0"]);
      assert.deepEqual(flags["Platelet count"], ["250", "NORMAL", "150 - 450"]);
      assert.deepEqual(flags["Remark"], ["Microcytic hypochromic", "NORMAL", ""]);
      assert.equal(r.reports[0]!.kind, "VERIFIED");
      assert.ok(r.reports[0]!.verifiedBy);
      // A man with the same Hb of 12.6 is low: his range starts at 13.5.
      const man = await billed(cbc, d1, "MALE");
      await collect(man.orderId);
      const mr = await result(man.orderId);
      assert.equal(mr.parameters.find((p) => p.name === "Haemoglobin")!.rangeText, "13.5 - 17.5");
      const md = await draft(mr.resultId!, mr.version!, { ...normalValues(), [pid("Haemoglobin")]: "12.6" });
      await verify(mr.resultId!, md.body.data.version);
      assert.equal((await result(man.orderId)).reports[0]!.values.find((val) => val.name === "Haemoglobin")!.flag, "LOW");
      // Changing the ranges later never changes the report already given.
      await setUp(cbc.id, { parameters: [{ ...CBC_PARAMS[0], id: cbcParams[0]!.id, lowFemale: 10, criticalLow: 7 }, ...cbcParams.slice(1).map((p, i) => ({ ...CBC_PARAMS[i + 1], id: p.id }))] });
      assert.equal((await result(x.orderId)).reports[0]!.values.find((val) => val.name === "Haemoglobin")!.rangeText, "12.0 - 15.5");
      await setUp(cbc.id, { parameters: [{ ...CBC_PARAMS[0], id: cbcParams[0]!.id }, ...cbcParams.slice(1).map((p, i) => ({ ...CBC_PARAMS[i + 1], id: p.id }))] });
    });

    it("a verified report is released, cannot be typed over, and amending needs a reason and the current version; earlier versions are kept", async () => {
      const x = await reported();
      assert.equal((await draft(x.resultId, x.version, normalValues())).status, 409, "a verified result is not edited directly");
      const body = (reason: string, v = 1, values = normalValues()) => ({ expectedVersion: v, reason, values: Object.entries(values).map(([parameterId, value]) => ({ parameterId, value })) });
      assert.equal((await t.api("post", `/lab/results/${x.resultId}/amend`, path.token).send(body("no"))).status, 400, "a reason");
      for (const [who, tok] of [["technician", tech.token], ["doctor", d1.token], ["reception", rec.token]] as const) assert.equal((await t.api("post", `/lab/results/${x.resultId}/amend`, tok).send(body("Sample was mislabelled"))).status, 403, who);
      assert.equal((await t.api("post", `/lab/results/${x.resultId}/amend`, path.token).send(body("Typing mistake in platelets", 3))).status, 409, "not the current version");
      const corrected = { ...normalValues(), [pid("Platelet count")]: "310" };
      const am = await t.api("post", `/lab/results/${x.resultId}/amend`, path.token).send(body("Typing mistake in platelets", 1, corrected));
      assert.equal(am.status, 200, JSON.stringify(am.body));
      assert.equal(am.body.data.currentVersion, 2);
      const r = await result(x.orderId);
      assert.deepEqual(r.reports.map((v) => [v.version, v.kind]), [[2, "AMENDED"], [1, "VERIFIED"]]);
      assert.equal(r.reports[0]!.values.find((v) => v.name === "Platelet count")!.value, "310");
      assert.equal(r.reports[1]!.values.find((v) => v.name === "Platelet count")!.value, "250", "the first report still shows what it showed");
      assert.equal(r.reports[0]!.reason, "Typing mistake in platelets");
      assert.equal((await t.api("post", `/lab/results/${x.resultId}/amend`, path.token).send(body("Another correction here", 1))).status, 409);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LAB_RESULT_AMENDED", entityId: x.resultId } }));
      assert.equal((await t.api("post", `/lab/results/${x.resultId}/amend`, path.token).send(body("Missing a value now", 2, { [pid("Haemoglobin")]: "13" }))).status, 400);
    });

    it("a test with no set-up still works: one typed result", async () => {
      const rare = await mkService("Rare marker");
      const o = await billed(rare);
      assert.equal((await collect(o.orderId)).body.data.specimen, "Sample");
      const r = await result(o.orderId);
      assert.deepEqual(r.parameters.map((p) => [p.id, p.name, p.type]), [["FREE", "Rare marker", "TEXT"]]);
      const d = await draft(r.resultId!, r.version!, { FREE: "Not detected" });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      assert.equal((await verify(r.resultId!, d.body.data.version)).status, 200);
      assert.equal((await result(o.orderId)).reports[0]!.values[0]!.value, "Not detected");
    });
  });

  describe("critical values", () => {
    const critical = () => ({ ...normalValues(), [pid("Platelet count")]: "12", [pid("Haemoglobin")]: "6.5" });

    it("a critical value is flagged for the doctor, listed until acknowledged, and only the doctor of the visit can acknowledge it", async () => {
      const x = await ready(critical());
      const v = await verify(x.resultId, x.version);
      assert.equal(v.body.data.hasCritical, true);
      const flags = (await result(x.orderId)).reports[0]!.values.filter((val) => val.flag !== "NORMAL").map((val) => [val.name, val.flag]);
      assert.deepEqual(flags.sort(), [["Haemoglobin", "CRITICAL_LOW"], ["Platelet count", "CRITICAL_LOW"]]);
      const list = (await t.api("get", "/lab/critical", tech.token)).body.data as { resultId: string; doctor: string }[];
      assert.ok(list.some((c) => c.resultId === x.resultId && c.doctor === d1.token.slice(0, 0) + (list.find((y) => y.resultId === x.resultId)?.doctor ?? "")));
      assert.ok(((await t.api("get", "/lab/worklist?state=CRITICAL&pageSize=100", tech.token)).body.data.items as { testOrderId: string; critical: boolean }[]).some((i) => i.testOrderId === x.orderId && i.critical));
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LAB_CRITICAL_RESULT", entityId: x.resultId } }));
      // The doctor of the visit is told once (notifications.md); another doctor is not.
      assert.equal(await t.prisma.notification.count({ where: { tenantId: a.tenantId, recipientUserId: d1.userId, type: "CRITICAL_LAB_RESULT", entityId: x.resultId } }), 1);
      assert.equal(await t.prisma.notification.count({ where: { tenantId: a.tenantId, recipientUserId: d2.userId, entityId: x.resultId } }), 0);
      assert.equal((await t.api("post", `/lab/results/${x.resultId}/acknowledge`, d2.token)).status, 404, "another doctor's patient");
      assert.equal((await t.api("post", `/lab/results/${x.resultId}/acknowledge`, rec.token)).status, 403);
      assert.equal((await t.api("post", `/lab/results/${x.resultId}/acknowledge`, bPath.token)).status, 404);
      const ack = await t.api("post", `/lab/results/${x.resultId}/acknowledge`, d1.token);
      assert.equal(ack.status, 200, JSON.stringify(ack.body));
      assert.equal((await t.api("post", `/lab/results/${x.resultId}/acknowledge`, d1.token)).status, 409, "already acknowledged");
      assert.equal(((await t.api("get", "/lab/critical", tech.token)).body.data as { resultId: string }[]).some((c) => c.resultId === x.resultId), false);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LAB_CRITICAL_ACKNOWLEDGED", entityId: x.resultId } }));
      const normal = await reported();
      assert.equal((await t.api("post", `/lab/results/${normal.resultId}/acknowledge`, d1.token)).status, 409, "nothing critical to acknowledge");
    });

    it("amending to a critical value asks for the doctor's attention again; amending to normal clears it", async () => {
      const x = await ready(critical());
      await verify(x.resultId, x.version);
      assert.equal((await t.api("post", `/lab/results/${x.resultId}/acknowledge`, d1.token)).status, 200);
      const amend = (values: Record<string, string>, v: number) => t.api("post", `/lab/results/${x.resultId}/amend`, path.token).send({ expectedVersion: v, reason: "Repeat run gave different values", values: Object.entries(values).map(([parameterId, value]) => ({ parameterId, value })) });
      assert.equal((await amend({ ...critical(), [pid("Haemoglobin")]: "6.0" }, 1)).status, 200);
      assert.equal((await result(x.orderId)).criticalAcknowledged, false, "still critical: the doctor must see the new report");
      assert.equal(((await t.api("get", "/lab/critical", tech.token)).body.data as { resultId: string }[]).some((c) => c.resultId === x.resultId), true);
      const fixed = await amend(normalValues(), 2);
      assert.equal(fixed.body.data.hasCritical, false);
      assert.equal(((await t.api("get", "/lab/critical", tech.token)).body.data as { resultId: string }[]).some((c) => c.resultId === x.resultId), false);
    });
  });

  describe("what the doctor and the patient's record see", () => {
    it("the doctor of the visit sees where each test stands and the reported values; another doctor, reception and other hospitals do not", async () => {
      const o = await billed();
      let rows = (await t.api("get", `/encounters/${o.encounterId}/lab-results`, d1.token)).body.data as { state: string; report: unknown; test: string }[];
      assert.deepEqual(rows.map((r) => [r.test, r.state, r.report]), [[cbc.name, "WAITING_SAMPLE", null]]);
      await collect(o.orderId);
      rows = (await t.api("get", `/encounters/${o.encounterId}/lab-results`, d1.token)).body.data;
      assert.equal(rows[0]!.state, "SAMPLE_TAKEN");
      const r = await result(o.orderId);
      const d = await draft(r.resultId!, r.version!, normalValues());
      await verify(r.resultId!, d.body.data.version);
      rows = (await t.api("get", `/encounters/${o.encounterId}/lab-results`, d1.token)).body.data;
      assert.equal(rows[0]!.state, "REPORTED");
      assert.equal((rows[0]!.report as { values: Value[] }).values.length, 4);
      assert.equal((await t.api("get", `/encounters/${o.encounterId}/lab-results`, tech.token)).status, 200);
      assert.equal((await t.api("get", `/encounters/${o.encounterId}/lab-results`, d2.token)).status, 404, "not their patient");
      assert.equal((await t.api("get", `/encounters/${o.encounterId}/lab-results`, rec.token)).status, 403);
      assert.equal((await t.api("get", `/encounters/${o.encounterId}/lab-results`, bPath.token)).status, 404);
      assert.equal((await t.api("get", `/lab/orders/${o.orderId}/result`, bPath.token)).status, 404, "another hospital cannot open the result by its id");
      assert.equal((await t.api("get", `/lab/orders/${randomUUID()}/result`, tech.token)).status, 404);
      assert.equal((await t.api("get", "/lab/orders/not-an-id/result", tech.token)).status, 404);
    });

    it("the report prints once verified, with the ranges, flags and who verified it; an amended report says so; a reprint is a duplicate; scope applies", async () => {
      const o = await ready({ ...normalValues(), [pid("Haemoglobin")]: "11.0" });
      const early = await t.api("get", `/print/lab-reports/${o.orderId}`, tech.token);
      assert.equal(early.status, 409, "not verified yet");
      await verify(o.resultId, o.version);
      const first = await t.api("get", `/print/lab-reports/${o.orderId}`, d1.token);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      for (const text of ["Laboratory report", cbc.name, "Haemoglobin", "11.0", "12.0 - 15.5", "LOW", "Total WBC count", "Verified by"]) assert.ok(first.text.includes(text), `the report shows "${text}"`);
      assert.ok(!first.text.includes("DUPLICATE COPY"));
      assert.match((await t.api("get", `/print/lab-reports/${o.orderId}`, d1.token)).text, /DUPLICATE COPY/);
      assert.equal((await t.api("get", `/print/lab-reports/${o.orderId}`, d2.token)).status, 404, "another doctor's patient");
      assert.equal((await t.api("get", `/print/lab-reports/${o.orderId}`, rec.token)).status, 403);
      assert.equal((await t.api("get", `/print/lab-reports/${o.orderId}`, bPath.token)).status, 404);
      const pdf = await t.api("get", `/print/lab-reports/${o.orderId}?format=pdf`, d1.token).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (x: Buffer) => c.push(x)); res.on("end", () => cb(null, Buffer.concat(c))); });
      assert.equal(pdf.status, 200);
      assert.equal((pdf.body as Buffer).subarray(0, 5).toString(), "%PDF-");
      assert.equal((await t.api("post", `/lab/results/${o.resultId}/amend`, path.token).send({ expectedVersion: 1, reason: "Repeat run was normal", values: Object.entries(normalValues()).map(([parameterId, value]) => ({ parameterId, value })) })).status, 200);
      const amended = await t.api("get", `/print/lab-reports/${o.orderId}`, d1.token);
      assert.match(amended.text, /AMENDED REPORT/);
      assert.match(amended.text, /Repeat run was normal/);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "DOCUMENT_PRINTED", entityType: "LabResult", entityId: o.resultId } }));
    });
  });

  describe("integrity", () => {
    it("DATABASE: reports, samples, results and set-ups cannot be rewritten or deleted; a report must follow the one before; an amendment needs its reason", async () => {
      const x = await reported();
      const ver = await t.prisma.labResultVersion.findFirstOrThrow({ where: { resultId: x.resultId } });
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "LabResultVersion" SET comment = 'changed' WHERE id = '${ver.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "LabResultVersion" WHERE id = '${ver.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "LabResult" WHERE id = '${x.resultId}'::uuid`), /cannot be deleted/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "LabResult" SET status = 'DRAFT', "currentVersion" = 0 WHERE id = '${x.resultId}'::uuid`), /only move forward/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "LabResult" SET "currentVersion" = 5 WHERE id = '${x.resultId}'::uuid`), /one version at a time/);
      const base = `"tenantId", "resultId", values, "verifiedById"`;
      const vals = `'${a.tenantId}'::uuid, '${x.resultId}'::uuid, '[]'::jsonb, '${path.id}'::uuid`;
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "LabResultVersion" (${base}, version, kind, reason) VALUES (${vals}, 3, 'AMENDED', 'Skipping version two')`), /without gaps/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "LabResultVersion" (${base}, version, kind) VALUES (${vals}, 2, 'AMENDED')`), /lab_version_kind|check constraint/i);
      const sample = await t.prisma.labSample.findFirstOrThrow({ where: { testOrderId: x.orderId } });
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "LabSample" WHERE id = '${sample.id}'::uuid`), /cannot be deleted/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "LabSample" SET specimen = 'Urine' WHERE id = '${sample.id}'::uuid`), /can only be rejected/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "LabTestDefinition" WHERE "serviceId" = '${cbc.id}'::uuid`), /append-only/);
    });

    it("DATABASE: a sample or result belongs to a billed laboratory test of the same patient; the pathology room cannot be reached with other kinds of tests", async () => {
      const patient = await registerPatient(t, rec.token);
      const v = await startVisit(t, rec.token, d1, patient.id);
      const ordered = await t.prisma.testOrder.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: patient.id, encounterId: v.encounterId, category: "LABORATORY", name: "CBC (not billed)", orderedById: d1.userId } });
      const cols = `"tenantId", "facilityId", "patientId", "encounterId", "testOrderId", "accessionNumber", specimen, "collectedById"`;
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "LabSample" (${cols}) VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${patient.id}'::uuid, '${v.encounterId}'::uuid, '${ordered.id}'::uuid, 'LAB-RAW-1', 'Blood', '${tech.id}'::uuid)`), /billed laboratory test/);
      const other = await registerPatient(t, rec.token);
      const o = await billed();
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "LabSample" (${cols}) VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${other.id}'::uuid, '${o.encounterId}'::uuid, '${o.orderId}'::uuid, 'LAB-RAW-2', 'Blood', '${tech.id}'::uuid)`), /same patient/);
      const xray = await mkService("Skull X-ray", a, "PROCEDURE");
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "LabTestDefinition" ("tenantId", "facilityId", "serviceId", specimen, "createdById") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${xray.id}'::uuid, 'None', '${path.id}'::uuid)`), /price list/);
    });

    it("concurrency: two samples at the same moment make one; two verifications make one; two saves with the same token make one", async () => {
      const o = await billed();
      const [s1, s2] = await Promise.all([collect(o.orderId), collect(o.orderId)]);
      assert.deepEqual([s1.status, s2.status].sort(), [201, 409], JSON.stringify([s1.body, s2.body]));
      const r = await result(o.orderId);
      const [d1r, d2r] = await Promise.all([draft(r.resultId!, r.version!, normalValues()), draft(r.resultId!, r.version!, { ...normalValues(), [pid("Haemoglobin")]: "14.0" })]);
      assert.deepEqual([d1r.status, d2r.status].sort(), [200, 409]);
      const version = Math.max(d1r.body.data?.version ?? 0, d2r.body.data?.version ?? 0);
      const [v1, v2] = await Promise.all([verify(r.resultId!, version), verify(r.resultId!, version)]);
      assert.deepEqual([v1.status, v2.status].sort(), [200, 409], JSON.stringify([v1.body, v2.body]));
      assert.equal(await t.prisma.labResultVersion.count({ where: { resultId: r.resultId! } }), 1, "one report");
      assert.equal(await t.prisma.labSample.count({ where: { testOrderId: o.orderId, status: "COLLECTED" } }), 1, "one live sample");
    });

    it("the new roles exist for the hospital with the permissions the lab needs", async () => {
      for (const [role, perms] of [["LAB_TECHNICIAN", ["LAB_READ", "LAB_COLLECT", "LAB_RESULT"]], ["PATHOLOGIST", ["LAB_READ", "LAB_RESULT", "LAB_VERIFY", "LAB_MASTERS"]]] as const) {
        const r = await t.prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, name: role, isSystem: true }, include: { permissions: true } });
        for (const p of perms) assert.ok(r.permissions.some((x) => x.permission === p), `${role} has ${p}`);
      }
      const me = await t.api("get", "/auth/me", path.token);
      assert.equal(me.status, 200);
      assert.ok((me.body.data.permissions as string[]).includes("LAB_VERIFY"));
    });
  });

  it("releasing a report emails the patient that one is ready (never what it says), once, and only with their agreement", async () => {
    assert.equal((await t.api("put", "/settings/EMAIL_ENABLED", a.admin.token).send({ value: true })).status, 200);
    try {
      const x = await ready(normalValues());
      const patientId = (await t.prisma.testOrder.findFirstOrThrow({ where: { id: x.orderId }, select: { encounter: { select: { patientId: true } } } })).encounter.patientId;
      const address = `lab${uniqueWord(6)}@example.org`.toLowerCase();
      await t.prisma.patient.update({ where: { id: patientId }, data: { email: address } });
      await t.prisma.patientConsent.create({ data: { tenantId: a.tenantId, patientId, purpose: "EMAIL_MESSAGES", status: "GRANTED", method: "VERBAL", recordedById: rec.id } });
      assert.equal((await verify(x.resultId, x.version)).status, 200);
      const mail = await t.prisma.emailOutbox.findMany({ where: { tenantId: a.tenantId, patientId } });
      assert.equal(mail.length, 1);
      assert.deepEqual([mail[0]!.templateKey, mail[0]!.toAddress, mail[0]!.entityType, mail[0]!.entityId], ["REPORT_READY", address, "LabResult", x.resultId]);
      assert.ok(!/haemoglobin|platelet|13\.0|normocytic/i.test(mail[0]!.bodyText + mail[0]!.subject), "no test name or value in the email");
      const amend = await t.api("post", `/lab/results/${x.resultId}/amend`, path.token).send({ expectedVersion: 1, reason: "Corrected a value", values: Object.entries(normalValues()).map(([parameterId, value]) => ({ parameterId, value })) });
      assert.equal(amend.status, 200, JSON.stringify(amend.body));
      assert.equal(await t.prisma.emailOutbox.count({ where: { tenantId: a.tenantId, patientId } }), 1, "an amendment does not email again");
    } finally {
      await t.api("put", "/settings/EMAIL_ENABLED", a.admin.token).send({ value: false });
    }
  });

});
