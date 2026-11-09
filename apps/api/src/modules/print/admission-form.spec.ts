import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, makeUserWithPermissions, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const XSS = "<script>alert(1)</script>";
const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;

describe("admission form print", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let doc: TestDoctor;

  const get = (id: string, tok?: string, q = "") => t.api("get", `/print/admission-forms/${id}${q}`, tok);
  const admit = async (reason = "Pneumonia needing IV antibiotics", patientBody: Record<string, unknown> = {}) => {
    const ward = (await t.api("post", "/wards", a.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    const room = (await t.api("post", "/rooms", a.admin.token).send({ wardId: ward.id, name: "Room 12", code: code("R") })).body.data;
    const bed = (await t.api("post", "/beds", a.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: "1000" })).body.data as { id: string; code: string };
    const patient = await registerPatient(t, rec.token, patientBody);
    const r = await t.api("post", "/admissions", rec.token).send({ patientId: patient.id, consultantId: doc.practitionerId, bedId: bed.id, reason });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient, bed, ward: ward.name as string, adm: r.body.data as { id: string; admissionNumber: string } };
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("adf-a");
    b = await t.makeTenant("adf-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
    assert.equal((await t.api("put", "/settings/PRINT_HEADER", a.admin.token).send({ value: { hospitalName: "Sunrise Care Hospital", phone: "033-5550100" } })).status, 200);
  });
  after(async () => { await t.close(); });

  it("prints who is admitted, under whom and where, the contacts, the consent wording and the signature lines, with the hospital's own header", async () => {
    const { adm, patient, bed, ward } = await admit("Fever and cough", { guardianName: "Meera Das", guardianRelation: "Mother", guardianMobile: "9830011223", emergencyContactName: "Ravi Das", emergencyContactMobile: "9830044556", bloodGroup: "O_POS" });
    const r = await get(adm.id, rec.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.headers["content-type"] ?? "", /text\/html/);
    assert.match(r.headers["content-security-policy"] ?? "", /default-src 'none'/);
    assert.match(r.headers["cache-control"] ?? "", /no-store/);
    for (const text of ["Sunrise Care Hospital", "Admission Form", adm.admissionNumber, patient.mrn, "Fever and cough", ward, bed.code, "Meera Das", "Mother", "9830011223", "Ravi Das", "Consent and declaration", "Patient or relative: signature", "Admitting doctor"]) {
      assert.ok(r.text.includes(text), `the form shows "${text}"`);
    }
    assert.match(r.text, /agree to be admitted/, "the standard consent wording");
    assert.ok(!r.text.includes("DUPLICATE COPY"), "the first print is not a duplicate");
  });

  it("a patient with no guardian or emergency contact has no empty Contacts section", async () => {
    const { adm } = await admit("Observation");
    const r = await get(adm.id, rec.token);
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes("Contacts"), "no empty heading");
    assert.ok(r.text.includes("Consent and declaration"));
  });

  it("the PDF is a real PDF, and the consent wording and the footer are the hospital's own", async () => {
    assert.equal((await t.api("put", "/settings/ADMISSION_CONSENT_TEXT", a.admin.token).send({ value: "We consent to treatment at Sunrise Care. <b>Custom</b> wording." })).status, 200);
    assert.equal((await t.api("put", "/settings/PRINT_FOOTER", a.admin.token).send({ value: { admissionForm: "Visiting hours 4 to 6 pm" } })).status, 200);
    const { adm } = await admit();
    const html = await get(adm.id, rec.token);
    assert.match(html.text, /We consent to treatment at Sunrise Care\./);
    assert.ok(!html.text.includes("<b>Custom</b>"), "the wording is escaped");
    assert.match(html.text, /Visiting hours 4 to 6 pm/);
    const pdf = await t.api("get", `/print/admission-forms/${adm.id}?format=pdf&download=1`, rec.token).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers["content-type"] ?? "", /application\/pdf/);
    assert.match(pdf.headers["content-disposition"] ?? "", /attachment; filename="admission-form-/);
    assert.equal((pdf.body as Buffer).subarray(0, 5).toString(), "%PDF-");
    assert.equal((await t.api("put", "/settings/ADMISSION_CONSENT_TEXT", a.admin.token).send({ value: "short" })).status, 400, "the wording needs at least 10 characters");
  });

  it("prints in Bengali and Hindi with each language's own labels and consent wording; the hospital can replace the wording; an unknown language is refused", async () => {
    const { adm } = await admit("Fever");
    const bn = await get(adm.id, rec.token, "?lang=bn");
    assert.equal(bn.status, 200, JSON.stringify(bn.body));
    for (const text of ["ভর্তি ফর্ম", "সম্মতি ও ঘোষণা", "রোগী", "আমি এই হাসপাতালে ভর্তি হতে", adm.admissionNumber]) assert.ok(bn.text.includes(text), `Bengali form shows "${text}"`);
    assert.ok(!bn.text.includes("Consent and declaration"), "no English headings on the Bengali form");
    const hi = await get(adm.id, rec.token, "?lang=hi");
    for (const text of ["भर्ती फ़ॉर्म", "सहमति और घोषणा", "मैं इस अस्पताल में भर्ती होने"]) assert.ok(hi.text.includes(text), `Hindi form shows "${text}"`);
    assert.equal((await t.api("put", "/settings/ADMISSION_CONSENT_TEXT_BN", a.admin.token).send({ value: "আমরা চিকিৎসায় সম্মতি দিলাম। <b>নিজস্ব</b> বাক্য।" })).status, 200);
    assert.equal((await t.api("put", "/settings/ADMISSION_CONSENT_TEXT_HI", a.admin.token).send({ value: "हम उपचार के लिए सहमति देते हैं। अपना वाक्य।" })).status, 200);
    const custom = await get(adm.id, rec.token, "?lang=bn");
    assert.match(custom.text, /আমরা চিকিৎসায় সম্মতি দিলাম/);
    assert.ok(!custom.text.includes("<b>নিজস্ব</b>"), "escaped");
    assert.match((await get(adm.id, rec.token, "?lang=hi")).text, /हम उपचार के लिए सहमति देते हैं/);
    assert.match((await get(adm.id, rec.token)).text, /Consent and declaration/, "English is unchanged");
    const pdf = await t.api("get", `/print/admission-forms/${adm.id}?format=pdf&lang=hi&download=1`, rec.token).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    assert.equal(pdf.status, 200);
    assert.equal((pdf.body as Buffer).subarray(0, 5).toString(), "%PDF-");
    assert.match(pdf.headers["content-disposition"] ?? "", /admission-form-.*-hi.pdf/);
    assert.equal((await get(adm.id, rec.token, "?lang=fr")).status, 400);
    assert.equal((await t.api("put", "/settings/ADMISSION_CONSENT_TEXT_BN", a.admin.token).send({ value: "ছোট" })).status, 400, "too short");
  });

  it("everything typed is escaped; a reprint is stamped DUPLICATE COPY; every print is audited", async () => {
    const { adm } = await admit(`Observation ${XSS}`);
    const first = await get(adm.id, rec.token);
    assert.ok(!first.text.includes(XSS), "raw script must never appear");
    assert.match(first.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(!first.text.includes("DUPLICATE COPY"));
    assert.match((await get(adm.id, rec.token)).text, /DUPLICATE COPY/);
    const events = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: "DOCUMENT_PRINTED", entityId: adm.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(events.map((e) => [(e.metadata as { documentType: string }).documentType, (e.metadata as { copy: number }).copy]), [["ADMISSION_FORM", 1], ["ADMISSION_FORM", 2]]);
    assert.equal(JSON.stringify(events[0]!.metadata).includes("Observation"), false, "no clinical text in the audit line");
  });

  it("a cancelled admission has no form", async () => {
    const { adm } = await admit();
    assert.equal((await t.api("post", `/admissions/${adm.id}/cancel`, rec.token).send({ reason: "Admitted by mistake" })).status, 200);
    const r = await get(adm.id, rec.token);
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /cancelled/);
  });

  it("only people who may read admissions can print it; another hospital's admission and bad ids answer 404", async () => {
    const { adm } = await admit();
    const nobody = await makeUserWithPermissions(t, a, ["PATIENT_READ"]);
    assert.equal((await get(adm.id, nobody.token)).status, 403, "no ADMISSION_READ");
    assert.equal((await get(adm.id)).status, 401);
    const nurse = await t.makeUser(a, ["NURSE"]);
    assert.equal((await get(adm.id, nurse.token)).status, 200);
    assert.equal((await get(adm.id, b.admin.token)).status, 404, "another hospital cannot see it");
    assert.equal((await get(randomUUID(), rec.token)).status, 404);
    assert.equal((await get("not-an-id", rec.token)).status, 404);
    assert.equal((await get(adm.id, rec.token, "?format=docx")).status, 400);
    assert.equal((await get(adm.id, rec.token, "?extra=1")).status, 400);
  });
});
