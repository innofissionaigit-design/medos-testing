import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

interface Draft {
  hasText: boolean; ocrError: string | null; warnings: string[];
  patientCheck: { nameOnPaper: string | null; name: string; ageOnPaper: number | null; age: string; genderOnPaper: string | null; gender: string };
  diagnoses: string[]; advice: string[]; diet: string[]; referral: string | null; followUpDays: number | null;
  medicines: { name: string; strength?: string; frequency?: string; durationDays?: number; matched: { id: string; brandName: string; genericName: string; strength: string | null } | null }[];
  tests: { text: string; category: string; matched: { id: string; name: string; code: string } | null }[];
}

/** A handwritten picture turned into a draft prescription: read, matched to the hospital's own lists and the three dropdowns (docs/prescriptions.md). */
describe("prescription from a handwritten picture: OCR text, dropdown lists and review", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let pharm: { id: string; token: string };
  let doc: TestDoctor;
  let other: TestDoctor;
  let bAdminDoctor: TestDoctor;
  let glycomet: string;
  let cbc: string;
  let hba1c: string;
  let xray: string;
  const first = uniqueWord(6);

  const paper = (name: string, age: number, sex: string) => `Name: ${name}   Age: ${age}   Sex: ${sex}
Dx: Type 2 diabetes mellitus, Hypertension
Rx
1) Tab Metformin 500mg 1-0-1 x 30 days
2) Tab Zyxomycin 250mg 1-0-1 x 5 days
Inv: CBC, HbA1c, Urine R/E
X-ray chest PA
Advice: Walk 30 minutes daily. Avoid sugar and sweets
Diet: Low salt, low sugar diet
Refer: Dr. Sen, Cardiology
F/U after 2 weeks`;

  /** A visit of a patient with this name and a picture uploaded for it, optionally with the text typed in. */
  const scanWith = async (text: string | null, doctor = doc, o: Record<string, unknown> = {}) => {
    const patient = await registerPatient(t, rec.token, { firstName: first, lastName: uniqueWord(7), ...o });
    const v = await startVisit(t, rec.token, doctor, patient.id);
    const up = await t.api("post", `/encounters/${v.encounterId}/prescription-scans`, doctor.token).query({ filename: "rx.png" }).set("Content-Type", "image/png").send(PNG);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const scanId = up.body.data.id as string;
    if (text !== null) assert.equal((await t.api("put", `/prescription-scans/${scanId}/correction`, doctor.token).send({ text })).status, 200);
    return { patient, scanId, ...v };
  };
  const draft = async (scanId: string, tok = doc.token) => { const r = await t.api("get", `/prescription-scans/${scanId}/prescription-draft`, tok); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data as Draft; };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("pdr-a");
    b = await t.makeTenant("pdr-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]);
    doc = await makeDoctor(t, a);
    other = await makeDoctor(t, a);
    bAdminDoctor = await makeDoctor(t, b);
    assert.equal((await t.api("put", "/settings/PRESCRIPTION_UPLOAD_ENABLED", a.admin.token).send({ value: true })).status, 200);
    const med = async (brandName: string, genericName: string, strength: string, tok = pharm.token) => {
      const r = await t.api("post", "/medicines", tok).send({ brandName, genericName, strength, dosageForm: "TABLET", gstPercent: 12, reorderLevel: 5 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.data.id as string;
    };
    glycomet = await med("Glycomet", "Metformin", "500 mg");
    await med("Glycomet", "Metformin", "850 mg");
    await med("Amlong", "Amlodipine", "5 mg");
    const bPharm = await t.makeUser(b, ["PHARMACIST"]);
    await med("Otherhospitalbrand", "Othergeneric", "10 mg", bPharm.token);
    const svc = async (code: string, name: string, category = "INVESTIGATION") => {
      const r = await t.api("post", "/services", a.admin.token).send({ code, name, category, price: "100", taxPercent: "0" });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.data.id as string;
    };
    cbc = await svc("cbc", "CBC");
    hba1c = await svc("hba1c", "HbA1c");
    xray = await svc("cxr", "Chest X-ray");
    await svc("consult", "Consultation fee", "CONSULTATION");
    await t.prisma.service.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, code: "OLDTEST", name: "Retired test", category: "INVESTIGATION", price: "50", status: "INACTIVE" } });
    await t.prisma.service.create({ data: { tenantId: b.tenantId, facilityId: b.facilityId, code: "BTEST", name: "Other hospital test", category: "INVESTIGATION", price: "50" } });
  });
  after(async () => { await t.close(); });

  describe("the three dropdowns", () => {
    it("Drug, Medicine and Lab test come from the hospital's own active lists, and the standard advice comes with them", async () => {
      const r = await t.api("get", "/prescription-scans/options", doc.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const o = r.body.data as { drugs: string[]; medicines: { id: string; brandName: string; genericName: string; strength: string | null }[]; labTests: { id: string; name: string; code: string }[]; advice: string[]; truncated: { medicines: boolean; labTests: boolean } };
      assert.deepEqual(o.drugs, ["Amlodipine", "Metformin"], "each drug once, A to Z (Metformin has two strengths but is one drug)");
      assert.deepEqual(o.medicines.map((m) => `${m.brandName} ${m.strength}`), ["Amlong 5 mg", "Glycomet 500 mg", "Glycomet 850 mg"], "every brand and strength, from this hospital only");
      assert.equal(o.medicines.some((m) => m.brandName === "Otherhospitalbrand"), false, "another hospital's medicines never appear");
      assert.deepEqual(o.labTests.map((x) => x.name), ["CBC", "Chest X-ray", "HbA1c"], "only active investigations: no consultation fee, no retired test, nothing from another hospital");
      assert.ok(o.advice.length >= 8 && o.advice.every((x) => x.length > 10));
      assert.deepEqual(o.truncated, { medicines: false, labTests: false });
    });

    it("an unknown medicine or test is simply not in the lists, a retired one disappears, and access follows the permissions", async () => {
      const x = await t.api("post", "/services", a.admin.token).send({ code: "temp", name: "Temporary test", category: "INVESTIGATION", price: "10", taxPercent: "0" });
      assert.equal((await t.api("get", "/prescription-scans/options", doc.token)).body.data.labTests.some((l: { name: string }) => l.name === "Temporary test"), true);
      assert.equal((await t.api("patch", `/services/${x.body.data.id}`, a.admin.token).send({ status: "INACTIVE" })).status, 200);
      assert.equal((await t.api("get", "/prescription-scans/options", doc.token)).body.data.labTests.some((l: { name: string }) => l.name === "Temporary test"), false, "retired tests leave the list at once");
      assert.equal((await t.api("get", "/prescription-scans/options", rec.token)).status, 403);
      assert.equal((await t.api("get", "/prescription-scans/options", pharm.token)).status, 403);
      assert.equal((await t.api("get", "/prescription-scans/options")).status, 401);
      const bo = (await t.api("get", "/prescription-scans/options", bAdminDoctor.token)).body.data as { labTests: { name: string }[]; medicines: { brandName: string }[] };
      assert.deepEqual(bo.labTests.map((l) => l.name), ["Other hospital test"], "each hospital sees only its own lists");
      assert.deepEqual(bo.medicines.map((m) => m.brandName), ["Otherhospitalbrand"]);
    });
  });

  describe("the draft built from the picture", () => {
    it("maps the text onto the diagnosis, medicines, tests, advice, diet, referral and follow-up, matched to the hospital's lists", async () => {
      const s = await scanWith(null);
      const name = (await t.prisma.patient.findFirstOrThrow({ where: { id: s.patient.id } }));
      const text = paper(`${name.firstName} ${name.lastName}`, 36, "F");
      assert.equal((await t.api("put", `/prescription-scans/${s.scanId}/correction`, doc.token).send({ text })).status, 200);
      const d = await draft(s.scanId);
      assert.equal(d.hasText, true);
      assert.deepEqual(d.patientCheck, { nameOnPaper: `${name.firstName} ${name.lastName}`, name: "MATCH", ageOnPaper: 36, age: "MATCH", genderOnPaper: "FEMALE", gender: "MATCH" });
      assert.deepEqual(d.warnings, [], "nothing to warn about");
      assert.deepEqual(d.diagnoses, ["Type 2 diabetes mellitus", "Hypertension"]);
      const metformin = d.medicines.find((m) => m.name === "Metformin")!;
      assert.deepEqual([metformin.strength, metformin.frequency, metformin.durationDays], ["500mg", "BD", 30], "dose, how often and days are read");
      assert.deepEqual([metformin.matched?.id, metformin.matched?.brandName, metformin.matched?.strength], [glycomet, "Glycomet", "500 mg"], "matched to the medicine list, at the strength on the paper");
      assert.equal(d.medicines.find((m) => m.name === "Zyxomycin")!.matched, null, "a medicine the hospital does not list is left for the doctor to choose");
      assert.deepEqual(d.tests.map((x) => [x.text, x.category, x.matched?.id ?? null]), [["CBC", "LABORATORY", cbc], ["HbA1c", "LABORATORY", hba1c], ["Urine R/E", "LABORATORY", null], ["X-ray chest PA", "RADIOLOGY", xray]], "tests matched to the lab-test list (the X-ray line is matched to the Chest X-ray entry); one with no entry stays unmatched");
      assert.deepEqual(d.advice, ["Walk 30 minutes daily", "Avoid sugar and sweets"]);
      assert.deepEqual([d.diet, d.referral, d.followUpDays], [["Low salt, low sugar diet"], "Dr. Sen, Cardiology", 14]);
    });

    it("warns when the paper is for someone else: a different name, age or sex", async () => {
      const s = await scanWith(paper("Totally Different", 72, "M"));
      const d = await draft(s.scanId);
      assert.deepEqual([d.patientCheck.name, d.patientCheck.age, d.patientCheck.gender], ["DIFFERENT", "DIFFERENT", "DIFFERENT"]);
      assert.equal(d.warnings.length, 3);
      assert.ok(d.warnings[0]!.includes("does not match this patient"));
      const partial = await scanWith(paper(`${first} Someoneelse`, 36, "F"));
      assert.equal((await draft(partial.scanId)).patientCheck.name, "PARTIAL", "only part of the name matches");
    });

    it("works when nothing could be read: a clear message and empty suggestions, so the doctor fills it in by hand with the dropdowns", async () => {
      const s = await scanWith(null);
      const d = await draft(s.scanId);
      assert.deepEqual([d.hasText, d.medicines, d.tests, d.diagnoses, d.advice], [false, [], [], [], []]);
      assert.equal(d.patientCheck.name, "NOT_ON_PAPER");
      assert.ok(d.warnings.some((w) => /Nothing has been read|Nothing could be read/.test(w)));
      const junk = await scanWithJunk();
      assert.equal(junk.hasText, true);
      assert.ok(junk.warnings.some((w) => w.includes("no medicines, diagnosis or tests could be picked out")), "text was read but holds nothing usable");
      assert.deepEqual([junk.medicines.length, junk.tests.length], [0, 0]);
    });

    it("builds nothing by itself: no diagnosis, prescription, test order or note is made until the doctor applies it and signs", async () => {
      const s = await scanWith(paper("Anyone", 36, "F"));
      await draft(s.scanId);
      await draft(s.scanId);
      assert.equal(await t.prisma.diagnosis.count({ where: { encounterId: s.encounterId } }), 0);
      assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: s.encounterId } }), 0);
      assert.equal(await t.prisma.testOrder.count({ where: { encounterId: s.encounterId } }), 0);
      assert.equal(await t.prisma.clinicalDocument.count({ where: { encounterId: s.encounterId } }), 0);
    });

    it("is for the doctor of the visit: nobody else, no other hospital, and an unknown picture is a 404", async () => {
      const s = await scanWith(paper("Anyone", 36, "F"));
      assert.equal((await t.api("get", `/prescription-scans/${s.scanId}/prescription-draft`, rec.token)).status, 403, "Reception cannot");
      assert.equal((await t.api("get", `/prescription-scans/${s.scanId}/prescription-draft`, pharm.token)).status, 403);
      assert.equal((await t.api("get", `/prescription-scans/${s.scanId}/prescription-draft`, other.token)).status, 404, "another doctor's patient");
      assert.equal((await t.api("get", `/prescription-scans/${s.scanId}/prescription-draft`, bAdminDoctor.token)).status, 404, "another hospital");
      assert.equal((await t.api("get", `/prescription-scans/${s.scanId}/prescription-draft`, a.admin.token)).status, 403, "needs the permission to handle handwritten prescriptions");
      assert.equal((await t.api("get", "/prescription-scans/00000000-0000-4000-8000-000000000000/prescription-draft", doc.token)).status, 404);
      assert.equal((await t.api("get", "/prescription-scans/not-an-id/prescription-draft", doc.token)).status, 404, "a malformed id is not found, like everywhere else");
      assert.equal((await t.api("get", `/prescription-scans/${s.scanId}/prescription-draft`)).status, 401);
    });
  });

  /** Text that was read but holds nothing of a prescription. */
  async function scanWithJunk(): Promise<Draft> {
    const s = await scanWith("zzz qqq www random scribble 12345");
    return draft(s.scanId);
  }
});

/** The same flow with the picture read by a real OCR call (a stand-in service answering over HTTP), including everything that can go wrong with it. */
describe("prescription from a handwritten picture: the OCR service itself", () => {
  let t: TestApp;
  let a: TestTenant;
  let rec: { id: string; token: string };
  let doc: TestDoctor;
  let server: Server;
  const seen: { auth: string | undefined; body: Record<string, unknown> }[] = [];
  const mode: { current: "ok" | "error" | "garbage" | "slow" } = { current: "ok" };
  const READ = "Name: Anyone Atall   Age: 36   Sex: F\nDx: Viral fever\nRx\n1) Tab Paracetamol 650mg 1-1-1 x 3 days\nInv: CBC\nAdvice: Take rest and drink plenty of fluids\nF/U after 3 days";
  const SECRET = "boom with secrets";

  const scan = async () => {
    const patient = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, doc, patient.id);
    const r = await t.api("post", `/encounters/${v.encounterId}/prescription-scans`, doc.token).query({ filename: "rx.png" }).set("Content-Type", "image/png").send(PNG);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.data.id as string, status: r.body.data.status as string, body: JSON.stringify(r.body) };
  };
  const draft = async (id: string) => (await t.api("get", `/prescription-scans/${id}/prescription-draft`, doc.token)).body.data as Draft;

  before(async () => {
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown> });
        const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
        if (mode.current === "error") return send(500, { message: SECRET });
        if (mode.current === "garbage") return send(200, { hello: "world" });
        if (mode.current === "slow") return void setTimeout(() => send(200, { text: READ }), 3000);
        return send(200, { text: READ, confidence: 0.91 });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    process.env["OCR_PROVIDER"] = "http";
    process.env["OCR_API_URL"] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/read`;
    process.env["OCR_API_KEY"] = "test-ocr-key";
    process.env["OCR_TIMEOUT_MS"] = "1000";
    t = await startApp();
    a = await t.makeTenant("pdo-a");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
    for (const k of ["PRESCRIPTION_UPLOAD_ENABLED", "PRESCRIPTION_OCR_ENABLED"]) assert.equal((await t.api("put", `/settings/${k}`, a.admin.token).send({ value: true })).status, 200);
    const pharm = await t.makeUser(a, ["PHARMACIST"]);
    assert.equal((await t.api("post", "/medicines", pharm.token).send({ brandName: "Crocin", genericName: "Paracetamol", strength: "650 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 5 })).status, 201);
    assert.equal((await t.api("post", "/services", a.admin.token).send({ code: "cbc", name: "CBC", category: "INVESTIGATION", price: "200", taxPercent: "0" })).status, 201);
  });
  after(async () => {
    await t.close();
    server.close();
    for (const k of ["OCR_PROVIDER", "OCR_API_URL", "OCR_API_KEY", "OCR_TIMEOUT_MS"]) delete process.env[k];
  });

  it("uploading calls the OCR service with the picture and the key; the text read becomes a draft with no typing at all", async () => {
    mode.current = "ok";
    const before = seen.length;
    const s = await scan();
    assert.equal(s.status, "OCR_DONE");
    assert.equal(seen.length, before + 1, "the OCR service was called once, at upload");
    const call = seen[seen.length - 1]!;
    assert.equal(call.auth, "Bearer test-ocr-key");
    assert.deepEqual(Object.keys(call.body).sort(), ["contentBase64", "contentType", "fileName"]);
    assert.equal(call.body["contentType"], "image/png");
    assert.equal(Buffer.from(call.body["contentBase64"] as string, "base64").equals(PNG), true, "the picture itself was sent");
    const d = await draft(s.id);
    assert.equal(d.hasText, true);
    assert.deepEqual(d.diagnoses, ["Viral fever"]);
    assert.deepEqual([d.medicines[0]?.name, d.medicines[0]?.strength, d.medicines[0]?.frequency, d.medicines[0]?.durationDays, d.medicines[0]?.matched?.brandName], ["Paracetamol", "650mg", "TDS", 3, "Crocin"], "read, then matched to the medicine list");
    assert.deepEqual(d.tests.map((x) => [x.text, x.matched?.name ?? null]), [["CBC", "CBC"]]);
    assert.deepEqual([d.advice, d.followUpDays], [["Take rest and drink plenty of fluids"], 3]);
    assert.equal(d.patientCheck.name, "DIFFERENT", "the name on the paper is not this patient's: the doctor is warned");
  });

  it("when the OCR service fails the upload still works, the draft says what happened without leaking anything, and the doctor fills it in by hand", async () => {
    mode.current = "error";
    const s = await scan();
    assert.equal(s.status, "OCR_FAILED");
    assert.equal(s.body.includes(SECRET), false, "what the OCR service said is never passed on");
    const d = await draft(s.id);
    assert.equal(d.hasText, false);
    assert.deepEqual([d.medicines, d.tests, d.diagnoses], [[], [], []]);
    assert.ok(d.warnings.some((w) => w.includes("Nothing could be read from the picture") && w.includes("HTTP 500")), JSON.stringify(d.warnings));
    assert.equal(JSON.stringify(d).includes(SECRET), false);
    mode.current = "garbage";
    const g = await scan();
    assert.equal(g.status, "OCR_FAILED");
    assert.ok((await draft(g.id)).warnings.some((w) => w.includes("format this system does not understand")));
    mode.current = "slow";
    const slow = await scan();
    assert.equal(slow.status, "OCR_FAILED");
    assert.ok((await draft(slow.id)).warnings.some((w) => w.includes("did not answer in time")), "a slow service does not hang the upload");
  });

  it("reading again after a failure fills the draft; the doctor's own corrected text always wins over what OCR read", async () => {
    mode.current = "error";
    const s = await scan();
    assert.equal(s.status, "OCR_FAILED");
    mode.current = "ok";
    const again = await t.api("post", `/prescription-scans/${s.id}/extract`, doc.token);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const d = await draft(s.id);
    assert.deepEqual(d.diagnoses, ["Viral fever"]);
    assert.equal((await t.api("put", `/prescription-scans/${s.id}/correction`, doc.token).send({ text: "Dx: Acute bronchitis\nInv: ESR" })).status, 200);
    const fixed = await draft(s.id);
    assert.deepEqual([fixed.diagnoses, fixed.tests.map((x) => x.text), fixed.medicines.length], [["Acute bronchitis"], ["ESR"], 0], "the corrected text replaces the OCR text");
  });
});
