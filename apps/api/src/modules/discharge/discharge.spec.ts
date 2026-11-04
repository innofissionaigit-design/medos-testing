import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

let seq = 0;
const code = (p: string) => `${p}${(++seq).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`.slice(0, 14);
const key = () => `k-${randomUUID().slice(0, 18)}`;
const COURSE = { hospitalCourse: "Admitted with fever and cough. Treated with IV antibiotics. Recovered well.", finalDiagnoses: [{ text: "Community-acquired pneumonia", code: "J18.9" }] };

interface World { tenant: TestTenant; rec: { id: string; token: string }; nurse: { id: string; token: string }; cashier: { id: string; token: string }; pharm: { id: string; token: string }; doc: TestDoctor }

describe("discharge workflow, final bill and discharge summary", () => {
  let t: TestApp;
  let w: World;
  let other: TestTenant;

  const world = async (label: string): Promise<World> => {
    const tenant = await t.makeTenant(label);
    return {
      tenant, rec: await t.makeUser(tenant, ["RECEPTIONIST"]), nurse: await t.makeUser(tenant, ["NURSE"]), cashier: await t.makeUser(tenant, ["CASHIER"]),
      pharm: await t.makeUser(tenant, ["PHARMACIST"]), doc: await makeDoctor(t, tenant),
    };
  };
  const mkBed = async (x: World, rate = "1000") => {
    const ward = (await t.api("post", "/wards", x.tenant.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    const room = (await t.api("post", "/rooms", x.tenant.admin.token).send({ wardId: ward.id, name: "Room", code: code("R") })).body.data;
    return (await t.api("post", "/beds", x.tenant.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: rate })).body.data as { id: string; code: string };
  };
  const admit = async (x: World, rate = "1000") => {
    const bed = await mkBed(x, rate);
    const patient = await registerPatient(t, x.rec.token);
    const r = await t.api("post", "/admissions", x.rec.token).send({ patientId: patient.id, consultantId: x.doc.practitionerId, bedId: bed.id, reason: "Pneumonia needing IV antibiotics" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { bed, patient, adm: r.body.data as { id: string; encounterId: string; admissionNumber: string } };
  };
  const svc = async (x: World, name: string, price: string, tax = "0") => (await t.api("post", "/services", x.tenant.admin.token).send({ code: code("S"), name, category: "PROCEDURE", price, taxPercent: tax })).body.data.id as string;
  const clear = (x: World, admId: string, step: string, tok: string, extra: Record<string, unknown> = {}) => t.api("post", `/admissions/${admId}/discharge/clear`, tok).send({ step, ...extra });
  const status = async (x: World, admId: string) => (await t.api("get", `/admissions/${admId}/discharge`, x.doc.token)).body.data;
  const sign = async (x: World, admId: string) => {
    const d = await t.api("put", `/admissions/${admId}/discharge-summary`, x.doc.token).send({ content: COURSE });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const s = await t.api("post", `/admissions/${admId}/discharge-summary/sign`, x.doc.token).send({ version: d.body.data.version });
    assert.equal(s.status, 200, JSON.stringify(s.body));
  };
  /** Clears every pre-billing step. */
  const clearAll = async (x: World, admId: string) => {
    assert.equal((await clear(x, admId, "MEDICALLY_FIT", x.doc.token)).status, 200);
    assert.equal((await clear(x, admId, "NURSING", x.nurse.token)).status, 200);
    assert.equal((await clear(x, admId, "CHARGES_REVIEWED", x.cashier.token)).status, 200);
    assert.equal((await clear(x, admId, "PHARMACY", x.pharm.token)).status, 200);
  };
  const complete = (x: World, admId: string, body: Record<string, unknown> = {}, tok = x.doc.token) => t.api("post", `/admissions/${admId}/discharge/complete`, tok).send(body);
  const finalInvoice = (x: World, admId: string, tok = x.cashier.token) => t.api("post", `/admissions/${admId}/discharge/final-invoice`, tok);
  const payUpi = (invoiceId: string, amount: string, tok: string) => t.api("post", `/invoices/${invoiceId}/payments`, tok).set("Idempotency-Key", key()).send({ payments: [{ method: "UPI", amount, reference: "UPI-DISCH-01" }] });

  before(async () => {
    t = await startApp();
    w = await world("dis-a");
    other = await t.makeTenant("dis-b");
  });
  after(async () => { await t.close(); });

  // ───────────────────────── mandatory IPD scenario ─────────────────────────
  it("MANDATORY IPD FLOW: admit → bed → vitals → order → MAR → note → charges → transfer → fit → summary → final bill → payment → discharge → bed free", async () => {
    const x = await world("dis-flow");
    const visit = await svc(x, "Doctor visit", "400", "5");
    const proc = await svc(x, "Wound debridement", "2500");
    const { adm, patient, bed } = await admit(x, "1000");
    const bed2 = await mkBed(x, "3000");

    assert.equal((await t.api("post", `/encounters/${adm.encounterId}/observations`, x.nurse.token).send({ observations: [{ type: "PULSE", value: 92 }, { type: "TEMPERATURE", value: 38.1 }] })).status, 201);
    await t.api("put", `/encounters/${adm.encounterId}/prescription`, x.doc.token).send({ items: [{ genericName: "Ceftriaxone", strength: "1 g", dosage: "1 vial", route: "IV", frequency: "STAT", quantity: 1 }] });
    const order = (await t.api("post", `/encounters/${adm.encounterId}/prescription/sign`, x.doc.token).send({})).body.data;
    assert.equal((await t.api("post", `/admissions/${adm.id}/mar/generate`, x.nurse.token).send({ hours: 24 })).status, 200);
    const slot = (await t.api("get", `/admissions/${adm.id}/mar`, x.nurse.token)).body.data[0];
    assert.equal((await t.api("post", `/mar/${slot.id}/administer`, x.nurse.token).send({ status: "GIVEN" })).body.data.status, "GIVEN");
    assert.ok(order.orderNumber);
    assert.equal((await t.api("post", `/admissions/${adm.id}/notes`, x.nurse.token).send({ note: "Tolerated first dose well." })).status, 201);
    assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.doc.token).send({ type: "DOCTOR_VISIT", serviceId: visit, quantity: 2 })).status, 201);
    assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.doc.token).send({ type: "PROCEDURE", serviceId: proc, quantity: 1 })).status, 201);
    assert.equal((await t.api("post", `/admissions/${adm.id}/transfer`, x.nurse.token).send({ toBedId: bed2.id, reason: "Step-up to higher dependency room" })).status, 200);

    assert.equal((await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token, { note: "Afebrile 48h, eating well" })).status, 200);
    assert.equal((await clear(x, adm.id, "NURSING", x.nurse.token)).status, 200);
    assert.equal((await clear(x, adm.id, "CHARGES_REVIEWED", x.cashier.token)).status, 200);
    assert.equal((await clear(x, adm.id, "PHARMACY", x.pharm.token)).status, 200);
    await sign(x, adm.id);

    const fb = await finalInvoice(x, adm.id);
    assert.equal(fb.status, 200, JSON.stringify(fb.body));
    const inv = (await t.api("get", `/invoices/${fb.body.data.invoice.id}`, x.cashier.token)).body.data;
    assert.equal(inv.kind, "IPD");
    assert.equal(inv.status, "ISSUED");
    // visits 2 x 400 + 5% = 840.00; procedure 2500; bed days: 1000 (first bed) for today = 1000 -> 4340.00
    assert.equal(inv.total, "4340.00");
    assert.equal(inv.lines.length, 3);
    assert.ok(inv.lines.every((l: { sourceType: string }) => l.sourceType === "CHARGE"));
    assert.equal(inv.encounterId, adm.encounterId);
    assert.equal((await t.prisma.charge.count({ where: { admissionId: adm.id, status: "BILLED", invoiceId: inv.id } })), 3);

    const blocked = await complete(x, adm.id);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "DISCHARGE_BLOCKED");
    assert.match(blocked.body.error.message, /billing not cleared/);
    assert.equal((await payUpi(inv.id, "2000", x.cashier.token)).body.data.invoice.status, "PARTIALLY_PAID");
    assert.equal((await complete(x, adm.id)).status, 409, "still owes money");
    const paid = await payUpi(inv.id, "2340", x.cashier.token);
    assert.equal(paid.body.data.invoice.status, "PAID");

    const st = await status(x, adm.id);
    assert.equal(st.canComplete, true);
    assert.equal(st.steps.find((s: { step: string }) => s.step === "BILLING").status, "CLEARED");
    const done = await complete(x, adm.id, { type: "ROUTINE", note: "Home with oral antibiotics" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.status, "DISCHARGED");
    assert.ok(done.body.data.dischargedAt);

    const row = await t.prisma.admission.findFirstOrThrow({ where: { id: adm.id } });
    assert.equal(row.status, "DISCHARGED");
    assert.equal(row.dischargeType, "ROUTINE");
    assert.equal(row.finalInvoiceId, inv.id);
    assert.equal((await t.prisma.encounter.findFirstOrThrow({ where: { id: adm.encounterId } })).status, "COMPLETED");
    assert.equal(await t.prisma.bedAssignment.count({ where: { admissionId: adm.id, releasedAt: null } }), 0);
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed2.id } })).status, "CLEANING", "the occupied bed is released for cleaning");
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed.id } })).status, "CLEANING");
    const clean = await t.api("post", `/beds/${bed2.id}/status`, x.nurse.token).send({ status: "AVAILABLE" });
    assert.equal(clean.body.data.status, "AVAILABLE", "bed becomes available after cleaning");
    assert.equal((await t.api("post", "/admissions", x.rec.token).send({ patientId: patient.id, consultantId: x.doc.practitionerId, bedId: bed2.id })).status, 201, "the patient and the bed can be reused");

    for (const action of ["ADMISSION_CREATED", "BED_TRANSFERRED", "DISCHARGE_STEP_CLEARED", "FINAL_INVOICE_CREATED", "PAYMENT_RECEIVED", "DISCHARGE_SUMMARY_SIGNED", "ADMISSION_DISCHARGED"]) {
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action } }), action);
    }
    assert.equal((await complete(x, adm.id)).status, 409, "cannot discharge twice");
  });

  // ───────────────────────── step rules ─────────────────────────
  it("the final bill carries each service's SAC/HSN code as it was when billed (G6); charges without a code stay without one", async () => {
    const coded = (await t.api("post", "/services", w.tenant.admin.token).send({ code: code("SC"), name: "Dressing change", category: "PROCEDURE", price: "200", taxPercent: 0, sacCode: "999316" })).body.data.id as string;
    const plain = await svc(w, "General care", "300");
    const { adm } = await admit(w, "500");
    for (const serviceId of [coded, plain]) assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, w.cashier.token).send({ type: "SERVICE", serviceId, quantity: 1 })).status, 201);
    assert.equal((await t.api("patch", `/services/${coded}`, w.tenant.admin.token).send({ sacCode: "999399" })).status, 200, "master changed after the charge was posted but before billing");
    await clearAll(w, adm.id);
    await sign(w, adm.id);
    const fb = await finalInvoice(w, adm.id);
    assert.equal(fb.status, 200, JSON.stringify(fb.body));
    const inv = (await t.api("get", `/invoices/${fb.body.data.invoice.id}`, w.cashier.token)).body.data as { lines: { description: string; hsnSac: string | null }[] };
    assert.equal(inv.lines.find((l) => l.description === "Dressing change")!.hsnSac, "999399", "the code in force when the final bill is raised");
    assert.equal(inv.lines.find((l) => l.description === "General care")!.hsnSac, null);
    assert.ok(inv.lines.some((l) => l.description.startsWith("Bed ")), "bed charges are on the bill without a code");
  });

  describe("clearance steps", () => {
    it("the pharmacy step clears itself when the pharmacy dispenses everything prescribed; until then it stays pending and can still be cleared by hand", async () => {
      const x = await world("dis-pharm-auto");
      const stepOf = async (admId: string) => (await status(x, admId)).steps.find((s: { step: string }) => s.step === "PHARMACY");

      // Nothing prescribed: after the doctor's fitness decision there is nothing to dispense, so it clears itself.
      const none = await admit(x);
      assert.equal((await stepOf(none.adm.id)).status, "PENDING", "waits for the doctor's fitness decision");
      assert.equal((await clear(x, none.adm.id, "MEDICALLY_FIT", x.doc.token)).status, 200);
      const auto = await stepOf(none.adm.id);
      assert.equal(auto.status, "CLEARED");
      assert.equal(auto.note, "Nothing to dispense");

      // A signed prescription for 4 units: pending, with a reason, until the pharmacy dispenses all 4.
      const { adm, patient } = await admit(x);
      const med = (await t.api("post", "/medicines", x.pharm.token).send({ brandName: `Ceft${uniqueWord(5)}`, genericName: `Ceftri${uniqueWord(5)}`, strength: "1 g", dosageForm: "INJECTION" })).body.data as { id: string; genericName: string };
      const ymd = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
      assert.equal((await t.api("post", "/pharmacy/batches", x.pharm.token).set("Idempotency-Key", key()).send({ medicineId: med.id, batchNo: "AUTO1", expiryDate: ymd, mrp: "100", purchasePrice: "60", sellingPrice: "95", quantity: 20 })).status, 201);
      await t.api("put", `/encounters/${adm.encounterId}/prescription`, x.doc.token).send({ items: [{ medicineId: med.id, genericName: med.genericName, strength: "1 g", dosage: "1 vial", route: "IV", frequency: "OD", quantity: 4 }] });
      const order = (await t.api("post", `/encounters/${adm.encounterId}/prescription/sign`, x.doc.token).send({})).body.data as { id: string; items: { id: string }[] };
      assert.equal((await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token)).status, 200);
      const pending = await stepOf(adm.id);
      assert.equal(pending.status, "PENDING");
      assert.match(pending.blockers[0], /not yet fully dispensed/);

      const dispense = (qty: number) => t.api("post", "/pharmacy/dispenses", x.pharm.token).set("Idempotency-Key", key())
        .send({ patientId: patient.id, medicationOrderId: order.id, items: [{ medicationOrderItemId: order.items[0]!.id, medicineId: med.id, quantity: qty }] });
      assert.equal((await dispense(3)).status, 201);
      assert.equal((await stepOf(adm.id)).status, "PENDING", "partly dispensed is still pending");
      assert.equal((await dispense(1)).status, 201);
      const done = await stepOf(adm.id);
      assert.equal(done.status, "CLEARED", "fully dispensed: cleared without anyone clicking");
      assert.equal(done.note, "All prescribed medicines dispensed");
      assert.deepEqual(done.blockers, []);

      // Clearing by hand stays possible for a facility that wants it, and a hand-made clearance is never overwritten.
      assert.equal((await clear(x, adm.id, "PHARMACY", x.pharm.token)).status, 200);
      assert.equal((await stepOf(adm.id)).status, "CLEARED");
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge`, x.nurse.token)).status, 200, "the ward sees the same result");
    });

    it("everything waits for the doctor's medical-fitness decision; each step needs its own role", async () => {
      const { adm } = await admit(w);
      for (const [step, u] of [["NURSING", w.nurse], ["CHARGES_REVIEWED", w.cashier], ["PHARMACY", w.pharm]] as const) {
        const r = await clear(w, adm.id, step, u.token);
        assert.equal(r.status, 409, step);
        assert.equal(r.body.error.code, "DISCHARGE_BLOCKED");
      }
      assert.equal((await clear(w, adm.id, "MEDICALLY_FIT", w.nurse.token)).status, 403, "only a doctor");
      assert.equal((await clear(w, adm.id, "MEDICALLY_FIT", w.rec.token)).status, 403);
      const noProfile = await t.makeUser(w.tenant, ["DOCTOR"]);
      assert.equal((await clear(w, adm.id, "MEDICALLY_FIT", noProfile.token)).status, 403, "must be a registered practitioner");
      assert.equal((await clear(w, adm.id, "MEDICALLY_FIT", w.doc.token)).status, 200);
      assert.equal((await clear(w, adm.id, "MEDICALLY_FIT", w.doc.token)).status, 409, "already cleared");
      assert.equal((await clear(w, adm.id, "NURSING", w.doc.token)).status, 403, "the doctor cannot give nursing clearance");
      assert.equal((await clear(w, adm.id, "PHARMACY", w.nurse.token)).status, 403);
      assert.equal((await clear(w, adm.id, "CHARGES_REVIEWED", w.nurse.token)).status, 200, "nurses hold CHARGE_CREATE");
      assert.equal((await clear(w, adm.id, "BILLING", w.cashier.token)).status, 400, "billing clears itself");
      assert.equal((await clear(w, adm.id, "SURGERY", w.doc.token)).status, 400);
    });

    it("nursing clearance is blocked by pending tasks and overdue medication until they are resolved", async () => {
      const x = await world("dis-nur");
      const { adm, patient } = await admit(x);
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const task = (await t.api("post", `/admissions/${adm.id}/tasks`, x.nurse.token).send({ title: "Remove IV cannula", dueAt: new Date(Date.now() + 3_600_000).toISOString() })).body.data;
      await t.api("put", `/encounters/${adm.encounterId}/prescription`, x.doc.token).send({ items: [{ genericName: "Aztreonam", dosage: "1 g", route: "IV", frequency: "OTHER", frequencyText: "As directed" }] });
      const order = (await t.api("post", `/encounters/${adm.encounterId}/prescription/sign`, x.doc.token).send({})).body.data;
      const mar = await t.prisma.medicationAdministration.create({ data: { tenantId: x.tenant.tenantId, facilityId: x.tenant.facilityId, patientId: patient.id, admissionId: adm.id, encounterId: adm.encounterId, medicationOrderItemId: order.items[0].id, scheduledAt: new Date(Date.now() - 2 * 3_600_000) } });
      const r = await clear(x, adm.id, "NURSING", x.nurse.token);
      assert.equal(r.status, 409);
      assert.match(r.body.error.message, /1 nursing task\(s\) still pending/);
      assert.match(r.body.error.message, /1 overdue medication dose/);
      await t.api("post", `/tasks/${task.id}/complete`, x.nurse.token).send({});
      assert.equal((await clear(x, adm.id, "NURSING", x.nurse.token)).status, 409, "the overdue dose still blocks");
      await t.api("post", `/mar/${mar.id}/administer`, x.nurse.token).send({ status: "MISSED", remarks: "Patient was off the ward" });
      assert.equal((await clear(x, adm.id, "NURSING", x.nurse.token)).status, 200);
    });

    it("waivers need ADMISSION_DISCHARGE and a real reason; medical fitness can never be waived", async () => {
      const x = await world("dis-wv");
      const { adm } = await admit(x);
      const waive = (step: string, reason: string, tok = x.doc.token) => t.api("post", `/admissions/${adm.id}/discharge/waive`, tok).send({ step, reason });
      assert.equal((await waive("PHARMACY", "Patient has own medicines at home")).status, 409, "fitness first");
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      assert.equal((await waive("PHARMACY", "short")).status, 400);
      assert.equal((await waive("MEDICALLY_FIT", "Trying to waive the doctor decision")).status, 400);
      assert.equal((await waive("PHARMACY", "Patient has own medicines at home", x.nurse.token)).status, 403);
      assert.equal((await waive("PHARMACY", "Patient has own medicines at home")).status, 200);
      assert.equal((await waive("PHARMACY", "Waived twice by mistake")).status, 409);
      assert.equal((await clear(x, adm.id, "PHARMACY", x.pharm.token)).status, 409, "already waived");
      const st = await status(x, adm.id);
      const p = st.steps.find((s: { step: string }) => s.step === "PHARMACY");
      assert.equal(p.status, "WAIVED");
      assert.equal(p.note, "Patient has own medicines at home");
      const waivedRow = await t.prisma.dischargeClearance.findFirstOrThrow({ where: { admissionId: adm.id, step: "PHARMACY" } });
      await assert.rejects(() => t.prisma.dischargeClearance.update({ where: { id: waivedRow.id }, data: { status: "CLEARED" } }), /append-only/);
      await assert.rejects(() => t.prisma.dischargeClearance.create({ data: { tenantId: x.tenant.tenantId, facilityId: x.tenant.facilityId, admissionId: adm.id, step: "MEDICALLY_FIT", status: "WAIVED", note: "Raw SQL waiver attempt here", byId: x.doc.userId } }), /clearance_fit_not_waivable|check|Unique/i);
    });
  });

  // ───────────────────────── final bill ─────────────────────────
  describe("final bill", () => {
    it("requires the earlier steps; bills every pending charge once, correctly taxed; charges become BILLED", async () => {
      const x = await world("dis-fb");
      const s1 = await svc(x, "Nebulisation", "150.50", "12");
      const { adm } = await admit(x, "999.99");
      await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 3 });
      const voided = (await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 })).body.data;
      await t.api("post", `/charges/${voided.id}/void`, x.nurse.token).send({ reason: "Posted in error" });
      const early = await finalInvoice(x, adm.id);
      assert.equal(early.status, 409);
      assert.match(early.body.error.message, /Clear these steps/);
      await clearAll(x, adm.id);
      assert.equal((await finalInvoice(x, adm.id, x.rec.token)).status, 403, "reception cannot issue invoices");
      assert.equal((await finalInvoice(x, adm.id, x.nurse.token)).status, 403);
      const r = await finalInvoice(x, adm.id);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const inv = (await t.api("get", `/invoices/${r.body.data.invoice.id}`, x.cashier.token)).body.data;
      // 3 x 150.50 = 451.50 + 12% (54.18) = 505.68; bed day 999.99; total 1505.67
      assert.equal(inv.total, "1505.67");
      assert.equal(inv.taxTotal, "54.18");
      assert.equal(inv.lines.length, 2, "the voided charge is not billed");
      assert.equal(await t.prisma.charge.count({ where: { admissionId: adm.id, status: "BILLED" } }), 2);
      assert.equal(await t.prisma.charge.count({ where: { admissionId: adm.id, status: "VOIDED" } }), 1);
      assert.equal((await t.prisma.admission.findFirstOrThrow({ where: { id: adm.id } })).finalInvoiceId, inv.id);
      assert.equal(r.body.data.status.finalInvoice.balanceDue, "1505.67");
    });

    it("cannot be created twice; concurrent requests produce exactly one invoice and bill each charge once", async () => {
      const x = await world("dis-fb2");
      const s1 = await svc(x, "Dressing", "200");
      const { adm } = await admit(x, "500");
      await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 });
      await clearAll(x, adm.id);
      const rs = await Promise.all(Array.from({ length: 6 }, () => finalInvoice(x, adm.id)));
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
      assert.equal(await t.prisma.invoice.count({ where: { patientId: (await t.prisma.admission.findFirstOrThrow({ where: { id: adm.id } })).patientId, kind: "IPD" } }), 1);
      assert.equal(await t.prisma.invoiceLine.count({ where: { sourceType: "CHARGE", sourceId: { in: (await t.prisma.charge.findMany({ where: { admissionId: adm.id } })).map((c) => c.id) } } }), 2);
      const again = await finalInvoice(x, adm.id);
      assert.equal(again.body.error.code, "CONFLICT");
    });

    it("DATABASE: a charge can never be billed on two invoices, even by raw SQL", async () => {
      const x = await world("dis-fb3");
      const s1 = await svc(x, "Injection", "100");
      const { adm } = await admit(x, "100");
      await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 });
      await clearAll(x, adm.id);
      const r = await finalInvoice(x, adm.id);
      const line = await t.prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: r.body.data.invoice.id, sourceType: "CHARGE" } });
      const patient = (await t.prisma.admission.findFirstOrThrow({ where: { id: adm.id } })).patientId;
      const dup = await t.prisma.invoice.create({ data: { tenantId: x.tenant.tenantId, facilityId: x.tenant.facilityId, patientId: patient, createdById: x.cashier.id, subtotal: 100, total: 100 } });
      await assert.rejects(() => t.prisma.invoiceLine.create({ data: { tenantId: x.tenant.tenantId, invoiceId: dup.id, lineNo: 1, description: "Double billed", quantity: 1, unitPrice: 100, taxAmount: 0, lineTotal: 100, sourceType: "CHARGE", sourceId: line.sourceId! } }), /Unique|unique/);
      await assert.rejects(() => t.prisma.charge.update({ where: { id: line.sourceId! }, data: { status: "PENDING", invoiceId: null } }), /cannot change|charge_billed_has_invoice|check/i);
    });

    it("no charges at all: the bill step settles itself and discharge needs no invoice", async () => {
      const x = await world("dis-nofee");
      const { adm } = await admit(x, "0");
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      await clear(x, adm.id, "NURSING", x.nurse.token);
      await clear(x, adm.id, "CHARGES_REVIEWED", x.cashier.token);
      await clear(x, adm.id, "PHARMACY", x.pharm.token);
      await sign(x, adm.id);
      const r = await finalInvoice(x, adm.id);
      assert.equal(r.status, 200);
      assert.equal(r.body.data.invoice, null);
      assert.equal((await complete(x, adm.id)).status, 200);
    });

    it("only billing staff and administrators raise the final bill; Reception, nurses, pharmacists and doctors are refused and nothing is billed", async () => {
      const x = await world("dis-fbr");
      const { adm } = await admit(x, "500.00");
      await clearAll(x, adm.id);
      for (const [who, tok] of [["reception", x.rec.token], ["nurse", x.nurse.token], ["pharmacist", x.pharm.token], ["doctor", x.doc.token]] as const) {
        assert.equal((await finalInvoice(x, adm.id, tok)).status, 403, `${who} cannot raise the final bill`);
      }
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: x.tenant.tenantId, kind: "IPD" } }), 0, "refused attempts billed nothing");
      const r = await finalInvoice(x, adm.id, x.tenant.admin.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: x.tenant.tenantId, kind: "IPD" } }), 1);
    });

    it("no new charges, bed days or counter-charged medicines once the final bill is issued", async () => {
      const x = await world("dis-lock");
      const s1 = await svc(x, "Review", "100");
      const { adm, patient } = await admit(x, "300");
      await clearAll(x, adm.id);
      await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 });
      await finalInvoice(x, adm.id);
      const late = await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 });
      assert.equal(late.status, 409);
      assert.match(late.body.error.message, /final bill has already been issued/);
      assert.equal((await t.api("post", `/admissions/${adm.id}/charges/bed-days`, x.nurse.token)).body.data.posted, 0);
      const med = (await t.api("post", "/medicines", x.pharm.token).send({ brandName: `Lock${uniqueWord(4)}`, genericName: `Lockgen${uniqueWord(4)}`, dosageForm: "TABLET", gstPercent: 0 })).body.data;
      await t.api("post", "/pharmacy/batches", x.pharm.token).set("Idempotency-Key", key()).send({ medicineId: med.id, batchNo: "LK1", expiryDate: new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10), mrp: "10", purchasePrice: "5", sellingPrice: "9", quantity: 10 });
      const d = await t.api("post", "/pharmacy/dispenses", x.pharm.token).set("Idempotency-Key", key()).send({ patientId: patient.id, items: [{ medicineId: med.id, quantity: 1 }], chargeToAdmission: true });
      assert.equal(d.status, 409);
    });
  });

  // ───────────────────────── completion ─────────────────────────
  describe("completing the discharge", () => {
    it("lists every blocker; the summary requirement, bed status and steps are configurable per facility", async () => {
      const x = await world("dis-cfg");
      const { adm, bed } = await admit(x);
      const early = await complete(x, adm.id);
      assert.equal(early.status, 409);
      assert.ok(early.body.error.details.blockers.length >= 4);
      const put = (key: string, value: unknown) => t.api("put", `/settings/${key}`, x.tenant.admin.token).send({ value });
      assert.equal((await put("DISCHARGE_REQUIRED_STEPS", ["NURSING"])).status, 200);
      assert.equal((await put("DISCHARGE_REQUIRE_SUMMARY", false)).status, 200);
      assert.equal((await put("BED_AFTER_DISCHARGE", "AVAILABLE")).status, 200);
      assert.equal((await complete(x, adm.id)).status, 409, "fitness and nursing are still required");
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      await clear(x, adm.id, "NURSING", x.nurse.token);
      const r = await complete(x, adm.id, { type: "LAMA", note: "Left against medical advice, risks explained" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await t.prisma.admission.findFirstOrThrow({ where: { id: adm.id } })).dischargeType, "LAMA");
      assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed.id } })).status, "AVAILABLE");
      assert.equal((await complete(x, adm.id, { type: "WALKED_OUT" })).status, 400);
    });

    it("requires a signed summary by default, and only a registered practitioner with discharge rights can complete", async () => {
      const x = await world("dis-sum");
      const { adm } = await admit(x, "0");
      await clearAll(x, adm.id);
      const noSummary = await complete(x, adm.id);
      assert.equal(noSummary.status, 409);
      assert.match(noSummary.body.error.message, /discharge summary is not signed/);
      await sign(x, adm.id);
      await finalInvoice(x, adm.id);
      for (const u of [x.nurse, x.rec, x.cashier, x.pharm]) assert.equal((await complete(x, adm.id, {}, u.token)).status, 403);
      assert.equal((await complete(x, adm.id, {}, (await t.makeUser(x.tenant, ["DOCTOR"])).token)).status, 403, "doctor user without a practitioner record");
      assert.equal((await complete(x, adm.id)).status, 200);
    });

    it("an unpaid final bill blocks discharge unless the doctor waives billing with a reason; waivers are audited", async () => {
      const x = await world("dis-pay");
      const s1 = await svc(x, "Procedure", "1000");
      const { adm } = await admit(x, "0");
      await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 });
      await clearAll(x, adm.id);
      await sign(x, adm.id);
      await finalInvoice(x, adm.id);
      const blocked = await complete(x, adm.id);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /billing not cleared/);
      const w1 = await t.api("post", `/admissions/${adm.id}/discharge/waive`, x.doc.token).send({ step: "BILLING", reason: "Charity case approved by the medical director" });
      assert.equal(w1.status, 200);
      assert.equal((await complete(x, adm.id)).status, 200);
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: x.tenant.tenantId, action: "DISCHARGE_STEP_WAIVED" } });
      assert.equal(evt.actorUserId, x.doc.userId);
      assert.equal((evt.metadata as { reason: string }).reason, "Charity case approved by the medical director");
    });

    it("completion is atomic and single-shot: 6 parallel attempts discharge once and release the bed once", async () => {
      const x = await world("dis-race");
      const { adm, bed } = await admit(x, "0");
      await clearAll(x, adm.id);
      await sign(x, adm.id);
      await finalInvoice(x, adm.id);
      const rs = await Promise.all(Array.from({ length: 6 }, () => complete(x, adm.id)));
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: x.tenant.tenantId, action: "ADMISSION_DISCHARGED", entityId: adm.id } }), 1);
      assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed.id } })).status, "CLEANING");
      assert.equal(await t.prisma.bedAssignment.count({ where: { admissionId: adm.id } }), 1);
    });

    it("six clinicians clearing the same step at once record it once", async () => {
      const x = await world("dis-race2");
      const { adm } = await admit(x);
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const nurses = await Promise.all(Array.from({ length: 5 }, () => t.makeUser(x.tenant, ["NURSE"])));
      const rs = await Promise.all([x.nurse, ...nurses].map((n) => clear(x, adm.id, "NURSING", n.token)));
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      assert.equal(await t.prisma.dischargeClearance.count({ where: { admissionId: adm.id, step: "NURSING" } }), 1);
    });

    it("a discharged admission is read-only: no transfers, notes, charges, MAR or further clearances; history stays readable", async () => {
      const x = await world("dis-ro");
      const { adm, patient } = await admit(x, "0");
      const spare = await mkBed(x);
      await clearAll(x, adm.id);
      await sign(x, adm.id);
      await finalInvoice(x, adm.id);
      await complete(x, adm.id);
      assert.equal((await t.api("post", `/admissions/${adm.id}/transfer`, x.nurse.token).send({ toBedId: spare.id, reason: "Transfer after discharge" })).status, 409);
      assert.equal((await t.api("post", `/admissions/${adm.id}/notes`, x.nurse.token).send({ note: "Late note after discharge" })).status, 409);
      assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ type: "SERVICE", description: "Late charge", unitPrice: "10", taxPercent: 0, quantity: 1 })).status, 409);
      assert.equal((await clear(x, adm.id, "NURSING", x.nurse.token)).status, 409);
      assert.equal((await t.api("post", `/admissions/${adm.id}/cancel`, x.rec.token).send({ reason: "Cancel after discharge" })).status, 409);
      assert.equal((await t.api("put", `/admissions/${adm.id}/discharge-summary`, x.doc.token).send({ content: COURSE })).status, 409);
      assert.equal((await t.api("get", `/admissions/${adm.id}`, x.rec.token)).body.data.bedHistory.length, 1);
      assert.equal((await t.api("get", "/nursing/worklist", x.nurse.token)).body.data.some((r: { admissionId: string }) => r.admissionId === adm.id), false);
      assert.equal((await t.api("get", "/admissions", x.rec.token).query({ status: "DISCHARGED", patientId: patient.id })).body.data.length, 1);
      await assert.rejects(() => t.prisma.admission.update({ where: { id: adm.id }, data: { status: "ADMITTED" } }), /cannot be reopened|closed admission/);
      await assert.rejects(() => t.prisma.admission.update({ where: { id: adm.id }, data: { dischargeType: "DEATH" } }), /closed admission cannot be changed/);
    });

    it("is isolated by tenant and facility", async () => {
      const { adm } = await admit(w);
      const oDoc = await makeDoctor(t, other);
      const oNurse = await t.makeUser(other, ["NURSE"]);
      for (const [m, p, tok, body] of [
        ["get", `/admissions/${adm.id}/discharge`, oDoc.token, {}], ["post", `/admissions/${adm.id}/discharge/clear`, oDoc.token, { step: "MEDICALLY_FIT" }],
        ["post", `/admissions/${adm.id}/discharge/waive`, oDoc.token, { step: "PHARMACY", reason: "Cross tenant waiver attempt" }], ["post", `/admissions/${adm.id}/discharge/complete`, oDoc.token, {}],
        ["get", `/admissions/${adm.id}/discharge-summary`, oDoc.token, {}], ["put", `/admissions/${adm.id}/discharge-summary`, oDoc.token, { content: COURSE }],
        ["get", `/admissions/${adm.id}/notes`, oNurse.token, {}],
      ] as const) assert.equal((await t.api(m, p, tok).send(body)).status, 404, `${m} ${p}`);
      const f2 = await t.makeUser(w.tenant, ["NURSE"], { facilityIds: [w.tenant.facility2Id] });
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge`, f2.token)).status, 404);
      assert.equal((await t.api("get", `/admissions/${randomUUID()}/discharge`, w.doc.token)).status, 404);
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge`, w.rec.token)).status, 200);
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge`, (await t.makeUser(w.tenant, ["PHARMACIST"])).token)).status, 200);
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge`)).status, 401);
    });
  });

  // ───────────────────────── discharge summary ─────────────────────────
  describe("discharge summary", () => {
    it("suggests what is already in the record, then saves a structured draft with optimistic locking", async () => {
      const x = await world("dis-sm1");
      const proc = await svc(x, "Chest tube insertion", "5000");
      const { adm } = await admit(x);
      await t.api("post", `/admissions/${adm.id}/charges`, x.doc.token).send({ type: "PROCEDURE", serviceId: proc, quantity: 1 });
      await t.api("put", `/encounters/${adm.encounterId}/prescription`, x.doc.token).send({ items: [{ genericName: "Amoxicillin-Clavulanate", strength: "625 mg", dosage: "1 tablet", route: "ORAL", frequency: "BD", durationDays: 5 }] });
      await t.api("post", `/encounters/${adm.encounterId}/prescription/sign`, x.doc.token).send({});
      const g = (await t.api("get", `/admissions/${adm.id}/discharge-summary`, x.doc.token)).body.data;
      assert.equal(g.document, null);
      assert.equal(g.suggested.dischargeMedications[0].genericName, "Amoxicillin-Clavulanate");
      assert.equal(g.suggested.procedures[0].name, "Chest tube insertion");
      assert.equal(g.admission.admissionNumber, adm.admissionNumber);
      const content = { ...COURSE, procedures: [{ name: "Chest tube insertion", date: new Date().toISOString().slice(0, 10) }], investigationSummary: "CXR: right lower lobe consolidation, resolving.", dischargeMedications: g.suggested.dischargeMedications, advice: "Rest, fluids, avoid smoking", followUp: { afterDays: 7, notes: "Review with chest X-ray" } };
      const s1 = await t.api("put", `/admissions/${adm.id}/discharge-summary`, x.doc.token).send({ content });
      assert.equal(s1.status, 200, JSON.stringify(s1.body));
      assert.equal(s1.body.data.version, 1);
      const s2 = await t.api("put", `/admissions/${adm.id}/discharge-summary`, x.doc.token).send({ content: { ...content, advice: "Updated advice" }, version: 1 });
      assert.equal(s2.body.data.version, 2);
      assert.equal((await t.api("put", `/admissions/${adm.id}/discharge-summary`, x.doc.token).send({ content, version: 1 })).body.error.code, "STALE_VERSION");
      assert.equal((await t.api("put", `/admissions/${adm.id}/discharge-summary`, x.doc.token).send({ content })).status, 409, "version required once a draft exists");
      const other2 = await makeDoctor(t, x.tenant);
      assert.equal((await t.api("put", `/admissions/${adm.id}/discharge-summary`, other2.token).send({ content, version: 2 })).status, 403);
      for (const bad of [{ hospitalCourse: "x".repeat(8001) }, { dischargeMedications: [{ genericName: "X-drug", dosage: "1", route: "RECTAL", frequency: "OD" }] }, { finalDiagnoses: [{ text: "a" }] }, { followUp: { afterDays: 0 } }, { status: "SIGNED" }]) {
        assert.equal((await t.api("put", `/admissions/${adm.id}/discharge-summary`, x.doc.token).send({ content: { ...content, ...bad }, version: 2 })).status, 400, JSON.stringify(bad).slice(0, 50));
      }
    });

    it("only the treating consultant signs, and only with a hospital course and a final diagnosis; diagnoses join the patient's history", async () => {
      const x = await world("dis-sm2");
      const { adm, patient } = await admit(x);
      const draft = await t.api("put", `/admissions/${adm.id}/discharge-summary`, x.doc.token).send({ content: { advice: "Rest" } });
      const sign1 = (tok: string, v: number) => t.api("post", `/admissions/${adm.id}/discharge-summary/sign`, tok).send({ version: v });
      assert.equal((await sign1(x.doc.token, draft.body.data.version)).status, 400, "course and diagnosis required");
      const full = await t.api("put", `/admissions/${adm.id}/discharge-summary`, x.doc.token).send({ content: COURSE, version: 1 });
      const colleague = await makeDoctor(t, x.tenant);
      assert.equal((await sign1(colleague.token, full.body.data.version)).status, 403, "not the treating consultant");
      for (const u of [x.nurse, x.rec]) assert.equal((await sign1(u.token, full.body.data.version)).status, 403);
      assert.equal((await sign1(x.doc.token, 1)).status, 409, "stale version");
      const ok = await sign1(x.doc.token, full.body.data.version);
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.status, "SIGNED");
      assert.equal((await sign1(x.doc.token, full.body.data.version)).status, 409);
      const hist = (await t.api("get", `/patients/${patient.id}/diagnoses`, x.doc.token)).body.data;
      assert.equal(hist[0].text, "Community-acquired pneumonia");
      assert.equal(hist[0].type, "FINAL");
      assert.equal((await t.api("put", `/admissions/${adm.id}/discharge-summary`, x.doc.token).send({ content: COURSE, version: 2 })).body.error.code, "CONSULTATION_SIGNED");
      const docRow = await t.prisma.clinicalDocument.findFirstOrThrow({ where: { encounterId: adm.encounterId } });
      await assert.rejects(() => t.prisma.clinicalDocument.update({ where: { id: docRow.id }, data: { draft: { hospitalCourse: "Tampered" } } }), /cannot be edited/);
    });

    it("amends with reason, author and a new version; the signed original stays recoverable", async () => {
      const x = await world("dis-sm3");
      const { adm } = await admit(x);
      await sign(x, adm.id);
      const original = (await t.api("get", `/admissions/${adm.id}/discharge-summary/versions/1`, x.doc.token)).body.data;
      const amend = (tok: string, body: Record<string, unknown>) => t.api("post", `/admissions/${adm.id}/discharge-summary/amend`, tok).send(body);
      const content = { ...COURSE, advice: "Added: avoid NSAIDs", hospitalCourse: `${COURSE.hospitalCourse} Renal function monitored.` };
      assert.equal((await amend(x.doc.token, { expectedVersion: 1, reason: "too short", content })).status, 400);
      assert.equal((await amend(x.nurse.token, { expectedVersion: 1, reason: "Nurse tries to amend the summary", content })).status, 403);
      assert.equal((await amend(x.doc.token, { expectedVersion: 5, reason: "Wrong expected version here", content })).body.error.code, "STALE_VERSION");
      const ok = await amend(x.doc.token, { expectedVersion: 1, reason: "Added renal monitoring and NSAID advice", content });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.currentVersion, 2);
      const g = (await t.api("get", `/admissions/${adm.id}/discharge-summary`, x.doc.token)).body.data.document;
      assert.equal(g.status, "AMENDED");
      assert.equal(g.content.advice, "Added: avoid NSAIDs");
      assert.deepEqual(g.versions.map((v: { version: number; reason: string | null }) => [v.version, v.reason]), [[1, null], [2, "Added renal monitoring and NSAID advice"]]);
      assert.deepEqual((await t.api("get", `/admissions/${adm.id}/discharge-summary/versions/1`, x.doc.token)).body.data.content, original.content, "version 1 is untouched");
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge-summary/versions/9`, x.doc.token)).status, 404);
      const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => amend(x.doc.token, { expectedVersion: 2, reason: `Concurrent amendment number ${i}`, content: { ...content, advice: `Variant ${i}` } })));
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: x.tenant.tenantId, action: "DISCHARGE_SUMMARY_AMENDED" }, orderBy: { createdAt: "asc" } });
      assert.equal(evt.actorUserId, x.doc.userId);
    });

    it("clinical read access: doctors read, nurses cannot; amendments remain possible after discharge", async () => {
      const x = await world("dis-sm4");
      const { adm } = await admit(x, "0");
      await clearAll(x, adm.id);
      await sign(x, adm.id);
      await finalInvoice(x, adm.id);
      await complete(x, adm.id);
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge-summary`, x.nurse.token)).status, 403);
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge-summary`, x.doc.token)).status, 200);
      const r = await t.api("post", `/admissions/${adm.id}/discharge-summary/amend`, x.doc.token).send({ expectedVersion: 1, reason: "Corrected the follow-up date after discharge", content: { ...COURSE, followUp: { afterDays: 14 } } });
      assert.equal(r.status, 200);
    });
  });

  // ───────────────────────── settings and feature flags ─────────────────────────
  describe("settings and feature flags", () => {
    it("modules can be switched off per facility without code changes; settings are admin-only, validated and audited", async () => {
      const x = await world("dis-set");
      const { adm } = await admit(x);
      assert.equal((await t.api("get", "/settings/features", x.nurse.token)).body.data.NURSING_ENABLED, true);
      const put = (key: string, value: unknown, tok = x.tenant.admin.token) => t.api("put", `/settings/${key}`, tok).send({ value });
      assert.equal((await put("NURSING_ENABLED", false, x.doc.token)).status, 403);
      assert.equal((await put("NURSING_ENABLED", "no")).status, 400);
      assert.equal((await put("NOT_A_SETTING", true)).status, 404);
      assert.equal((await put("DISCHARGE_REQUIRED_STEPS", ["NURSING", "NURSING"])).status, 400);
      assert.equal((await put("DISCHARGE_REQUIRED_STEPS", ["MEDICALLY_FIT"])).status, 400, "fitness is implicit, not configurable");
      assert.equal((await put("BED_AFTER_DISCHARGE", "OCCUPIED")).status, 400);
      assert.equal((await put("NURSING_ENABLED", false)).status, 200);
      const off = await t.api("get", "/nursing/worklist", x.nurse.token);
      assert.equal(off.status, 403);
      assert.equal(off.body.error.code, "FEATURE_DISABLED");
      assert.equal((await t.api("post", `/admissions/${adm.id}/notes`, x.nurse.token).send({ note: "Should not be allowed" })).body.error.code, "FEATURE_DISABLED");
      assert.equal((await t.api("get", "/settings/features", x.nurse.token)).body.data.NURSING_ENABLED, false);
      assert.equal((await t.api("get", "/admissions", x.rec.token)).status, 200, "other modules unaffected");
      assert.equal((await put("PHARMACY_ENABLED", false)).status, 200);
      assert.equal((await t.api("get", "/pharmacy/stock", x.pharm.token)).body.error.code, "FEATURE_DISABLED");
      assert.equal((await t.api("get", "/medicines", x.doc.token)).status, 200, "the medicine master used by prescribers stays available");
      assert.equal((await put("IPD_ENABLED", false)).status, 200);
      assert.equal((await t.api("get", "/admissions", x.rec.token)).body.error.code, "FEATURE_DISABLED");
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge`, x.doc.token)).body.error.code, "FEATURE_DISABLED");
      assert.equal((await put("NURSING_ENABLED", true)).status, 200);
      assert.equal((await t.api("get", "/nursing/worklist", x.nurse.token)).status, 200, "re-enabling restores access");
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: x.tenant.tenantId, action: "SETTING_CHANGED", entityId: "NURSING_ENABLED" }, orderBy: { createdAt: "asc" } });
      assert.deepEqual({ from: (evt.metadata as { from: unknown }).from, to: (evt.metadata as { to: unknown }).to }, { from: true, to: false });
      const list = (await t.api("get", "/settings", x.tenant.admin.token)).body.data as { key: string; isDefault: boolean }[];
      assert.equal(list.find((s) => s.key === "IPD_ENABLED")!.isDefault, false);
      assert.equal(list.find((s) => s.key === "BED_AFTER_DISCHARGE")!.isDefault, true);
      assert.equal((await t.api("get", "/settings", x.doc.token)).status, 403);
    });

    it("settings are per facility and per tenant: switching a module off elsewhere changes nothing here", async () => {
      const y = await world("dis-set2");
      await t.api("put", "/settings/IPD_ENABLED", y.tenant.admin.token).send({ value: false });
      assert.equal((await t.api("get", "/admissions", w.rec.token)).status, 200, "another tenant is unaffected");
      const f2 = await t.makeUser(y.tenant, ["RECEPTIONIST"], { facilityIds: [y.tenant.facility2Id] });
      assert.equal((await t.api("get", "/admissions", f2.token)).status, 200, "another facility of the same tenant is unaffected");
      assert.equal((await t.api("get", "/admissions", y.rec.token)).body.error.code, "FEATURE_DISABLED");
    });

    it("print settings accept a logo image only as a bounded PNG/JPEG data URL; invalid GSTIN or header is rejected", async () => {
      const x = await world("dis-prt");
      const put = (key: string, value: unknown) => t.api("put", `/settings/${key}`, x.tenant.admin.token).send({ value });
      const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      assert.equal((await put("PRINT_HEADER", { hospitalName: "Sunrise Nursing Home", address: "12 Park Street, Kolkata", phone: "033 2222 3333", gstin: "19ABCDE1234F1Z5", logoDataUrl: png })).status, 200);
      for (const bad of [{ hospitalName: "X" }, { hospitalName: "Ok Name", gstin: "BAD" }, { hospitalName: "Ok Name", logoDataUrl: "data:text/html;base64,PHNjcmlwdD4=" }, { hospitalName: "Ok Name", logoDataUrl: "http://evil.example/x.png" }, { hospitalName: "Ok Name", extra: 1 }]) {
        assert.equal((await put("PRINT_HEADER", bad)).status, 400, JSON.stringify(bad).slice(0, 60));
      }
      assert.equal((await put("PRINT_FOOTER", { invoice: "Thank you. Subject to Kolkata jurisdiction." })).status, 200);
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: x.tenant.tenantId, action: "SETTING_CHANGED", entityId: "PRINT_HEADER" } });
      assert.ok(!JSON.stringify(evt.metadata).includes("base64"), "the logo is not copied into the audit log");
    });
  });
});
