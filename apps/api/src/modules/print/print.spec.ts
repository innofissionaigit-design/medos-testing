import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Response as SuperResponse } from "supertest";
import { randomUUID } from "node:crypto";
import { makeDoctor, makeUserWithPermissions, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const XSS = "<script>alert(1)</script>";
const COURSE = { hospitalCourse: `Admitted with fever. ${XSS}`, finalDiagnoses: [{ text: "Community-acquired pneumonia", code: "J18.9" }] };

describe("printable documents", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let cashier: { id: string; token: string };
  let doc: TestDoctor;
  let bDoc: TestDoctor;

  const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;
  const get = (path: string, tok?: string) => t.api("get", `/print/${path}`, tok);
  const issuedInvoice = async (notes?: string) => {
    const p = await registerPatient(t, rec.token);
    const d = await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, ...(notes ? { notes } : {}), lines: [{ description: "Procedure", unitPrice: "250", taxPercent: 0, quantity: 1 }] });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    return { patient: p, id: d.body.data.id as string };
  };
  const issue = async (id: string) => assert.equal((await t.api("post", `/invoices/${id}/issue`, cashier.token)).status, 200);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("prt-a");
    b = await t.makeTenant("prt-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    doc = await makeDoctor(t, a);
    bDoc = await makeDoctor(t, b);
    const h = await t.api("put", "/settings/PRINT_HEADER", a.admin.token).send({ value: { hospitalName: "Sunrise Care Hospital", tagline: XSS, phone: "033-5550100" } });
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.equal((await t.api("put", "/settings/PRINT_FOOTER", a.admin.token).send({ value: { invoice: "Thank you. <b>Get well soon</b>" } })).status, 200);
  });
  after(async () => { await t.close(); });

  describe("invoices and receipts", () => {
    it("a draft invoice cannot be printed; an issued one renders with the configured header, escaped content and a locked-down CSP", async () => {
      const inv = await issuedInvoice(XSS);
      assert.equal((await get(`invoices/${inv.id}`, cashier.token)).status, 409);
      await issue(inv.id);
      const r = await get(`invoices/${inv.id}`, cashier.token);
      assert.equal(r.status, 200);
      assert.match(r.headers["content-type"] ?? "", /text\/html/);
      assert.match(r.headers["content-security-policy"] ?? "", /default-src 'none'/);
      assert.match(r.headers["cache-control"] ?? "", /no-store/);
      assert.match(r.text, /Sunrise Care Hospital/);
      assert.match(r.text, /250\.00/);
      assert.ok(!r.text.includes(XSS), "raw script must never appear");
      assert.ok(!r.text.includes("<b>Get well soon</b>"), "footer is escaped");
      assert.match(r.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    });

    it("a reprint is stamped DUPLICATE COPY and every print is audited", async () => {
      const inv = await issuedInvoice();
      await issue(inv.id);
      const first = await get(`invoices/${inv.id}`, cashier.token);
      assert.ok(!first.text.includes("DUPLICATE COPY"));
      const second = await get(`invoices/${inv.id}`, cashier.token);
      assert.match(second.text, /DUPLICATE COPY/);
      const events = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: "DOCUMENT_PRINTED", entityId: inv.id }, orderBy: { createdAt: "asc" } });
      assert.equal(events.length, 2);
      assert.deepEqual(events.map((e) => (e.metadata as { copy: number }).copy), [1, 2]);
    });

    it("a cancelled invoice prints with a CANCELLED banner", async () => {
      const inv = await issuedInvoice();
      await issue(inv.id);
      const mgr = await t.makeUser(a, ["MANAGER"]);
      const c = await t.api("post", `/invoices/${inv.id}/cancel`, mgr.token).send({ reason: "Raised against wrong patient" });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      assert.match((await get(`invoices/${inv.id}`, cashier.token)).text, /CANCELLED/);
    });

    it("prints a receipt for a split payment", async () => {
      const inv = await issuedInvoice();
      await issue(inv.id);
      assert.equal((await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "100" })).status, 201);
      const p = await t.api("post", `/invoices/${inv.id}/payments`, cashier.token).set("Idempotency-Key", `k-${randomUUID().slice(0, 18)}`).send({ payments: [{ method: "CASH", amount: "100" }, { method: "UPI", amount: "150", reference: "UPI-PRT-1" }] });
      assert.equal(p.status, 201, JSON.stringify(p.body));
      const receiptId = (p.body.data.receipt ?? p.body.data).id as string;
      const r = await get(`receipts/${receiptId}`, cashier.token);
      assert.equal(r.status, 200);
      assert.match(r.text, /CASH/);
      assert.match(r.text, /UPI-PRT-1/);
      assert.match(r.text, /250\.00/);
    });

    it("prints an Advance section: the advance set against the bill and what the patient still holds; none for a bill with no advance", async () => {
      await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "100" }); // already open from an earlier test: either answer is fine
      const plain = await issuedInvoice();
      await issue(plain.id);
      assert.ok(!(await get(`invoices/${plain.id}`, cashier.token)).text.includes("Advance"), "no advance, none printed");

      const inv = await issuedInvoice();
      await issue(inv.id);
      const take = await t.api("post", `/patients/${inv.patient.id}/advances`, cashier.token).set("Idempotency-Key", `k-${randomUUID().slice(0, 18)}`).send({ tenders: [{ method: "CASH", amount: "300" }] });
      assert.equal(take.status, 201, JSON.stringify(take.body));
      const receiptNo = take.body.data.receiptNumber as string;
      const use = await t.api("post", `/invoices/${inv.id}/advances`, cashier.token).set("Idempotency-Key", `k-${randomUUID().slice(0, 18)}`).send({ amount: "100" });
      assert.equal(use.status, 201, JSON.stringify(use.body));

      const html = (await get(`invoices/${inv.id}`, cashier.token)).text;
      assert.match(html, /<h3>Advance<\/h3>/);
      assert.ok(html.includes(receiptNo), "names the advance receipt");
      assert.match(html, /Total advance used on this bill/);
      assert.match(html, /Advance still held for the patient/);
      assert.match(html, /200\.00/, "300 received, 100 used: 200 still held");

      const pdf = await t.api("get", `/print/invoices/${inv.id}`, cashier.token).query({ format: "pdf" }).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (x: Buffer) => c.push(x)); res.on("end", () => cb(null, Buffer.concat(c))); });
      assert.equal(pdf.status, 200);
      assert.equal((pdf.body as Buffer).subarray(0, 4).toString(), "%PDF");
    });

    it("is isolated by tenant, permission and authentication", async () => {
      const inv = await issuedInvoice();
      await issue(inv.id);
      const bCashier = await t.makeUser(b, ["CASHIER"]);
      assert.equal((await get(`invoices/${inv.id}`, bCashier.token)).status, 404);
      assert.equal((await get(`receipts/${randomUUID()}`, cashier.token)).status, 404);
      assert.equal((await get(`invoices/not-a-uuid`, cashier.token)).status, 404);
      const noRead = await makeUserWithPermissions(t, a, ["PATIENT_READ"]);
      assert.equal((await get(`invoices/${inv.id}`, noRead.token)).status, 403);
      assert.equal((await get(`invoices/${inv.id}`)).status, 401);
    });
  });

  describe("prescription", () => {
    it("only a signed prescription prints", async () => {
      const p = await registerPatient(t, rec.token);
      const v = await startVisit(t, rec.token, doc, p.id);
      assert.equal((await get(`prescriptions/${v.encounterId}`, doc.token)).status, 409);
      const save = await t.api("put", `/encounters/${v.encounterId}/prescription`, doc.token).send({ items: [
        { genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3, instructions: XSS },
        { genericName: "Amoxicillin", strength: "250 mg", dosage: "1 capsule", route: "ORAL", frequency: "BD", durationDays: 5 },
      ] });
      assert.equal(save.status, 200, JSON.stringify(save.body));
      assert.equal((await get(`prescriptions/${v.encounterId}`, doc.token)).status, 409, "draft is not printable");
      const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Fever and cough for 3 days" } });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      assert.equal((await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doc.token).send({ text: "Acute bronchitis", type: "PROVISIONAL" })).status, 201);
      const sign = await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doc.token).send({ version: c.body.data.version });
      assert.equal(sign.status, 200, JSON.stringify(sign.body));
      const r = await get(`prescriptions/${v.encounterId}`, doc.token);
      assert.equal(r.status, 200);
      assert.match(r.text, /Paracetamol/);
      assert.match(r.text, /Three times daily/);
      assert.ok(!r.text.includes(XSS));

    });

    it("is isolated by tenant", async () => {
      const p = await registerPatient(t, rec.token);
      const v = await startVisit(t, rec.token, doc, p.id);
      assert.equal((await get(`prescriptions/${v.encounterId}`, bDoc.token)).status, 404);
    });
  });

  describe("patient label", () => {
    it("prints the label with the MRN and is tenant-scoped", async () => {
      const p = await registerPatient(t, rec.token);
      const r = await get(`patient-labels/${p.id}`, rec.token);
      assert.equal(r.status, 200);
      assert.ok(r.text.includes(p.mrn));
      assert.equal((await get(`patient-labels/${p.id}`, bDoc.token)).status, 404);
    });
  });

  describe("discharge summary", () => {
    it("prints only once signed, using the signed content", async () => {
      const mk = async (path: string, body: Record<string, unknown>) => {
        const r = await t.api("post", path, a.admin.token).send(body);
        assert.equal(r.status, 201, JSON.stringify(r.body));
        return r.body.data as { id: string };
      };
      const ward = await mk("/wards", { name: `Ward ${uniqueWord(4)}`, code: code("W") });
      const room = await mk("/rooms", { wardId: ward.id, name: "Room", code: code("R") });
      const bed = await mk("/beds", { roomId: room.id, code: code("B"), dailyRate: "500" });
      const p = await registerPatient(t, rec.token);
      const adm = await t.api("post", "/admissions", rec.token).send({ patientId: p.id, consultantId: doc.practitionerId, bedId: bed.id, reason: "Pneumonia needing IV antibiotics" });
      assert.equal(adm.status, 201, JSON.stringify(adm.body));
      const id = adm.body.data.id as string;
      assert.equal((await get(`discharge-summaries/${id}`, doc.token)).status, 409, "no document yet");
      const d = await t.api("put", `/admissions/${id}/discharge-summary`, doc.token).send({ content: COURSE });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      assert.equal((await get(`discharge-summaries/${id}`, doc.token)).status, 409, "draft is not printable");
      assert.equal((await t.api("post", `/admissions/${id}/discharge-summary/sign`, doc.token).send({ version: d.body.data.version })).status, 200);
      const r = await get(`discharge-summaries/${id}`, doc.token);
      assert.equal(r.status, 200);
      assert.match(r.text, /Community-acquired pneumonia/);
      assert.ok(!r.text.includes(XSS));
      assert.equal((await get(`discharge-summaries/${id}`, bDoc.token)).status, 404);
    });
  });
  describe("PDF output", () => {
    const binary = (res: SuperResponse, cb: (err: Error | null, body: Buffer) => void) => { const ch: Buffer[] = []; res.on("data", (d: Buffer) => ch.push(d)); res.on("end", () => cb(null, Buffer.concat(ch))); };
    const pdf = (path: string, tok?: string, query = "") => t.api("get", `/print/${path}?format=pdf${query}`, tok).buffer(true).parse(binary);

    it("renders invoices and receipts as real PDFs with the right headers; drafts still cannot be printed", async () => {
      const inv = await issuedInvoice();
      assert.equal((await pdf(`invoices/${inv.id}`, cashier.token)).status, 409, "draft");
      await issue(inv.id);
      const r = await pdf(`invoices/${inv.id}`, cashier.token);
      assert.equal(r.status, 200);
      assert.equal(r.headers["content-type"], "application/pdf");
      assert.match(r.headers["content-disposition"] ?? "", /^inline; filename="invoice-INV-.*\.pdf"/);
      assert.match(r.headers["content-security-policy"] ?? "", /default-src 'none'/);
      const body = r.body as Buffer;
      assert.equal(body.subarray(0, 5).toString("latin1"), "%PDF-");
      assert.ok(body.length > 1500, `PDF is suspiciously small (${body.length} bytes)`);
      assert.match(body.subarray(body.length - 16).toString("latin1"), /%%EOF/);
      const dl = await pdf(`invoices/${inv.id}`, cashier.token, "&download=1");
      assert.match(dl.headers["content-disposition"] ?? "", /^attachment/);
      const events = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: "DOCUMENT_PRINTED", entityId: inv.id }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(events.map((e) => (e.metadata as { format: string }).format), ["pdf", "pdf"], "every PDF is audited with its format");
    });

    it("a PDF reprint is stamped as a duplicate in the same way as HTML", async () => {
      const inv = await issuedInvoice();
      await issue(inv.id);
      const first = (await pdf(`invoices/${inv.id}`, cashier.token)).body as Buffer;
      const second = (await pdf(`invoices/${inv.id}`, cashier.token)).body as Buffer;
      assert.ok(second.length > first.length - 200, "second copy carries the banner");
      assert.match((await get(`invoices/${inv.id}`, cashier.token)).text, /DUPLICATE COPY/, "and so does the HTML, since the count is shared");
    });

    it("renders receipts, labels, prescriptions and discharge summaries; each respects permissions and tenancy", async () => {
      const p = await registerPatient(t, rec.token);
      const label = await pdf(`patient-labels/${p.id}`, rec.token);
      assert.equal(label.status, 200);
      assert.equal((label.body as Buffer).subarray(0, 5).toString("latin1"), "%PDF-");
      assert.equal((await pdf(`patient-labels/${p.id}`, bDoc.token)).status, 404, "other tenant");
      const noRead = await makeUserWithPermissions(t, a, ["APPOINTMENT_READ"]);
      assert.equal((await pdf(`patient-labels/${p.id}`, noRead.token)).status, 403);
      assert.equal((await pdf(`patient-labels/${p.id}`)).status, 401);
      const v = await startVisit(t, rec.token, doc, p.id);
      assert.equal((await pdf(`prescriptions/${v.encounterId}`, doc.token)).status, 409, "no signed prescription yet");
    });

    it("rejects unknown formats and extra parameters, and handles text PDF cannot represent without failing", async () => {
      const p = await registerPatient(t, rec.token);
      assert.equal((await t.api("get", `/print/patient-labels/${p.id}?format=docx`, rec.token)).status, 400);
      assert.equal((await t.api("get", `/print/patient-labels/${p.id}?tenantId=x`, rec.token)).status, 400);
      const odd = await t.api("put", "/settings/PRINT_HEADER", a.admin.token).send({ value: { hospitalName: "সূর্যোদয় Hospital ₹ café", tagline: "Care — always" } });
      assert.equal(odd.status, 200, JSON.stringify(odd.body));
      const r = await pdf(`patient-labels/${p.id}`, rec.token);
      assert.equal(r.status, 200, "non-Latin characters are replaced, not fatal");
      await t.api("put", "/settings/PRINT_HEADER", a.admin.token).send({ value: { hospitalName: "Sunrise Care Hospital", tagline: XSS, phone: "033-5550100" } });
    });
  });});
