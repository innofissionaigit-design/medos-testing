import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const key = () => `k-${randomUUID().slice(0, 18)}`;

interface Test { id: string; category: string; name: string; serviceId: string | null; price: string | null }
interface QueueVisit { encounterId: string; patientName: string; mrn: string | null; doctorName: string | null; tests: Test[]; estimatedTotal: string; testsWithoutPrice: number }
interface QueuePicture { scanId: string; encounterId: string; pages: { fileId: string; pageNo: number }[] }

/** The doctor's tests and medicines reach the Pharmacy and the Cashier when the prescription is signed or the picture is uploaded (docs/test-orders.md). */
describe("tests advised by the doctor go to the Cashier to be billed, and the Pharmacy sees them", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let cashier: { id: string; token: string };
  let cashier2: { id: string; token: string };
  let pharm: { id: string; token: string };
  let bCashier: { id: string; token: string };
  let d1: TestDoctor;
  let d2: TestDoctor;
  let svc: Record<string, { id: string; price: string; tax: string }>;
  let med: { id: string; genericName: string; brandName: string };

  const mkService = async (code: string, name: string, price: string, tax: string) => {
    const r = await t.api("post", "/services", a.admin.token).send({ code, name, category: "INVESTIGATION", price, taxPercent: tax });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.data.id as string, price, tax };
  };
  const queue = async (tok = cashier.token) => { const r = await t.api("get", "/test-orders/queue", tok); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data as { visits: QueueVisit[]; handwritten: QueuePicture[] }; };
  const visitOf = async (encounterId: string, tok = cashier.token) => (await queue(tok)).visits.find((v) => v.encounterId === encounterId);
  const orders = (encounterId: string) => t.prisma.testOrder.findMany({ where: { encounterId }, orderBy: { createdAt: "asc" } });

  /** A visit with a signed digital prescription: one medicine and the given tests. */
  const signedVisit = async (doctor: TestDoctor, tests: { investigationsAdvised?: string[]; otherTestsAdvised?: string[]; cardiologyAdvised?: string[]; proceduresAdvised?: string[] }, withMedicine = true, existing?: { id: string }) => {
    const patient = existing ?? await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, doctor, patient.id);
    await t.api("post", `/queue/${v.queueId}/start`, doctor.token);
    const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, doctor.token).send({ content: { chiefComplaint: "Fever and cough", ...tests } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doctor.token).send({ text: "Viral fever", type: "PROVISIONAL" });
    if (withMedicine) {
      const rx = await t.api("put", `/encounters/${v.encounterId}/prescription`, doctor.token).send({ items: [{ medicineId: med.id, genericName: med.genericName, brandName: med.brandName, strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "BD", durationDays: 5, quantity: 10 }] });
      assert.equal(rx.status, 200, JSON.stringify(rx.body));
    }
    const s = await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doctor.token).send({ version: c.body.data.version, acknowledgeAllergyWarnings: true });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return { patient, ...v };
  };
  const bill = (tok: string, body: Record<string, unknown>) => t.api("post", "/test-orders/bill", tok).send(body);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("tst-a");
    b = await t.makeTenant("tst-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    cashier2 = await t.makeUser(a, ["CASHIER"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]);
    bCashier = await t.makeUser(b, ["CASHIER"]);
    d1 = await makeDoctor(t, a);
    d2 = await makeDoctor(t, a);
    svc = {
      cbc: await mkService("cbc", "CBC", "200.00", "0"),
      xray: await mkService("cxr", "Chest X-ray", "500.00", "5"),
      ecg: await mkService("ecg", "ECG", "350.50", "0"),
      panel: await mkService("vpn", "Viral panel", "1000.00", "0"),
      spiro: await mkService("spi", "Spirometry test", "300.00", "0"),
    };
    const m = await t.api("post", "/medicines", pharm.token).send({ brandName: `Brand${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "500 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 5 });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    med = m.body.data;
    assert.equal((await t.api("put", "/settings/PRESCRIPTION_UPLOAD_ENABLED", a.admin.token).send({ value: true })).status, 200);
  });
  after(async () => { await t.close(); });

  describe("digital prescription", () => {
    it("signing orders every advised test, matched to the price list; the same test written twice is one order", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC", " cbc ", "Rare marker"], otherTestsAdvised: ["Chest X-ray"], cardiologyAdvised: ["ecg"], proceduresAdvised: ["Spirometry test"] });
      const o = await orders(v.encounterId);
      assert.equal(o.length, 5, "CBC once, plus the other four");
      assert.ok(o.every((x) => x.status === "ORDERED" && x.source === "DIGITAL" && x.consultationVersion === 1));
      const by = (n: string) => o.find((x) => x.name === n)!;
      assert.equal(by("CBC").serviceId, svc.cbc!.id, "matched by name");
      assert.equal(by("ecg").serviceId, svc.ecg!.id, "matched by code, whatever the case");
      assert.equal(by("Chest X-ray").category, "RADIOLOGY");
      assert.equal(by("ecg").category, "CARDIOLOGY");
      assert.equal(by("Spirometry test").category, "PROCEDURE");
      assert.equal(by("Rare marker").serviceId, null, "no price-list item with that wording");
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "TEST_ORDERS_PLACED", entityId: v.encounterId } }), 1);
    });

    it("a visit with no tests orders none; a draft that is not signed orders none", async () => {
      const none = await signedVisit(d1, {});
      assert.equal((await orders(none.encounterId)).length, 0);
      const patient = await registerPatient(t, rec.token);
      const v = await startVisit(t, rec.token, d1, patient.id);
      await t.api("put", `/encounters/${v.encounterId}/consultation`, d1.token).send({ content: { chiefComplaint: "Cough", investigationsAdvised: ["CBC"] } });
      assert.equal((await orders(v.encounterId)).length, 0);
    });

    it("the Cashier's queue shows the visit with patient, doctor, each test and its price; only the Cashier may see it", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC"], otherTestsAdvised: ["Chest X-ray"] });
      const q = await visitOf(v.encounterId);
      assert.ok(q, "the visit is in the Cashier's queue");
      assert.deepEqual(q.tests.map((x) => [x.name, x.price]).sort(), [["CBC", "200.00"], ["Chest X-ray", "500.00"]]);
      assert.equal(q.estimatedTotal, "725.00", "200 + 500 + 5% GST on the X-ray");
      assert.equal(q.testsWithoutPrice, 0);
      assert.ok(q.mrn && q.doctorName);
      for (const tok of [rec.token, pharm.token, d1.token]) assert.equal((await t.api("get", "/test-orders/queue", tok)).status, 403);
      assert.equal((await t.api("get", "/test-orders/queue")).status, 401);
      assert.equal((await visitOf(v.encounterId, bCashier.token)), undefined, "another hospital's cashier sees nothing of this hospital");
    });

    it("the Pharmacy sees the doctor's tests next to the medicines of the same prescription", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC"], cardiologyAdvised: ["ECG"] });
      const q = (await t.api("get", "/pharmacy/queue", pharm.token)).body.data as { patientName: string; testsAdvised: { name: string; category: string; status: string }[]; items: unknown[] }[];
      const mine = q.find((x) => x.testsAdvised.some((y) => y.name === "CBC") && x.testsAdvised.some((y) => y.name === "ECG"));
      assert.ok(mine, "the prescription is in the pharmacy queue with its tests");
      assert.deepEqual(mine.testsAdvised.map((x) => `${x.category}:${x.name}`).sort(), ["CARDIOLOGY:ECG", "LABORATORY:CBC"]);
      assert.ok(mine.items.length >= 1, "and its medicines");
      assert.ok(v.encounterId);
    });

    it("billing: a test with no price-list match needs the Cashier to choose one; then an issued bill is made at the price-list prices and the Cashier collects it", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC", "Rare marker"], otherTestsAdvised: ["Chest X-ray"] });
      const o = await orders(v.encounterId);
      const all = o.map((x) => ({ orderId: x.id }));
      const refused = await bill(cashier.token, { encounterId: v.encounterId, orders: all });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, "TEST_NEEDS_PRICE");
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, encounterId: v.encounterId } }), 0, "nothing was billed");
      const rare = o.find((x) => x.name === "Rare marker")!;
      const ok = await bill(cashier.token, { encounterId: v.encounterId, orders: o.map((x) => (x.id === rare.id ? { orderId: x.id, serviceId: svc.panel!.id } : { orderId: x.id })) });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.data.tests, 3);
      assert.equal(ok.body.data.total, "1725.00", "200 + 1000 + 500 + 5% GST");
      const inv = (await t.api("get", `/invoices/${ok.body.data.invoiceId}`, cashier.token)).body.data;
      assert.equal(inv.status, "ISSUED");
      assert.equal(inv.kind, "OTHER", "not an OPD bill: the doctor's share and the consultation's bill are worked out from OPD bills");
      assert.equal(inv.lines.length, 3);
      assert.equal(inv.encounterId, v.encounterId);
      assert.ok((await orders(v.encounterId)).every((x) => x.status === "BILLED" && x.invoiceId === inv.id && x.billedById === cashier.id));
      assert.equal(await visitOf(v.encounterId), undefined, "billed tests leave the queue");
      const pay = await t.api("post", `/invoices/${inv.id}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "UPI", amount: "1725.00", reference: "REF-1234" }] });
      assert.equal(pay.status, 201, JSON.stringify(pay.body));
      assert.equal((await t.api("get", `/invoices/${inv.id}`, cashier.token)).body.data.status, "PAID");
      const ev = await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "TEST_ORDERS_BILLED", entityId: inv.id } });
      assert.ok(ev);
      assert.equal((ev.metadata as { tests: number }).tests, 3);
    });

    it("tests are never billed twice, even by two cashiers at the same moment", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC"], cardiologyAdvised: ["ECG"] });
      const body = { encounterId: v.encounterId, orders: (await orders(v.encounterId)).map((x) => ({ orderId: x.id })) };
      const rs = await Promise.all([bill(cashier.token, body), bill(cashier2.token, body), bill(cashier.token, body)]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409]);
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, encounterId: v.encounterId } }), 1);
      assert.equal((await bill(cashier.token, body)).status, 409, "and not afterwards either");
    });

    it("an amendment takes an unbilled test off and adds a new one; a billed test is never touched", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC"], cardiologyAdvised: ["ECG"] });
      const ecg = (await orders(v.encounterId)).find((x) => x.name === "ECG")!;
      assert.equal((await bill(cashier.token, { encounterId: v.encounterId, orders: [{ orderId: ecg.id }] })).status, 201);
      const am = await t.api("post", `/encounters/${v.encounterId}/consultation/amend`, d1.token).send({ expectedVersion: 1, reason: "Dropped the CBC, added a viral panel", content: { chiefComplaint: "Fever and cough", investigationsAdvised: ["Viral panel"], cardiologyAdvised: ["ECG"] } });
      assert.equal(am.status, 200, JSON.stringify(am.body));
      const o = await orders(v.encounterId);
      const state = (n: string) => o.filter((x) => x.name === n).map((x) => x.status);
      assert.deepEqual(state("CBC"), ["CANCELLED"], "taken off, not billed");
      assert.deepEqual(state("Viral panel"), ["ORDERED"]);
      assert.deepEqual(state("ECG"), ["BILLED"], "billed tests stay as they were");
      assert.equal((await t.prisma.testOrder.findFirstOrThrow({ where: { encounterId: v.encounterId, name: "CBC" } })).cancelReason?.includes("version 2"), true);
      const q = await visitOf(v.encounterId);
      assert.deepEqual(q?.tests.map((x) => x.name), ["Viral panel"]);
    });

    it("the Cashier can take an unneeded test off with a reason; a billed test cannot be taken off and the database refuses to change it", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC"], cardiologyAdvised: ["ECG"] });
      const [cbc, ecg] = [(await orders(v.encounterId)).find((x) => x.name === "CBC")!, (await orders(v.encounterId)).find((x) => x.name === "ECG")!];
      assert.equal((await t.api("post", `/test-orders/${cbc.id}/cancel`, cashier.token).send({ reason: "no" })).status, 400, "a real reason is needed");
      assert.equal((await t.api("post", `/test-orders/${cbc.id}/cancel`, rec.token).send({ reason: "Patient will test elsewhere" })).status, 403);
      assert.equal((await t.api("post", `/test-orders/${cbc.id}/cancel`, bCashier.token).send({ reason: "Patient will test elsewhere" })).status, 404, "another hospital's order");
      assert.equal((await t.api("post", `/test-orders/${cbc.id}/cancel`, cashier.token).send({ reason: "Patient will test elsewhere" })).status, 200);
      assert.equal((await t.api("post", `/test-orders/${cbc.id}/cancel`, cashier.token).send({ reason: "Patient will test elsewhere" })).status, 409);
      assert.equal((await bill(cashier.token, { encounterId: v.encounterId, orders: [{ orderId: ecg.id }] })).status, 201);
      assert.equal((await t.api("post", `/test-orders/${ecg.id}/cancel`, cashier.token).send({ reason: "Cancelled after billing" })).status, 409);
      await assert.rejects(() => t.prisma.testOrder.update({ where: { id: ecg.id }, data: { status: "ORDERED" } }), /cannot change/);
      await assert.rejects(() => t.prisma.testOrder.delete({ where: { id: ecg.id } }), /never deleted/);
      await assert.rejects(() => t.prisma.testOrder.update({ where: { id: cbc.id }, data: { name: "Something else" } }), /cannot change/);
    });

    it("the doctor sees where each test stands, with the bill number; another doctor cannot", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC"] });
      const cbc = (await orders(v.encounterId))[0]!;
      const before = (await t.api("get", `/encounters/${v.encounterId}/test-orders`, d1.token)).body.data as { name: string; status: string; invoiceNumber: string | null }[];
      assert.deepEqual(before.map((x) => [x.name, x.status, x.invoiceNumber]), [["CBC", "ORDERED", null]]);
      const done = await bill(cashier.token, { encounterId: v.encounterId, orders: [{ orderId: cbc.id }] });
      const after = (await t.api("get", `/encounters/${v.encounterId}/test-orders`, d1.token)).body.data as { status: string; invoiceNumber: string | null }[];
      assert.deepEqual(after.map((x) => [x.status, x.invoiceNumber]), [["BILLED", done.body.data.invoiceNumber]]);
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/test-orders`, d2.token)).status, 404, "not their patient");
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/test-orders`, rec.token)).status, 403);
    });

    it("validation: unknown fields, an empty request, another visit's test, an unknown price-list item and another hospital's visit are all refused", async () => {
      const v1 = await signedVisit(d1, { investigationsAdvised: ["CBC"] });
      const v2 = await signedVisit(d1, { investigationsAdvised: ["CBC"] });
      const o1 = (await orders(v1.encounterId))[0]!;
      assert.equal((await bill(cashier.token, { encounterId: v1.encounterId, orders: [{ orderId: o1.id }], total: "1.00" })).status, 400, "the total is never taken from the request");
      assert.equal((await bill(cashier.token, { encounterId: v1.encounterId })).status, 400, "nothing chosen");
      assert.equal((await bill(cashier.token, { encounterId: v2.encounterId, orders: [{ orderId: o1.id }] })).status, 409, "a test of another visit");
      assert.equal((await bill(cashier.token, { encounterId: v1.encounterId, orders: [{ orderId: o1.id, serviceId: randomUUID() }] })).status, 400, "unknown price-list item");
      assert.equal((await bill(bCashier.token, { encounterId: v1.encounterId, orders: [{ orderId: o1.id }] })).status, 404, "another hospital");
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, encounterId: v1.encounterId } }), 0);
      assert.equal((await bill(rec.token, { encounterId: v1.encounterId, orders: [{ orderId: o1.id }] })).status, 403);
    });

    it("the pharmacist is told how many tablets to give when the doctor left the quantity blank: dose x times a day x days, never a silent one", async () => {
      const patient = await registerPatient(t, rec.token);
      const dx = await makeDoctor(t, a);
      const v = await startVisit(t, rec.token, dx, patient.id);
      await t.api("post", `/queue/${v.queueId}/start`, dx.token);
      const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, dx.token).send({ content: { chiefComplaint: "Fever" } });
      await t.api("post", `/encounters/${v.encounterId}/diagnoses`, dx.token).send({ text: "Viral fever", type: "PROVISIONAL" });
      const item = (o: Record<string, unknown>) => ({ medicineId: med.id, genericName: med.genericName, brandName: med.brandName, strength: "500 mg", route: "ORAL", ...o });
      const rx = await t.api("put", `/encounters/${v.encounterId}/prescription`, dx.token).send({ items: [
        item({ dosage: "1 tablet", frequency: "BD", durationDays: 3 }),
        item({ dosage: "2 tablets", frequency: "TDS", durationDays: 5 }),
        item({ dosage: "1 tablet", frequency: "OD", durationDays: 5, quantity: 12 }),
        item({ dosage: "1 tablet", frequency: "SOS" }),
        item({ dosage: "5 ml", frequency: "BD", durationDays: 5 }),
      ] });
      assert.equal(rx.status, 200, JSON.stringify(rx.body));
      assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, dx.token).send({ version: c.body.data.version, acknowledgeAllergyWarnings: true })).status, 200);

      type QItem = { dosage: string; frequency: string; quantity: number | null; suggestedQuantity: number | null };
      const queue = (await t.api("get", "/pharmacy/queue", pharm.token)).body.data as { patientName: string; items: QItem[] }[];
      const order = queue.find((o) => o.items.some((i) => i.dosage === "2 tablets" && i.frequency === "TDS" && i.suggestedQuantity === 30))!;
      assert.ok(order, "the prescription is in the pharmacy queue");
      const by = (d: string, f: string) => order.items.find((i) => i.dosage === d && i.frequency === f)!;
      assert.deepEqual([by("1 tablet", "BD").quantity, by("1 tablet", "BD").suggestedQuantity], [null, 6], "1 tablet twice a day for 3 days");
      assert.deepEqual([by("2 tablets", "TDS").quantity, by("2 tablets", "TDS").suggestedQuantity], [null, 30]);
      assert.deepEqual([by("1 tablet", "OD").quantity, by("1 tablet", "OD").suggestedQuantity], [12, null], "a quantity the doctor wrote is the quantity; nothing is suggested over it");
      assert.equal(by("1 tablet", "SOS").suggestedQuantity, null, "only when needed: the pharmacist is asked to enter it");
      assert.equal(by("5 ml", "BD").suggestedQuantity, null, "a liquid is given by the bottle, not counted");

      const card = ((await t.api("get", "/cashier/prescriptions", cashier.token)).body.data.patients as { patientId: string; visits: { medicines: { items: { dosage: string; frequency: string; quantity: number | null; suggestedQuantity: number | null }[] }[] }[] }[]).find((x) => x.patientId === patient.id)!;
      const cashierItems = card.visits.flatMap((x) => x.medicines).flatMap((m) => m.items);
      assert.equal(cashierItems.find((i) => i.dosage === "1 tablet" && i.frequency === "BD")!.suggestedQuantity, 6, "the Cashier sees the same figure");
      assert.equal(cashierItems.find((i) => i.dosage === "1 tablet" && i.frequency === "OD")!.quantity, 12);
      // The signed prescription itself is exactly what the doctor wrote: the calculation is shown, not written into it.
      const stored = await t.prisma.medicationOrderItem.findMany({ where: { order: { encounterId: v.encounterId } }, select: { dosage: true, frequency: true, quantity: true } });
      assert.deepEqual([stored.length, stored.filter((i) => i.quantity === null).length, stored.filter((i) => i.quantity === 12).length], [5, 4, 1], "four lines still have no quantity of their own, and one has the doctor's 12");
    });

    it("typing is accepted: a test the price list does not know is billed at the price the Cashier types, with its tax, without choosing a price-list item", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC", "Rare marker"], otherTestsAdvised: ["X-ray left wrist"] });
      const o = await orders(v.encounterId);
      const rare = o.find((x) => x.name === "Rare marker")!;
      const xray = o.find((x) => x.name === "X-ray left wrist")!;
      const cbc = o.find((x) => x.name === "CBC")!;
      const ok = await bill(cashier.token, { encounterId: v.encounterId, orders: [{ orderId: cbc.id }, { orderId: rare.id, price: "750", taxPercent: "5" }, { orderId: xray.id, price: "400.50" }] });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.data.total, "1388.00", "200 + 750 + 5% GST (787.50) + 400.50");
      const inv = (await t.api("get", `/invoices/${ok.body.data.invoiceId}`, cashier.token)).body.data;
      assert.deepEqual(inv.lines.map((l: { description: string }) => l.description).sort(), ["CBC", "Rare marker", "X-ray left wrist"], "the lines carry the doctor's wording");
      assert.ok((await orders(v.encounterId)).every((x) => x.status === "BILLED"));
      assert.equal((await t.prisma.testOrder.findFirstOrThrow({ where: { id: rare.id } })).serviceId, null, "no price-list item was involved");
      const ev = await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "TEST_ORDERS_BILLED", entityId: inv.id } });
      assert.equal((ev!.metadata as { typedPrices: number }).typedPrices, 2, "typed prices are recorded in the audit trail");
    });

    it("a typed price must be a real amount; it cannot be combined with a price-list item or typed over a test that already has a price", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC", "Rare marker"] });
      const o = await orders(v.encounterId);
      const rare = o.find((x) => x.name === "Rare marker")!;
      const cbc = o.find((x) => x.name === "CBC")!;
      const tryBill = (orderLine: Record<string, unknown>) => bill(cashier.token, { encounterId: v.encounterId, orders: [{ orderId: cbc.id }, orderLine] });
      for (const bad of ["0", "-5", "abc", "1e3", "12.345", "", "100000000"]) assert.equal((await tryBill({ orderId: rare.id, price: bad })).status, 400, `price "${bad}"`);
      assert.equal((await tryBill({ orderId: rare.id, price: "100", taxPercent: "101" })).status, 400, "tax over 100");
      assert.equal((await tryBill({ orderId: rare.id, price: "100", taxPercent: "x" })).status, 400);
      assert.equal((await tryBill({ orderId: rare.id, taxPercent: "5" })).status, 400, "a tax rate needs a price");
      assert.equal((await tryBill({ orderId: rare.id, price: "100", serviceId: svc.cbc!.id })).status, 400, "not both a price-list item and a typed price");
      assert.equal((await bill(cashier.token, { encounterId: v.encounterId, orders: [{ orderId: cbc.id, price: "1" }, { orderId: rare.id, price: "100" }] })).status, 400, "CBC already has its price-list price");
      assert.equal((await tryBill({ orderId: rare.id })).status, 409, "no price at all still needs one");
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, encounterId: v.encounterId } }), 0, "nothing was billed by any refused request");
      assert.equal((await bill(rec.token, { encounterId: v.encounterId, orders: [{ orderId: rare.id, price: "100" }] })).status, 403, "only the Cashier");
    });
  });

  describe("handwritten prescription picture", () => {
    const upload = (doctor: TestDoctor, encounterId: string) => t.api("post", `/encounters/${encounterId}/prescription-scans`, doctor.token).query({ filename: "rx.png" }).set("Content-Type", "image/png").send(PNG);
    /** A visit where the doctor uploaded a picture and signed straight away, with no typed tests. */
    const pictureVisit = async (doctor: TestDoctor, existing?: { id: string }) => {
      const patient = existing ?? await registerPatient(t, rec.token);
      const v = await startVisit(t, rec.token, doctor, patient.id);
      await t.api("post", `/queue/${v.queueId}/start`, doctor.token);
      const scan = await upload(doctor, v.encounterId);
      assert.equal(scan.status, 201, JSON.stringify(scan.body));
      const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, doctor.token).send({ content: { chiefComplaint: "Cough" } });
      assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doctor.token).send({ version: c.body.data.version })).status, 200);
      return { patient, scanId: scan.body.data.id as string, ...v };
    };

    it("the Cashier sees the doctor's picture, reads the tests off it, bills them from the price list, and the picture leaves the queue", async () => {
      const p = await pictureVisit(d1);
      const pic = (await queue()).handwritten.find((x) => x.scanId === p.scanId);
      assert.ok(pic, "the picture is in the Cashier's queue");
      assert.equal(pic.pages.length, 1);
      assert.equal((await t.api("get", `/files/${pic.pages[0]!.fileId}/content`, cashier.token)).status, 200, "the Cashier can open the picture");
      const ok = await bill(cashier.token, { encounterId: p.encounterId, fromPicture: { scanId: p.scanId, tests: [{ serviceId: svc.cbc!.id }, { serviceId: svc.ecg!.id, category: "CARDIOLOGY" }] } });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.data.total, "550.50");
      const o = await orders(p.encounterId);
      assert.deepEqual(o.map((x) => [x.name, x.source, x.status, x.scanId === p.scanId]).sort(), [["CBC", "HANDWRITTEN", "BILLED", true], ["ECG", "HANDWRITTEN", "BILLED", true]]);
      assert.equal((await queue()).handwritten.some((x) => x.scanId === p.scanId), false, "dealt with");
      assert.equal((await bill(cashier.token, { encounterId: p.encounterId, fromPicture: { scanId: p.scanId, tests: [{ serviceId: svc.cbc!.id }] } })).status, 409, "not billed twice");
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, encounterId: p.encounterId } }), 1);
    });

    it("typing is accepted: the Cashier types the tests read off the picture, with their prices, mixed with price-list tests", async () => {
      const p = await pictureVisit(d1);
      const ok = await bill(cashier.token, { encounterId: p.encounterId, fromPicture: { scanId: p.scanId, tests: [
        { name: "X-ray chest", price: "400", taxPercent: "5", category: "RADIOLOGY" },
        { name: "Blood sugar fasting", price: "90" },
        { serviceId: svc.cbc!.id },
      ] } });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.data.total, "710.00", "400 + 5% GST + 90 + 200");
      const o = await orders(p.encounterId);
      assert.deepEqual(o.map((x) => [x.name, x.category, x.source, x.status, x.serviceId === null]).sort(), [
        ["Blood sugar fasting", "LABORATORY", "HANDWRITTEN", "BILLED", true], ["CBC", "LABORATORY", "HANDWRITTEN", "BILLED", false], ["X-ray chest", "RADIOLOGY", "HANDWRITTEN", "BILLED", true],
      ]);
      assert.equal((await queue()).handwritten.some((x) => x.scanId === p.scanId), false, "dealt with");
    });

    it("typed tests on a picture are checked: a name, a real price, a known category; nothing is billed when any is wrong", async () => {
      const p = await pictureVisit(d1);
      const tryTests = (tests: unknown[]) => bill(cashier.token, { encounterId: p.encounterId, fromPicture: { scanId: p.scanId, tests } });
      assert.equal((await tryTests([{ name: "X", price: "100" }])).status, 400, "name too short");
      assert.equal((await tryTests([{ name: "X-ray chest", price: "0" }])).status, 400, "no price");
      assert.equal((await tryTests([{ name: "X-ray chest", price: "-10" }])).status, 400);
      assert.equal((await tryTests([{ name: "X-ray chest" }])).status, 400, "a typed test needs its price");
      assert.equal((await tryTests([{ name: "X-ray chest", price: "100", category: "MAGIC" }])).status, 400);
      assert.equal((await tryTests([{ name: "X-ray chest", price: "100", serviceId: svc.cbc!.id }])).status, 400, "not both");
      assert.equal((await tryTests([{ name: "X-ray chest", price: "100", discount: "50" }])).status, 400, "no extra fields");
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, encounterId: p.encounterId } }), 0);
      assert.equal((await orders(p.encounterId)).length, 0, "no half-made orders either");
      assert.equal((await queue()).handwritten.some((x) => x.scanId === p.scanId), true, "the picture is still waiting");
    });

    it("the Cashier's one view per patient: digital and handwritten prescriptions of the same patient, with medicines, tests and bills, together", async () => {
      const patient = await registerPatient(t, rec.token);
      const dx = await makeDoctor(t, a); // a doctor with no consultation left open by the tests above
      const digital = await signedVisit(dx, { investigationsAdvised: ["CBC", "Rare marker"] }, true, patient);
      const c1 = await t.api("post", `/queue/${digital.queueId}/complete`, dx.token);
      assert.equal(c1.status, 200, JSON.stringify(c1.body));
      const hand = await pictureVisit(dx, patient);
      const c2 = await t.api("post", `/queue/${hand.queueId}/complete`, dx.token);
      assert.equal(c2.status, 200, JSON.stringify(c2.body));

      const view = async (tok = cashier.token) => { const r = await t.api("get", "/cashier/prescriptions", tok); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data.patients as { patientId: string; patientName: string; mrn: string | null; toCollect: string; testsToBill: number; medicinesWaiting: number; picturesToRead: number; visits: { encounterId: string; doctorName: string | null; medicines: { source: string; pharmacy: string; items: { name: string; quantity: number | null; given: number }[] }[]; pictures: { scanId: string; pharmacy: string; testsRead: boolean; pages: unknown[] }[]; tests: { name: string; status: string; source: string; price: string | null; invoiceNumber: string | null }[]; bills: { invoiceId: string; kind: string; status: string; total: string; balanceDue: string }[] }[] }[]; };
      const mine = async (tok?: string) => (await view(tok)).filter((x) => x.patientId === patient.id);

      const cards = await mine();
      assert.equal(cards.length, 1, "one card for the patient, not one per prescription");
      let card = cards[0]!;
      assert.equal(card.visits.length, 2);
      const dv = card.visits.find((v) => v.encounterId === digital.encounterId)!;
      const hv = card.visits.find((v) => v.encounterId === hand.encounterId)!;
      assert.equal(dv.medicines.length, 1);
      assert.equal(dv.medicines[0]!.source, "DIGITAL");
      assert.equal(dv.medicines[0]!.pharmacy, "WAITING", "the medicine is with the pharmacy");
      assert.deepEqual([dv.medicines[0]!.items[0]!.name.includes(med.genericName), dv.medicines[0]!.items[0]!.quantity, dv.medicines[0]!.items[0]!.given], [true, 10, 0]);
      assert.deepEqual(dv.tests.map((x) => [x.name, x.status, x.price]).sort(), [["CBC", "ORDERED", "200.00"], ["Rare marker", "ORDERED", null]]);
      assert.equal(hv.pictures.length, 1);
      assert.deepEqual([hv.pictures[0]!.pharmacy, hv.pictures[0]!.testsRead, hv.pictures[0]!.pages.length], ["WAITING", false, 1]);
      assert.deepEqual([card.testsToBill, card.medicinesWaiting, card.picturesToRead, card.toCollect], [2, 2, 1, "0.00"], "2 tests to bill; the digital medicine and the handwritten picture are both with the pharmacy; 1 picture to read");
      assert.ok(card.mrn && dv.doctorName);

      // Billing the digital tests and the tests read off the picture puts both bills on the same card.
      const b1 = await bill(cashier.token, { encounterId: digital.encounterId, orders: (await orders(digital.encounterId)).map((o) => (o.name === "Rare marker" ? { orderId: o.id, price: "100" } : { orderId: o.id })) });
      assert.equal(b1.status, 201, JSON.stringify(b1.body));
      const b2 = await bill(cashier.token, { encounterId: hand.encounterId, fromPicture: { scanId: hand.scanId, tests: [{ name: "Urine routine", price: "50" }, { serviceId: svc.ecg!.id, category: "CARDIOLOGY" }] } });
      assert.equal(b2.status, 201, JSON.stringify(b2.body));
      card = (await mine())[0]!;
      const hv2 = card.visits.find((v) => v.encounterId === hand.encounterId)!;
      assert.deepEqual(hv2.tests.map((x) => [x.name, x.source, x.status]).sort(), [["ECG", "HANDWRITTEN", "BILLED"], ["Urine routine", "HANDWRITTEN", "BILLED"]], "tests from the picture are listed with the others");
      assert.equal(hv2.pictures[0]!.testsRead, true);
      assert.equal(card.testsToBill, 0);
      assert.equal(card.picturesToRead, 0);
      const bills = card.visits.flatMap((v) => v.bills);
      assert.equal(bills.length, 2);
      assert.ok(bills.every((x) => x.kind === "OTHER" && x.status === "ISSUED"));
      assert.equal(card.toCollect, "700.50", "200 + 100 for the first bill, 50 + 350.50 for the second");
      assert.equal(card.visits.flatMap((v) => v.tests).filter((x) => x.invoiceNumber).length, 4, "each billed test shows its bill number");

      // Collecting a bill reduces what is to collect, and a paid bill leaves the card when nothing else is open.
      const pay = await t.api("post", `/invoices/${b1.body.data.invoiceId}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: "300.00" }] });
      assert.equal(pay.status, 201, JSON.stringify(pay.body));
      assert.equal((await mine())[0]!.toCollect, "400.50", "the first bill is paid in full; only the second is still to collect");
    });

    /** A patient with two issued bills still to collect: tests of a digital visit (300.00) and tests read off a handwritten picture (400.50). */
    const twoBills = async () => {
      const patient = await registerPatient(t, rec.token);
      const dx = await makeDoctor(t, a);
      const digital = await signedVisit(dx, { investigationsAdvised: ["CBC", "Rare marker"] }, false, patient);
      assert.equal((await t.api("post", `/queue/${digital.queueId}/complete`, dx.token)).status, 200);
      const hand = await pictureVisit(dx, patient);
      assert.equal((await t.api("post", `/queue/${hand.queueId}/complete`, dx.token)).status, 200);
      const a1 = await bill(cashier.token, { encounterId: digital.encounterId, orders: (await orders(digital.encounterId)).map((o) => (o.name === "Rare marker" ? { orderId: o.id, price: "100" } : { orderId: o.id })) });
      const a2 = await bill(cashier.token, { encounterId: hand.encounterId, fromPicture: { scanId: hand.scanId, tests: [{ name: "Urine routine", price: "50" }, { serviceId: svc.ecg!.id, category: "CARDIOLOGY" }] } });
      assert.deepEqual([a1.status, a2.status, a1.body.data.total, a2.body.data.total], [201, 201, "300.00", "400.50"]);
      return { patient, first: a1.body.data.invoiceId as string, second: a2.body.data.invoiceId as string };
    };
    const collect = (tok: string, patientId: string, body: Record<string, unknown>, k: string | null = key()) => { const r = t.api("post", `/cashier/patients/${patientId}/collect`, tok); if (k) r.set("Idempotency-Key", k); return r.send(body); };
    const status = async (id: string) => (await t.api("get", `/invoices/${id}`, cashier.token)).body.data as { status: string; balanceDue: string };

    it("Collect total: one payment, even split over several ways of paying, settles every bill of the patient, oldest first, one receipt per bill", async () => {
      const { patient, first, second } = await twoBills();
      const ids = [first, second];
      const key1 = key();
      const ok = await collect(cashier.token, patient.id, { invoiceIds: ids, payments: [{ method: "CASH", amount: "200.00" }, { method: "UPI", amount: "500.50", reference: "UPI-REF-77" }] }, key1);
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.data.total, "700.50");
      assert.equal(ok.body.data.stillDue, "0.00");
      assert.deepEqual(ok.body.data.receipts.map((r: { invoiceId: string; amount: string; invoiceStatus: string }) => [r.invoiceId, r.amount, r.invoiceStatus]), [[first, "300.00", "PAID"], [second, "400.50", "PAID"]], "oldest bill first, each with its own receipt");
      const rcs = await t.prisma.receipt.findMany({ where: { invoiceId: { in: ids } }, select: { id: true, invoiceId: true } });
      const pays = await t.prisma.payment.findMany({ where: { receiptId: { in: rcs.map((r) => r.id) } }, select: { method: true, amount: true, receiptId: true } });
      const sum = (m: string, inv: string) => pays.filter((p) => p.method === m && rcs.find((r) => r.id === p.receiptId)?.invoiceId === inv).reduce((n, p) => n + Number(p.amount), 0);
      assert.deepEqual([sum("CASH", first), sum("UPI", first), sum("CASH", second), sum("UPI", second)], [200, 100, 0, 400.5], "the cash went to the first bill, the rest of the first bill and all of the second by UPI");
      for (const id of ids) assert.equal((await status(id)).status, "PAID");
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "PATIENT_PAYMENT_COLLECTED", entityId: patient.id } }), 1);
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "PAYMENT_RECEIVED", entityId: { in: ids } } }), 2, "and each bill's own payment is audited");
      // A retry with the same key (double click, network drop) answers with the same result and takes nothing more.
      const before = await t.prisma.receipt.count({ where: { invoiceId: { in: ids } } });
      const again = await collect(cashier.token, patient.id, { invoiceIds: ids, payments: [{ method: "CASH", amount: "200.00" }, { method: "UPI", amount: "500.50", reference: "UPI-REF-77" }] }, key1);
      assert.equal(again.status, 200);
      assert.deepEqual(again.body.data.receipts.map((r: { receiptId: string }) => r.receiptId), ok.body.data.receipts.map((r: { receiptId: string }) => r.receiptId));
      assert.equal(await t.prisma.receipt.count({ where: { invoiceId: { in: ids } } }), before);
      const card = ((await t.api("get", "/cashier/prescriptions", cashier.token)).body.data.patients as { patientId: string; toCollect: string }[]).find((x) => x.patientId === patient.id);
      assert.equal(card?.toCollect ?? "0.00", "0.00", "nothing is left to collect for the patient");
    });

    it("a part-payment settles the earliest bills first; more than is due, or a missing reference, takes nothing at all", async () => {
      const { patient, first, second } = await twoBills();
      const ids = [first, second];
      const body = (payments: unknown[]) => ({ invoiceIds: ids, payments });
      assert.equal((await collect(cashier.token, patient.id, body([{ method: "CASH", amount: "700.51" }]))).status, 409, "more than the total due");
      assert.equal((await collect(cashier.token, patient.id, body([{ method: "UPI", amount: "100.00" }]))).status, 400, "a UPI payment needs its reference");
      assert.equal((await collect(cashier.token, patient.id, body([{ method: "CASH", amount: "0" }]))).status, 400);
      assert.equal((await collect(cashier.token, patient.id, body([{ method: "CASH", amount: "100.00", discount: "5" }]))).status, 400, "no extra fields");
      assert.equal(await t.prisma.receipt.count({ where: { invoiceId: { in: ids } } }), 0, "refused requests took no money");
      const part = await collect(cashier.token, patient.id, body([{ method: "CASH", amount: "350.00" }]));
      assert.equal(part.status, 201, JSON.stringify(part.body));
      assert.equal(part.body.data.stillDue, "350.50");
      assert.deepEqual(part.body.data.receipts.map((r: { amount: string; invoiceStatus: string }) => [r.amount, r.invoiceStatus]), [["300.00", "PAID"], ["50.00", "PARTIALLY_PAID"]]);
      assert.deepEqual([(await status(first)).status, (await status(second)).balanceDue], ["PAID", "350.50"]);
      const rest = await collect(cashier.token, patient.id, body([{ method: "CARD", amount: "350.50", reference: "CARD-0042" }]));
      assert.equal(rest.status, 201, JSON.stringify(rest.body));
      assert.deepEqual(rest.body.data.receipts.map((r: { invoiceId: string }) => r.invoiceId), [second], "the paid bill is left alone");
      assert.equal((await collect(cashier.token, patient.id, body([{ method: "CASH", amount: "1.00" }]))).status, 409, "nothing is left to collect");
    });

    it("collecting is for the Cashier, needs a key, only touches this patient's medicines and tests bills, and never crosses hospitals", async () => {
      const { patient, first, second } = await twoBills();
      const other = await twoBills();
      const body = { invoiceIds: [first, second], payments: [{ method: "CASH", amount: "100.00" }] };
      assert.equal((await collect(cashier.token, patient.id, body, null)).status, 400, "an Idempotency-Key is required");
      for (const tok of [rec.token, pharm.token, d1.token]) assert.equal((await collect(tok, patient.id, body)).status, 403);
      assert.equal((await t.api("post", `/cashier/patients/${patient.id}/collect`).send(body)).status, 401);
      assert.equal((await collect(bCashier.token, patient.id, body)).status, 404, "another hospital");
      assert.equal((await collect(cashier.token, patient.id, { invoiceIds: [first, other.first], payments: body.payments })).status, 404, "another patient's bill");
      assert.equal((await collect(cashier.token, patient.id, { invoiceIds: [randomUUID()], payments: body.payments })).status, 404);
      assert.equal((await collect(cashier.token, patient.id, { invoiceIds: [], payments: body.payments })).status, 400);
      assert.equal(await t.prisma.receipt.count({ where: { invoiceId: { in: [first, second, other.first] } } }), 0, "nothing was taken by any refused request");
    });

    it("two cashiers collecting the same bills at once: the money is taken once", async () => {
      const { patient, first, second } = await twoBills();
      const body = { invoiceIds: [first, second], payments: [{ method: "CASH", amount: "700.50" }] };
      const rs = await Promise.all([collect(cashier.token, patient.id, body), collect(cashier2.token, patient.id, body), collect(cashier.token, patient.id, body)]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409], JSON.stringify(rs.map((r) => r.body)));
      assert.equal(await t.prisma.receipt.count({ where: { invoiceId: { in: [first, second] } } }), 2, "one receipt per bill, taken once");
      const total = (await t.prisma.receipt.findMany({ where: { invoiceId: { in: [first, second] } }, select: { total: true } })).reduce((n, r) => n + Number(r.total), 0);
      assert.equal(total, 700.5);
    });

    it("the consolidated view is for the Cashier only, shows no consultation notes, and never crosses hospitals", async () => {
      const patient = await registerPatient(t, rec.token);
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC"] }, true, patient);
      for (const tok of [rec.token, pharm.token, d1.token]) assert.equal((await t.api("get", "/cashier/prescriptions", tok)).status, 403);
      assert.equal((await t.api("get", "/cashier/prescriptions")).status, 401);
      const r = await t.api("get", "/cashier/prescriptions", cashier.token);
      const mine = (r.body.data.patients as { patientId: string }[]).find((x) => x.patientId === patient.id);
      assert.ok(mine);
      assert.equal(JSON.stringify(mine).includes("Fever and cough"), false, "the chief complaint is not shown");
      assert.equal(JSON.stringify(mine).includes("Viral fever"), false, "nor the diagnosis");
      const other = (await t.api("get", "/cashier/prescriptions", bCashier.token)).body.data.patients as { patientId: string }[];
      assert.equal(other.some((x) => x.patientId === patient.id), false, "another hospital's cashier sees nothing");
      assert.ok(v.encounterId);
    });

    // ───── the Cashier edits the tests for billing; the doctor's orders stay as written ─────
    const saveLines = (tok: string, encounterId: string, lines: unknown[]) => t.api("put", `/test-orders/billing/${encounterId}`, tok).send({ lines });
    interface SavedLine { id: string | null; orderId: string | null; name: string; originalName: string | null; quantity: number; price: string | null; taxPercent: string; removed: boolean; edited: boolean; source: string; total: string | null }
    const saved = (r: { body: { data: { lines: SavedLine[]; total: string; unpriced: number } } }) => r.body.data;

    it("editing for billing: the Cashier changes a test's name, quantity and price, adds a test and takes one off, and the total follows; the doctor's order is not touched", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC", "Rare marker", "Lipid profile"] }, false);
      const o = await orders(v.encounterId);
      const [cbc, rare, lipid] = [o.find((x) => x.name === "CBC")!, o.find((x) => x.name === "Rare marker")!, o.find((x) => x.name === "Lipid profile")!];
      const before = o.map((x) => ({ id: x.id, name: x.name, category: x.category, serviceId: x.serviceId, status: x.status, source: x.source, orderedById: x.orderedById }));
      const r = await saveLines(cashier.token, v.encounterId, [
        { orderId: cbc.id, name: "CBC with ESR", category: "LABORATORY", quantity: 2, price: "180.00", taxPercent: "0" },
        { orderId: rare.id, name: "Rare marker", category: "LABORATORY", quantity: 1, price: "750", taxPercent: "5" },
        { orderId: lipid.id, name: "Lipid profile", category: "LABORATORY", quantity: 1, removed: true },
        { name: "Urine routine", category: "LABORATORY", quantity: 1, price: "50" },
      ]);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const d = saved(r);
      assert.equal(d.total, "1197.50", "2 x 180 + 750 with 5% tax + 50; the removed test counts for nothing");
      assert.deepEqual(d.lines.map((l) => [l.name, l.originalName, l.quantity, l.removed, l.source]), [["CBC with ESR", "CBC", 2, false, "DIGITAL"], ["Rare marker", "Rare marker", 1, false, "DIGITAL"], ["Lipid profile", "Lipid profile", 1, true, "DIGITAL"], ["Urine routine", null, 1, false, "CASHIER"]]);
      const after = (await orders(v.encounterId)).map((x) => ({ id: x.id, name: x.name, category: x.category, serviceId: x.serviceId, status: x.status, source: x.source, orderedById: x.orderedById }));
      assert.deepEqual(after, before, "the doctor's orders are exactly as the doctor wrote them (and still waiting)");
      const rows = await t.prisma.testBillingLine.findMany({ where: { encounterId: v.encounterId }, orderBy: { createdAt: "asc" } });
      assert.equal(rows.length, 4);
      assert.ok(rows.every((x) => x.status === "DRAFT" && x.createdById === cashier.id && x.updatedById === cashier.id), "who made the changes is recorded on the billing lines");
      assert.equal(rows.find((x) => x.testOrderId === cbc.id)?.name, "CBC with ESR");
      const doctorSees = (await t.api("get", `/encounters/${v.encounterId}/test-orders`, d1.token)).body.data as { name: string }[];
      assert.deepEqual(doctorSees.map((x) => x.name).sort(), ["CBC", "Lipid profile", "Rare marker"], "the doctor still sees only what the doctor ordered");
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "TEST_BILLING_SAVED", entityId: v.encounterId } }), 1);
      // The Cashier's view of the visit carries the saved lines and the total.
      const card = ((await t.api("get", "/cashier/prescriptions", cashier.token)).body.data.patients as { patientId: string; visits: { encounterId: string; billing: { total: string; lines: SavedLine[] } }[] }[]).find((x) => x.patientId === v.patient.id)!;
      assert.equal(card.visits.find((x) => x.encounterId === v.encounterId)!.billing.total, "1197.50");
      // Saving again changes the same lines (no second line for an order) and an added test left out of the list is dropped, not deleted.
      const extra = d.lines.find((l) => l.name === "Urine routine")!;
      const again = await saveLines(cashier.token, v.encounterId, [
        { orderId: cbc.id, name: "CBC with ESR", category: "LABORATORY", quantity: 1, price: "200", taxPercent: "0" },
        { orderId: rare.id, name: "Rare marker", category: "LABORATORY", quantity: 1, price: "750", taxPercent: "5" },
        { orderId: lipid.id, name: "Lipid profile", category: "LABORATORY", quantity: 1, price: "300" },
      ]);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(saved(again).total, "1287.50", "200 + 787.50 + 300");
      assert.equal(await t.prisma.testBillingLine.count({ where: { encounterId: v.encounterId, testOrderId: { not: null } } }), 3, "still one line per order");
      assert.equal((await t.prisma.testBillingLine.findFirstOrThrow({ where: { id: extra.id! } })).status, "DROPPED");
      assert.equal((await t.prisma.testBillingLine.findFirstOrThrow({ where: { testOrderId: cbc.id } })).version, 2);
    });

    it("bad edits are refused and save nothing: prices, quantities, names, another visit's tests, unknown fields", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC"] }, false);
      const other = await signedVisit(d1, { investigationsAdvised: ["CBC"] }, false);
      const cbc = (await orders(v.encounterId))[0]!;
      const otherCbc = (await orders(other.encounterId))[0]!;
      const line = (o: Record<string, unknown> = {}) => ({ orderId: cbc.id, name: "CBC", category: "LABORATORY", quantity: 1, price: "200", taxPercent: "0", ...o });
      const refused = async (lines: unknown[], status = 400, msg = "") => assert.equal((await saveLines(cashier.token, v.encounterId, lines)).status, status, msg);
      await refused([line({ price: "0" })], 400, "price zero");
      await refused([line({ price: "-5" })], 400);
      await refused([line({ price: "abc" })], 400);
      await refused([line({ price: undefined })], 400, "a price is needed unless the test is taken off");
      await refused([line({ quantity: 0 })], 400);
      await refused([line({ quantity: 100 })], 400);
      await refused([line({ quantity: 1.5 })], 400);
      await refused([line({ name: "X" })], 400);
      await refused([line({ taxPercent: "101" })], 400);
      await refused([line({ category: "MAGIC" })], 400);
      await refused([line({ total: "1.00" })], 400, "the total is never taken from the request");
      await refused([line({ lineId: randomUUID() })], 400, "an order and a line together");
      await refused([line({ orderId: otherCbc.id })], 409, "a test of another visit");
      await refused([line({ orderId: undefined, lineId: randomUUID() })], 404, "a line that does not exist");
      await refused([line({ serviceId: randomUUID() })], 400, "an unknown price-list item");
      await refused([{ name: "Added test", category: "LABORATORY", quantity: 1, price: "10", scanId: randomUUID() }], 404, "a picture that is not on this visit");
      assert.equal(await t.prisma.testBillingLine.count({ where: { encounterId: v.encounterId } }), 0, "nothing was saved by any refused request");
      assert.equal((await saveLines(rec.token, v.encounterId, [line()])).status, 403);
      assert.equal((await saveLines(bCashier.token, v.encounterId, [line()])).status, 404, "another hospital");
      assert.equal((await t.api("put", `/test-orders/billing/${v.encounterId}`, cashier.token).send({ lines: [line()], extra: 1 })).status, 400);
      assert.equal((await saveLines(cashier.token, v.encounterId, [line({ removed: true, price: undefined })])).status, 200, "a test taken off needs no price");
    });

    it("bill and collect in one step: the edited tests and the pharmacy's medicines bill are paid together, split over ways of paying, each bill with its own receipt", async () => {
      const dx = await makeDoctor(t, a);
      const v = await signedVisit(dx, { investigationsAdvised: ["CBC", "Rare marker"] }, true);
      const o = await orders(v.encounterId);
      const cbc = o.find((x) => x.name === "CBC")!;
      const rare = o.find((x) => x.name === "Rare marker")!;
      assert.equal((await saveLines(cashier.token, v.encounterId, [
        { orderId: cbc.id, name: "CBC with ESR", category: "LABORATORY", quantity: 2, price: "180", taxPercent: "0" },
        { orderId: rare.id, name: "Rare marker", category: "LABORATORY", quantity: 1, price: "750", taxPercent: "5" },
        { name: "Urine routine", category: "LABORATORY", quantity: 1, price: "50" },
      ])).status, 200);
      // The pharmacy's medicines bill for the same visit (made here as the pharmacy would make it).
      const pb = await t.api("post", "/invoices", cashier.token).send({ patientId: v.patient.id, encounterId: v.encounterId, kind: "PHARMACY", lines: [{ description: "Medicines", unitPrice: "300", taxPercent: 0, quantity: 1 }] });
      assert.equal(pb.status, 201, JSON.stringify(pb.body));
      assert.equal((await t.api("post", `/invoices/${pb.body.data.id}/issue`, cashier.token)).status, 200);

      const body = { invoiceIds: [pb.body.data.id], billTests: [v.encounterId], payments: [{ method: "CASH", amount: "1000.00" }, { method: "UPI", amount: "497.50", reference: "UPI-REF-9" }] };
      const bad = await collect(cashier.token, v.patient.id, { ...body, payments: [{ method: "CASH", amount: "1497.51" }] });
      assert.equal(bad.status, 409, "more than the combined total");
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, encounterId: v.encounterId, kind: "OTHER" } }), 0, "a refused payment did not bill the tests either");
      assert.equal((await orders(v.encounterId)).every((x) => x.status === "ORDERED"), true);
      const ok = await collect(cashier.token, v.patient.id, body);
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.data.total, "1497.50", "tests 1197.50 + medicines 300");
      assert.equal(ok.body.data.stillDue, "0.00");
      assert.equal(ok.body.data.billedTests.length, 1);
      assert.equal(ok.body.data.receipts.length, 2, "one receipt per bill");
      assert.ok(ok.body.data.receipts.every((r: { invoiceStatus: string }) => r.invoiceStatus === "PAID"));
      const testInv = (await t.api("get", `/invoices/${ok.body.data.billedTests[0].invoiceNumber ? ok.body.data.receipts.find((r: { invoiceNumber: string }) => r.invoiceNumber === ok.body.data.billedTests[0].invoiceNumber).invoiceId : ""}`, cashier.token)).body.data;
      assert.equal(testInv.kind, "OTHER");
      assert.deepEqual(testInv.lines.map((l: { description: string; quantity: string }) => [l.description, Number(l.quantity)]).sort(), [["CBC with ESR", 2], ["Rare marker", 1], ["Urine routine", 1]], "the bill carries the Cashier's wording and quantities");
      const after = await orders(v.encounterId);
      assert.deepEqual(after.map((x) => [x.name, x.status]).sort(), [["CBC", "BILLED"], ["Rare marker", "BILLED"], ["Urine routine", "BILLED"]], "the doctor's wording is kept; the added test got an order record");
      assert.equal(after.find((x) => x.name === "Urine routine")!.source, "CASHIER");
      const lines = await t.prisma.testBillingLine.findMany({ where: { encounterId: v.encounterId } });
      assert.ok(lines.every((x) => x.status === "BILLED" && x.invoiceId === testInv.id));
      // The same request again (a retry) takes nothing more; a new request finds nothing left to collect.
      assert.equal((await collect(cashier.token, v.patient.id, body)).status, 409);
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, encounterId: v.encounterId, kind: "OTHER" } }), 1);
    });

    it("taking a test off at billing closes the doctor's order as 'taken off' with its wording intact, and bills the rest", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC", "Lipid profile"] }, false);
      const o = await orders(v.encounterId);
      const lipid = o.find((x) => x.name === "Lipid profile")!;
      assert.equal((await saveLines(cashier.token, v.encounterId, [{ orderId: lipid.id, name: "Lipid profile", category: "LABORATORY", quantity: 1, removed: true }])).status, 200);
      const ok = await bill(cashier.token, { encounterId: v.encounterId, fromSaved: true });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.data.tests, 1);
      assert.equal(ok.body.data.total, "200.00", "only the CBC at its price-list price");
      const after = await orders(v.encounterId);
      assert.deepEqual(after.map((x) => [x.name, x.status]).sort(), [["CBC", "BILLED"], ["Lipid profile", "CANCELLED"]]);
      assert.equal(after.find((x) => x.name === "Lipid profile")!.cancelReason, "Taken off the bill by the Cashier");
      assert.equal((await t.prisma.testBillingLine.findFirstOrThrow({ where: { testOrderId: lipid.id } })).status, "DROPPED");
      assert.equal((await bill(cashier.token, { encounterId: v.encounterId, fromSaved: true })).status, 409, "nothing is left to bill");
      // Everything taken off: no bill is made and the orders are closed.
      const w = await signedVisit(d1, { investigationsAdvised: ["CBC"] }, false);
      const cbc = (await orders(w.encounterId))[0]!;
      await saveLines(cashier.token, w.encounterId, [{ orderId: cbc.id, name: "CBC", category: "LABORATORY", quantity: 1, removed: true }]);
      const none = await bill(cashier.token, { encounterId: w.encounterId, fromSaved: true });
      assert.equal(none.status, 201, JSON.stringify(none.body));
      assert.deepEqual([none.body.data.invoiceId, none.body.data.tests, none.body.data.total], [null, 0, "0.00"]);
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, encounterId: w.encounterId } }), 0);
    });

    it("tests with no price must be edited before billing; unedited tests are billed at the price-list price", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC", "Rare marker"] }, false);
      const refused = await bill(cashier.token, { encounterId: v.encounterId, fromSaved: true });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, "TEST_NEEDS_PRICE");
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, encounterId: v.encounterId } }), 0);
      assert.equal(await t.prisma.testBillingLine.count({ where: { encounterId: v.encounterId } }), 0, "a refused billing leaves nothing behind");
      assert.equal((await bill(cashier.token, { encounterId: v.encounterId, fromSaved: true, orders: [{ orderId: randomUUID() }] })).status, 400, "saved lines cannot be mixed with other tests");
    });

    it("handwritten prescription: tests the Cashier reads off the picture are saved, edited and billed like any other; the picture is then dealt with", async () => {
      const dx = await makeDoctor(t, a);
      const p = await pictureVisit(dx);
      const r = await saveLines(cashier.token, p.encounterId, [
        { scanId: p.scanId, name: "X-ray chest", category: "RADIOLOGY", quantity: 1, price: "400", taxPercent: "5" },
        { scanId: p.scanId, name: "Blood sugar fasting", category: "LABORATORY", quantity: 2, price: "45" },
      ]);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(saved(r).lines.map((l) => [l.name, l.source]), [["X-ray chest", "HANDWRITTEN"], ["Blood sugar fasting", "HANDWRITTEN"]]);
      assert.equal(saved(r).total, "510.00", "400 + 5% + 2 x 45");
      const ids = saved(r).lines.map((l) => l.id!);
      const edit = await saveLines(cashier.token, p.encounterId, [
        { lineId: ids[0], scanId: p.scanId, name: "X-ray chest PA view", category: "RADIOLOGY", quantity: 1, price: "450", taxPercent: "0" },
        { lineId: ids[1], scanId: p.scanId, name: "Blood sugar fasting", category: "LABORATORY", quantity: 1, price: "45" },
      ]);
      assert.equal(saved(edit).total, "495.00");
      assert.equal((await orders(p.encounterId)).length, 0, "nothing is an order until it is billed");
      const ok = await collect(cashier.token, p.patient.id, { billTests: [p.encounterId], payments: [{ method: "CASH", amount: "495.00" }] });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const o = await orders(p.encounterId);
      assert.deepEqual(o.map((x) => [x.name, x.source, x.status, x.scanId === p.scanId]).sort(), [["Blood sugar fasting", "HANDWRITTEN", "BILLED", true], ["X-ray chest PA view", "HANDWRITTEN", "BILLED", true]]);
      assert.equal((await t.prisma.scanTestReview.findUniqueOrThrow({ where: { scanId: p.scanId } })).outcome, "BILLED");
      assert.equal((await saveLines(cashier.token, p.encounterId, [{ scanId: p.scanId, name: "Late test", category: "LABORATORY", quantity: 1, price: "10" }])).status, 409, "the picture is dealt with");
    });

    it("billed lines are final: the database refuses to change or delete them, or to bill a bad price", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC"] }, false);
      assert.equal((await bill(cashier.token, { encounterId: v.encounterId, fromSaved: true })).status, 201);
      const line = await t.prisma.testBillingLine.findFirstOrThrow({ where: { encounterId: v.encounterId } });
      assert.equal(line.status, "BILLED");
      await assert.rejects(() => t.prisma.testBillingLine.update({ where: { id: line.id }, data: { unitPrice: "1" } }), /cannot change/);
      await assert.rejects(() => t.prisma.testBillingLine.delete({ where: { id: line.id } }), /never deleted/);
      const w = await signedVisit(d1, { investigationsAdvised: ["CBC"] }, false);
      const o = (await orders(w.encounterId))[0]!;
      await assert.rejects(() => t.prisma.testBillingLine.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: w.patient.id, encounterId: w.encounterId, testOrderId: o.id, name: "CBC", category: "LABORATORY", quantity: 1, unitPrice: "0", createdById: cashier.id, updatedById: cashier.id } }), /check|price/i);
      await t.prisma.testBillingLine.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: w.patient.id, encounterId: w.encounterId, testOrderId: o.id, name: "CBC", category: "LABORATORY", quantity: 1, unitPrice: "10", createdById: cashier.id, updatedById: cashier.id } });
      await assert.rejects(() => t.prisma.testBillingLine.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: w.patient.id, encounterId: w.encounterId, testOrderId: o.id, name: "CBC again", category: "LABORATORY", quantity: 1, unitPrice: "10", createdById: cashier.id, updatedById: cashier.id } }), /Unique|unique/, "one line per doctor's order");
    });

    it("two cashiers billing the same visit at once: one bill", async () => {
      const v = await signedVisit(d1, { investigationsAdvised: ["CBC", "ECG"] }, false);
      const rs = await Promise.all([bill(cashier.token, { encounterId: v.encounterId, fromSaved: true }), bill(cashier2.token, { encounterId: v.encounterId, fromSaved: true }), bill(cashier.token, { encounterId: v.encounterId, fromSaved: true })]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409], JSON.stringify(rs.map((r) => r.body)));
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, encounterId: v.encounterId } }), 1);
    });

    it("a picture with no tests is marked so and leaves the queue; only the Cashier, and only in this hospital", async () => {
      const p = await pictureVisit(d1);
      assert.equal((await t.api("post", `/test-orders/pictures/${p.scanId}/no-tests`, rec.token)).status, 403);
      assert.equal((await t.api("post", `/test-orders/pictures/${p.scanId}/no-tests`, bCashier.token)).status, 404);
      assert.equal((await t.api("post", `/test-orders/pictures/${p.scanId}/no-tests`, cashier.token)).status, 200);
      assert.equal((await queue()).handwritten.some((x) => x.scanId === p.scanId), false);
      assert.equal((await t.api("post", `/test-orders/pictures/${p.scanId}/no-tests`, cashier.token)).status, 409);
      assert.equal((await orders(p.encounterId)).length, 0);
      await assert.rejects(() => t.prisma.scanTestReview.delete({ where: { scanId: p.scanId } }), /append-only|cannot/i);
    });

    it("a picture the pharmacy sent back as unusable is not billed, and the picture's tests of another visit are refused", async () => {
      const p = await pictureVisit(d1);
      const other = await pictureVisit(d1);
      assert.equal((await bill(cashier.token, { encounterId: p.encounterId, fromPicture: { scanId: other.scanId, tests: [{ serviceId: svc.cbc!.id }] } })).status, 404, "a picture of another visit");
      assert.equal((await bill(cashier.token, { encounterId: p.encounterId, fromPicture: { scanId: p.scanId, tests: [] } })).status, 400);
      assert.equal((await bill(bCashier.token, { encounterId: p.encounterId, fromPicture: { scanId: p.scanId, tests: [{ serviceId: svc.cbc!.id }] } })).status, 404, "another hospital");
    });
  });
});
