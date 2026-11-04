import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDoctor, makeUserWithPermissions, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const ITEM = { genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3, foodRelation: "AFTER_FOOD" };

describe("prescription templates and the extra prescription parts", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let d1: TestDoctor;
  let d2: TestDoctor;
  let bDoc: TestDoctor;
  const make = (tok: string, body: Record<string, unknown>) => t.api("post", "/prescription-templates", tok).send(body);
  const names = async (tok: string) => ((await t.api("get", "/prescription-templates", tok)).body.data as { name: string }[]).map((x) => x.name);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("tpl-a");
    b = await t.makeTenant("tpl-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    [d1, d2] = [await makeDoctor(t, a), await makeDoctor(t, a)] as [TestDoctor, TestDoctor];
    bDoc = await makeDoctor(t, b);
  });
  after(async () => { await t.close(); });

  it("a doctor saves a template; only they see it unless they share it", async () => {
    const r = await make(d1.token, { name: "Viral fever", content: { items: [ITEM], investigationsAdvised: ["CBC"], otherTestsAdvised: ["Chest X-ray"], cardiologyAdvised: ["ECG"], proceduresAdvised: ["Spirometry"], advice: "Rest and fluids" } });
    assert.deepEqual([r.body.data.content.otherTestsAdvised, r.body.data.content.cardiologyAdvised, r.body.data.content.proceduresAdvised], [["Chest X-ray"], ["ECG"], ["Spirometry"]]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.data.name, r.body.data.shared, r.body.data.mine, r.body.data.content.items[0].foodRelation], ["Viral fever", false, true, "AFTER_FOOD"]);
    assert.deepEqual(await names(d1.token), ["Viral fever"]);
    assert.deepEqual(await names(d2.token), []);
    const shared = await make(d1.token, { name: "Hypertension review", shared: true, content: { advice: "Low salt diet" } });
    assert.equal(shared.status, 201);
    assert.deepEqual(await names(d2.token), ["Hypertension review"]);
    assert.equal(((await t.api("get", "/prescription-templates", d2.token)).body.data[0] as { mine: boolean }).mine, false);
    assert.deepEqual(await names(bDoc.token), [], "another hospital sees none");
  });
  it("needs a name, something in it, and refuses unknown fields, bad food timing, and duplicate names", async () => {
    assert.equal((await make(d1.token, { name: "Empty", content: {} })).status, 400);
    assert.equal((await make(d1.token, { name: "x", content: { advice: "a" } })).status, 400);
    assert.equal((await make(d1.token, { name: "Odd one", content: { advice: "a" }, extra: 1 })).status, 400);
    assert.equal((await make(d1.token, { name: "Odd two", content: { items: [{ ...ITEM, foodRelation: "WHENEVER" }] } })).status, 400);
    assert.equal((await make(d1.token, { name: "Odd three", content: { items: [ITEM], patientId: "x" } })).status, 400, "a template holds nothing about a patient");
    assert.equal((await make(d1.token, { name: "Viral fever", content: { advice: "again" } })).status, 409);
    assert.equal((await make(d2.token, { name: "Viral fever", content: { advice: "mine" } })).status, 201, "the same name for another doctor is fine");
  });
  it("only the owner removes a template; it is hidden, not deleted, and the name can be used again", async () => {
    const mine = (await make(d1.token, { name: "Short course", shared: true, content: { items: [ITEM] } })).body.data;
    assert.equal((await t.api("post", `/prescription-templates/${mine.id}/remove`, d2.token)).status, 404, "a shared template is not theirs to remove");
    assert.equal((await t.api("post", `/prescription-templates/${mine.id}/remove`, bDoc.token)).status, 404);
    assert.equal((await t.api("post", `/prescription-templates/${mine.id}/remove`, d1.token)).status, 200);
    assert.ok(!(await names(d2.token)).includes("Short course"));
    assert.equal((await t.prisma.prescriptionTemplate.findFirstOrThrow({ where: { id: mine.id } })).status, "INACTIVE");
    assert.equal((await t.api("post", `/prescription-templates/${mine.id}/remove`, d1.token)).status, 404, "already removed");
    assert.equal((await make(d1.token, { name: "Short course", content: { items: [ITEM] } })).status, 201);
    const actions = (await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: mine.id }, select: { action: true } })).map((e) => e.action);
    assert.deepEqual(actions.sort(), ["PRESCRIPTION_TEMPLATE_REMOVED", "PRESCRIPTION_TEMPLATE_SAVED"]);
  });
  it("reception and unauthenticated callers cannot use templates", async () => {
    assert.equal((await t.api("get", "/prescription-templates", rec.token)).status, 403);
    assert.equal((await make(rec.token, { name: "Nope", content: { advice: "a" } })).status, 403);
    assert.equal((await t.api("get", "/prescription-templates")).status, 401);
    const reader = await makeUserWithPermissions(t, a, ["CONSULTATION_READ"]);
    assert.equal((await t.api("get", "/prescription-templates", reader.token)).status, 403);
  });

  it("food timing, tests advised, diet and referral are saved with the visit, signed with it, and printed", async () => {
    const p = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, d1, p.id);
    await t.api("post", `/queue/${v.queueId}/start`, d1.token);
    const rx = await t.api("put", `/encounters/${v.encounterId}/prescription`, d1.token).send({ items: [ITEM, { ...ITEM, genericName: "Pantoprazole", strength: "40 mg", frequency: "OD", foodRelation: "EMPTY_STOMACH" }] });
    assert.equal(rx.status, 200, JSON.stringify(rx.body));
    assert.deepEqual((rx.body.data.order.items as { foodRelation: string }[]).map((i) => i.foodRelation), ["AFTER_FOOD", "EMPTY_STOMACH"]);
    assert.equal((await t.api("put", `/encounters/${v.encounterId}/prescription`, d1.token).send({ items: [{ ...ITEM, foodRelation: "SOMETIME" }] })).status, 400);
    const bad = await t.api("put", `/encounters/${v.encounterId}/consultation`, d1.token).send({ content: { chiefComplaint: "Fever", investigationsAdvised: ["a"] } });
    assert.equal(bad.status, 400, "a test name is at least two characters");
    const note = await t.api("put", `/encounters/${v.encounterId}/consultation`, d1.token).send({ content: { chiefComplaint: "Fever for 2 days", investigationsAdvised: ["CBC", "Dengue NS1 antigen"], otherTestsAdvised: ["Chest X-ray"], cardiologyAdvised: ["ECG"], proceduresAdvised: ["Spirometry"], pastHistory: "Asthma since childhood", dietAdvice: "Plenty of oral fluids", referral: "Physician if fever persists beyond 5 days", followUp: { afterDays: 5, notes: "Bring reports" } } });
    assert.equal(note.status, 200, JSON.stringify(note.body));
    assert.deepEqual(note.body.data.content.investigationsAdvised, ["CBC", "Dengue NS1 antigen"]);
    assert.deepEqual(note.body.data.content.otherTestsAdvised, ["Chest X-ray"]);
    assert.deepEqual([note.body.data.content.cardiologyAdvised, note.body.data.content.proceduresAdvised], [["ECG"], ["Spirometry"]]);
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/diagnoses`, d1.token).send({ text: "Viral fever", type: "PROVISIONAL" })).status, 201);
    await t.prisma.practitioner.update({ where: { id: d1.practitionerId }, data: { registrationNo: "WBMC-12345", specialty: "General Medicine" } });
    const ws = await t.api("get", `/encounters/${v.encounterId}/workspace`, d1.token);
    assert.deepEqual([ws.body.data.header.practitionerRegistrationNo, ws.body.data.header.practitionerSpecialty], ["WBMC-12345", "General Medicine"]);
    const sign = await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, d1.token).send({ version: note.body.data.version });
    assert.equal(sign.status, 200, JSON.stringify(sign.body));
    const html = await t.api("get", `/print/prescriptions/${v.encounterId}`, d1.token);
    assert.equal(html.status, 200);
    for (const s of ["Radiology / imaging", "Chest X-ray", "Cardiology investigations", "ECG", "Other diagnostic procedures", "Spirometry", "Laboratory investigations", "Asthma since childhood", "WBMC-12345", "Viral fever", "Fever for 2 days", "After food", "Empty stomach", "Dengue NS1 antigen", "Plenty of oral fluids", "Physician if fever persists", "Bring reports", "Pantoprazole"]) assert.match(html.text, new RegExp(s), s);
    const stored = await t.api("get", `/encounters/${v.encounterId}/consultation`, d1.token);
    assert.equal(stored.status, 200);
  });
});
