import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PERMISSIONS } from "@medos/shared";
import { makeDoctor, makeUserWithPermissions, PASSWORD, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../test/harness";

/**
 * Stage 42 certification: the mandatory IPD workflow from CLAUDE.md §37 driven only through the public HTTP API against the
 * real database, including the bed-history requirement (Ward A → ICU → Ward B must be reconstructable, §17).
 */
describe("IPD end-to-end certification", () => {
  let t: TestApp;
  let hosp: TestTenant;
  let rec: { id: string; username: string; token: string };
  let nurse: { id: string; token: string };
  let cashier: { id: string; token: string };
  let pharm: { id: string; token: string };
  let doc: TestDoctor;

  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;
  const ok = <T extends { status: number; body: unknown }>(r: T, status: number | number[], what: string): T => {
    assert.ok([status].flat().includes(r.status), `${what}: expected ${String(status)}, got ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  };
  const admin = (path: string, body: Record<string, unknown>) => t.api("post", path, hosp.admin.token).send(body);

  before(async () => {
    t = await startApp();
    hosp = await t.makeTenant("ipd-cert");
    rec = await t.makeUser(hosp, ["RECEPTIONIST"], { username: "reception.ipd" });
    nurse = await t.makeUser(hosp, ["NURSE"]);
    cashier = await t.makeUser(hosp, ["CASHIER"]);
    pharm = await t.makeUser(hosp, ["PHARMACIST"]);
    doc = await makeDoctor(t, hosp);
  });
  after(async () => { await t.close(); });

  it("MANDATORY IPD FLOW: register → admit → bed → vitals → note → medication given → charge → transfer ×2 → discharge → final bill → payment → bed released", async () => {
    // setup an administrator would have done: wards (A, ICU, B), beds, price list, stocked IV medicine
    const mkBed = async (wardName: string, rate: string) => {
      const ward = ok(await admin("/wards", { name: wardName, code: code("W") }), 201, "ward").body as { data: { id: string } };
      const room = ok(await admin("/rooms", { wardId: ward.data.id, name: "Room 1", code: code("R") }), 201, "room").body as { data: { id: string } };
      const bed = ok(await admin("/beds", { roomId: room.data.id, code: code("B"), dailyRate: rate }), 201, "bed").body as { data: { id: string } };
      return { wardId: ward.data.id, bedId: bed.data.id };
    };
    const a = await mkBed("Ward A", "1000");
    const icu = await mkBed("ICU", "4000");
    const b = await mkBed("Ward B", "1500");
    const visit = (ok(await admin("/services", { code: "DV", name: "Doctor visit", category: "CONSULTATION", price: "400.00", taxPercent: 0 }), 201, "service").body as { data: { id: string } }).data.id;
    const med = (ok(await t.api("post", "/medicines", pharm.token).send({ brandName: `Ceftri${uniqueWord(3)}`, genericName: "Ceftriaxone", strength: "1 g", dosageForm: "INJECTION", gstPercent: 12, reorderLevel: 5 }), 201, "medicine").body as { data: { id: string } }).data.id;
    ok(await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({ medicineId: med, batchNo: "IV-01", expiryDate: new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10), mrp: "130.00", purchasePrice: "80.00", sellingPrice: "120.00", quantity: 20 }), 201, "stock");

    // 1. Registration (real login)
    const login = ok(await t.login(hosp.code, rec.username, PASSWORD, hosp.facilityId), 200, "login");
    const recTok = login.body.data.tokens.accessToken as string;
    const patient = await registerPatient(t, recTok);

    // 2. Admission + 3. bed allocation (in one step; the bed becomes OCCUPIED)
    const adm = ok(await t.api("post", "/admissions", recTok).set("Idempotency-Key", key()).send({ patientId: patient.id, consultantId: doc.practitionerId, bedId: a.bedId, reason: "Lower respiratory infection needing IV antibiotics" }), 201, "admit").body as { data: { id: string; encounterId: string; admissionNumber: string } };
    const admissionId = adm.data.id;
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: a.bedId } })).status, "OCCUPIED");
    assert.equal((await t.api("post", "/admissions", recTok).send({ patientId: patient.id, consultantId: doc.practitionerId, bedId: icu.bedId, reason: "Duplicate admission attempt" })).status, 409, "one active admission per patient");

    // 4. Vitals  5. Nursing note
    ok(await t.api("post", `/encounters/${adm.data.encounterId}/observations`, nurse.token).send({ observations: [{ type: "PULSE", value: 104 }, { type: "TEMPERATURE", value: 38.9 }] }), 201, "vitals");
    ok(await t.api("post", `/admissions/${admissionId}/notes`, nurse.token).send({ note: "Febrile, cough productive. IV access secured." }), 201, "nursing note");

    // 6. Medication: doctor orders, nurse generates the schedule and records administration
    ok(await t.api("put", `/encounters/${adm.data.encounterId}/prescription`, doc.token).send({ items: [{ medicineId: med, genericName: "Ceftriaxone", strength: "1 g", dosage: "1 vial", route: "IV", frequency: "STAT", quantity: 1 }] }), 200, "order");
    ok(await t.api("post", `/encounters/${adm.data.encounterId}/prescription/sign`, doc.token).send({}), 200, "sign order");
    ok(await t.api("post", `/admissions/${admissionId}/mar/generate`, nurse.token).send({ hours: 24 }), 200, "MAR");
    const slots = (await t.api("get", `/admissions/${admissionId}/mar`, nurse.token)).body.data as { id: string; status: string }[];
    assert.ok(slots.length >= 1 && slots.every((s) => s.status === "DUE"), "ordering a drug schedules it but does not mark it given");
    assert.equal(ok(await t.api("post", `/mar/${slots[0]!.id}/administer`, nurse.token).send({ status: "GIVEN" }), 200, "administer").body.data.status, "GIVEN");
    assert.equal((await t.api("post", `/mar/${slots[0]!.id}/administer`, nurse.token).send({ status: "GIVEN" })).status, 409, "a slot cannot be administered twice");

    // pharmacy supplies the IV drug to the ward: charged to the admission, no counter payment
    ok(await t.api("post", "/pharmacy/dispenses", pharm.token).set("Idempotency-Key", key()).send({ patientId: patient.id, items: [{ medicineId: med, quantity: 2 }], chargeToAdmission: true }), 201, "ward supply");

    // 7. Charge added
    ok(await t.api("post", `/admissions/${admissionId}/charges`, doc.token).send({ type: "DOCTOR_VISIT", serviceId: visit, quantity: 2 }), 201, "charge");

    // 8. Bed transfer: Ward A → ICU → Ward B
    ok(await t.api("post", `/admissions/${admissionId}/transfer`, nurse.token).send({ toBedId: icu.bedId, reason: "Oxygen requirement rising" }), 200, "to ICU");
    ok(await t.api("post", `/admissions/${admissionId}/transfer`, nurse.token).send({ toBedId: b.bedId, reason: "Stable, step down to ward" }), 200, "to Ward B");
    const history = await t.prisma.bedAssignment.findMany({ where: { admissionId }, orderBy: { assignedAt: "asc" }, include: { bed: { include: { ward: true } } } });
    assert.deepEqual(history.map((h) => h.bed.ward.name), ["Ward A", "ICU", "Ward B"], "the journey is reconstructable");
    assert.equal(history.filter((h) => h.releasedAt === null).length, 1, "exactly one open assignment");
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: b.bedId } })).status, "OCCUPIED");
    assert.notEqual((await t.prisma.bed.findFirstOrThrow({ where: { id: a.bedId } })).status, "OCCUPIED", "the vacated bed is not left occupied");

    // 9. Doctor discharge: clearances, signed summary — but not complete before billing
    const clear = (step: string, tok: string, body: Record<string, unknown> = {}) => t.api("post", `/admissions/${admissionId}/discharge/clear`, tok).send({ step, ...body });
    ok(await clear("MEDICALLY_FIT", doc.token, { note: "Afebrile 48 h, on oral antibiotics" }), 200, "fit");
    ok(await clear("NURSING", nurse.token), 200, "nursing clearance");
    ok(await clear("CHARGES_REVIEWED", cashier.token), 200, "charges reviewed");
    ok(await clear("PHARMACY", pharm.token), 200, "pharmacy clearance");
    const draft = ok(await t.api("put", `/admissions/${admissionId}/discharge-summary`, doc.token).send({ content: { hospitalCourse: "Treated with IV ceftriaxone; fever settled.", finalDiagnoses: [{ text: "Lower respiratory tract infection", code: "J22" }], conditionAtDischarge: "Stable" } }), 200, "summary draft");
    ok(await t.api("post", `/admissions/${admissionId}/discharge-summary/sign`, doc.token).send({ version: draft.body.data.version }), 200, "summary sign");
    assert.equal((await t.api("post", `/admissions/${admissionId}/discharge/complete`, doc.token).send({ type: "ROUTINE" })).status, 409, "cannot discharge before the final bill");

    // 10. Final bill  11. Payment
    const fb = ok(await t.api("post", `/admissions/${admissionId}/discharge/final-invoice`, cashier.token), 200, "final bill");
    const invoiceId = fb.body.data.invoice.id as string;
    const inv = (await t.api("get", `/invoices/${invoiceId}`, cashier.token)).body.data;
    assert.equal(inv.status, "ISSUED");
    const lineSum = inv.lines.reduce((n: number, l: { lineTotal: string }) => n + Math.round(Number(l.lineTotal) * 100), 0);
    assert.equal(Math.round(Number(inv.total) * 100), lineSum, "invoice total equals its lines");
    assert.ok(inv.lines.some((l: { description: string }) => /ceftri/i.test(l.description)), "ward-supplied medicine is on the bill");
    assert.ok(inv.lines.some((l: { description: string }) => /visit/i.test(l.description)), "doctor visits are on the bill");
    assert.equal((await t.api("post", `/admissions/${admissionId}/discharge/complete`, doc.token).send({ type: "ROUTINE" })).status, 409, "unpaid bill blocks discharge");
    ok(await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "0" }), 201, "shift");
    const half = Math.floor(Number(inv.total) / 2);
    ok(await t.api("post", `/invoices/${invoiceId}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "UPI", amount: half.toFixed(2), reference: "UPI-IPD-001" }] }), 201, "part payment");
    assert.equal((await t.api("post", `/admissions/${admissionId}/discharge/complete`, doc.token).send({ type: "ROUTINE" })).status, 409, "part payment is not enough");
    const rest = (Number(inv.total) - half).toFixed(2);
    assert.equal(ok(await t.api("post", `/invoices/${invoiceId}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: rest }] }), 201, "balance").body.data.invoice.status, "PAID");

    // 12. Discharge completes → bed released
    const done = ok(await t.api("post", `/admissions/${admissionId}/discharge/complete`, doc.token).send({ type: "ROUTINE", note: "Home on oral antibiotics" }), 200, "discharge");
    assert.equal(done.body.data.status, "DISCHARGED");
    assert.equal(await t.prisma.bedAssignment.count({ where: { admissionId, releasedAt: null } }), 0);
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: b.bedId } })).status, "CLEANING", "released bed goes to cleaning");
    ok(await t.api("post", `/beds/${b.bedId}/status`, nurse.token).send({ status: "AVAILABLE" }), 200, "bed cleaned");
    assert.equal((await t.prisma.encounter.findFirstOrThrow({ where: { id: adm.data.encounterId } })).status, "COMPLETED");

    // the discharged record is closed; history remains readable
    assert.equal((await t.api("post", `/admissions/${admissionId}/notes`, nurse.token).send({ note: "Late entry after discharge" })).status, 409);
    assert.equal((await t.api("get", `/admissions/${admissionId}`, rec.token)).status, 200);

    // money and stock reconcile
    const balance = await t.prisma.stockBalance.findMany({ where: { medicineId: med } });
    assert.equal(balance.reduce((n, x) => n + x.quantity, 0), 18, "20 received − 2 supplied");
    const receipts = await t.prisma.receipt.findMany({ where: { invoiceId } });
    assert.equal(receipts.reduce((n, r) => n + Math.round(Number(r.total) * 100), 0), Math.round(Number(inv.total) * 100));
    assert.equal(await t.prisma.charge.count({ where: { admissionId, status: "PENDING" } }), 0, "nothing left unbilled");

    // audit trail: every step of the journey, in order, by the right people
    const events = await t.prisma.auditEvent.findMany({ where: { tenantId: hosp.tenantId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const actions = events.map((e) => e.action);
    const expected = ["PATIENT_CREATED", "ADMISSION_CREATED", "VITALS_RECORDED", "NURSING_NOTE_ADDED", "PRESCRIPTION_SIGNED", "MEDICATION_GIVEN", "PHARMACY_DISPENSED", "CHARGE_POSTED", "BED_TRANSFERRED", "BED_TRANSFERRED", "DISCHARGE_STEP_CLEARED", "DISCHARGE_SUMMARY_SIGNED", "FINAL_INVOICE_CREATED", "PAYMENT_RECEIVED", "PAYMENT_RECEIVED", "ADMISSION_DISCHARGED"];
    let at = -1;
    for (const x of expected) {
      const i = actions.indexOf(x, at + 1);
      assert.ok(i > at, `audit event ${x} missing or out of order`);
      at = i;
    }
    assert.equal(events.find((e) => e.action === "MEDICATION_GIVEN")!.actorUserId, nurse.id);
    assert.equal(events.find((e) => e.action === "ADMISSION_DISCHARGED")!.actorUserId, doc.userId);

    // reports agree
    const dis = (await t.api("get", "/reports/ipd/admissions-discharges", hosp.admin.token)).body.data;
    assert.equal(dis.totalAdmissions, 1);
    assert.equal(dis.totalDischarges, 1);
    assert.equal((await t.api("get", "/reports/ipd/current-admissions", hosp.admin.token)).body.data.total, 0);
    const occ = (await t.api("get", "/reports/ipd/bed-occupancy", hosp.admin.token)).body.data;
    assert.equal(occ.occupied, 0);
    // printable discharge summary
    ok(await t.api("get", `/print/discharge-summaries/${admissionId}`, doc.token), 200, "print summary");
  });

  it("other hospitals and unauthorised roles cannot touch the admission", async () => {
    const other = await t.makeTenant("ipd-other");
    const intruder = await makeUserWithPermissions(t, other, [...PERMISSIONS]);
    const bed = await (async () => {
      const w = (await admin("/wards", { name: `W ${uniqueWord(4)}`, code: code("W") })).body.data.id as string;
      const r = (await admin("/rooms", { wardId: w, name: "Room", code: code("R") })).body.data.id as string;
      return (await admin("/beds", { roomId: r, code: code("B"), dailyRate: "500" })).body.data.id as string;
    })();
    const patient = await registerPatient(t, rec.token);
    const adm = ok(await t.api("post", "/admissions", rec.token).send({ patientId: patient.id, consultantId: doc.practitionerId, bedId: bed, reason: "Observation after minor injury" }), 201, "admit").body as { data: { id: string } };
    for (const [m, p, body] of [
      ["get", `/admissions/${adm.data.id}`, {}], ["post", `/admissions/${adm.data.id}/transfer`, { toBedId: randomUUID(), reason: "Cross hospital attempt" }],
      ["get", `/admissions/${adm.data.id}/discharge`, {}], ["post", `/admissions/${adm.data.id}/discharge/complete`, { type: "ROUTINE" }],
    ] as const) {
      assert.equal((await t.api(m, p, intruder.token).send(body)).status, 404, `${m} ${p}`);
    }
    assert.equal((await t.api("post", `/admissions/${adm.data.id}/discharge/complete`, nurse.token).send({ type: "ROUTINE" })).status, 403, "nurses cannot discharge");
    assert.equal((await t.api("post", `/admissions/${adm.data.id}/discharge/final-invoice`, rec.token)).status, 403, "reception cannot raise the final bill");
  });
});
