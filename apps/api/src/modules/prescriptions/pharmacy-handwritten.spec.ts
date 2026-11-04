import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("handwritten prescription: doctor uploads, pharmacy views, verifies, enters the medicines, dispenses; the cashier collects", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let pharm: { id: string; token: string };
  let cashier: { id: string; token: string };
  let doc: TestDoctor;
  let med: { id: string; genericName: string };
  let batchId: string;
  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const stock = async () => (await t.prisma.stockBalance.findFirstOrThrow({ where: { batchId } })).quantity;
  const upload = (enc: string, scanId?: string) => t.api("post", `/encounters/${enc}/prescription-scans`, doc.token).query({ filename: "rx.png", ...(scanId ? { scanId } : {}) }).set("Content-Type", "image/png").send(PNG);
  const queue = async (tok = pharm.token) => (await t.api("get", "/pharmacy/handwritten", tok)).body.data as { id: string; patientId: string; pages: { pageNo: number; fileId: string }[]; patientName: string; mrn: string; doctorName: string; encounterNumber: string; allergies: unknown[] }[];
  const dispense = (body: Record<string, unknown>, tok = pharm.token) => t.api("post", "/pharmacy/dispenses", tok).set("Idempotency-Key", key()).send(body);
  const body = (scan: { id: string }, patientId: string, o: Record<string, unknown> = {}) => ({ patientId, prescriptionScanId: scan.id, verifiedHandwriting: true, items: [{ medicineId: med.id, quantity: 5 }], ...o });

  const newPrescription = async (pages = 1) => {
    const patient = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, doc, patient.id);
    await t.api("post", `/queue/${v.queueId}/start`, doc.token);
    const n = await t.api("put", `/encounters/${v.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Cough" } });
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doc.token).send({ text: "Cough", type: "PROVISIONAL" });
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doc.token).send({ version: n.body.data.version })).status, 200);
    assert.equal((await t.api("post", `/queue/${v.queueId}/complete`, doc.token)).status, 200);
    const scan = (await upload(v.encounterId)).body.data as { id: string };
    for (let p = 2; p <= pages; p++) assert.equal((await upload(v.encounterId, scan.id)).status, 201);
    return { patient, scan, ...v };
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("phw-a");
    b = await t.makeTenant("phw-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    doc = await makeDoctor(t, a);
    assert.equal((await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "0" })).status, 201);
    assert.equal((await t.api("put", "/settings/PRESCRIPTION_UPLOAD_ENABLED", a.admin.token).send({ value: true })).status, 200);
    med = (await t.api("post", "/medicines", pharm.token).send({ brandName: `Cof${uniqueWord(5)}`, genericName: `Gen${uniqueWord(6)}`, strength: "10 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 5 })).body.data;
    const batch = await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({ medicineId: med.id, batchNo: "HWB1", expiryDate: new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10), mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.50", quantity: 500 });
    assert.equal(batch.status, 201, JSON.stringify(batch.body));
    batchId = batch.body.data.batchId ?? (await t.prisma.medicineBatch.findFirstOrThrow({ where: { medicineId: med.id } })).id;
  });
  after(async () => { await t.close(); });

  it("the pictures, every page, appear on the pharmacy screen as soon as the doctor uploads them: no approval step", async () => {
    const p = await newPrescription(2);
    const row = (await queue()).find((x) => x.id === p.scan.id);
    assert.ok(row, "in the pharmacist's list at once");
    assert.deepEqual(row.pages.map((x) => x.pageNo), [1, 2]);
    assert.deepEqual([row.patientName.length > 0, row.mrn, row.encounterNumber, row.doctorName?.length > 0, row.allergies], [true, p.patient.mrn, (await t.prisma.encounter.findFirstOrThrow({ where: { id: p.encounterId } })).encounterNumber, true, []]);
    for (const pg of row.pages) assert.equal((await t.api("get", `/files/${pg.fileId}/content`, pharm.token)).status, 200, "the pharmacist can open each page");
    assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: p.encounterId, source: "HANDWRITTEN" } }), 0, "no prescription was created by the upload; the pharmacist enters the medicines");
    const mine = (await t.api("get", `/encounters/${p.encounterId}/prescription-scans`, doc.token)).body.data[0];
    assert.equal(mine.pharmacy.outcome, null, "the doctor sees it is waiting at the pharmacy");
  });

  it("only the pharmacy sees the list, and each hospital sees its own", async () => {
    await newPrescription();
    for (const tok of [rec.token, cashier.token, doc.token]) assert.equal((await t.api("get", "/pharmacy/handwritten", tok)).status, 403);
    assert.equal((await t.api("get", "/pharmacy/handwritten")).status, 401);
    const bPharm = await t.makeUser(b, ["PHARMACIST"]);
    assert.deepEqual(await queue(bPharm.token), []);
  });

  it("dispensing needs the pharmacist's confirmation and the pharmacist's own entries", async () => {
    const p = await newPrescription();
    const bad: [string, Record<string, unknown>][] = [
      ["not confirmed", { verifiedHandwriting: false }], ["no confirmation field", { verifiedHandwriting: undefined }], ["with a digital prescription", { medicationOrderId: randomUUID() }],
      ["with prescription lines", { items: [{ medicineId: med.id, quantity: 1, medicationOrderItemId: randomUUID() }] }], ["charged to an admission", { chargeToAdmission: true }],
      ["unknown medicine", { items: [{ medicineId: randomUUID(), quantity: 1 }] }], ["no medicines", { items: [] }],
    ];
    for (const [label, o] of bad) assert.equal((await dispense(body(p.scan, p.patient.id, o))).status, 400, label);
    const other = await registerPatient(t, rec.token);
    assert.equal((await dispense(body(p.scan, other.id))).status, 404, "another patient's picture");
    assert.equal((await dispense(body({ id: randomUUID() }, p.patient.id))).status, 404);
    assert.equal((await dispense(body(p.scan, p.patient.id), rec.token)).status, 403);
    assert.equal((await queue()).some((x) => x.id === p.scan.id), true, "still waiting");
  });

  it("dispense creates the bill for the cashier and takes the picture off the pharmacy list", async () => {
    const p = await newPrescription(2);
    const before = await stock();
    const r = await dispense(body(p.scan, p.patient.id, { items: [{ medicineId: med.id, quantity: 7 }] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const d = r.body.data.dispense;
    assert.equal(d.invoice.status, "ISSUED", "billed, not paid");
    assert.equal(await stock(), before - 7);
    const row = await t.prisma.dispense.findFirstOrThrow({ where: { id: d.id } });
    assert.equal(row.prescriptionScanId, p.scan.id);
    assert.equal(row.encounterId, p.encounterId, "the bill belongs to the visit");
    const scan = await t.prisma.prescriptionScan.findFirstOrThrow({ where: { id: p.scan.id } });
    assert.deepEqual([scan.pharmacyOutcome, scan.pharmacyById], ["DISPENSED", pharm.id]);
    assert.equal((await queue()).some((x) => x.id === p.scan.id), false, "gone from the queue");
    assert.equal((await dispense(body(p.scan, p.patient.id))).status, 409, "already dealt with");
    const waiting = await t.api("get", "/invoices?kind=PHARMACY&outstanding=true", cashier.token);
    assert.ok((waiting.body.data as { id: string }[]).some((i) => i.id === d.invoiceId), "on the cashier's screen");
    const paid = await t.api("post", `/invoices/${d.invoiceId}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: d.total }] });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.equal((await t.api("get", `/invoices/${d.invoiceId}`, cashier.token)).body.data.status, "PAID");
    const mine = (await t.api("get", `/encounters/${p.encounterId}/prescription-scans`, doc.token)).body.data[0];
    assert.deepEqual([mine.pharmacy.outcome, mine.pharmacy.by !== null], ["DISPENSED", true], "the doctor sees it was dispensed");
    const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PHARMACY_DISPENSED", entityId: d.id } });
    assert.deepEqual([(ev.metadata as Record<string, unknown>)["scanId"], (ev.metadata as Record<string, unknown>)["handwrittenVerified"]], [p.scan.id, true]);
    // The record is final.
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PrescriptionScan" SET "pharmacyOutcome" = 'REJECTED', "pharmacyNote" = 'changed my mind' WHERE id = '${p.scan.id}'::uuid`));
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Dispense" SET "prescriptionScanId" = NULL WHERE id = '${d.id}'::uuid`));
    // No page can be added once the pharmacy has dealt with it.
    assert.equal((await upload(p.encounterId, p.scan.id)).status, 409);
  });

  it("a prescription dispensed in parts stays on the list until the last part", async () => {
    const p = await newPrescription();
    const first = await dispense(body(p.scan, p.patient.id, { completesPrescription: false, items: [{ medicineId: med.id, quantity: 2 }] }));
    assert.equal(first.status, 201);
    assert.equal((await queue()).some((x) => x.id === p.scan.id), true);
    const last = await dispense(body(p.scan, p.patient.id, { items: [{ medicineId: med.id, quantity: 3 }] }));
    assert.equal(last.status, 201);
    assert.equal((await queue()).some((x) => x.id === p.scan.id), false);
    assert.equal(await t.prisma.dispense.count({ where: { prescriptionScanId: p.scan.id } }), 2);
  });

  it("two pharmacists finishing the same prescription at once: one succeeds, the other changes nothing", async () => {
    const p = await newPrescription();
    const pharm2 = await t.makeUser(a, ["PHARMACIST"]);
    const before = await stock();
    const rs = await Promise.all([dispense(body(p.scan, p.patient.id, { items: [{ medicineId: med.id, quantity: 4 }] })), dispense(body(p.scan, p.patient.id, { items: [{ medicineId: med.id, quantity: 4 }] }), pharm2.token)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], rs.map((r) => JSON.stringify(r.body)).join(" | "));
    assert.equal(await stock(), before - 4, "the loser took no stock");
    assert.equal(await t.prisma.dispense.count({ where: { prescriptionScanId: p.scan.id } }), 1);
  });

  it("a medicine that matches a recorded allergy must be acknowledged, as for any sale", async () => {
    const p = await newPrescription();
    assert.equal((await t.api("post", `/patients/${p.patient.id}/allergies`, doc.token).send({ allergen: med.genericName, type: "DRUG", reaction: "Rash", severity: "SEVERE" })).status, 201);
    assert.equal((await queue()).find((x) => x.id === p.scan.id)?.allergies.length, 1, "the pharmacist sees the allergy next to the picture");
    const blocked = await dispense(body(p.scan, p.patient.id));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "ALLERGY_CONFLICT");
    assert.equal((await t.prisma.prescriptionScan.findFirstOrThrow({ where: { id: p.scan.id } })).pharmacyOutcome, null);
    assert.equal((await dispense(body(p.scan, p.patient.id, { acknowledgeAllergyWarnings: true }))).status, 201);
  });

  it("a picture the pharmacy cannot use goes back with the reason, and the doctor sees it", async () => {
    const p = await newPrescription();
    const reject = (tok: string, reason: unknown) => t.api("post", `/pharmacy/handwritten/${p.scan.id}/reject`, tok).send({ reason });
    assert.equal((await reject(pharm.token, "no")).status, 400, "a reason is needed");
    assert.equal((await reject(rec.token, "Page is blurred")).status, 403);
    assert.equal((await t.api("post", `/pharmacy/handwritten/${randomUUID()}/reject`, pharm.token).send({ reason: "Page is blurred" })).status, 404);
    const bPharm = await t.makeUser(b, ["PHARMACIST"]);
    assert.equal((await reject(bPharm.token, "Page is blurred")).status, 404, "another hospital");
    assert.equal((await reject(pharm.token, "Page is blurred, please upload again")).status, 200);
    assert.equal((await queue()).some((x) => x.id === p.scan.id), false);
    assert.equal((await reject(pharm.token, "Page is blurred again")).status, 409, "already dealt with");
    assert.equal((await dispense(body(p.scan, p.patient.id))).status, 409);
    const mine = (await t.api("get", `/encounters/${p.encounterId}/prescription-scans`, doc.token)).body.data[0];
    assert.deepEqual([mine.pharmacy.outcome, mine.pharmacy.note], ["REJECTED", "Page is blurred, please upload again"]);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "HANDWRITTEN_PRESCRIPTION_REJECTED", entityId: p.scan.id } }));
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PrescriptionScan" SET "pharmacyOutcome" = 'DISPENSED', "pharmacyNote" = NULL WHERE id = '${p.scan.id}'::uuid`));
  });
});
