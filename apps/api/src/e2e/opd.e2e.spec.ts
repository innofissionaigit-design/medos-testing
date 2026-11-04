import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, PASSWORD, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../test/harness";

/**
 * Stage 41 certification: the mandatory OPD workflow from CLAUDE.md §36, driven only through the public HTTP API against the
 * real database, using real logins. Nothing in the backend is mocked.
 */
describe("OPD end-to-end certification", () => {
  let t: TestApp;
  let hosp: TestTenant;
  let rec: { id: string; username: string; token: string };
  let nurse: { id: string; token: string };
  let cashier: { id: string; token: string };
  let pharm: { id: string; token: string };
  let doc: TestDoctor;

  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const ok = <T extends { status: number; body: unknown }>(r: T, status: number | number[], what: string): T => {
    assert.ok([status].flat().includes(r.status), `${what}: expected ${String(status)}, got ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  };

  before(async () => {
    t = await startApp();
    hosp = await t.makeTenant("opd-cert");
    rec = await t.makeUser(hosp, ["RECEPTIONIST"], { username: "reception.cert" });
    nurse = await t.makeUser(hosp, ["NURSE"]);
    cashier = await t.makeUser(hosp, ["CASHIER"]);
    pharm = await t.makeUser(hosp, ["PHARMACIST"]);
    doc = await makeDoctor(t, hosp);
  });
  after(async () => { await t.close(); });

  it("MANDATORY OPD FLOW: login → register → check-in → queue → doctor → vitals → diagnosis → prescription → sign → invoice → payment → pharmacy → dispense → receipts", async () => {
    // ── setup an administrator would have done: price list and stocked medicine ──
    const consult = ok(await t.api("post", "/services", hosp.admin.token).send({ code: "CONS", name: "OPD consultation", category: "CONSULTATION", price: "500.00", taxPercent: 0 }), 201, "service").body as { data: { id: string } };
    const med = ok(await t.api("post", "/medicines", pharm.token).send({ brandName: `Para${uniqueWord(4)}`, genericName: "Paracetamol", strength: "500 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 10 }), 201, "medicine").body as { data: { id: string } };
    const batch = ok(await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({
      medicineId: med.data.id, batchNo: "CERT-01", expiryDate: new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10), mrp: "3.00", purchasePrice: "1.20", sellingPrice: "2.50", quantity: 100,
    }), 201, "stock").body as { data: { id: string } };

    // 1. Receptionist logs in (a real login, not a harness token)
    const login = ok(await t.login(hosp.code, rec.username, PASSWORD, hosp.facilityId), 200, "login");
    assert.equal(login.body.data.status, "AUTHENTICATED");
    const recTok = login.body.data.tokens.accessToken as string;

    // 2. Register patient
    const patient = await registerPatient(t, recTok);
    assert.match(patient.mrn, /\S+/);

    // 3. Check-in (walk-in books and checks in) → 4. patient enters the OPD queue
    const visit = ok(await t.api("post", "/appointments/walk-in", recTok).send({ patientId: patient.id, practitionerId: doc.practitionerId }), 201, "walk-in").body as { data: { encounter: { id: string }; queueEntry: { id: string; status: string } } };
    const encounterId = visit.data.encounter.id;
    const queueId = visit.data.queueEntry.id;
    const queue = ok(await t.api("get", "/queue", recTok), 200, "queue").body as { data: { id: string }[] };
    assert.ok(queue.data.some((q) => q.id === queueId), "patient appears in the OPD queue");

    // 5. Doctor opens the patient
    ok(await t.api("post", `/queue/${queueId}/call`, doc.token), 200, "call");
    ok(await t.api("post", `/queue/${queueId}/start`, doc.token), 200, "start consultation");

    // 6. Vitals recorded
    ok(await t.api("post", `/encounters/${encounterId}/observations`, nurse.token).send({ observations: [{ type: "PULSE", value: 88 }, { type: "TEMPERATURE", value: 38.4 }] }), 201, "vitals");

    // 7. Diagnosis recorded + notes
    const note = ok(await t.api("put", `/encounters/${encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Fever for 2 days", examination: "Throat congested" } }), 200, "consultation draft");
    ok(await t.api("post", `/encounters/${encounterId}/diagnoses`, doc.token).send({ text: "Viral fever", type: "PROVISIONAL", code: "B34.9" }), 201, "diagnosis");

    // 8. Prescription created
    const rx = ok(await t.api("put", `/encounters/${encounterId}/prescription`, doc.token).send({ items: [{ medicineId: med.data.id, genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3, quantity: 9 }] }), 200, "prescription");
    assert.equal(rx.body.data.order.status, "DRAFT");
    ok(await t.api("get", `/pharmacy/queue`, pharm.token), 200, "pharmacy queue before signing");
    const beforeSign = (await t.api("get", "/pharmacy/queue", pharm.token)).body.data as { patientId: string }[];
    assert.ok(!beforeSign.some((o) => o.patientId === patient.id), "a draft prescription is invisible to pharmacy");

    // 9. Consultation signed (signs the prescription with it); then the visit is completed
    const signed = ok(await t.api("post", `/encounters/${encounterId}/consultation/sign`, doc.token).send({ version: note.body.data.version }), 200, "sign");
    assert.equal(signed.body.data.status, "SIGNED");
    ok(await t.api("post", `/queue/${queueId}/complete`, doc.token), 200, "complete visit");
    const amend = await t.api("put", `/encounters/${encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Rewritten after signing" }, version: 2 });
    assert.equal(amend.status, 409, "a signed note cannot be silently overwritten");

    // 10. Invoice generated
    const draft = ok(await t.api("post", "/invoices", cashier.token).send({ patientId: patient.id, encounterId, lines: [{ serviceId: consult.data.id, quantity: 1 }] }), 201, "invoice");
    const invoiceId = draft.body.data.id as string;
    const issued = ok(await t.api("post", `/invoices/${invoiceId}/issue`, cashier.token), 200, "issue invoice");
    assert.equal(issued.body.data.total, "500.00");

    // 11. Payment collected (split) → consultation receipt
    ok(await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "1000" }), 201, "open shift");
    const pay = ok(await t.api("post", `/invoices/${invoiceId}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: "200.00" }, { method: "UPI", amount: "300.00", reference: "UPI-CERT-001" }] }), 201, "payment");
    assert.equal(pay.body.data.invoice.status, "PAID");

    // 12. Pharmacy receives the signed prescription
    const pq = (await t.api("get", "/pharmacy/queue", pharm.token)).body.data as { id: string; patientId: string; items: { id: string; medicineId: string }[] }[];
    const order = pq.find((o) => o.patientId === patient.id);
    assert.ok(order, "pharmacy sees the signed prescription");

    // 13. Medicine dispensed (FEFO batch): the pharmacy only bills → 14. the cashier collects and the receipt is produced
    const item = order.items[0]!;
    const dis = ok(await t.api("post", "/pharmacy/dispenses", pharm.token).set("Idempotency-Key", key()).send({
      patientId: patient.id, medicationOrderId: order.id, items: [{ medicationOrderItemId: item.id, medicineId: item.medicineId, quantity: 9 }],
    }), 201, "dispense");
    assert.equal(dis.body.data.dispense.invoice.status, "ISSUED", "pharmacy bills but takes no payment");
    const pharmPay = ok(await t.api("post", `/invoices/${dis.body.data.dispense.invoiceId}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: "22.50" }] }), 201, "cashier collects the pharmacy bill");
    assert.equal(pharmPay.body.data.receipt.total, "22.50");
    assert.ok(pharmPay.body.data.receipt.receiptNumber);
    assert.equal((await t.api("get", "/pharmacy/queue", pharm.token)).body.data.some((o: { id: string }) => o.id === order.id), false, "fully dispensed prescription leaves the queue");

    // ── what must now be true everywhere ──
    const enc = await t.prisma.encounter.findFirstOrThrow({ where: { id: encounterId } });
    assert.equal(enc.status, "COMPLETED");
    const inv = (await t.api("get", `/invoices/${invoiceId}`, cashier.token)).body.data;
    assert.equal(inv.status, "PAID");
    assert.equal(inv.balanceDue, "0.00");
    assert.equal(inv.receipts.length, 1);
    assert.equal(inv.receipts[0].payments.length, 2, "split tender kept as two lines");
    const pharmInvoiceId = dis.body.data.dispense.invoiceId as string;
    const pharmInv = (await t.api("get", `/invoices/${pharmInvoiceId}`, cashier.token)).body.data;
    assert.equal(pharmInv.status, "PAID");
    assert.equal(pharmInv.total, "22.50");

    // stock: ledger reconciles to the cached balance, 100 → 91
    const bal = await t.prisma.stockBalance.findFirstOrThrow({ where: { batchId: batch.data.id } });
    assert.equal(bal.quantity, 91);
    const ledger = await t.prisma.stockLedger.findMany({ where: { batchId: batch.data.id } });
    assert.equal(ledger.reduce((n, l) => n + (l.direction === "IN" ? l.quantity : -l.quantity), 0), bal.quantity);

    // receipts are printable and carry the right numbers
    for (const [receiptId, expect] of [[inv.receipts[0].id, "500.00"], [(await t.api("get", `/invoices/${pharmInvoiceId}`, cashier.token)).body.data.receipts[0].id, "22.50"]] as const) {
      const html = ok(await t.api("get", `/print/receipts/${receiptId}`, cashier.token), 200, "print receipt");
      assert.ok(html.text.includes(expect));
    }
    ok(await t.api("get", `/print/prescriptions/${encounterId}`, doc.token), 200, "print prescription");
    ok(await t.api("get", `/print/invoices/${invoiceId}`, cashier.token), 200, "print invoice");

    // audit trail: each business step is recorded, by the right actor, in order
    const events = await t.prisma.auditEvent.findMany({ where: { tenantId: hosp.tenantId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const actions = events.map((e) => e.action);
    const expected = ["LOGIN_SUCCESS", "PATIENT_CREATED", "ENCOUNTER_OPENED", "VITALS_RECORDED", "DIAGNOSIS_RECORDED", "CONSULTATION_SIGNED", "INVOICE_ISSUED", "PAYMENT_RECEIVED", "PHARMACY_DISPENSED"];
    let at = -1;
    for (const a of expected) {
      const i = actions.indexOf(a, at + 1);
      assert.ok(i > at, `audit event ${a} missing or out of order`);
      at = i;
    }
    assert.equal(events.find((e) => e.action === "PHARMACY_DISPENSED")!.actorUserId, pharm.id);
    assert.equal(events.find((e) => e.action === "CONSULTATION_SIGNED")!.actorUserId, doc.userId);

    // reports agree with what just happened
    const opd = (await t.api("get", "/reports/opd/daily", hosp.admin.token)).body.data;
    assert.equal(opd.total, 1);
    const col = (await t.api("get", "/reports/collections", hosp.admin.token)).body.data;
    assert.equal(col.totals.received, "522.50");
    assert.equal(col.byMode.find((m: { method: string }) => m.method === "UPI").received, "300.00");
  });

  it("the flow cannot be short-circuited: each step is refused out of order or without permission", async () => {
    const patient = await registerPatient(t, rec.token);
    const visit = ok(await t.api("post", "/appointments/walk-in", rec.token).send({ patientId: patient.id, practitionerId: doc.practitionerId }), 201, "walk-in").body as { data: { encounter: { id: string }; queueEntry: { id: string } } };
    const enc = visit.data.encounter.id;
    assert.equal((await t.api("post", `/encounters/${enc}/consultation/sign`, doc.token).send({ version: 1 })).status, 409, "cannot sign a consultation that has no draft");
    assert.equal((await t.api("post", `/encounters/${enc}/observations`, rec.token).send({ observations: [{ type: "PULSE", value: 80 }] })).status, 403, "reception cannot record vitals");
    assert.equal((await t.api("put", `/encounters/${enc}/consultation`, nurse.token).send({ content: { chiefComplaint: "x" } })).status, 403, "nurse cannot write the consultation");
    assert.equal((await t.api("post", "/pharmacy/dispenses", cashier.token).set("Idempotency-Key", key()).send({ patientId: patient.id, items: [{ medicineId: randomUUID(), quantity: 1 }] })).status, 403, "cashier cannot dispense");
    assert.equal((await t.api("post", "/invoices", pharm.token).send({ patientId: randomUUID(), lines: [{ description: "x", unitPrice: "1", taxPercent: 0, quantity: 1 }] })).status !== 201, true);
  });
});
