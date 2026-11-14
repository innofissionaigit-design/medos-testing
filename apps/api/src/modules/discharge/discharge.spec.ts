import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

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
    // The patient keeps the bed until they actually leave; confirming the departure releases it for cleaning.
    assert.equal(await t.prisma.bedAssignment.count({ where: { admissionId: adm.id, releasedAt: null } }), 1, "the bed is kept until the patient leaves");
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed2.id } })).status, "OCCUPIED");
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/departure`, x.nurse.token).send({ mode: "WHEELCHAIR" })).status, 200, "the nurse sees the patient out");
    assert.equal(await t.prisma.bedAssignment.count({ where: { admissionId: adm.id, releasedAt: null } }), 0);
    assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed2.id } })).status, "CLEANING", "the vacated bed is released for cleaning");
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

  describe("laboratory / radiology clearance: pending services and charges", () => {
    const labRow = async (x: World, admId: string) => (await status(x, admId)).steps.find((s: { step: string }) => s.step === "LAB_RADIOLOGY");
    const chk = (r: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) => r.checks.find((c) => c.name === name)!;
    const svcOf = async (x: World, name: string) => (await t.api("post", "/services", x.tenant.admin.token).send({ code: code("L"), name, category: "INVESTIGATION", price: "250", taxPercent: 0 })).body.data as { id: string; name: string };
    /** A test the doctor advised on this admission: not billed yet. */
    const order = async (x: World, adm: { encounterId: string }, patientId: string, category: "LABORATORY" | "RADIOLOGY" | "CARDIOLOGY", name: string) =>
      t.prisma.testOrder.create({ data: { tenantId: x.tenant.tenantId, facilityId: x.tenant.facilityId, patientId, encounterId: adm.encounterId, category, name, orderedById: x.doc.userId } });
    const bill = (x: World, adm: { encounterId: string }, orderId: string, serviceId: string) => t.api("post", "/test-orders/bill", x.cashier.token).send({ encounterId: adm.encounterId, orders: [{ orderId, serviceId }] });

    it("owned by the relevant departments; pending until the doctor has decided; with nothing ordered it reconciles by itself", async () => {
      const x = await world("dis-lr-stage");
      const { adm } = await admit(x);
      const before = await labRow(x, adm.id);
      assert.equal(before.stage, "Laboratory / radiology");
      assert.equal(before.responsible, "Relevant departments");
      assert.equal(before.status, "PENDING");
      assert.equal(before.hisStatus, "Pending services or charges not yet reconciled");
      assert.deepEqual(before.checks.map((c: { name: string }) => c.name), ["Laboratory", "Radiology", "Charges"]);
      assert.equal(before.automatic, true, "nobody clicks it: it reconciles itself");
      assert.equal(before.waivable, true);
      assert.equal(before.required, true, "required by default");

      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const after = await labRow(x, adm.id);
      assert.equal(after.status, "CLEARED");
      assert.equal(after.hisStatus, "Pending services and charges reconciled");
      assert.equal(after.note, "No laboratory or radiology tests ordered");
      assert.equal(after.checks.every((c: { ok: boolean }) => c.ok), true);
    });

    it("a test that is not billed, or billed but not performed, is a pending charge or service: it blocks, and the cashier can take an unneeded one off", async () => {
      const x = await world("dis-lr-pending");
      const { adm, patient } = await admit(x);
      await clearAll(x, adm.id);
      assert.equal((await labRow(x, adm.id)).status, "CLEARED");
      const cbc = await svcOf(x, `CBC ${uniqueWord(4)}`); const xr = await svcOf(x, `Chest X-ray ${uniqueWord(4)}`);
      const lab = await order(x, adm, patient.id, "LABORATORY", cbc.name);
      const rad = await order(x, adm, patient.id, "RADIOLOGY", xr.name);
      await order(x, adm, patient.id, "CARDIOLOGY", `ECG ${uniqueWord(4)}`); // another kind of test: not this stage's business

      const open = await labRow(x, adm.id);
      assert.equal(open.status, "PENDING", "no longer clears itself");
      assert.equal(chk(open, "Laboratory").ok, false);
      assert.match(chk(open, "Laboratory").detail, new RegExp(`0 of 1 test\\(s\\) resulted · waiting: ${cbc.name}`));
      assert.match(chk(open, "Radiology").detail, /0 of 1 study\(ies\) reported/);
      assert.equal(chk(open, "Charges").ok, false);
      assert.match(chk(open, "Charges").detail, /2 test\(s\) not yet billed/);
      assert.ok(open.blockers.some((b: string) => /ordered but not yet billed/.test(b)));
      const st = await status(x, adm.id);
      assert.equal(st.canComplete, false);
      assert.ok(st.blockers.includes("lab radiology not cleared"), JSON.stringify(st.blockers));
      const fb = await finalInvoice(x, adm.id);
      assert.equal(fb.status, 409);
      assert.match(fb.body.error.message, /Clear these steps before billing: .*lab radiology/);

      // The cashier bills the X-ray and marks the blood test "not needed": the charges are settled, the X-ray is still to be done.
      assert.equal((await bill(x, adm, rad.id, xr.id)).status, 201);
      assert.equal((await t.api("post", `/test-orders/${lab.id}/cancel`, x.cashier.token).send({ reason: "Done at another lab" })).status, 200);
      const half = await labRow(x, adm.id);
      assert.equal(chk(half, "Charges").ok, true);
      assert.equal(chk(half, "Laboratory").ok, true, "the cancelled blood test no longer counts");
      assert.equal(chk(half, "Radiology").ok, false);
      assert.match(chk(half, "Radiology").detail, /0 of 1 study\(ies\) reported · waiting/);
      assert.equal(half.status, "PENDING");
      assert.ok(half.blockers.some((b: string) => /radiology study not yet reported/.test(b)));
    });

    it("performed and billed tests reconcile it by themselves: a verified laboratory result and a signed radiology report", async () => {
      const x = await world("dis-lr-done");
      const lt = await t.makeUser(x.tenant, ["LAB_TECHNICIAN"]); const path = await t.makeUser(x.tenant, ["PATHOLOGIST"]);
      const rg = await t.makeUser(x.tenant, ["RADIOGRAPHER"]); const rl = await t.makeUser(x.tenant, ["RADIOLOGIST"]);
      const { adm, patient } = await admit(x);
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const cbc = await svcOf(x, `CBC ${uniqueWord(4)}`); const xr = await svcOf(x, `Chest X-ray ${uniqueWord(4)}`);
      assert.equal((await t.api("put", `/lab/tests/${cbc.id}`, path.token).send({ specimen: "Blood (EDTA)", turnaroundHours: 4, parameters: [{ name: "Remark", type: "TEXT", decimals: 0 }] })).status, 200);
      const lab = await order(x, adm, patient.id, "LABORATORY", cbc.name);
      const rad = await order(x, adm, patient.id, "RADIOLOGY", xr.name);
      assert.equal((await bill(x, adm, lab.id, cbc.id)).status, 201);
      assert.equal((await bill(x, adm, rad.id, xr.id)).status, 201);

      const billedOnly = await labRow(x, adm.id);
      assert.equal(billedOnly.status, "PENDING", "billed but not performed: a pending service");
      assert.equal(chk(billedOnly, "Charges").ok, true);
      assert.ok(billedOnly.blockers.some((b: string) => /laboratory result not yet verified/.test(b)) && billedOnly.blockers.some((b: string) => /radiology study not yet reported/.test(b)));

      assert.equal((await t.api("post", `/lab/orders/${lab.id}/sample`, lt.token).send({})).status, 201);
      const rv = (await t.api("get", `/lab/orders/${lab.id}/result`, lt.token)).body.data as { resultId: string; version: number; parameters: { id: string }[] };
      const dr = await t.api("put", `/lab/results/${rv.resultId}/draft`, lt.token).send({ version: rv.version, values: [{ parameterId: rv.parameters[0]!.id, value: "Normocytic" }] });
      assert.equal(dr.status, 200, JSON.stringify(dr.body));
      assert.equal((await labRow(x, adm.id)).status, "PENDING", "a draft result is not a result yet");
      assert.equal((await t.api("post", `/lab/results/${rv.resultId}/verify`, path.token).send({ version: dr.body.data.version })).status, 200);
      const mid = await labRow(x, adm.id);
      assert.equal(chk(mid, "Laboratory").ok, true);
      assert.match(chk(mid, "Laboratory").detail, /1 of 1 test\(s\) resulted/);
      assert.equal(mid.status, "PENDING", "the X-ray is still outstanding");

      const study = await t.api("post", `/rad/orders/${rad.id}/study`, rg.token).send({ modality: "XRAY", bodyPart: "Chest PA" });
      assert.equal(study.status, 201, JSON.stringify(study.body));
      assert.equal((await labRow(x, adm.id)).status, "PENDING", "performed but not reported");
      assert.equal((await t.api("post", `/rad/studies/${study.body.data.id}/report`, rl.token).send({ findings: "Clear lung fields.", impression: "Normal chest radiograph", critical: false })).status, 200);

      const done = await labRow(x, adm.id);
      assert.equal(done.status, "CLEARED");
      assert.equal(done.hisStatus, "Pending services and charges reconciled");
      assert.equal(done.note, "Every test performed, reported and billed");
      assert.match(chk(done, "Radiology").detail, /1 of 1 study\(ies\) reported/);
      assert.match(chk(done, "Charges").detail, /All 2 test\(s\) billed/);
    });

    it("counts the patient's tests ordered since admission from any visit, and ignores older ones", async () => {
      const x = await world("dis-lr-scope");
      const { adm, patient } = await admit(x);
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      assert.equal((await labRow(x, adm.id)).status, "CLEARED");

      // A test from before the admission (an old outpatient visit) is not part of this stay.
      const oldVisit = await startVisit(t, x.rec.token, x.doc, patient.id);
      const old = await order(x, { encounterId: oldVisit.encounterId }, patient.id, "LABORATORY", `Old CBC ${uniqueWord(4)}`);
      await t.prisma.testOrder.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 30 * 86_400_000) } });
      assert.equal((await labRow(x, adm.id)).status, "CLEARED", "a month-old test is not this stay's");

      // A test ordered at a visit during the stay is.
      await order(x, { encounterId: oldVisit.encounterId }, patient.id, "RADIOLOGY", `Chest X-ray ${uniqueWord(4)}`);
      const now = await labRow(x, adm.id);
      assert.equal(now.status, "PENDING");
      assert.match(chk(now, "Radiology").detail, /0 of 1 study\(ies\) reported/);
      assert.equal(chk(now, "Laboratory").detail, "No laboratory tests ordered");
    });


    it("the treating doctor or the RMO orders a test from the admission; the cashier bills it, the departments perform it, and the stage follows each step", async () => {
      const x = await world("dis-lr-order");
      const rmo = await t.makeUser(x.tenant, ["RMO"]);
      await t.prisma.practitioner.create({ data: { tenantId: x.tenant.tenantId, facilityId: x.tenant.facilityId, userId: rmo.id, displayName: `Dr. ${uniqueWord(6)} (RMO)`, scheduleSet: true } });
      const lt = await t.makeUser(x.tenant, ["LAB_TECHNICIAN"]); const path = await t.makeUser(x.tenant, ["PATHOLOGIST"]);
      const { adm } = await admit(x);
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const cbc = await svcOf(x, `CBC ${uniqueWord(4)}`);
      assert.equal((await t.api("put", `/lab/tests/${cbc.id}`, path.token).send({ specimen: "Blood (EDTA)", turnaroundHours: 4, parameters: [{ name: "Remark", type: "TEXT", decimals: 0 }] })).status, 200);
      const post = (body: Record<string, unknown>, tok = x.doc.token) => t.api("post", `/admissions/${adm.id}/test-orders`, tok).send(body);
      const list = async () => (await t.api("get", `/admissions/${adm.id}/test-orders`, x.rec.token)).body.data as { id: string; name: string; category: string; state: string }[];

      assert.equal((await list()).length, 0);
      const o = await post({ category: "LABORATORY", name: cbc.name });
      assert.equal(o.status, 201, JSON.stringify(o.body));
      assert.equal(o.body.data.onPriceList, true, "matched to the price list by name");
      assert.equal(o.body.data.state, "TO_BE_BILLED");
      const xr = await post({ category: "RADIOLOGY", name: `Chest X-ray ${uniqueWord(4)}` }, rmo.token);
      assert.equal(xr.status, 201, "the RMO can order too");
      assert.equal(xr.body.data.onPriceList, false, "not on the price list: the cashier picks or types a price");

      assert.equal((await post({ category: "LABORATORY", name: cbc.name.toLowerCase() })).status, 409, "the same test twice is refused");
      assert.equal((await post({ category: "CARDIOLOGY", name: "ECG" })).status, 400, "only laboratory and radiology");
      assert.equal((await post({ category: "LABORATORY", name: "CBC", extra: 1 })).status, 400, "unknown fields are refused");
      assert.equal((await post({ category: "LABORATORY", name: "Urine routine" }, x.nurse.token)).status, 403, "a nurse cannot order");
      assert.equal((await post({ category: "LABORATORY", name: "Urine routine" }, x.cashier.token)).status, 403, "a cashier cannot order");
      const other = await world("dis-lr-order-b");
      assert.equal((await t.api("post", `/admissions/${adm.id}/test-orders`, other.doc.token).send({ category: "LABORATORY", name: "Urine routine" })).status, 404, "another hospital cannot see it");

      let row = await labRow(x, adm.id);
      assert.equal(row.status, "PENDING");
      assert.match(chk(row, "Charges").detail, /2 test\(s\) not yet billed/);
      assert.deepEqual((await list()).map((i) => i.state), ["TO_BE_BILLED", "TO_BE_BILLED"]);

      const orderId = o.body.data.id as string;
      assert.equal((await bill(x, adm, orderId, cbc.id)).status, 201);
      assert.equal((await list()).find((i) => i.id === orderId)!.state, "WAITING_FOR_RESULT");
      assert.equal((await t.api("post", `/lab/orders/${orderId}/sample`, lt.token).send({})).status, 201);
      const rv = (await t.api("get", `/lab/orders/${orderId}/result`, lt.token)).body.data as { resultId: string; version: number; parameters: { id: string }[] };
      const dr = await t.api("put", `/lab/results/${rv.resultId}/draft`, lt.token).send({ version: rv.version, values: [{ parameterId: rv.parameters[0]!.id, value: "Normocytic" }] });
      assert.equal((await t.api("post", `/lab/results/${rv.resultId}/verify`, path.token).send({ version: dr.body.data.version })).status, 200);
      assert.equal((await list()).find((i) => i.id === orderId)!.state, "DONE");

      // The cashier takes the X-ray off ("not needed"): it no longer counts, and the stage reconciles by itself.
      assert.equal((await t.api("post", `/test-orders/${xr.body.data.id}/cancel`, x.cashier.token).send({ reason: "Not needed after the examination" })).status, 200);
      assert.equal((await list()).find((i) => i.id === xr.body.data.id)!.state, "NOT_NEEDED");
      row = await labRow(x, adm.id);
      assert.equal(row.status, "CLEARED");
      assert.equal(row.hisStatus, "Pending services and charges reconciled");

      // A closed admission takes no more orders.
      const done = await admit(x);
      await t.prisma.admission.update({ where: { id: done.adm.id }, data: { status: "DISCHARGED", dischargedAt: new Date(Date.now() + 1000), dischargeType: "ROUTINE" } });
      assert.equal((await t.api("post", `/admissions/${done.adm.id}/test-orders`, x.doc.token).send({ category: "LABORATORY", name: "CBC late" })).status, 409);
    });

    it("it cannot be cleared by hand; only a doctor can waive it, with a written reason, and a hospital can leave it out of the required steps", async () => {
      const x = await world("dis-lr-waive");
      const { adm, patient } = await admit(x);
      await clearAll(x, adm.id);
      const cbc = await svcOf(x, `CBC ${uniqueWord(4)}`);
      await order(x, adm, patient.id, "LABORATORY", cbc.name);
      assert.equal((await labRow(x, adm.id)).status, "PENDING");

      assert.equal((await clear(x, adm.id, "LAB_RADIOLOGY", x.nurse.token)).status, 400, "there is no Clear for this stage");
      const waive = (reason: string, tok = x.doc.token) => t.api("post", `/admissions/${adm.id}/discharge/waive`, tok).send({ step: "LAB_RADIOLOGY", reason });
      assert.equal((await waive("Test no longer needed", x.nurse.token)).status, 403, "a nurse cannot waive");
      assert.equal((await waive("short")).status, 400, "a real reason is needed");
      assert.equal((await waive("Patient had the blood test at an outside laboratory")).status, 200);
      const w = await labRow(x, adm.id);
      assert.equal(w.status, "WAIVED");
      assert.equal(w.hisStatus, "Laboratory / radiology clearance waived");
      assert.match(w.note, /outside laboratory/);

      // A hospital that does not want this stage can drop it from the required steps; a pending test then no longer blocks discharge.
      const y = await world("dis-lr-optional");
      const a2 = await admit(y);
      await clearAll(y, a2.adm.id);
      await order(y, a2.adm, a2.patient.id, "LABORATORY", `CBC ${uniqueWord(4)}`);
      assert.ok((await status(y, a2.adm.id)).blockers.includes("lab radiology not cleared"));
      assert.equal((await t.api("put", "/settings/DISCHARGE_REQUIRED_STEPS", y.tenant.admin.token).send({ value: ["NURSING", "CHARGES_REVIEWED", "PHARMACY", "BILLING"] })).status, 200);
      const opt = await status(y, a2.adm.id);
      assert.equal(opt.steps.find((s: { step: string }) => s.step === "LAB_RADIOLOGY").required, false);
      assert.ok(!opt.blockers.includes("lab radiology not cleared"));
      assert.equal((await t.api("put", "/settings/DISCHARGE_REQUIRED_STEPS", y.tenant.admin.token).send({ value: ["LAB_RADIOLOGY", "LAB_RADIOLOGY"] })).status, 400, "duplicates are refused");
    });
  });

  describe("OT / procedure clearance: procedure, implants and consumables finalised", () => {
    const otRow = async (x: World, admId: string) => (await status(x, admId)).steps.find((s: { step: string }) => s.step === "OT_PROCEDURE");
    const chk = (r: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) => r.checks.find((c) => c.name === name)!;
    const svc2 = async (x: World, name: string, category: string, price: string) => (await t.api("post", "/services", x.tenant.admin.token).send({ code: code("O"), name, category, price, taxPercent: 0 })).body.data as { id: string; name: string };
    const setUpOt = async (label: string) => {
      const x = await world(label);
      const coord = await t.makeUser(x.tenant, ["OT_COORDINATOR"]);
      const appen = await svc2(x, `Appendectomy ${uniqueWord(4)}`, "PROCEDURE", "15000");
      const plate = await svc2(x, `Plate ${uniqueWord(4)}`, "OTHER", "8500"); const kit = await svc2(x, `Kit ${uniqueWord(4)}`, "OTHER", "1800");
      const { adm } = await admit(x);
      const plan = async () => (await t.api("post", `/admissions/${adm.id}/procedures`, x.doc.token).send({ serviceId: appen.id })).body.data.id as string;
      const perform = (pid: string) => t.api("post", `/procedures/${pid}/perform`, coord.token).send({});
      const finalise = (pid: string) => t.api("post", `/procedures/${pid}/finalise`, coord.token);
      const addItem = (pid: string, body: Record<string, unknown>) => t.api("post", `/procedures/${pid}/items`, coord.token).send(body);
      return { x, coord, appen, plate, kit, adm, plan, perform, finalise, addItem };
    };

    it("owned by the OT / procedure coordinator; pending until the doctor has decided; with no procedures it reconciles by itself", async () => {
      const { x, adm } = await setUpOt("dis-ot-stage");
      const before = await otRow(x, adm.id);
      assert.equal(before.stage, "OT / procedure");
      assert.equal(before.responsible, "OT / procedure coordinator");
      assert.equal(before.status, "PENDING");
      assert.equal(before.hisStatus, "Procedure, implants or consumables not yet finalised");
      assert.deepEqual(before.checks.map((c: { name: string }) => c.name), ["Procedure", "Implants", "Consumables"]);
      assert.equal(before.automatic, true);
      assert.equal(before.waivable, true);
      assert.equal(before.required, true, "required by default");

      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const after = await otRow(x, adm.id);
      assert.equal(after.status, "CLEARED");
      assert.equal(after.hisStatus, "Procedure, implants and consumables finalised");
      assert.equal(after.note, "No procedures planned");
      assert.equal(after.checks.every((c: { ok: boolean }) => c.ok), true);
    });

    it("a planned or performed procedure keeps it pending; finalising it, with its implants and consumables, clears it by itself", async () => {
      const o = await setUpOt("dis-ot-flow");
      const { x, adm } = o;
      await clearAll(x, adm.id);
      assert.equal((await otRow(x, adm.id)).status, "CLEARED");
      const pid = await o.plan();

      const planned = await otRow(x, adm.id);
      assert.equal(planned.status, "PENDING", "no longer clears itself");
      assert.equal(chk(planned, "Procedure").ok, false);
      assert.match(chk(planned, "Procedure").detail, /0 of 1 procedure\(s\) finalised · waiting: Appendectomy/);
      assert.ok(planned.blockers.some((b: string) => /planned but not yet performed/.test(b)));
      const st = await status(x, adm.id);
      assert.equal(st.canComplete, false);
      assert.ok(st.blockers.includes("ot procedure not cleared"), JSON.stringify(st.blockers));
      const fb = await finalInvoice(x, adm.id);
      assert.equal(fb.status, 409);
      assert.match(fb.body.error.message, /Clear these steps before billing: .*ot procedure/);

      assert.equal((await o.perform(pid)).status, 200);
      const imp = await o.addItem(pid, { kind: "IMPLANT", serviceId: o.plate.id, quantity: 1, serialNo: "SN-77-1020" });
      assert.equal(imp.status, 201, JSON.stringify(imp.body));
      assert.equal((await o.addItem(pid, { kind: "CONSUMABLE", serviceId: o.kit.id, quantity: 2 })).status, 201);
      const performed = await otRow(x, adm.id);
      assert.equal(performed.status, "PENDING", "performed is not finalised");
      assert.ok(performed.blockers.some((b: string) => /performed but not yet finalised/.test(b)));
      assert.match(chk(performed, "Implants").detail, /0 of 1 implant\(s\) recorded, charged and finalised/);
      assert.match(chk(performed, "Consumables").detail, /0 of 1 consumable\(s\) recorded, charged and finalised/);

      assert.equal((await o.finalise(pid)).status, 200);
      const done = await otRow(x, adm.id);
      assert.equal(done.status, "CLEARED");
      assert.equal(done.hisStatus, "Procedure, implants and consumables finalised");
      assert.equal(done.note, "Every procedure finalised");
      assert.equal(done.checks.every((c: { ok: boolean }) => c.ok), true);
      assert.match(chk(done, "Procedure").detail, /1 of 1 procedure\(s\) finalised/);
      assert.match(chk(done, "Implants").detail, /1 of 1 implant\(s\) recorded, charged and finalised/);
      assert.match(chk(done, "Consumables").detail, /1 of 1 consumable\(s\) recorded, charged and finalised/);

      // The charges flow into the final bill: the procedure, the implant and the consumables.
      const bill = await finalInvoice(x, adm.id);
      assert.equal(bill.status, 200, JSON.stringify(bill.body));
      const lines = await t.prisma.charge.findMany({ where: { admissionId: adm.id, status: "BILLED", OR: [{ sourceKey: { startsWith: "PROCEDURE:" } }, { sourceKey: { startsWith: "PROCEDURE_ITEM:" } }] } });
      assert.equal(lines.length, 3);
      assert.equal(lines.reduce((n, c) => n + Number(c.unitPrice) * Number(c.quantity), 0), 15000 + 8500 + 3600);

      // After the final bill the record takes no more changes.
      const late = await t.api("post", `/admissions/${adm.id}/procedures`, x.doc.token).send({ serviceId: o.appen.id });
      assert.equal(late.status, 409);
      assert.match(late.body.error.message, /final bill has already been issued/);
    });

    it("a cancelled procedure does not count; a finalised procedure whose charge is later voided is flagged", async () => {
      const o = await setUpOt("dis-ot-charge");
      const { x, adm } = o;
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const cancelled = await o.plan();
      assert.equal((await otRow(x, adm.id)).status, "PENDING");
      assert.equal((await t.api("post", `/procedures/${cancelled}/cancel`, x.doc.token).send({ reason: "Patient refused the operation" })).status, 200);
      assert.equal((await otRow(x, adm.id)).status, "CLEARED", "a cancelled procedure no longer counts");

      const pid = await o.plan();
      await o.perform(pid);
      await o.addItem(pid, { kind: "IMPLANT", serviceId: o.plate.id, quantity: 1, serialNo: "SN-5-5555" });
      assert.equal((await o.finalise(pid)).status, 200);
      assert.equal((await otRow(x, adm.id)).status, "CLEARED");
      await t.prisma.charge.updateMany({ where: { admissionId: adm.id, sourceKey: `PROCEDURE:${pid}` }, data: { status: "VOIDED", voidReason: "Test: voided at billing by mistake", voidedById: x.cashier.id, voidedAt: new Date() } });
      const bad = await otRow(x, adm.id);
      assert.equal(bad.status, "PENDING");
      assert.ok(bad.blockers.some((b: string) => /its charge is missing or voided/.test(b)), JSON.stringify(bad.blockers));
    });

    it("it has no Clear; only a doctor can waive it, with a written reason; a hospital can leave it out of the required steps", async () => {
      const o = await setUpOt("dis-ot-waive");
      const { x, adm } = o;
      await clearAll(x, adm.id);
      await o.plan();
      assert.equal((await otRow(x, adm.id)).status, "PENDING");
      assert.equal((await clear(x, adm.id, "OT_PROCEDURE", o.coord.token)).status, 400, "there is no Clear for this stage");
      const waive = (reason: string, tok = x.doc.token) => t.api("post", `/admissions/${adm.id}/discharge/waive`, tok).send({ step: "OT_PROCEDURE", reason });
      assert.equal((await waive("Operation moved to another hospital", o.coord.token)).status, 403, "the coordinator cannot waive");
      assert.equal((await waive("short")).status, 400, "a real reason is needed");
      assert.equal((await waive("Operation moved to another hospital")).status, 200);
      const w = await otRow(x, adm.id);
      assert.equal(w.status, "WAIVED");
      assert.equal(w.hisStatus, "OT / procedure clearance waived");
      assert.match(w.note, /another hospital/);

      const y = await setUpOt("dis-ot-optional");
      await clearAll(y.x, y.adm.id);
      await y.plan();
      assert.ok((await status(y.x, y.adm.id)).blockers.includes("ot procedure not cleared"));
      assert.equal((await t.api("put", "/settings/DISCHARGE_REQUIRED_STEPS", y.x.tenant.admin.token).send({ value: ["NURSING", "CHARGES_REVIEWED", "PHARMACY", "LAB_RADIOLOGY", "BILLING"] })).status, 200);
      const opt = await status(y.x, y.adm.id);
      assert.equal(opt.steps.find((s: { step: string }) => s.step === "OT_PROCEDURE").required, false);
      assert.ok(!opt.blockers.includes("ot procedure not cleared"));
    });
  });

  describe("insurance clearance: documentation submitted, authorisation tracked", () => {
    const insRow = async (x: World, admId: string) => (await status(x, admId)).steps.find((s: { step: string }) => s.step === "INSURANCE");
    const chk = (r: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) => r.checks.find((c) => c.name === name)!;
    const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    const PDF = Buffer.from("%PDF-1.4 not really a pdf");
    const setUpIns = async (label: string, withPolicy = true) => {
      const x = await world(label);
      const officer = await t.makeUser(x.tenant, ["CLAIMS_OFFICER"]);
      const insurer = (await t.api("post", "/claims/insurers", officer.token).send({ name: `TPA ${uniqueWord(6)}`, kind: "TPA" })).body.data as { id: string };
      const { adm, patient } = await admit(x);
      const addPolicy = async (over: Record<string, unknown> = {}) => (await t.api("post", `/patients/${patient.id}/policies`, officer.token).send({ insurerId: insurer.id, policyNumber: `POL-${uniqueWord(6)}`, validFrom: iso(-30), validTo: iso(300), sumInsured: "500000", ...over })).body.data as { id: string };
      const policy = withPolicy ? await addPolicy() : null;
      const open = async (type = "CASHLESS", policyId = policy!.id) => { const r = await t.api("post", "/claims", officer.token).send({ patientId: patient.id, policyId, type, encounterId: adm.encounterId }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data.id as string; };
      const attach = (claimId: string, label = "Discharge summary") => t.api("post", `/claims/${claimId}/documents`, officer.token).query({ filename: "discharge.pdf", label }).set("Content-Type", "application/pdf").send(PDF);
      const post = (claimId: string, path: string, body: Record<string, unknown>) => t.api("post", `/claims/${claimId}/${path}`, officer.token).send(body);
      return { x, officer, insurer, adm, patient, policy, open, attach, post, addPolicy };
    };

    it("owned by the TPA desk and the external payer; a patient with no insurance is self-pay and it clears by itself once the doctor has decided", async () => {
      const { x, adm } = await setUpIns("dis-ins-self", false);
      const before = await insRow(x, adm.id);
      assert.equal(before.stage, "Insurance");
      assert.equal(before.responsible, "TPA desk + external payer");
      assert.equal(before.status, "PENDING");
      assert.equal(before.hisStatus, "Insurance documents or authorisation not yet complete");
      assert.deepEqual(before.checks.map((c: { name: string }) => c.name), ["Documentation", "Authorisation"]);
      assert.equal(before.automatic, true);
      assert.equal(before.waivable, true);
      assert.equal(before.required, true, "required by default");
      assert.equal((await status(x, adm.id)).steps.length, 9);

      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const after = await insRow(x, adm.id);
      assert.equal(after.status, "CLEARED");
      assert.equal(after.hisStatus, "Not applicable: self-pay patient");
      assert.equal(after.note, "Not insured (self-pay)");
      assert.equal(after.reconciliation.insured, false);
      assert.equal(after.reconciliation.claim, null);
    });

    it("a patient with a valid policy but no claim is pending; there is no Clear; a doctor can waive it for a patient who pays themselves", async () => {
      const s = await setUpIns("dis-ins-noclaim");
      const { x, adm } = s;
      await clearAll(x, adm.id);
      const row = await insRow(x, adm.id);
      assert.equal(row.status, "PENDING");
      assert.equal(chk(row, "Documentation").ok, false);
      assert.equal(row.reconciliation.insured, true);
      assert.equal(row.reconciliation.validPolicies, 1);
      assert.ok(row.blockers.some((b: string) => /Insurance claim not started/.test(b)), JSON.stringify(row.blockers));
      const st = await status(x, adm.id);
      assert.equal(st.canComplete, false);
      assert.ok(st.blockers.includes("insurance not cleared"), JSON.stringify(st.blockers));
      const fb = await finalInvoice(x, adm.id);
      assert.equal(fb.status, 409);
      assert.match(fb.body.error.message, /Clear these steps before billing: .*insurance/);

      assert.equal((await clear(x, adm.id, "INSURANCE", s.officer.token)).status, 400, "there is no Clear for this stage");
      const waive = (reason: string, tok = x.doc.token) => t.api("post", `/admissions/${adm.id}/discharge/waive`, tok).send({ step: "INSURANCE", reason });
      assert.equal((await waive("Patient will pay in cash", s.officer.token)).status, 403, "the TPA desk cannot waive");
      assert.equal((await waive("short")).status, 400, "a real reason is needed");
      assert.equal((await waive("Patient chose to pay in cash")).status, 200);
      const w = await insRow(x, adm.id);
      assert.equal(w.status, "WAIVED");
      assert.equal(w.hisStatus, "Insurance clearance waived (self-pay)");
      assert.match(w.note, /pay in cash/);
    });

    it("a cashless claim: documents attached, authorisation requested and answered; each missing piece keeps it pending and says what is missing", async () => {
      const s = await setUpIns("dis-ins-cashless");
      const { x, adm } = s;
      await clearAll(x, adm.id);
      const claimId = await s.open("CASHLESS");

      const draft = await insRow(x, adm.id);
      assert.equal(draft.status, "PENDING");
      assert.equal(draft.reconciliation.claim.status, "DRAFT");
      assert.equal(chk(draft, "Documentation").detail, "No documents are attached to the claim yet");
      assert.equal(chk(draft, "Authorisation").detail, "Pre-authorisation has not been requested");
      assert.ok(draft.blockers.some((b: string) => b.includes("Pre-authorisation has not been requested")));

      assert.equal((await s.attach(claimId)).status, 201);
      assert.equal((await s.attach(claimId, "Policy card")).status, 201);
      const withDocs = await insRow(x, adm.id);
      assert.equal(withDocs.status, "PENDING");
      assert.equal(withDocs.reconciliation.claim.documents, 2);
      assert.match(chk(withDocs, "Documentation").detail, /2 document\(s\) attached, but nothing has been sent to the insurer yet/);
      assert.equal(chk(withDocs, "Documentation").ok, false, "documents that have not been sent are not documentation submitted");

      assert.equal((await s.post(claimId, "preauth", { requestedAmount: "50000" })).status, 200);
      const asked = await insRow(x, adm.id);
      assert.equal(asked.status, "PENDING");
      assert.equal(chk(asked, "Documentation").ok, true);
      assert.match(chk(asked, "Documentation").detail, /2 document\(s\) attached and sent for authorisation/);
      assert.equal(chk(asked, "Authorisation").ok, false);
      assert.match(chk(asked, "Authorisation").detail, /Waiting for the insurer's decision on 50000\.00/);
      assert.equal((await finalInvoice(x, adm.id)).status, 409, "no final bill while the authorisation is open");

      assert.equal((await s.post(claimId, "preauth-decision", { decision: "APPROVE", amount: "40000" })).status, 200);
      const done = await insRow(x, adm.id);
      assert.equal(done.status, "CLEARED");
      assert.equal(done.hisStatus, "Documentation submitted; authorisation tracked");
      assert.match(done.note, /^Claim .+ \(preauth approved\)$/);
      assert.equal(done.checks.every((c: { ok: boolean }) => c.ok), true);
      assert.match(chk(done, "Authorisation").detail, /Pre-authorisation approved for 40000\.00 \(asked 50000\.00\)/);
      assert.equal(done.reconciliation.claim.preauthApproved, "40000.00");
      assert.equal(done.reconciliation.claim.documents, 2);

      // The claim is submitted against an issued invoice and the insurer raises a query: the stage goes back to pending until the desk answers it.
      const inv = await t.api("post", "/invoices", x.cashier.token).send({ patientId: s.patient.id, lines: [{ description: "Package", unitPrice: "40000", taxPercent: 0, quantity: 1 }] });
      assert.equal(inv.status, 201, JSON.stringify(inv.body));
      assert.equal((await t.api("post", `/invoices/${inv.body.data.id}/issue`, x.cashier.token)).status, 200);
      assert.equal((await s.post(claimId, "submit", { invoiceId: inv.body.data.id, claimedAmount: "40000" })).status, 200);
      assert.equal((await insRow(x, adm.id)).status, "CLEARED", "submitted and authorised");
      assert.equal((await s.post(claimId, "query", { note: "Send the final bill with the stamp" })).status, 200);
      const queried = await insRow(x, adm.id);
      assert.equal(queried.status, "PENDING");
      assert.match(chk(queried, "Authorisation").detail, /query that is not yet answered/);
      assert.equal((await s.post(claimId, "resubmit", { note: "Stamped bill attached" })).status, 200);
      assert.equal((await insRow(x, adm.id)).status, "CLEARED");

      // A removed document stops counting.
      const docs = (await t.api("get", `/claims/${claimId}/documents`, s.officer.token)).body.data as { id: string }[];
      for (const d of docs) assert.equal((await t.api("post", `/claim-documents/${d.id}/remove`, s.officer.token).send({ reason: "Wrong files attached" })).status, 200);
      assert.equal((await insRow(x, adm.id)).status, "PENDING", "no documents left");
    });

    it("an authorisation the insurer rejected is tracked: the stage clears and says the patient pays", async () => {
      const s = await setUpIns("dis-ins-reject");
      const { x, adm } = s;
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const claimId = await s.open("CASHLESS");
      assert.equal((await insRow(x, adm.id)).status, "PENDING");
      await s.attach(claimId);
      await s.post(claimId, "preauth", { requestedAmount: "30000" });
      assert.equal((await s.post(claimId, "preauth-decision", { decision: "REJECT", reason: "Waiting period not over" })).status, 200);
      const r = await insRow(x, adm.id);
      assert.equal(r.status, "CLEARED");
      assert.equal(r.note, "Insurer rejected the claim: self-pay");
      assert.match(chk(r, "Authorisation").detail, /Rejected by the insurer: Waiting period not over; the patient pays as self-pay/);
    });

    it("a reimbursement claim needs no authorisation: its documents are collected now and filed after the final bill", async () => {
      const s = await setUpIns("dis-ins-reimb");
      const { x, adm } = s;
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const claimId = await s.open("REIMBURSEMENT");
      const empty = await insRow(x, adm.id);
      assert.equal(empty.status, "PENDING");
      assert.equal(chk(empty, "Authorisation").ok, true);
      assert.equal(chk(empty, "Authorisation").detail, "Reimbursement claim: no pre-authorisation is needed");
      assert.equal(chk(empty, "Documentation").ok, false);
      await s.attach(claimId);
      const done = await insRow(x, adm.id);
      assert.equal(done.status, "CLEARED");
      assert.match(chk(done, "Documentation").detail, /1 document\(s\) collected; the claim is filed after the final bill/);
    });

    it("a closed claim is no longer live: with a valid policy the stage goes back to needing a claim", async () => {
      const s = await setUpIns("dis-ins-closed");
      const { x, adm } = s;
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const claimId = await s.open("REIMBURSEMENT");
      await s.attach(claimId);
      assert.equal((await insRow(x, adm.id)).status, "CLEARED");
      assert.equal((await s.post(claimId, "close", { reason: "Patient withdrew the claim" })).status, 200);
      const row = await insRow(x, adm.id);
      assert.equal(row.status, "PENDING");
      assert.equal(row.reconciliation.claim, null);
      assert.ok(row.blockers.some((b: string) => /Insurance claim not started/.test(b)));
    });

    it("a policy that has expired or been switched off does not make the patient insured", async () => {
      const s = await setUpIns("dis-ins-expired", false);
      const { x, adm } = s;
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const old = await s.addPolicy({ validFrom: iso(-400), validTo: iso(-10) });
      assert.ok(old.id);
      assert.equal((await insRow(x, adm.id)).status, "CLEARED", "an expired policy: self-pay");
      const live = await s.addPolicy();
      assert.equal((await insRow(x, adm.id)).status, "PENDING");
      assert.equal((await t.api("put", `/policies/${live.id}`, s.officer.token).send({ status: "INACTIVE" })).status, 200);
      assert.equal((await insRow(x, adm.id)).status, "CLEARED", "an inactive policy: self-pay");
    });

    it("the claim belongs to one hospital: another hospital cannot link a claim to this admission or see this checklist; the TPA desk here can look but not waive", async () => {
      const s = await setUpIns("dis-ins-iso");
      const { x, adm } = s;
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const claimId = await s.open("CASHLESS");
      const o = await t.makeUser(other, ["CLAIMS_OFFICER"]);
      const ins = (await t.api("post", "/claims/insurers", o.token).send({ name: `TPA ${uniqueWord(6)}`, kind: "TPA" })).body.data as { id: string };
      const pol = await t.api("post", `/patients/${s.patient.id}/policies`, o.token).send({ insurerId: ins.id, policyNumber: "POL-FOREIGN-1", validFrom: iso(-1), validTo: iso(100) });
      assert.equal(pol.status, 404, "another hospital's patient");
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge`, o.token)).status, 404, "another hospital's admission");
      assert.equal((await t.api("get", `/claims/${claimId}`, o.token)).status, 404);
      assert.equal((await t.api("post", `/claims/${claimId}/documents`, o.token).query({ filename: "x.pdf", label: "Foreign file" }).set("Content-Type", "application/pdf").send(PDF)).status, 404);
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge`, s.officer.token)).status, 200);
      assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/waive`, s.officer.token).send({ step: "INSURANCE", reason: "Trying to skip insurance" })).status, 403);
    });

    it("a hospital can leave it out of the required steps; a pending claim then no longer blocks discharge", async () => {
      const s = await setUpIns("dis-ins-optional");
      const { x, adm } = s;
      await clearAll(x, adm.id);
      assert.ok((await status(x, adm.id)).blockers.includes("insurance not cleared"));
      assert.equal((await t.api("put", "/settings/DISCHARGE_REQUIRED_STEPS", x.tenant.admin.token).send({ value: ["NURSING", "CHARGES_REVIEWED", "PHARMACY", "LAB_RADIOLOGY", "OT_PROCEDURE", "BILLING"] })).status, 200);
      const opt = await status(x, adm.id);
      assert.equal(opt.steps.find((q: { step: string }) => q.step === "INSURANCE").required, false);
      assert.ok(!opt.blockers.includes("insurance not cleared"));
      assert.equal((await t.api("put", "/settings/DISCHARGE_REQUIRED_STEPS", x.tenant.admin.token).send({ value: ["INSURANCE", "INSURANCE"] })).status, 400, "duplicates are refused");
    });

    it("the whole stay for an insured patient: claim, documents, authorisation, final bill, payment, discharge", async () => {
      const s = await setUpIns("dis-ins-full");
      const { x, adm } = s;
      const care = await svc(x, "Inpatient care package", "6000");
      const charge = await t.api("post", `/admissions/${adm.id}/charges`, x.cashier.token).send({ type: "SERVICE", serviceId: care, quantity: 1 });
      assert.equal(charge.status, 201, JSON.stringify(charge.body));
      await sign(x, adm.id);
      await clearAll(x, adm.id);
      const claimId = await s.open("CASHLESS");
      assert.equal((await complete(x, adm.id)).status, 409, "insurance is still open");
      await s.attach(claimId);
      await s.post(claimId, "preauth", { requestedAmount: "6000" });
      await s.post(claimId, "preauth-decision", { decision: "APPROVE", amount: "6000" });
      assert.equal((await insRow(x, adm.id)).status, "CLEARED");
      const bill = await finalInvoice(x, adm.id);
      assert.equal(bill.status, 200, JSON.stringify(bill.body));
      const invoice = bill.body.data.invoice as { id: string; total: string };
      assert.equal((await payUpi(invoice.id, String(invoice.total), x.cashier.token)).status, 201);
      assert.equal((await complete(x, adm.id)).status, 200);
      assert.equal((await status(x, adm.id)).status, "DISCHARGED");
    });
  });

  describe("final billing: final bill, deposits, credits and patient liability reconciled", () => {
    const billRow = async (x: World, admId: string) => (await status(x, admId)).steps.find((s: { step: string }) => s.step === "BILLING");
    const chk = (r: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) => r.checks.find((c) => c.name === name)!;
    const takeAdvance = (x: World, patientId: string, amount: string) => t.api("post", `/patients/${patientId}/advances`, x.cashier.token).set("Idempotency-Key", key()).send({ tenders: [{ method: "CASH", amount }] });
    const m2 = (n: number) => n.toFixed(2);
    /** An admission with one charge (plus the bed day posted at admission), a signed summary and every earlier stage cleared. */
    const readyToBill = async (label: string, price = "5000") => {
      const x = await world(label);
      const care = await svc(x, `Inpatient care ${uniqueWord(4)}`, price);
      const { adm, patient } = await admit(x);
      assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.cashier.token).send({ type: "SERVICE", serviceId: care, quantity: 1 })).status, 201);
      await sign(x, adm.id);
      await clearAll(x, adm.id);
      return { x, adm, patient };
    };

    it("owned by IP billing; four checks; with nothing to bill, nothing owed and no deposits it reconciles by itself once the doctor has decided", async () => {
      const x = await world("dis-bill-stage");
      const { adm } = await admit(x);
      const before = await billRow(x, adm.id);
      assert.equal(before.stage, "Final billing");
      assert.equal(before.responsible, "IP billing");
      assert.equal(before.status, "PENDING");
      assert.equal(before.hisStatus, "Final bill, deposits, credits or patient liability not yet reconciled");
      assert.deepEqual(before.checks.map((c: { name: string }) => c.name), ["Final bill", "Deposits", "Credits", "Patient liability"]);
      assert.equal(before.automatic, true);
      assert.equal(before.waivable, false, "the bill cannot be waived");
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const after = await billRow(x, adm.id);
      assert.equal(after.status, "CLEARED");
      assert.equal(after.hisStatus, "Final bill, deposits, credits and patient liability reconciled");
      assert.equal(chk(after, "Final bill").detail, "No chargeable items");
      assert.equal(chk(after, "Deposits").detail, "No advance deposits");
      assert.equal(chk(after, "Patient liability").detail, "Nothing to pay");
      assert.equal(after.checks.every((c: { ok: boolean }) => c.ok), true);
    });

    it("an unbilled charge keeps it pending; once the bill is paid in full it reconciles", async () => {
      const { x, adm } = await readyToBill("dis-bill-pay");
      const open = await billRow(x, adm.id);
      assert.equal(open.status, "PENDING");
      assert.equal(chk(open, "Final bill").ok, false);
      const pending = (await status(x, adm.id)).pendingCharges.total as string;
      assert.ok(Number(pending) >= 5000, pending);
      assert.equal(chk(open, "Final bill").detail, `Not yet generated: ${pending} of charges are not billed`);
      assert.ok(open.blockers.includes("Generate the final bill"));
      const bill = await finalInvoice(x, adm.id);
      assert.equal(bill.status, 200, JSON.stringify(bill.body));
      const invoice = bill.body.data.invoice as { id: string; total: string; invoiceNumber: string };
      const owing = await billRow(x, adm.id);
      assert.equal(owing.status, "PENDING");
      assert.equal(chk(owing, "Final bill").ok, true);
      assert.equal(chk(owing, "Final bill").detail, `Bill ${invoice.invoiceNumber} for ${pending} (issued)`);
      assert.equal(chk(owing, "Patient liability").ok, false);
      assert.equal(chk(owing, "Patient liability").detail, `Patient owes ${pending}`);
      assert.ok(owing.blockers.includes(`Payment pending: ${pending} due from the patient`), JSON.stringify(owing.blockers));
      assert.equal(owing.reconciliation.patientLiability, pending);
      assert.equal((await payUpi(invoice.id, pending, x.cashier.token)).status, 201);
      const paid = await billRow(x, adm.id);
      assert.equal(paid.status, "CLEARED");
      assert.equal(paid.hisStatus, "Final bill, deposits, credits and patient liability reconciled");
      assert.equal(chk(paid, "Patient liability").detail, "Paid in full");
      assert.equal(paid.reconciliation.patientLiability, "0.00");
    });

    it("an advance deposit must be applied to the bill or refunded: money left with the hospital keeps it pending", async () => {
      const { x, adm, patient } = await readyToBill("dis-bill-deposit");
      assert.equal((await takeAdvance(x, patient.id, "8000")).status, 201);
      const withDeposit = await billRow(x, adm.id);
      assert.equal(chk(withDeposit, "Deposits").ok, false);
      assert.match(chk(withDeposit, "Deposits").detail, /8000\.00 taken · 0\.00 applied to bills · 0\.00 refunded · 8000\.00 still unapplied/);
      const bill = await finalInvoice(x, adm.id);
      const invoice = bill.body.data.invoice as { id: string; total: string };
      const total = Number(invoice.total); const rest = m2(8000 - total);
      assert.equal((await t.api("post", `/invoices/${invoice.id}/advances`, x.cashier.token).set("Idempotency-Key", key()).send({ amount: m2(total) })).status, 201);
      const left = await billRow(x, adm.id);
      assert.equal(left.status, "PENDING", "the bill is paid but the rest of the deposit is still with the hospital");
      assert.equal(chk(left, "Patient liability").ok, true);
      assert.equal(chk(left, "Deposits").ok, false);
      assert.equal(chk(left, "Deposits").detail, `8000.00 taken · ${m2(total)} applied to bills · 0.00 refunded · ${rest} still unapplied`);
      assert.ok(left.blockers.includes(`${rest} of advance deposits not yet applied to the bill or refunded`), JSON.stringify(left.blockers));
      const st = await status(x, adm.id);
      assert.equal(st.canComplete, false);
      assert.equal((await complete(x, adm.id)).status, 409, "no discharge while the deposit is unresolved");
      const dep = ((await t.api("get", `/patients/${patient.id}/advances`, x.cashier.token)).body.data.items as { id: string; balance: string }[]).find((d) => d.balance !== "0.00")!;
      assert.equal((await t.api("post", `/advances/${dep.id}/refunds`, x.cashier.token).set("Idempotency-Key", key()).send({ method: "CASH", amount: rest, reason: "Unused advance returned at discharge" })).status, 201);
      const done = await billRow(x, adm.id);
      assert.equal(done.status, "CLEARED");
      assert.equal(chk(done, "Deposits").detail, `8000.00 taken · ${m2(total)} applied to bills · ${rest} refunded`);
      assert.equal((await complete(x, adm.id)).status, 200);
    });

    it("an advance taken before the admission, or for a booking, is not this stay's deposit", async () => {
      const x = await world("dis-bill-oldadv");
      const care = await svc(x, `Care ${uniqueWord(4)}`, "1000");
      const bed = await mkBed(x);
      const patient = await registerPatient(t, x.rec.token);
      assert.equal((await takeAdvance(x, patient.id, "700")).status, 201, "taken before admission");
      const r = await t.api("post", "/admissions", x.rec.token).send({ patientId: patient.id, consultantId: x.doc.practitionerId, bedId: bed.id, reason: "Observation" });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const adm = r.body.data as { id: string };
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      void care;
      const row = await billRow(x, adm.id);
      assert.equal(row.status, "CLEARED");
      assert.equal(chk(row, "Deposits").detail, "No advance deposits");
    });

    it("credit notes: an overpayment after a credit note is a refund that is due; refunding it reconciles the stage", async () => {
      const { x, adm } = await readyToBill("dis-bill-credit");
      const invoice = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      assert.equal((await payUpi(invoice.id, invoice.total, x.cashier.token)).status, 201);
      assert.equal((await billRow(x, adm.id)).status, "CLEARED");
      const manager = await t.makeUser(x.tenant, ["MANAGER"]);
      assert.equal((await t.api("post", `/invoices/${invoice.id}/credit-notes`, x.cashier.token).set("Idempotency-Key", key()).send({ amount: "500", reason: "Billing correction" })).status, 403, "a cashier cannot raise a credit note");
      assert.equal((await t.api("post", `/invoices/${invoice.id}/credit-notes`, manager.token).set("Idempotency-Key", key()).send({ amount: "500", reason: "Billing correction" })).status, 201);
      const over = await billRow(x, adm.id);
      assert.equal(over.status, "PENDING");
      assert.equal(chk(over, "Credits").ok, false);
      assert.equal(chk(over, "Credits").detail, "Overpaid by 500.00 after credit notes: refund due");
      assert.ok(over.blockers.some((b: string) => /overpaid by 500\.00 after credit notes: refund it to the patient/.test(b)));
      assert.equal(over.reconciliation.overpaid, "500.00");
      assert.equal((await t.api("post", `/invoices/${invoice.id}/refunds`, x.cashier.token).set("Idempotency-Key", key()).send({ method: "UPI", amount: "500", reason: "Credit note refund", reference: "UPI-RF-0001" })).status, 201);
      const settled = await billRow(x, adm.id);
      assert.equal(settled.status, "CLEARED");
      assert.equal(chk(settled, "Credits").detail, "Credit notes of 500.00 are on the bill; nothing overpaid");
    });

    it("patient liability: what the insurer has authorised is not the patient's debt, so a cashless patient pays only their share", async () => {
      const { x, adm, patient } = await readyToBill("dis-bill-insured", "6000");
      const officer = await t.makeUser(x.tenant, ["CLAIMS_OFFICER"]);
      const insurer = (await t.api("post", "/claims/insurers", officer.token).send({ name: `TPA ${uniqueWord(6)}`, kind: "TPA" })).body.data as { id: string };
      const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
      const pol = (await t.api("post", `/patients/${patient.id}/policies`, officer.token).send({ insurerId: insurer.id, policyNumber: `POL-${uniqueWord(6)}`, validFrom: day(-30), validTo: day(300) })).body.data as { id: string };
      const claim = (await t.api("post", "/claims", officer.token).send({ patientId: patient.id, policyId: pol.id, type: "CASHLESS", encounterId: adm.encounterId })).body.data as { id: string };
      assert.equal((await t.api("post", `/claims/${claim.id}/documents`, officer.token).query({ filename: "d.pdf", label: "Discharge summary" }).set("Content-Type", "application/pdf").send(Buffer.from("%PDF-1.4 synthetic"))).status, 201);
      assert.equal((await t.api("post", `/claims/${claim.id}/preauth`, officer.token).send({ requestedAmount: "5000" })).status, 200);
      assert.equal((await t.api("post", `/claims/${claim.id}/preauth-decision`, officer.token).send({ decision: "APPROVE", amount: "4000" })).status, 200);
      const invoice = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      const mine = m2(Number(invoice.total) - 4000);
      const owing = await billRow(x, adm.id);
      assert.equal(owing.status, "PENDING");
      assert.equal(chk(owing, "Patient liability").detail, `Patient owes ${mine} · insurer's authorised share 4000.00 is awaited`);
      assert.equal(owing.reconciliation.insurerShare, "4000.00");
      assert.equal(owing.reconciliation.patientLiability, mine);
      // The patient's account statement tells the same story: the insurer's share is shown apart and the patient owes only their own share.
      const before = (await t.api("get", `/patients/${patient.id}/ledger`, x.cashier.token)).body.data;
      assert.equal(before.totals.balance, invoice.total, "the account still holds the whole bill");
      assert.equal(before.totals.insurerShare, "4000.00");
      assert.equal(before.totals.patientBalance, mine);
      assert.equal(before.position, "PATIENT_OWES");
      assert.equal((await payUpi(invoice.id, mine, x.cashier.token)).status, 201);
      const after = (await t.api("get", `/patients/${patient.id}/ledger`, x.cashier.token)).body.data;
      assert.equal(after.totals.balance, "4000.00");
      assert.equal(after.totals.insurerShare, "4000.00");
      assert.equal(after.totals.patientBalance, "0.00");
      assert.equal(after.position, "AWAITING_INSURER", "the patient is settled; the insurer's share is awaited");
      const paid = await billRow(x, adm.id);
      assert.equal(paid.status, "CLEARED", "the patient has paid their share");
      assert.equal(chk(paid, "Patient liability").detail, "Patient has paid their share · insurer's authorised share 4000.00 is awaited");
      assert.equal((await complete(x, adm.id)).status, 200, "a cashless patient can be discharged while the insurer's share is outstanding");
    });

    it("an insurer's authorisation that is rejected leaves the whole bill to the patient", async () => {
      const { x, adm, patient } = await readyToBill("dis-bill-rejected", "3000");
      const officer = await t.makeUser(x.tenant, ["CLAIMS_OFFICER"]);
      const insurer = (await t.api("post", "/claims/insurers", officer.token).send({ name: `TPA ${uniqueWord(6)}`, kind: "TPA" })).body.data as { id: string };
      const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
      const pol = (await t.api("post", `/patients/${patient.id}/policies`, officer.token).send({ insurerId: insurer.id, policyNumber: `POL-${uniqueWord(6)}`, validFrom: day(-30), validTo: day(300) })).body.data as { id: string };
      const claim = (await t.api("post", "/claims", officer.token).send({ patientId: patient.id, policyId: pol.id, type: "CASHLESS", encounterId: adm.encounterId })).body.data as { id: string };
      await t.api("post", `/claims/${claim.id}/documents`, officer.token).query({ filename: "d.pdf", label: "Discharge summary" }).set("Content-Type", "application/pdf").send(Buffer.from("%PDF-1.4 synthetic"));
      await t.api("post", `/claims/${claim.id}/preauth`, officer.token).send({ requestedAmount: "3000" });
      assert.equal((await t.api("post", `/claims/${claim.id}/preauth-decision`, officer.token).send({ decision: "REJECT", reason: "Waiting period not over" })).status, 200);
      const invoice = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      const row = await billRow(x, adm.id);
      assert.equal(chk(row, "Patient liability").detail, `Patient owes ${invoice.total}`);
      assert.equal(row.reconciliation.insurerShare, "0.00");
      const led = (await t.api("get", `/patients/${patient.id}/ledger`, x.cashier.token)).body.data;
      assert.equal(led.totals.insurerShare, "0.00", "a rejected authorisation is not an insurer's share");
      assert.equal(led.totals.patientBalance, invoice.total);
      assert.equal((await payUpi(invoice.id, invoice.total, x.cashier.token)).status, 201);
      assert.equal((await billRow(x, adm.id)).status, "CLEARED");
    });

    it("another hospital's deposits and bills never count here", async () => {
      const { x, adm } = await readyToBill("dis-bill-iso");
      const y = await world("dis-bill-iso-b");
      const stranger = await registerPatient(t, y.rec.token);
      assert.equal((await takeAdvance(y, stranger.id, "9000")).status, 201);
      const row = await billRow(x, adm.id);
      assert.equal(chk(row, "Deposits").detail, "No advance deposits");
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge`, y.doc.token)).status, 404);
    });
  });

  describe("financial release: cleared, or an authorised exception", () => {
    const relRow = async (x: World, admId: string) => (await status(x, admId)).steps.find((s: { step: string }) => s.step === "FINANCIAL_RELEASE");
    const chk = (r: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) => r.checks.find((c) => c.name === name)!;
    const except = (admId: string, tok: string, reason = "Dues to be collected after discharge from the employer") => t.api("post", `/admissions/${admId}/discharge/financial-exception`, tok).send({ reason });
    /** An admission with one charge, a signed summary and every earlier stage cleared; and a finance manager. */
    const ready = async (label: string) => {
      const x = await world(label);
      const finance = await t.makeUser(x.tenant, ["MANAGER"]);
      const care = await svc(x, `Inpatient care ${uniqueWord(4)}`, "4000");
      const { adm, patient } = await admit(x);
      assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.cashier.token).send({ type: "SERVICE", serviceId: care, quantity: 1 })).status, 201);
      await sign(x, adm.id);
      await clearAll(x, adm.id);
      return { x, finance, adm, patient };
    };

    it("owned by authorised billing / finance; follows final billing; with nothing outstanding it is simply cleared", async () => {
      const x = await world("dis-rel-stage");
      const { adm } = await admit(x);
      const before = await relRow(x, adm.id);
      assert.equal(before.stage, "Financial release");
      assert.equal(before.responsible, "Authorised billing / finance");
      assert.equal(before.status, "PENDING");
      assert.equal(before.hisStatus, "Financial release pending");
      assert.deepEqual(before.checks.map((c: { name: string }) => c.name), ["Final billing", "Authorisation"]);
      assert.equal(before.automatic, true);
      assert.equal(before.waivable, false, "a doctor cannot waive it");
      assert.equal(before.required, true, "required by default");
      const st = await status(x, adm.id);
      assert.equal(st.steps.length, 9);
      assert.equal(st.steps[8].step, "FINANCIAL_RELEASE", "the last stage");
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const after = await relRow(x, adm.id);
      assert.equal(after.status, "CLEARED");
      assert.equal(after.hisStatus, "Cleared");
      assert.equal(after.note, "Nothing outstanding");
      assert.equal(chk(after, "Final billing").detail, "Reconciled: nothing outstanding");
      assert.equal(chk(after, "Authorisation").detail, "Not needed");
    });

    it("a paid bill clears it by itself and the patient goes home; no exception is possible then", async () => {
      const { x, finance, adm } = await ready("dis-rel-paid");
      const invoice = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      assert.equal((await relRow(x, adm.id)).status, "PENDING");
      assert.equal((await payUpi(invoice.id, invoice.total, x.cashier.token)).status, 201);
      const row = await relRow(x, adm.id);
      assert.equal(row.status, "CLEARED");
      assert.equal(row.hisStatus, "Cleared");
      const ex = await except(adm.id, finance.token);
      assert.equal(ex.status, 409);
      assert.match(ex.body.error.message, /Nothing is outstanding/);
      assert.equal((await complete(x, adm.id)).status, 200);
    });

    it("money outstanding blocks the discharge until authorised billing / finance records an exception with a reason; the outstanding amounts are kept and audited", async () => {
      const { x, finance, adm } = await ready("dis-rel-exception");
      // before the final bill there is nothing to make an exception for
      const early = await except(adm.id, finance.token);
      assert.equal(early.status, 409);
      assert.match(early.body.error.message, /Generate the final bill first/);
      const invoice = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      const pending = await relRow(x, adm.id);
      assert.equal(pending.status, "PENDING");
      assert.equal(chk(pending, "Final billing").ok, false);
      assert.match(chk(pending, "Final billing").detail, new RegExp(`Payment pending: ${invoice.total.replace(".", "\\.")} due from the patient`));
      assert.equal(chk(pending, "Authorisation").detail, "No exception authorised");
      assert.ok(pending.blockers.some((b: string) => /Final billing is not reconciled/.test(b)));
      let st = await status(x, adm.id);
      assert.equal(st.canComplete, false);
      assert.ok(st.blockers.includes("financial release not cleared"), JSON.stringify(st.blockers));
      assert.equal((await complete(x, adm.id)).status, 409);

      // who may authorise it
      assert.equal((await except(adm.id, x.cashier.token)).status, 403, "the cashier cannot");
      assert.equal((await except(adm.id, x.doc.token)).status, 403, "the doctor cannot");
      assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/waive`, x.doc.token).send({ step: "FINANCIAL_RELEASE", reason: "Patient promised to pay later" })).status, 400, "it is not a doctor's waiver");
      assert.equal((await except(adm.id, finance.token, "short")).status, 400, "a real reason is needed");

      const ok = await except(adm.id, finance.token);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const row = await relRow(x, adm.id);
      assert.equal(row.status, "WAIVED");
      assert.equal(row.hisStatus, "Authorised exception");
      assert.match(row.note, /Dues to be collected after discharge from the employer/);
      assert.match(row.note, new RegExp(`patient owes ${invoice.total.replace(".", "\\.")}`));
      assert.ok(row.byName, "who authorised it");
      assert.match(chk(row, "Authorisation").detail, /^Exception authorised by /);
      const audit = await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action: "DISCHARGE_FINANCIAL_EXCEPTION_AUTHORISED", entityId: adm.id } });
      assert.ok(audit, "audited");
      assert.equal((audit!.metadata as { patientLiability: string }).patientLiability, invoice.total);
      assert.equal((await except(adm.id, finance.token)).status, 409, "only once");

      // final billing still tells the truth; the bill itself is untouched
      st = await status(x, adm.id);
      assert.equal(st.steps.find((s: { step: string }) => s.step === "BILLING").status, "PENDING");
      assert.equal(st.canComplete, true, JSON.stringify(st.blockers));
      const inv = (await t.api("get", `/invoices/${invoice.id}`, x.cashier.token)).body.data;
      assert.equal(inv.paidTotal ?? "0.00", "0.00");
      assert.equal((await complete(x, adm.id)).status, 200, "the patient is released by the exception");
    });

    it("an exception does not skip anything else: the doctor's decision comes first, and the clinical stages still have to clear", async () => {
      const x = await world("dis-rel-order");
      const finance = await t.makeUser(x.tenant, ["MANAGER"]);
      const { adm } = await admit(x);
      const r = await except(adm.id, finance.token);
      assert.equal(r.status, 409);
      assert.match(r.body.error.message, /medically fit first/);
    });

    it("another hospital's finance manager cannot release this patient", async () => {
      const { adm } = await ready("dis-rel-iso");
      const y = await world("dis-rel-iso-b");
      const stranger = await t.makeUser(y.tenant, ["MANAGER"]);
      assert.equal((await except(adm.id, stranger.token)).status, 404);
    });
  });

  describe("physical exit: actual departure confirmed", () => {
    const exitOf = async (x: World, admId: string) => (await status(x, admId)).exit;
    const depart = (admId: string, tok: string, body: Record<string, unknown>) => t.api("post", `/admissions/${admId}/discharge/departure`, tok).send(body);
    /** A patient discharged (paid bill, everything cleared) with the given discharge type. */
    const discharged = async (label: string, type = "ROUTINE") => {
      const x = await world(label);
      const care = await svc(x, `Inpatient care ${uniqueWord(4)}`, "2000");
      const { adm } = await admit(x);
      assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.cashier.token).send({ type: "SERVICE", serviceId: care, quantity: 1 })).status, 201);
      await sign(x, adm.id);
      await clearAll(x, adm.id);
      const before = await exitOf(x, adm.id);
      const invoice = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      assert.equal((await payUpi(invoice.id, invoice.total, x.cashier.token)).status, 201);
      const done = await complete(x, adm.id, { type });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      return { x, adm, before };
    };

    it("owned by the ward nurse / transport; not due while the patient is admitted; pending once the doctor has discharged", async () => {
      const { x, adm, before } = await discharged("dis-exit-stage");
      assert.equal(before.stage, "Physical exit");
      assert.equal(before.responsible, "Ward nurse / transport");
      assert.equal(before.status, "NOT_DUE");
      assert.equal(before.hisStatus, "Awaiting discharge");
      const after = await exitOf(x, adm.id);
      assert.equal(after.status, "PENDING");
      assert.equal(after.hisStatus, "Departure not yet confirmed");
      assert.equal(after.departedAt, null);
    });

    it("cannot be confirmed before the doctor completes the discharge", async () => {
      const x = await world("dis-exit-early");
      const { adm } = await admit(x);
      const r = await depart(adm.id, x.nurse.token, { mode: "WALKED" });
      assert.equal(r.status, 409);
      assert.match(r.body.error.message, /complete the discharge/);
    });

    it("the ward nurse confirms when, how and with whom the patient left; once; the time is checked; the record never changes and is audited", async () => {
      const { x, adm } = await discharged("dis-exit-nurse");
      assert.equal((await depart(adm.id, x.doc.token, { mode: "WALKED" })).status, 403, "not the doctor");
      assert.equal((await depart(adm.id, x.cashier.token, { mode: "WALKED" })).status, 403, "not the cashier");
      assert.equal((await depart(adm.id, x.nurse.token, { mode: "TELEPORTED" })).status, 400);
      assert.equal((await depart(adm.id, x.nurse.token, { mode: "WALKED", departedAt: new Date(Date.now() - 86_400_000).toISOString() })).status, 400, "before the discharge");
      assert.equal((await depart(adm.id, x.nurse.token, { mode: "WALKED", departedAt: new Date(Date.now() + 3_600_000).toISOString() })).status, 400, "in the future");
      assert.equal((await depart(adm.id, x.nurse.token, { mode: "BODY_RELEASED" })).status, 400, "body released is only for a death");
      const ok = await depart(adm.id, x.nurse.token, { mode: "WHEELCHAIR", escortedBy: "Son (Rahul)", note: "Belongings handed over" });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const e = await exitOf(x, adm.id);
      assert.equal(e.status, "CONFIRMED");
      assert.equal(e.hisStatus, "Actual departure confirmed");
      assert.equal(e.modeLabel, "by wheelchair");
      assert.equal(e.escortedBy, "Son (Rahul)");
      assert.equal(e.note, "Belongings handed over");
      assert.ok(e.byName, "who confirmed it");
      assert.equal(typeof e.minutesAfterDischarge, "number");
      assert.equal((await depart(adm.id, x.nurse.token, { mode: "WALKED" })).status, 409, "only once");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action: "PATIENT_DEPARTURE_CONFIRMED", entityId: adm.id } }), "audited");
      const row = await t.prisma.admissionDeparture.findFirstOrThrow({ where: { admissionId: adm.id } });
      await assert.rejects(t.prisma.admissionDeparture.update({ where: { id: row.id }, data: { mode: "WALKED" } }), "the record cannot be changed");
      await assert.rejects(t.prisma.admissionDeparture.delete({ where: { id: row.id } }), "or removed");
    });

    it("patient transport can confirm too, with a time in the past after the discharge", async () => {
      const { x, adm } = await discharged("dis-exit-transport");
      const porter = await t.makeUser(x.tenant, ["PATIENT_TRANSPORT"]);
      const dischargedAt = new Date((await status(x, adm.id)).dischargedAt as string).getTime();
      const r = await depart(adm.id, porter.token, { mode: "AMBULANCE", departedAt: new Date(dischargedAt + 1).toISOString(), escortedBy: "Ambulance crew" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await exitOf(x, adm.id)).modeLabel, "by ambulance");
    });

    it("a death is recorded as the body released, and only that", async () => {
      const { x, adm } = await discharged("dis-exit-death", "DEATH");
      assert.equal((await depart(adm.id, x.nurse.token, { mode: "STRETCHER" })).status, 400);
      assert.equal((await depart(adm.id, x.nurse.token, { mode: "BODY_RELEASED", escortedBy: "Family" })).status, 200);
      assert.equal((await exitOf(x, adm.id)).modeLabel, "body released");
    });

    it("a patient who absconded has no departure to confirm", async () => {
      const { x, adm } = await discharged("dis-exit-abscond", "ABSCONDED");
      const e = await exitOf(x, adm.id);
      assert.equal(e.status, "NOT_APPLICABLE");
      assert.equal(e.hisStatus, "Not applicable: the patient absconded");
      assert.equal((await depart(adm.id, x.nurse.token, { mode: "WALKED" })).status, 409);
    });

    it("another hospital's nurse cannot confirm this departure", async () => {
      const { adm } = await discharged("dis-exit-iso");
      const y = await world("dis-exit-iso-b");
      assert.equal((await depart(adm.id, y.nurse.token, { mode: "WALKED" })).status, 404);
    });
  });

  describe("bed turnover: vacated, cleaning, ready", () => {
    const turnOf = async (x: World, admId: string) => (await status(x, admId)).turnover;
    /** A patient discharged (paid bill, everything cleared); the bed they had, and a housekeeper. */
    const vacate = async (label: string, setup?: (x: World) => Promise<void>) => {
      const x = await world(label);
      if (setup) await setup(x);
      const keeper = await t.makeUser(x.tenant, ["HOUSEKEEPING"]);
      const care = await svc(x, `Inpatient care ${uniqueWord(4)}`, "1500");
      const { adm, bed, patient } = await admit(x);
      assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.cashier.token).send({ type: "SERVICE", serviceId: care, quantity: 1 })).status, 201);
      await sign(x, adm.id);
      await clearAll(x, adm.id);
      const before = await turnOf(x, adm.id);
      const invoice = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      assert.equal((await payUpi(invoice.id, invoice.total, x.cashier.token)).status, 201);
      assert.equal((await complete(x, adm.id)).status, 200);
      const kept = await turnOf(x, adm.id);
      const listedEarly = ((await t.api("get", "/bed-turnovers", keeper.token)).body.data as { bed: string }[]).some((r) => r.bed === bed.code);
      assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/departure`, x.nurse.token).send({ mode: "WALKED" })).status, 200);
      const list = (await t.api("get", "/bed-turnovers", keeper.token)).body.data as { id: string; bed: string; stage: string }[];
      const mine = list.find((r) => r.bed === bed.code)!;
      return { x, keeper, adm, bed, patient, before, kept, listedEarly, turnoverId: mine?.id };
    };
    const bedStatus = async (x: World, bedId: string) => ((await t.api("get", "/beds", x.tenant.admin.token)).body.data as { id: string; status: string }[]).find((b) => b.id === bedId)?.status;

    it("owned by housekeeping; not due while admitted; the bed is kept until the patient leaves, then vacated and the turnover opened", async () => {
      const { x, adm, bed, before, kept, listedEarly, turnoverId } = await vacate("dis-turn-stage");
      assert.equal(before.stage, "Bed turnover");
      assert.equal(before.responsible, "Housekeeping");
      assert.equal(before.status, "NOT_DUE");
      assert.equal(before.hisStatus, "Awaiting discharge");
      assert.equal(kept.status, "AWAITING_DEPARTURE", "discharged but not yet gone: the bed is still theirs");
      assert.equal(kept.hisStatus, "Bed kept until the patient leaves");
      assert.match(kept.bed, new RegExp(bed.code));
      assert.equal(listedEarly, false, "housekeeping does not see a bed that is still occupied");
      assert.ok(turnoverId, "housekeeping sees the vacated bed");
      const after = await turnOf(x, adm.id);
      assert.equal(after.status, "VACATED");
      assert.equal(after.hisStatus, "Vacated: cleaning not started");
      assert.match(after.bed, new RegExp(bed.code));
      assert.equal(await bedStatus(x, bed.id), "CLEANING");
    });

    it("housekeeping sees beds, never patients", async () => {
      const { keeper, adm, patient } = await vacate("dis-turn-privacy");
      const raw = JSON.stringify((await t.api("get", "/bed-turnovers", keeper.token)).body.data);
      assert.ok(!raw.includes(patient.id), "no patient id");
      assert.ok(!/patient|mrn/i.test(raw), "no patient fields");
      assert.equal((await t.api("get", `/admissions/${adm.id}`, keeper.token)).status, 403, "cannot open the admission");
      assert.equal((await t.api("get", `/patients/${patient.id}`, keeper.token)).status, 403, "cannot open the patient");
    });

    it("vacated, then cleaning, then ready, in that order and once each; ready makes the bed available; the record never changes and is audited", async () => {
      const { x, keeper, adm, bed, turnoverId } = await vacate("dis-turn-flow");
      const go = (step: string, tok = keeper.token) => t.api("post", `/bed-turnovers/${turnoverId}/${step}`, tok).send({});
      assert.equal((await go("start", x.doc.token)).status, 403, "not the doctor");
      assert.equal((await go("start", x.cashier.token)).status, 403, "not the cashier");
      const early = await go("ready");
      assert.equal(early.status, 409, "cleaning has to start first");
      assert.match(early.body.error.message, /Start the cleaning first/);
      assert.equal((await go("start")).status, 200);
      const cleaning = await turnOf(x, adm.id);
      assert.equal(cleaning.status, "CLEANING");
      assert.equal(cleaning.hisStatus, "Cleaning in progress");
      assert.ok(cleaning.cleaningStartedBy, "who started");
      assert.equal((await go("start")).status, 409, "only once");
      const r = await go("ready");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.bedStatus, "AVAILABLE");
      assert.equal(await bedStatus(x, bed.id), "AVAILABLE", "the bed can take the next patient");
      const done = await turnOf(x, adm.id);
      assert.equal(done.status, "READY");
      assert.equal(done.hisStatus, "Ready for the next patient");
      assert.ok(done.readyBy);
      assert.equal(typeof done.minutesToReady, "number");
      assert.equal((await go("ready")).status, 409, "only once");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action: "BED_TURNOVER_READY", entityId: bed.id } }), "audited");
      const row = await t.prisma.bedTurnover.findFirstOrThrow({ where: { id: turnoverId } });
      await assert.rejects(t.prisma.bedTurnover.update({ where: { id: row.id }, data: { vacatedAt: new Date() } }), "the times cannot be changed");
      await assert.rejects(t.prisma.bedTurnover.update({ where: { id: row.id }, data: { readyAt: new Date() } }), "a step cannot be redone");
      await assert.rejects(t.prisma.bedTurnover.delete({ where: { id: row.id } }), "or removed");
    });

    it("a nurse who marks the bed clean on the bed board completes the turnover too", async () => {
      const { x, adm, bed } = await vacate("dis-turn-nurse");
      const r = await t.api("post", `/beds/${bed.id}/status`, x.nurse.token).send({ status: "AVAILABLE" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const done = await turnOf(x, adm.id);
      assert.equal(done.status, "READY");
      assert.ok(done.readyBy);
    });

    it("a hospital that puts beds straight back to available has the bed ready at once", async () => {
      const { x, adm, bed } = await vacate("dis-turn-auto", async (w) => {
        assert.equal((await t.api("put", "/settings/BED_AFTER_DISCHARGE", w.tenant.admin.token).send({ value: "AVAILABLE" })).status, 200);
      });
      const done = await turnOf(x, adm.id);
      assert.equal(done.status, "READY");
      assert.equal(done.hisStatus, "Ready (no cleaning step at this hospital)");
      assert.equal(done.minutesToReady, 0);
      assert.equal(await bedStatus(x, bed.id), "AVAILABLE");
    });

    it("a patient who absconded has no departure: the bed is vacated at discharge", async () => {
      const x = await world("dis-turn-abscond");
      const care = await svc(x, `Care ${uniqueWord(4)}`, "1000");
      const { adm, bed } = await admit(x);
      await t.api("post", `/admissions/${adm.id}/charges`, x.cashier.token).send({ type: "SERVICE", serviceId: care, quantity: 1 });
      await sign(x, adm.id);
      await clearAll(x, adm.id);
      const invoice = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      await payUpi(invoice.id, invoice.total, x.cashier.token);
      assert.equal((await complete(x, adm.id, { type: "ABSCONDED" })).status, 200);
      assert.equal((await turnOf(x, adm.id)).status, "VACATED");
      assert.equal(await bedStatus(x, bed.id), "CLEANING");
    });

    it("another hospital's housekeeping cannot see or touch this bed", async () => {
      const { turnoverId } = await vacate("dis-turn-iso");
      const y = await world("dis-turn-iso-b");
      const other = await t.makeUser(y.tenant, ["HOUSEKEEPING"]);
      assert.equal((await t.api("post", `/bed-turnovers/${turnoverId}/start`, other.token).send({})).status, 404);
      const theirs = (await t.api("get", "/bed-turnovers", other.token)).body.data as { id: string }[];
      assert.ok(!theirs.some((r) => r.id === turnoverId));
    });
  });

  describe("post-discharge: records complete; claims and receivables tracked", () => {
    const postOf = async (x: World, admId: string) => (await status(x, admId)).postDischarge;
    const chk = (r: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) => r.checks.find((c) => c.name === name)!;
    const CODES = [{ diagnosis: "Community-acquired pneumonia", icd10: "J18.9", primary: true }];
    const signOff = (admId: string, tok: string, note?: string, codes: unknown = CODES) => t.api("post", `/admissions/${admId}/discharge/records-complete`, tok).send({ codes, ...(note ? { note } : {}) });
    const fileMove = (admId: string, tok: string, body: Record<string, unknown>) => t.api("post", `/admissions/${admId}/discharge/record-file`, tok).send(body);
    const departNow = (admId: string, x: World) => t.api("post", `/admissions/${admId}/discharge/departure`, x.nurse.token).send({ mode: "WALKED" });
    /** A stay taken to discharge: paid in full, or released by a finance exception with the bill unpaid. */
    const discharge = async (label: string, opts: { unpaid?: boolean } = {}) => {
      const x = await world(label);
      const mrd = await t.makeUser(x.tenant, ["MEDICAL_RECORDS"]);
      const care = await svc(x, `Inpatient care ${uniqueWord(4)}`, "3000");
      const { adm, patient } = await admit(x);
      assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.cashier.token).send({ type: "SERVICE", serviceId: care, quantity: 1 })).status, 201);
      await sign(x, adm.id);
      await clearAll(x, adm.id);
      const before = await postOf(x, adm.id);
      const invoice = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      if (opts.unpaid) {
        const finance = await t.makeUser(x.tenant, ["MANAGER"]);
        assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/financial-exception`, finance.token).send({ reason: "Corporate patient: employer settles monthly" })).status, 200);
      } else assert.equal((await payUpi(invoice.id, invoice.total, x.cashier.token)).status, 201);
      assert.equal((await complete(x, adm.id)).status, 200);
      return { x, mrd, adm, patient, invoice, before };
    };

    it("owned by MRD, claims and finance; not due while admitted; after discharge the records are pending until the record is ready and signed off", async () => {
      const { x, mrd, adm, before } = await discharge("dis-post-stage");
      assert.equal(before.stage, "Post-discharge");
      assert.equal(before.responsible, "MRD, claims, finance");
      assert.equal(before.status, "NOT_DUE");
      assert.equal(before.hisStatus, "Awaiting discharge");
      const p = await postOf(x, adm.id);
      assert.equal(p.status, "RECORDS_PENDING");
      assert.equal(p.hisStatus, "Records not yet complete");
      assert.deepEqual(p.checks.map((c: { name: string }) => c.name), ["Discharge summary", "Clinical documents", "Departure", "Medical records sign-off", "Diagnosis coding", "Record file", "Claims", "Receivables"]);
      assert.equal(chk(p, "Discharge summary").ok, true);
      assert.equal(chk(p, "Departure").ok, false, "the patient has not been seen out yet");
      assert.equal(p.recordReady, false);
      const early = await signOff(adm.id, mrd.token);
      assert.equal(early.status, 409);
      assert.match(early.body.error.message, /departure/);
    });

    it("once the departure is recorded the Medical Records Department signs the record off, once; with nothing owed the stay is closed", async () => {
      const { x, mrd, adm } = await discharge("dis-post-close");
      assert.equal((await departNow(adm.id, x)).status, 200);
      const ready = await postOf(x, adm.id);
      assert.equal(ready.recordReady, true);
      assert.equal(chk(ready, "Medical records sign-off").detail, "Ready for the Medical Records Department to sign off");
      assert.equal((await signOff(adm.id, x.nurse.token)).status, 403, "not the nurse");
      assert.equal((await signOff(adm.id, x.doc.token)).status, 403, "not the doctor");
      const ok = await signOff(adm.id, mrd.token, "Record checked and filed");
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const p = await postOf(x, adm.id);
      assert.equal(p.status, "CLOSED");
      assert.equal(p.hisStatus, "Records complete; claims and receivables closed");
      assert.ok(p.recordCompletedBy);
      assert.equal(chk(p, "Claims").detail, "No insurance claim for this stay");
      assert.equal(chk(p, "Receivables").detail, "Nothing receivable");
      assert.equal((await signOff(adm.id, mrd.token)).status, 409, "only once");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action: "MEDICAL_RECORD_COMPLETED", entityId: adm.id } }), "audited");
      const row = await t.prisma.medicalRecordCompletion.findFirstOrThrow({ where: { admissionId: adm.id } });
      await assert.rejects(t.prisma.medicalRecordCompletion.update({ where: { id: row.id }, data: { note: "changed" } }), "the sign-off cannot be changed");
    });

    it("money still owed keeps the stay in tracking after the record is complete, and shows on the finance list", async () => {
      const { x, mrd, adm, invoice } = await discharge("dis-post-owed", { unpaid: true });
      await departNow(adm.id, x);
      assert.equal((await signOff(adm.id, mrd.token)).status, 200);
      const p = await postOf(x, adm.id);
      assert.equal(p.status, "TRACKING");
      assert.equal(p.hisStatus, "Records complete; claims and receivables tracked");
      assert.equal(p.receivables.patient, invoice.total);
      assert.equal(chk(p, "Receivables").detail, `patient owes ${invoice.total}`);
      const list = (await t.api("get", "/post-discharge", x.cashier.token).query({ show: "RECEIVABLES" })).body.data as { items: { admissionId: string; receivables: { patient: string } }[] };
      const mine = list.items.find((r) => r.admissionId === adm.id);
      assert.ok(mine, "on the receivables list");
      assert.equal(mine!.receivables.patient, invoice.total);
      // the money comes in later: the stay closes by itself
      assert.equal((await payUpi(invoice.id, invoice.total, x.cashier.token)).status, 201);
      assert.equal((await postOf(x, adm.id)).status, "CLOSED");
    });

    it("an insurance claim is tracked after discharge with what the insurer still owes", async () => {
      const x = await world("dis-post-claim");
      const mrd = await t.makeUser(x.tenant, ["MEDICAL_RECORDS"]);
      const officer = await t.makeUser(x.tenant, ["CLAIMS_OFFICER"]);
      const care = await svc(x, `Inpatient care ${uniqueWord(4)}`, "5000");
      const { adm, patient } = await admit(x);
      await t.api("post", `/admissions/${adm.id}/charges`, x.cashier.token).send({ type: "SERVICE", serviceId: care, quantity: 1 });
      await sign(x, adm.id);
      await clearAll(x, adm.id);
      const insurer = (await t.api("post", "/claims/insurers", officer.token).send({ name: `TPA ${uniqueWord(6)}`, kind: "TPA" })).body.data as { id: string };
      const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
      const pol = (await t.api("post", `/patients/${patient.id}/policies`, officer.token).send({ insurerId: insurer.id, policyNumber: `POL-${uniqueWord(6)}`, validFrom: day(-30), validTo: day(300) })).body.data as { id: string };
      const claim = (await t.api("post", "/claims", officer.token).send({ patientId: patient.id, policyId: pol.id, type: "CASHLESS", encounterId: adm.encounterId })).body.data as { id: string; claimNumber: string };
      await t.api("post", `/claims/${claim.id}/documents`, officer.token).query({ filename: "d.pdf", label: "Discharge summary" }).set("Content-Type", "application/pdf").send(Buffer.from("%PDF-1.4 synthetic"));
      await t.api("post", `/claims/${claim.id}/preauth`, officer.token).send({ requestedAmount: "4000" });
      assert.equal((await t.api("post", `/claims/${claim.id}/preauth-decision`, officer.token).send({ decision: "APPROVE", amount: "3000" })).status, 200);
      const invoice = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      const mine = (Number(invoice.total) - 3000).toFixed(2);
      assert.equal((await payUpi(invoice.id, mine, x.cashier.token)).status, 201);
      assert.equal((await complete(x, adm.id)).status, 200);
      await departNow(adm.id, x);
      assert.equal((await signOff(adm.id, mrd.token)).status, 200);
      const p = await postOf(x, adm.id);
      assert.equal(p.status, "TRACKING");
      assert.equal(p.receivables.patient, "0.00");
      assert.equal(p.receivables.insurer, "3000.00");
      assert.match(chk(p, "Claims").detail, new RegExp(`^Claim ${claim.claimNumber} with TPA .+: preauth approved · insurer still owes 3000\\.00$`));
      const list = (await t.api("get", "/post-discharge", officer.token).query({ show: "CLAIMS" })).body.data as { items: { admissionId: string; claim: { open: boolean } }[] };
      assert.ok(list.items.some((r) => r.admissionId === adm.id && r.claim.open), "the TPA desk sees the claim to follow");
    });

    it("MRD codes the final diagnoses in ICD-10 when it signs off: pre-filled from the summary, checked, one primary, kept unchanged", async () => {
      const { x, mrd, adm } = await discharge("dis-post-icd");
      await departNow(adm.id, x);
      const before = await postOf(x, adm.id);
      assert.deepEqual(before.suggestedDiagnoses.map((d: { text: string; code?: string }) => [d.text, d.code]), [["Community-acquired pneumonia", "J18.9"]], "the summary's diagnoses are offered");
      assert.equal(chk(before, "Diagnosis coding").ok, false);
      assert.equal((await signOff(adm.id, mrd.token, undefined, [])).status, 400, "at least one coded diagnosis");
      assert.equal((await signOff(adm.id, mrd.token, undefined, [{ diagnosis: "Pneumonia", icd10: "pneumonia" }])).status, 400, "not an ICD-10 code");
      assert.equal((await signOff(adm.id, mrd.token, undefined, [{ diagnosis: "A", icd10: "J18.9", primary: true }, { diagnosis: "B", icd10: "E11.9", primary: true }])).status, 400, "two primaries");
      assert.equal((await signOff(adm.id, mrd.token, undefined, [{ diagnosis: "Pneumonia", icd10: "J18.9" }, { diagnosis: "Pneumonia again", icd10: "J18.9" }])).status, 400, "the same code twice");
      const ok = await signOff(adm.id, mrd.token, undefined, [{ diagnosis: "Type 2 diabetes", icd10: "e11.9" }, { diagnosis: "Community-acquired pneumonia", icd10: "J18.9", primary: true }]);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const p = await postOf(x, adm.id);
      assert.deepEqual(p.codes.map((c: { icd10: string; primary: boolean }) => [c.icd10, c.primary]), [["J18.9", true], ["E11.9", false]], "upper-cased, primary first");
      assert.equal(chk(p, "Diagnosis coding").ok, true);
      assert.match(chk(p, "Diagnosis coding").detail, /J18\.9 Community-acquired pneumonia \(primary\)/);
      const row = await t.prisma.medicalRecordCode.findFirstOrThrow({ where: { admissionId: adm.id, primary: true } });
      await assert.rejects(t.prisma.medicalRecordCode.update({ where: { id: row.id }, data: { icd10: "J15.9" } }), "a code cannot be changed");
    });

    it("the paper record is tracked: received, filed (where), issued (to whom), returned, filed again; in that order only", async () => {
      const { x, mrd, adm } = await discharge("dis-post-file");
      assert.equal((await fileMove(adm.id, x.nurse.token, { action: "RECEIVED" })).status, 403, "MRD only");
      assert.equal((await fileMove(adm.id, mrd.token, { action: "FILED", location: "Rack 4" })).status, 409, "it has to be received first");
      assert.equal((await fileMove(adm.id, mrd.token, { action: "RECEIVED" })).status, 200);
      assert.equal(chk(await postOf(x, adm.id), "Record file").detail.startsWith("received in MRD"), true);
      assert.equal((await fileMove(adm.id, mrd.token, { action: "FILED" })).status, 400, "where is it filed?");
      assert.equal((await fileMove(adm.id, mrd.token, { action: "FILED", location: "Rack 4, shelf B" })).status, 200);
      let p = await postOf(x, adm.id);
      assert.equal(chk(p, "Record file").ok, true);
      assert.match(chk(p, "Record file").detail, /^filed at Rack 4, shelf B by /);
      assert.deepEqual(p.file.nextActions, ["ISSUED"]);
      assert.equal((await fileMove(adm.id, mrd.token, { action: "ISSUED" })).status, 400, "issued to whom?");
      assert.equal((await fileMove(adm.id, mrd.token, { action: "ISSUED", issuedTo: "Dr. Audit (quality review)" })).status, 200);
      p = await postOf(x, adm.id);
      assert.equal(chk(p, "Record file").ok, false, "out of the file room");
      assert.match(chk(p, "Record file").detail, /^issued to Dr\. Audit/);
      assert.equal((await fileMove(adm.id, mrd.token, { action: "ISSUED", issuedTo: "Someone else" })).status, 409, "it is already out");
      assert.equal((await fileMove(adm.id, mrd.token, { action: "RETURNED" })).status, 200);
      assert.equal((await fileMove(adm.id, mrd.token, { action: "FILED", location: "Rack 4, shelf B" })).status, 200);
      p = await postOf(x, adm.id);
      assert.equal(p.file.history.length, 5);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action: "MEDICAL_RECORD_FILE_MOVED", entityId: adm.id } }), "audited");
      const mv = await t.prisma.medicalRecordFileMovement.findFirstOrThrow({ where: { admissionId: adm.id } });
      await assert.rejects(t.prisma.medicalRecordFileMovement.delete({ where: { id: mv.id } }), "movements are never removed");
    });

    it("the list shows money still owed by days since discharge", async () => {
      const { x, adm, invoice } = await discharge("dis-post-ageing", { unpaid: true });
      const list = (await t.api("get", "/post-discharge", x.cashier.token)).body.data as { ageing: { bucket: string; patient: string; stays: number }[] };
      assert.deepEqual(list.ageing.map((a) => a.bucket), ["0-30", "31-60", "61-90", "90+"]);
      const fresh = list.ageing.find((a) => a.bucket === "0-30")!;
      assert.ok(Number(fresh.patient) >= Number(invoice.total), "today's discharge owes in the 0-30 bucket");
      // move the discharge 75 days back: the money moves to 61-90
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`); // seeded history through the privileged test connection
        await tx.$executeRaw`UPDATE "Admission" SET "admittedAt" = now() - interval '80 days', "dischargedAt" = now() - interval '75 days' WHERE id = ${adm.id}::uuid`;
      });
      const later = (await t.api("get", "/post-discharge", x.cashier.token)).body.data as { ageing: { bucket: string; patient: string; stays: number }[]; items: { admissionId: string; daysSinceDischarge: number }[] };
      assert.equal(later.items.find((r) => r.admissionId === adm.id)!.daysSinceDischarge, 75);
      assert.equal(later.ageing.find((a) => a.bucket === "61-90")!.patient, invoice.total);
      assert.equal(later.ageing.find((a) => a.bucket === "61-90")!.stays, 1);
    });

    it("the list is for MRD, claims and finance only, and never crosses hospitals", async () => {
      const { x, mrd, adm } = await discharge("dis-post-list");
      const records = (await t.api("get", "/post-discharge", mrd.token).query({ show: "RECORDS" })).body.data as { items: { admissionId: string; recordReady: boolean }[] };
      assert.ok(records.items.some((r) => r.admissionId === adm.id), "MRD sees the record to complete");
      const keeper = await t.makeUser(x.tenant, ["HOUSEKEEPING"]);
      assert.equal((await t.api("get", "/post-discharge", keeper.token)).status, 403);
      assert.equal((await t.api("get", "/post-discharge", x.nurse.token)).status, 403);
      const y = await world("dis-post-list-b");
      const other = await t.makeUser(y.tenant, ["MEDICAL_RECORDS"]);
      const theirs = (await t.api("get", "/post-discharge", other.token).query({ show: "ALL" })).body.data as { items: { admissionId: string }[] };
      assert.ok(!theirs.items.some((r) => r.admissionId === adm.id));
      assert.equal((await signOff(adm.id, other.token)).status, 404);
    });
  });

  describe("pharmacy clearance: issues, returns and eligible credits", () => {
    const pharmRow = async (x: World, admId: string) => (await status(x, admId)).steps.find((s: { step: string }) => s.step === "PHARMACY");
    const chk = (r: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) => r.checks.find((c) => c.name === name)!;
    /** A medicine with 20 units in stock at a selling price of 9. */
    const stock = async (x: World) => {
      const med = (await t.api("post", "/medicines", x.pharm.token).send({ brandName: `Rec${uniqueWord(5)}`, genericName: `Recgen${uniqueWord(5)}`, strength: "500 mg", dosageForm: "TABLET", gstPercent: 0 })).body.data as { id: string };
      const b = await t.api("post", "/pharmacy/batches", x.pharm.token).set("Idempotency-Key", key()).send({ medicineId: med.id, batchNo: `B${uniqueWord(4)}`, expiryDate: new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10), mrp: "10", purchasePrice: "5", sellingPrice: "9", quantity: 20 });
      assert.equal(b.status, 201, JSON.stringify(b.body));
      return { med, batchId: (b.body.data.batch ?? b.body.data).id as string };
    };
    const issue = (x: World, patientId: string, medicineId: string, qty: number, toAdmission: boolean) =>
      t.api("post", "/pharmacy/dispenses", x.pharm.token).set("Idempotency-Key", key()).send({ patientId, items: [{ medicineId, quantity: qty }], ...(toAdmission ? { chargeToAdmission: true } : {}) });
    const giveBack = (x: World, dispenseId: string, itemId: string, qty: number) =>
      t.api("post", `/pharmacy/dispenses/${dispenseId}/returns`, x.pharm.token).set("Idempotency-Key", key()).send({ reason: "Patient no longer needs it", items: [{ dispenseItemId: itemId, quantity: qty }] });
    const voidCharges = (admId: string, prefix: string, byId: string) =>
      t.prisma.charge.updateMany({ where: { admissionId: admId, sourceKey: { startsWith: prefix } }, data: { status: "VOIDED", voidReason: "Test: charge removed by mistake", voidedById: byId, voidedAt: new Date() } });

    it("owned by the inpatient pharmacist, with Issues, Returns and Eligible credits shown; with nothing issued it reconciles by itself once the doctor has decided", async () => {
      const x = await world("dis-ph-stage");
      const { adm } = await admit(x);
      const before = await pharmRow(x, adm.id);
      assert.equal(before.stage, "Pharmacy clearance");
      assert.equal(before.responsible, "Inpatient pharmacist");
      assert.equal(before.status, "PENDING");
      assert.equal(before.hisStatus, "Issues, returns or eligible credits not yet reconciled");
      assert.deepEqual(before.checks.map((c: { name: string }) => c.name), ["Issues", "Returns", "Eligible credits"]);

      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const after = await pharmRow(x, adm.id);
      assert.equal(after.status, "CLEARED");
      assert.equal(after.hisStatus, "Issues, returns and eligible credits reconciled");
      assert.match(chk(after, "Issues").detail, /Nothing issued/);
      assert.equal(chk(after, "Returns").detail, "No returns");
      assert.equal(chk(after, "Eligible credits").detail, "No credits due");
      assert.equal(after.checks.every((c: { ok: boolean }) => c.ok), true, "all three checks are green");
    });

    it("medicines issued to the admission and partly returned stay reconciled: the charge is cut to match, and the numbers are shown", async () => {
      const x = await world("dis-ph-return");
      const { adm, patient } = await admit(x);
      const { med } = await stock(x);
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);

      const d = await issue(x, patient.id, med.id, 5, true);
      assert.equal(d.status, 201, JSON.stringify(d.body));
      const itemId = d.body.data.dispense.items[0].id as string;
      const issued = await pharmRow(x, adm.id);
      assert.match(chk(issued, "Issues").detail, /1 issue\(s\), 5 unit\(s\), 45\.00/);
      assert.equal(issued.status, "CLEARED");
      assert.equal(issued.note, "Everything issued is accounted for", "it no longer says 'Nothing to dispense' once something was issued");

      const back = await giveBack(x, d.body.data.dispense.id, itemId, 2);
      assert.equal(back.status, 201, JSON.stringify(back.body));
      const row = await pharmRow(x, adm.id);
      assert.match(chk(row, "Returns").detail, /2 unit\(s\) returned \(18\.00\), charges adjusted to match/);
      assert.equal(row.checks.every((c: { ok: boolean }) => c.ok), true);
      assert.equal(row.status, "CLEARED");
      const live = await t.prisma.charge.findMany({ where: { admissionId: adm.id, sourceKey: { startsWith: `DISPENSE_ITEM:${itemId}` }, status: { not: "VOIDED" } } });
      assert.equal(live.reduce((n, c) => n + Number(c.quantity), 0), 3, "3 units are still billed");
    });

    it("an issue with no live charge stops the stage; it cannot be cleared until it adds up, but it can be waived with a reason", async () => {
      const x = await world("dis-ph-block");
      const { adm, patient } = await admit(x);
      const { med } = await stock(x);
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      assert.equal((await issue(x, patient.id, med.id, 5, true)).status, 201);
      assert.equal((await pharmRow(x, adm.id)).status, "CLEARED");

      await voidCharges(adm.id, "DISPENSE_ITEM:", x.cashier.id);
      const bad = await pharmRow(x, adm.id);
      assert.equal(bad.status, "PENDING", "no longer clears itself");
      assert.equal(chk(bad, "Issues").ok, false);
      assert.match(chk(bad, "Issues").detail, /5 issued, 0 returned, but 0 billed \(should be 5\)/);
      assert.ok(bad.blockers.some((b: string) => /but 0 billed/.test(b)));

      const refused = await clear(x, adm.id, "PHARMACY", x.pharm.token);
      assert.equal(refused.status, 409);
      assert.match(refused.body.error.message, /Pharmacy clearance blocked: .*but 0 billed/);
      assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/waive`, x.doc.token).send({ step: "PHARMACY", reason: "Charge reversed on purpose after a billing check" })).status, 200);
      const waived = await pharmRow(x, adm.id);
      assert.equal(waived.status, "WAIVED");
      assert.equal(waived.hisStatus, "Pharmacy clearance waived");
    });

    it("a return of a counter sale (invoiced) must have credit notes covering it: raised by the return itself, and flagged if they are missing", async () => {
      const x = await world("dis-ph-credit");
      const { adm, patient } = await admit(x);
      const { med } = await stock(x);
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);

      const sale = await issue(x, patient.id, med.id, 5, false);
      assert.equal(sale.status, 201, JSON.stringify(sale.body));
      const saleId = sale.body.data.dispense.id as string;
      const saleItem = sale.body.data.dispense.items[0].id as string;
      const back = await giveBack(x, saleId, saleItem, 2);
      assert.equal(back.status, 201, JSON.stringify(back.body));
      const ok = await pharmRow(x, adm.id);
      assert.match(chk(ok, "Eligible credits").detail, /18\.00 due, credit notes raised 18\.00/);
      assert.equal(ok.checks.every((c: { ok: boolean }) => c.ok), true);
      assert.equal(ok.status, "CLEARED");

      // A return recorded without its credit note (done straight in the database) is exactly what the check is there to catch.
      const sale2 = await issue(x, patient.id, med.id, 3, false);
      await t.prisma.dispenseItem.updateMany({ where: { dispenseId: sale2.body.data.dispense.id }, data: { returnedQuantity: 1 } });
      const bad = await pharmRow(x, adm.id);
      assert.equal(chk(bad, "Eligible credits").ok, false);
      assert.match(chk(bad, "Eligible credits").detail, /returned medicines worth 9\.00 but credit notes cover only 0\.00/);
      assert.equal(bad.status, "PENDING");
      const refused = await clear(x, adm.id, "PHARMACY", x.pharm.token);
      assert.equal(refused.status, 409);
      assert.match(refused.body.error.message, /credit notes cover only/);
    });

    it("a medicine drawn from a ward store for the patient must still have its charge", async () => {
      const x = await world("dis-ph-ward");
      const { adm } = await admit(x);
      const { batchId } = await stock(x);
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const loc = (await t.api("post", "/pharmacy/locations", x.pharm.token).send({ name: `Ward ${uniqueWord(5)} store` })).body.data as { id: string };
      const tr = await t.api("post", "/pharmacy/transfers", x.pharm.token).set("Idempotency-Key", key()).send({ fromLocationId: null, toLocationId: loc.id, reason: "Stock for the ward", twoStep: false, items: [{ batchId, quantity: 10 }] });
      assert.equal(tr.status, 201, JSON.stringify(tr.body));
      const draw = await t.api("post", `/admissions/${adm.id}/ward-store-issues`, x.nurse.token).set("Idempotency-Key", key()).send({ locationId: loc.id, batchId, quantity: 4 });
      assert.equal(draw.status, 201, JSON.stringify(draw.body));
      const ok = await pharmRow(x, adm.id);
      assert.match(chk(ok, "Issues").detail, /1 issue\(s\), 4 unit\(s\), 36\.00/);
      assert.equal(ok.status, "CLEARED");

      await voidCharges(adm.id, "WARDISSUE:", x.cashier.id);
      const bad = await pharmRow(x, adm.id);
      assert.equal(chk(bad, "Issues").ok, false);
      assert.match(chk(bad, "Issues").detail, /4 unit\(s\) drawn from a ward store but the charge is missing or voided/);
      assert.equal((await clear(x, adm.id, "PHARMACY", x.pharm.token)).status, 409);
    });

    it("a medicine already on the final bill can be returned: it is restocked and a credit note is raised on that invoice, and the reconciliation counts it", async () => {
      const x = await world("dis-ph-after-bill");
      const { adm, patient } = await admit(x);
      const { med } = await stock(x);
      const d1 = await issue(x, patient.id, med.id, 5, true);
      const d2 = await issue(x, patient.id, med.id, 3, true);
      assert.equal(d1.status, 201); assert.equal(d2.status, 201);
      await clearAll(x, adm.id);
      const fb = await finalInvoice(x, adm.id);
      assert.equal(fb.status, 200, JSON.stringify(fb.body));
      const invoiceId = fb.body.data.invoice.id as string;
      const before = await t.prisma.invoice.findFirstOrThrow({ where: { id: invoiceId } });

      const back = await giveBack(x, d1.body.data.dispense.id, d1.body.data.dispense.items[0].id, 2);
      assert.equal(back.status, 201, JSON.stringify(back.body));
      assert.ok(back.body.data.creditNoteNumber, "a credit note is raised");
      assert.equal(back.body.data.creditedAmount, "18.00");
      const after = await t.prisma.invoice.findFirstOrThrow({ where: { id: invoiceId } });
      assert.equal(Number(after.creditedTotal) - Number(before.creditedTotal), 18, "the credit is on the final invoice");
      assert.equal((await t.prisma.charge.findMany({ where: { admissionId: adm.id, sourceKey: { startsWith: `DISPENSE_ITEM:${d1.body.data.dispense.items[0].id}` } } })).every((c) => c.status === "BILLED"), true, "the billed charge itself is untouched");

      const ok = await pharmRow(x, adm.id);
      assert.match(chk(ok, "Returns").detail, /2 unit\(s\) returned \(18\.00\)/);
      assert.equal(chk(ok, "Returns").ok, true);
      assert.match(chk(ok, "Eligible credits").detail, /18\.00 due, credit notes raised 18\.00/);
      assert.equal(chk(ok, "Eligible credits").ok, true);

      // A return recorded after billing without its credit note is what the check catches.
      await t.prisma.dispenseItem.updateMany({ where: { dispenseId: d2.body.data.dispense.id }, data: { returnedQuantity: 1 } });
      const bad = await pharmRow(x, adm.id);
      assert.equal(chk(bad, "Eligible credits").ok, false);
      assert.match(chk(bad, "Eligible credits").detail, /returned after billing worth 27\.00 but credit notes cover only 18\.00/);
    });

    it("a missing medicine charge can be put back by the pharmacist so the stage reconciles without a waiver; not after the final bill", async () => {
      const x = await world("dis-ph-repost");
      const { adm, patient } = await admit(x);
      const { med } = await stock(x);
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const repost = (tok = x.pharm.token) => t.api("post", `/admissions/${adm.id}/discharge/pharmacy/repost-charges`, tok).send({});

      assert.equal((await repost()).status, 409, "nothing is missing yet");
      assert.equal((await issue(x, patient.id, med.id, 5, true)).status, 201);
      await voidCharges(adm.id, "DISPENSE_ITEM:", x.cashier.id);
      const bad = await pharmRow(x, adm.id);
      assert.equal(bad.status, "PENDING");
      assert.match(chk(bad, "Issues").detail, /5 issued, 0 returned, but 0 billed \(should be 5\)/);

      assert.equal((await repost(x.nurse.token)).status, 403, "only someone who may dispense");
      const fixed = await repost();
      assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
      assert.deepEqual(fixed.body.data.reposted.map((r: { quantity: number }) => r.quantity), [5]);
      const row = fixed.body.data.status.steps.find((s: { step: string }) => s.step === "PHARMACY");
      assert.equal(row.status, "CLEARED", "reconciled by itself, no waiver");
      assert.equal(row.checks.every((c: { ok: boolean }) => c.ok), true);
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: x.tenant.tenantId, action: "PHARMACY_CHARGES_REPOSTED", entityId: adm.id } }), 1);
      assert.equal((await repost()).status, 409, "nothing is missing any more");

      // After the final bill the bill is never touched.
      const y = await world("dis-ph-repost-late");
      const a2 = await admit(y); const m2 = await stock(y);
      assert.equal((await issue(y, a2.patient.id, m2.med.id, 4, true)).status, 201);
      await clearAll(y, a2.adm.id);
      assert.equal((await finalInvoice(y, a2.adm.id)).status, 200);
      const late = await t.api("post", `/admissions/${a2.adm.id}/discharge/pharmacy/repost-charges`, y.pharm.token).send({});
      assert.equal(late.status, 409);
      assert.match(late.body.error.message, /final bill has already been issued/);
    });

    it("a re-posted charge also reconciles a ward-store issue whose charge was voided", async () => {
      const x = await world("dis-ph-repost-ward");
      const { adm } = await admit(x);
      const { batchId } = await stock(x);
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);
      const loc = (await t.api("post", "/pharmacy/locations", x.pharm.token).send({ name: `Ward ${uniqueWord(5)} store` })).body.data as { id: string };
      assert.equal((await t.api("post", "/pharmacy/transfers", x.pharm.token).set("Idempotency-Key", key()).send({ fromLocationId: null, toLocationId: loc.id, reason: "Stock for the ward", twoStep: false, items: [{ batchId, quantity: 10 }] })).status, 201);
      assert.equal((await t.api("post", `/admissions/${adm.id}/ward-store-issues`, x.nurse.token).set("Idempotency-Key", key()).send({ locationId: loc.id, batchId, quantity: 4 })).status, 201);
      await voidCharges(adm.id, "WARDISSUE:", x.cashier.id);
      assert.equal((await pharmRow(x, adm.id)).status, "PENDING");
      const r = await t.api("post", `/admissions/${adm.id}/discharge/pharmacy/repost-charges`, x.pharm.token).send({});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = await pharmRow(x, adm.id);
      assert.equal(row.status, "CLEARED");
      assert.match(chk(row, "Issues").detail, /1 issue\(s\), 4 unit\(s\), 36\.00/);
    });
  });

  describe("summary preparation: draft, signed, verified", () => {
    /** A resident medical officer: a registered practitioner (so they may write clinical documents) with the RMO role. */
    const makeRmo = async (x: World) => {
      const u = await t.makeUser(x.tenant, ["RMO"]);
      await t.prisma.practitioner.create({ data: { tenantId: x.tenant.tenantId, facilityId: x.tenant.facilityId, userId: u.id, displayName: `Dr. ${uniqueWord(6)} (RMO)`, specialty: "Resident Medical Officer", scheduleSet: true } });
      const fullName = (await t.prisma.user.findFirstOrThrow({ where: { id: u.id }, select: { fullName: true } })).fullName;
      return { ...u, fullName };
    };
    const putSummary = (admId: string, tok: string, body: Record<string, unknown>) => t.api("put", `/admissions/${admId}/discharge-summary`, tok).send(body);
    const verify = (admId: string, tok: string, body: Record<string, unknown>) => t.api("post", `/admissions/${admId}/discharge-summary/verify`, tok).send(body);
    const summaryOf = async (x: World, admId: string) => (await status(x, admId)).summary;

    it("RMO prepares, the treating consultant corrects and signs, the RMO verifies; every step shows on the row", async () => {
      const x = await world("dis-rmo-flow");
      const rmo = await makeRmo(x);
      const { adm } = await admit(x);

      // The RMO covers the whole ward: they can open a consultant's admission. Another consultant cannot.
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge`, rmo.token)).status, 200, "the RMO sees the whole ward");
      const otherDoc = await makeDoctor(t, x.tenant);
      assert.equal((await t.api("get", `/admissions/${adm.id}/discharge`, otherDoc.token)).status, 404, "a different consultant does not see this patient");

      // Draft, prepared by the RMO.
      const d = await putSummary(adm.id, rmo.token, { content: { hospitalCourse: "Admitted with fever and cough.", finalDiagnoses: [{ text: "Pneumonia" }] } });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      const draft = await summaryOf(x, adm.id);
      assert.equal(draft.status, "DRAFT");
      assert.equal(draft.hisStatus, "Draft");
      assert.equal(draft.preparedByName, rmo.fullName, "the RMO is named as the preparer");

      // The RMO can prepare but cannot sign, and cannot verify an unsigned draft.
      assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-summary/sign`, rmo.token).send({ version: d.body.data.version })).status, 403, "only the consultant signs");
      const early = await verify(adm.id, rmo.token, { version: 1 });
      assert.equal(early.status, 409);
      assert.match(early.body.error.message, /signed by the treating consultant/);

      // The treating consultant corrects the RMO's draft and signs it. Another doctor may not touch it.
      const intruder = await putSummary(adm.id, otherDoc.token, { content: COURSE, version: d.body.data.version });
      assert.equal(intruder.status, 403, "a doctor who is neither the author nor the treating consultant cannot change the draft");
      const fixed = await putSummary(adm.id, x.doc.token, { content: { ...COURSE, advice: "Review in one week" }, version: d.body.data.version });
      assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
      const signed = await t.api("post", `/admissions/${adm.id}/discharge-summary/sign`, x.doc.token).send({ version: fixed.body.data.version });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      const afterSign = await summaryOf(x, adm.id);
      assert.equal(afterSign.hisStatus, "Signed");
      assert.equal(afterSign.preparedByName, rmo.fullName, "the RMO is still named as the preparer");
      assert.ok(afterSign.signedByName && afterSign.signedByName !== rmo.fullName, "the consultant, not the RMO, signed");
      assert.equal(afterSign.verifiedByName, null);

      // Only someone holding CONSULTATION_VERIFY can verify.
      for (const [who, u] of [["doctor", x.doc], ["nurse", x.nurse], ["cashier", x.cashier], ["receptionist", x.rec]] as const) {
        assert.equal((await verify(adm.id, u.token, { version: 1 })).status, 403, `${who} cannot verify`);
      }
      assert.equal((await verify(adm.id, rmo.token, { version: 7 })).body.error.code, "STALE_VERSION", "the version must be the current one");
      assert.equal((await verify(adm.id, rmo.token, { version: 1, extra: true })).status, 400, "unknown fields are refused");

      const ok = await verify(adm.id, rmo.token, { version: 1, note: "Medicines and follow-up checked against the chart" });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const done = await summaryOf(x, adm.id);
      assert.equal(done.status, "VERIFIED");
      assert.equal(done.hisStatus, "Verified");
      assert.equal(done.verifiedByName, rmo.fullName, "the RMO is named as the verifier");
      assert.ok(done.verifiedAt);
      assert.equal(done.verificationNote, "Medicines and follow-up checked against the chart");
      assert.equal((await status(x, adm.id)).summaryStatus, "SIGNED", "the document itself is still just signed; verification is separate");

      // Verifying twice is refused, the audit trail has it, and the record cannot be changed or removed.
      assert.equal((await verify(adm.id, rmo.token, { version: 1 })).status, 409);
      const docRow = await t.prisma.clinicalDocument.findFirstOrThrow({ where: { encounterId: adm.encounterId, kind: "DISCHARGE_SUMMARY" } });
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: x.tenant.tenantId, action: "DISCHARGE_SUMMARY_VERIFIED", entityId: docRow.id } }), 1);
      await assert.rejects(() => t.prisma.dischargeSummaryVerification.deleteMany({ where: { documentId: docRow.id } }), "a verification cannot be deleted");
      await assert.rejects(() => t.prisma.dischargeSummaryVerification.updateMany({ where: { documentId: docRow.id }, data: { note: "changed" } }), "a verification cannot be edited");
    });

    it("an amendment is a new version and has to be verified again", async () => {
      const x = await world("dis-rmo-amend");
      const rmo = await makeRmo(x);
      const { adm } = await admit(x);
      await sign(x, adm.id);
      assert.equal((await verify(adm.id, rmo.token, { version: 1 })).status, 200);
      assert.equal((await summaryOf(x, adm.id)).hisStatus, "Verified");

      const am = await t.api("post", `/admissions/${adm.id}/discharge-summary/amend`, x.doc.token).send({ expectedVersion: 1, reason: "Corrected the antibiotic duration", content: { ...COURSE, advice: "Complete 7 days of antibiotics" } });
      assert.equal(am.status, 200, JSON.stringify(am.body));
      const re = await summaryOf(x, adm.id);
      assert.equal(re.status, "AMENDED", "no longer verified");
      assert.equal(re.hisStatus, "Signed (amended, version 2)");
      assert.equal(re.verifiedByName, null);
      assert.equal((await verify(adm.id, rmo.token, { version: 1 })).body.error.code, "STALE_VERSION", "version 1 is no longer the current one");

      assert.equal((await verify(adm.id, rmo.token, { version: 2 })).status, 200);
      const again = await summaryOf(x, adm.id);
      assert.equal(again.status, "VERIFIED");
      assert.equal(again.hisStatus, "Verified (amended, version 2)");
    });

    it("the person who signed the summary cannot also verify it, even if they hold the permission", async () => {
      const x = await world("dis-rmo-signer");
      const { adm } = await admit(x);
      await sign(x, adm.id);
      const role = await t.prisma.role.findFirstOrThrow({ where: { tenantId: x.tenant.tenantId, name: "DOCTOR" } });
      await t.prisma.rolePermission.create({ data: { tenantId: x.tenant.tenantId, roleId: role.id, permission: "CONSULTATION_VERIFY" } });
      const r = await verify(adm.id, x.doc.token, { version: 1 });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.match(r.body.error.message, /signed or amended this summary cannot verify/);
    });

    it("a hospital can require verification before discharge; by default it is not required", async () => {
      const x = await world("dis-rmo-required");
      const rmo = await makeRmo(x);
      const { adm } = await admit(x);
      await clearAll(x, adm.id);
      await sign(x, adm.id);
      assert.ok(!(await status(x, adm.id)).blockers.includes("discharge summary is not verified"), "off by default: a signed summary is enough");

      assert.equal((await t.api("put", "/settings/DISCHARGE_REQUIRE_VERIFIED_SUMMARY", x.tenant.admin.token).send({ value: true })).status, 200);
      // Bill and pay first, so the summary is the only thing left.
      const fb = await finalInvoice(x, adm.id);
      assert.equal(fb.status, 200, JSON.stringify(fb.body));
      assert.equal((await payUpi(fb.body.data.invoice.id, fb.body.data.invoice.total, x.cashier.token)).status, 201);
      const blocked = await status(x, adm.id);
      assert.equal(blocked.canComplete, false);
      assert.deepEqual(blocked.blockers, ["discharge summary is not verified"]);
      assert.equal(blocked.summary.verificationRequired, true);
      const refused = await complete(x, adm.id);
      assert.equal(refused.status, 409);
      assert.match(refused.body.error.message, /not verified/);

      assert.equal((await verify(adm.id, rmo.token, { version: 1 })).status, 200);
      assert.equal((await status(x, adm.id)).canComplete, true);
      const done = await complete(x, adm.id, { type: "ROUTINE" });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal((await verify(adm.id, rmo.token, { version: 1 })).status, 409, "an admission that is already closed cannot be verified");
    });

    it("another hospital's admission cannot be verified or seen", async () => {
      const x = await world("dis-rmo-a");
      const y = await world("dis-rmo-b");
      const rmoB = await makeRmo(y);
      const { adm } = await admit(x);
      await sign(x, adm.id);
      assert.equal((await verify(adm.id, rmoB.token, { version: 1 })).status, 404);
      assert.equal(await t.prisma.dischargeSummaryVerification.count({ where: { admissionId: adm.id } }), 0);
    });
  });

  describe("clearance steps", () => {
    it("summary preparation is reported with its team and status: not started, then draft, then signed, naming who prepared and who signed", async () => {
      const x = await world("dis-summary-stage");
      const { adm } = await admit(x);

      const none = (await status(x, adm.id)).summary;
      assert.equal(none.stage, "Summary preparation");
      assert.equal(none.responsible, "RMO / treating team");
      assert.equal(none.status, "NOT_STARTED");
      assert.equal(none.hisStatus, "Not started");
      assert.equal(none.preparedByName, null);
      assert.equal(none.signedByName, null);

      const d = await t.api("put", `/admissions/${adm.id}/discharge-summary`, x.doc.token).send({ content: COURSE });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      const draft = (await status(x, adm.id)).summary;
      assert.equal(draft.status, "DRAFT");
      assert.equal(draft.hisStatus, "Draft");
      assert.ok(draft.preparedByName, "the doctor who started the draft is named");
      assert.equal(draft.signedByName, null);

      const s = await t.api("post", `/admissions/${adm.id}/discharge-summary/sign`, x.doc.token).send({ version: d.body.data.version });
      assert.equal(s.status, 200, JSON.stringify(s.body));
      const signed = (await status(x, adm.id)).summary;
      assert.equal(signed.status, "SIGNED");
      assert.equal(signed.hisStatus, "Signed");
      assert.ok(signed.signedByName && signed.signedAt, "the signer and the time are shown");
      assert.equal((await status(x, adm.id)).summaryStatus, "SIGNED", "the existing summaryStatus field is unchanged");
    });

    it("every stage names its responsible person/team and the HIS status; the doctor's decision reads 'Clinically fit / discharge advised' and records who cleared it", async () => {
      const x = await world("dis-stage-table");
      const { adm } = await admit(x);
      const row = async (step: string) => (await status(x, adm.id)).steps.find((s: { step: string }) => s.step === step);

      const before = await row("MEDICALLY_FIT");
      assert.equal(before.stage, "Discharge decision");
      assert.equal(before.responsible, "Treating doctor");
      assert.equal(before.status, "PENDING");
      assert.equal(before.hisStatus, "Awaiting doctor's decision");
      assert.equal(before.byName, null);

      assert.equal((await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token)).status, 200);
      const after = await row("MEDICALLY_FIT");
      assert.equal(after.status, "CLEARED");
      assert.equal(after.hisStatus, "Clinically fit / discharge advised");
      assert.ok(after.byName, "the doctor who cleared it is named");
      assert.ok(after.at);

      const all = (await status(x, adm.id)).steps as { stage: string; responsible: string; hisStatus: string }[];
      assert.equal(all.length, 9);
      for (const s of all) { assert.ok(s.stage && s.responsible && s.hisStatus, "every stage has a name, an owner and a status text"); }
    });

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

    it("nursing clearance: owned by the ward nurse / in-charge, shows medication, documentation and handover separately, and records the handover note", async () => {
      const x = await world("dis-nur-stage");
      const { adm, patient } = await admit(x);
      const row = async () => (await status(x, adm.id)).steps.find((s: { step: string }) => s.step === "NURSING");
      const check = (r: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) => r.checks.find((c) => c.name === name)!;
      await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token);

      const start = await row();
      assert.equal(start.stage, "Nursing clearance");
      assert.equal(start.responsible, "Ward nurse / in-charge");
      assert.equal(start.status, "PENDING");
      assert.equal(start.hisStatus, "Medication, clinical documentation or handover outstanding");
      assert.deepEqual(start.checks.map((c: { name: string }) => c.name), ["Medication", "Clinical documentation", "Handover"]);
      assert.equal(check(start, "Medication").ok, true, "no doses are overdue yet");
      assert.equal(check(start, "Handover").ok, false, "the handover is only confirmed when the nurse clears the stage");

      // A pending nursing task and an overdue dose each show up under their own heading.
      const task = (await t.api("post", `/admissions/${adm.id}/tasks`, x.nurse.token).send({ title: "Remove IV cannula", dueAt: new Date(Date.now() + 3_600_000).toISOString() })).body.data;
      await t.api("put", `/encounters/${adm.encounterId}/prescription`, x.doc.token).send({ items: [{ genericName: "Aztreonam", dosage: "1 g", route: "IV", frequency: "OTHER", frequencyText: "As directed" }] });
      const order = (await t.api("post", `/encounters/${adm.encounterId}/prescription/sign`, x.doc.token).send({})).body.data;
      const mar = await t.prisma.medicationAdministration.create({ data: { tenantId: x.tenant.tenantId, facilityId: x.tenant.facilityId, patientId: patient.id, admissionId: adm.id, encounterId: adm.encounterId, medicationOrderItemId: order.items[0].id, scheduledAt: new Date(Date.now() - 2 * 3_600_000) } });
      const open = await row();
      assert.equal(check(open, "Medication").ok, false);
      assert.match(check(open, "Medication").detail, /1 overdue dose/);
      assert.equal(check(open, "Clinical documentation").ok, false);
      assert.match(check(open, "Clinical documentation").detail, /1 nursing task/);
      assert.equal((await clear(x, adm.id, "NURSING", x.nurse.token)).status, 409, "still blocked");

      await t.api("post", `/tasks/${task.id}/complete`, x.nurse.token).send({});
      await t.api("post", `/mar/${mar.id}/administer`, x.nurse.token).send({ status: "MISSED", remarks: "Patient was off the ward" });
      await t.api("post", `/admissions/${adm.id}/notes`, x.nurse.token).send({ note: "Wound dressing done, patient mobilising." });
      const ready = await row();
      assert.equal(check(ready, "Medication").ok, true);
      assert.equal(check(ready, "Clinical documentation").ok, true);
      assert.match(check(ready, "Clinical documentation").detail, /1 nursing note/);

      // Only a nurse can give it; the doctor cannot. The handover note is stored with it.
      assert.equal((await clear(x, adm.id, "NURSING", x.doc.token)).status, 403);
      const done = await clear(x, adm.id, "NURSING", x.nurse.token, { note: "Handed over to day in-charge, drain removed" });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      const after = await row();
      assert.equal(after.status, "CLEARED");
      assert.equal(after.hisStatus, "Medication, clinical documentation and handover complete");
      assert.ok(after.byName && after.at, "who and when");
      assert.equal(after.note, "Handed over to day in-charge, drain removed");
      assert.equal(check(after, "Handover").ok, true);
      assert.match(check(after, "Handover").detail, /Handed over to day in-charge/);
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

    it("after the final bill: bed days and counter-charged medicines stay refused; a late service charge waits for a supplementary bill", async () => {
      const x = await world("dis-lock");
      const s1 = await svc(x, "Review", "100");
      const { adm, patient } = await admit(x, "300");
      await clearAll(x, adm.id);
      await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 });
      await finalInvoice(x, adm.id);
      const late = await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 });
      assert.equal(late.status, 201, JSON.stringify(late.body));
      assert.equal(late.body.data.status, "PENDING", "the late charge is pending; the first bill is not touched");
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
      assert.equal((await put("BED_RELEASE_AT", "DISCHARGE")).status, 200, "this hospital frees beds at discharge");
      assert.equal((await put("BED_RELEASE_AT", "NEVER")).status, 400);
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
      assert.equal((await t.prisma.bed.findFirstOrThrow({ where: { id: bed.id } })).status, "OCCUPIED", "kept until the patient leaves");
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
  /** A patient discharged with everything cleared and paid, the departure confirmed and the bed turned around, for the given hospital. */
  const fullJourney = async (x: World) => {
    const keeper = await t.makeUser(x.tenant, ["HOUSEKEEPING"]);
    const care = await svc(x, `Inpatient care ${uniqueWord(4)}`, "1500");
    const { adm, bed, patient } = await admit(x);
    assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.cashier.token).send({ type: "SERVICE", serviceId: care, quantity: 1 })).status, 201);
    await sign(x, adm.id);
    await clearAll(x, adm.id);
    const invoice = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
    assert.equal((await payUpi(invoice.id, invoice.total, x.cashier.token)).status, 201);
    assert.equal((await complete(x, adm.id)).status, 200);
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/departure`, x.nurse.token).send({ mode: "WALKED" })).status, 200);
    const turn = ((await t.api("get", "/bed-turnovers", keeper.token)).body.data as { id: string; bed: string }[]).find((r) => r.bed === bed.code)!;
    assert.equal((await t.api("post", `/bed-turnovers/${turn.id}/start`, keeper.token)).status, 200);
    assert.equal((await t.api("post", `/bed-turnovers/${turn.id}/ready`, keeper.token)).status, 200);
    return { adm, patient, keeper };
  };

  describe("discharge turnaround report", () => {
    it("shows how long each part of the discharge took, from the doctor's advice to the bed being ready; REPORT_IPD only; only this hospital's discharges", async () => {
      const x = await world("tat-report");
      const reader = await t.makeUser(x.tenant, ["RECEPTIONIST"]);
      const empty = (await t.api("get", "/reports/ipd/discharge-turnaround", reader.token)).body.data;
      assert.equal(empty.discharges, 0);
      assert.equal(empty.slowestToClear, null, "nothing to compare yet");
      const { adm } = await fullJourney(x);
      const res = await t.api("get", "/reports/ipd/discharge-turnaround", reader.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const d = res.body.data as { discharges: number; slowestToClear: string | null; stages: { stage: string; cases: number; averageMinutes: number | null; medianMinutes: number | null }[]; admissions: { admissionNumber: string; adviceToBedReadyMinutes: number | null; adviceToDischargeMinutes: number | null; departureToBedReadyMinutes: number | null }[] };
      assert.equal(d.discharges, 1);
      assert.equal(d.admissions[0]!.admissionNumber, adm.admissionNumber);
      const whole = d.stages.find((s) => s.stage.startsWith("Whole journey"))!;
      assert.equal(whole.cases, 1);
      assert.ok((whole.averageMinutes ?? -1) >= 0 && (d.admissions[0]!.adviceToBedReadyMinutes ?? -1) >= 0);
      for (const name of ["Nursing clearance", "Pharmacy clearance", "Final bill issued", "Dues paid or released", "Patient leaving to bed ready", "Summary signed"]) assert.ok(d.stages.some((s) => s.stage.startsWith(name) && s.cases === 1), `${name} was measured`);
      assert.ok(d.slowestToClear, "the slowest stage to clear is named");
      assert.equal((await t.api("get", "/reports/ipd/discharge-turnaround", x.cashier.token)).status, 403, "billing does not see the IPD report");
      assert.equal((await t.api("get", "/reports/ipd/discharge-turnaround?from=2026-01-01&to=2026-12-31", reader.token)).status, 400, "ranges are bounded");
      const y = await world("tat-report-other");
      const outsider = await t.makeUser(y.tenant, ["RECEPTIONIST"]);
      assert.equal((await t.api("get", "/reports/ipd/discharge-turnaround", outsider.token)).body.data.discharges, 0, "another hospital's discharges are not counted");
    });
  });

  describe("housekeeping requests", () => {
    it("anyone who may ask raises a request for a place and a job; housekeeping sees all, starts and finishes them; each step is kept once, in order", async () => {
      const x = await world("hk-requests");
      const keeper = await t.makeUser(x.tenant, ["HOUSEKEEPING"]);
      const nurse2 = await t.makeUser(x.tenant, ["NURSE"]);
      const ask = (body: Record<string, unknown>, tok = x.nurse.token) => t.api("post", "/housekeeping/requests", tok).send(body);
      const job = { kind: "CLEANING", location: "Ward A corridor", description: "Spill near the nurses' station", priority: "URGENT" };
      for (const bad of [{ ...job, kind: "PAINTING" }, { ...job, location: "x" }, { ...job, priority: "NOW" }, { ...job, extra: 1 }, { kind: "CLEANING" }]) assert.equal((await ask(bad)).status, 400, JSON.stringify(bad));
      assert.equal((await ask(job, keeper.token)).status, 403, "housekeeping does the work; it does not raise requests");
      assert.equal((await ask(job, x.cashier.token)).status, 403);
      const made = await ask(job);
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const id = made.body.data.id as string;
      const routine = (await ask({ kind: "MAINTENANCE", location: "Room 4 tap" })).body.data.id as string;
      const list = async (tok: string) => (await t.api("get", "/housekeeping/requests", tok)).body.data as { id: string; status: string; priority: string; location: string; requestedBy: string }[];
      assert.deepEqual((await list(keeper.token)).map((r) => r.id), [id, routine], "housekeeping sees everything, urgent first");
      assert.equal((await list(nurse2.token)).length, 0, "a person who may only ask sees their own requests");
      assert.equal((await list(x.nurse.token)).length, 2);
      assert.equal((await t.api("get", "/housekeeping/requests", x.cashier.token)).status, 403);
      assert.equal((await t.api("post", `/housekeeping/requests/${id}/start`, x.nurse.token)).status, 403, "only housekeeping starts the work");
      assert.equal((await t.api("post", `/housekeeping/requests/${id}/done`, keeper.token).send({})).status, 409, "start it before marking it done");
      assert.equal((await t.api("post", `/housekeeping/requests/${id}/start`, keeper.token)).status, 200);
      assert.equal((await t.api("post", `/housekeeping/requests/${id}/start`, keeper.token)).status, 409, "already started");
      const done = await t.api("post", `/housekeeping/requests/${id}/done`, keeper.token).send({ note: "Mopped and sign put up" });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal((await t.api("post", `/housekeeping/requests/${id}/done`, keeper.token).send({})).status, 409, "finished once");
      const finished = (await t.api("get", "/housekeeping/requests", keeper.token)).body.data.find((r: { id: string }) => r.id === id);
      assert.deepEqual([finished.status, finished.doneNote, typeof finished.minutesToDone], ["DONE", "Mopped and sign put up", "number"]);
      assert.equal((await t.api("post", `/housekeeping/requests/${id}/cancel`, x.nurse.token).send({ reason: "Not needed any more" })).status, 409, "a finished request cannot be cancelled");
      assert.equal((await t.api("post", `/housekeeping/requests/${routine}/cancel`, nurse2.token).send({ reason: "Not my request" })).status, 404, "another person's request is not theirs to cancel");
      assert.equal((await t.api("post", `/housekeeping/requests/${routine}/cancel`, x.nurse.token).send({ reason: "no" })).status, 400, "a reason is needed");
      assert.equal((await t.api("post", `/housekeeping/requests/${routine}/cancel`, x.nurse.token).send({ reason: "Fixed by the plumber already" })).status, 200, "the requester can withdraw an open request");
      const y = await world("hk-requests-other");
      const strangerKeeper = await t.makeUser(y.tenant, ["HOUSEKEEPING"]);
      assert.equal((await t.api("post", `/housekeeping/requests/${id}/start`, strangerKeeper.token)).status, 404, "another hospital's request does not exist for them");
      assert.equal((await t.api("get", "/housekeeping/requests", strangerKeeper.token)).body.data.length, 0);
      await assert.rejects(() => t.prisma.housekeepingRequest.update({ where: { tenantId_id: { tenantId: x.tenant.tenantId, id } }, data: { location: "Somewhere else" } }), "a request cannot be edited, even directly in the database");
      await assert.rejects(() => t.prisma.housekeepingRequest.update({ where: { tenantId_id: { tenantId: x.tenant.tenantId, id } }, data: { status: "OPEN" } }), "a finished request is final");
      await assert.rejects(() => t.prisma.housekeepingRequest.delete({ where: { tenantId_id: { tenantId: x.tenant.tenantId, id } } }), "never deleted");
      for (const action of ["HOUSEKEEPING_REQUESTED", "HOUSEKEEPING_STARTED", "HOUSEKEEPING_DONE", "HOUSEKEEPING_CANCELLED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action } }), `${action} is audited`);
    });
  });

  describe("medical-record retention", () => {
    const review = (encounterId: string, body: Record<string, unknown>, tok: string) => t.api("post", `/records/retention/${encounterId}/review`, tok).send(body);
    const listOf = async (tok: string, show = "DUE") => (await t.api("get", `/records/retention?show=${show}`, tok)).body.data as { counts: { due: number; held: number; cleared: number }; policy: { ipdYears: number }; items: { encounterId: string; state: string; retentionEnds: string; review: { decision: string } | null }[] };
    /** Makes a finished visit look as if it ended `yearsAgo` years ago. */
    const age = (encounterId: string, yearsAgo: number) => t.prisma.$executeRaw`UPDATE "Encounter" SET "startedAt" = now() - make_interval(years => ${yearsAgo + 1}::int), "endedAt" = now() - make_interval(years => ${yearsAgo}::int) WHERE id = ${encounterId}::uuid`;

    it("a record is due for review once its period is over; the Medical Records Department holds it or clears it for archive; clearing is refused while it must still be kept; nothing is deleted", async () => {
      const x = await world("retention-main");
      const mrd = await t.makeUser(x.tenant, ["MEDICAL_RECORDS"]);
      const { adm } = await fullJourney(x);
      assert.equal((await listOf(mrd.token)).policy.ipdYears, 5, "the default stays 5 years for an inpatient stay");
      assert.equal((await listOf(mrd.token)).items.length, 0, "just discharged: nothing is due");
      assert.equal((await review(adm.encounterId, { decision: "CLEAR_FOR_ARCHIVE", note: "Trying to clear too early" }, mrd.token)).status, 409, "still within its retention period");
      await age(adm.encounterId, 6);
      const due = await listOf(mrd.token);
      assert.deepEqual([due.counts.due, due.items.length, due.items[0]?.state, due.items[0]?.encounterId], [1, 1, "DUE", adm.encounterId]);
      assert.ok(due.items[0]!.retentionEnds < new Date().toISOString().slice(0, 10), "its period ended in the past");
      for (const bad of [{ decision: "HOLD", note: "no" }, { decision: "KEEP", note: "Legal case open" }, { decision: "HOLD", note: "Legal case open", retainUntil: "2020-01-01" }, { decision: "CLEAR_FOR_ARCHIVE", note: "Committee agreed", retainUntil: "2031-01-01" }, { decision: "HOLD", note: "Legal case open", extra: 1 }]) assert.equal((await review(adm.encounterId, bad, mrd.token)).status, 400, JSON.stringify(bad));
      assert.equal((await review(adm.encounterId, { decision: "HOLD", note: "Open consumer-court case" }, x.rec.token)).status, 403, "Medical Records only");
      assert.equal((await t.api("get", "/records/retention", x.cashier.token)).status, 403);
      const y = await world("retention-other");
      const outsider = await t.makeUser(y.tenant, ["MEDICAL_RECORDS"]);
      assert.equal((await review(adm.encounterId, { decision: "HOLD", note: "Not their hospital" }, outsider.token)).status, 404, "another hospital cannot decide on this record");
      assert.equal((await listOf(outsider.token)).items.length, 0);
      assert.equal((await review(adm.encounterId, { decision: "HOLD", note: "Open consumer-court case" }, mrd.token)).status, 201);
      assert.equal((await listOf(mrd.token)).items.length, 0, "a held record leaves the due list");
      const held = await listOf(mrd.token, "HELD");
      assert.deepEqual([held.counts.held, held.items[0]?.state, held.items[0]?.review?.decision], [1, "HELD", "HOLD"]);
      assert.equal((await review(adm.encounterId, { decision: "CLEAR_FOR_ARCHIVE", note: "Case closed; committee agreed" }, mrd.token)).status, 201, "an explicit clearance ends a hold that had no end date");
      assert.equal((await review(adm.encounterId, { decision: "CLEAR_FOR_ARCHIVE", note: "Cleared a second time" }, mrd.token)).status, 409, "already cleared");
      const cleared = await listOf(mrd.token, "CLEARED");
      assert.deepEqual([cleared.counts.cleared, cleared.items[0]?.state], [1, "CLEARED"]);
      assert.equal((await t.prisma.encounter.findFirst({ where: { id: adm.encounterId } }))?.status, "COMPLETED", "the record itself is untouched: nothing is deleted");
      for (const action of ["RECORD_RETENTION_HOLD", "RECORD_RETENTION_CLEARED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action, entityId: adm.encounterId } }), `${action} is audited`);
      const rev = await t.prisma.recordRetentionReview.findFirstOrThrow({ where: { tenantId: x.tenant.tenantId, encounterId: adm.encounterId } });
      await assert.rejects(() => t.prisma.recordRetentionReview.update({ where: { tenantId_id: { tenantId: x.tenant.tenantId, id: rev.id } }, data: { note: "Edited later" } }), "a decision is never edited");
      await assert.rejects(() => t.prisma.recordRetentionReview.delete({ where: { tenantId_id: { tenantId: x.tenant.tenantId, id: rev.id } } }), "nor removed");
    });

    it("the hospital sets the years; a hold with an end date lapses back to due; a child's record is kept until they are an adult plus the period", async () => {
      const x = await world("retention-policy");
      const mrd = await t.makeUser(x.tenant, ["MEDICAL_RECORDS"]);
      const { adm, patient } = await fullJourney(x);
      await age(adm.encounterId, 6);
      assert.equal((await listOf(mrd.token)).counts.due, 1);
      assert.equal((await t.api("put", "/settings/MR_RETENTION_YEARS_IPD", x.tenant.admin.token).send({ value: 0 })).status, 400, "at least one year");
      assert.equal((await t.api("put", "/settings/MR_RETENTION_YEARS_IPD", x.tenant.admin.token).send({ value: 8 })).status, 200);
      const longer = await listOf(mrd.token);
      assert.deepEqual([longer.policy.ipdYears, longer.counts.due], [8, 0], "with 8 years the 6-year-old record is not due");
      assert.equal((await t.api("put", "/settings/MR_RETENTION_YEARS_IPD", x.tenant.admin.token).send({ value: 5 })).status, 200);
      assert.equal((await listOf(mrd.token)).counts.due, 1);
      // A child: born 10 years ago, so an adult in 8 years; the period starts then, not at discharge.
      await t.prisma.$executeRaw`UPDATE "Patient" SET "dateOfBirth" = (CURRENT_DATE - interval '10 years')::date WHERE id = ${patient.id}::uuid`;
      assert.equal((await listOf(mrd.token)).counts.due, 0, "a child's record is not due");
      assert.equal((await t.api("put", "/settings/MR_RETENTION_MINORS_UNTIL_ADULT", x.tenant.admin.token).send({ value: false })).status, 200);
      assert.equal((await listOf(mrd.token)).counts.due, 1, "with the child rule off, the normal period applies again");
      // A hold with an end date keeps the record off the due list until that day.
      assert.equal((await review(adm.encounterId, { decision: "HOLD", note: "Research study until next year", retainUntil: new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10) }, mrd.token)).status, 201);
      const held = await listOf(mrd.token, "HELD");
      assert.deepEqual([(await listOf(mrd.token)).counts.due, held.counts.held, held.items[0]?.review?.decision], [0, 1, "HOLD"]);
    });
  });
  describe("cashless insurance journey, end to end", () => {
    const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    const PDF = Buffer.from("%PDF-1.4 not really a pdf");
    const cents = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
    const step = async (x: World, admId: string, name: string) => (await status(x, admId)).steps.find((r: { step: string }) => r.step === name);

    it("MANDATORY CASHLESS FLOW: payer verification → pre-auth → treatment → enhancement → final bill → non-payables → patient share → discharge → decision → settlement with TDS", async () => {
      const x = await world("cashless-journey");
      const desk = await t.makeUser(x.tenant, ["CLAIMS_OFFICER"]);
      const mrd = await t.makeUser(x.tenant, ["MEDICAL_RECORDS"]);
      const at = (path: string, body: Record<string, unknown> = {}, tok = desk.token) => t.api("post", `/claims/${path}`, tok).send(body);
      const view = async (id: string) => (await t.api("get", `/claims/${id}`, desk.token)).body.data;

      // ── admission, policy and a cashless claim opened for this admission ──
      const insurer = (await t.api("post", "/claims/insurers", desk.token).send({ name: `Mediclaim ${uniqueWord(6)}`, kind: "TPA" })).body.data as { id: string };
      const { adm, patient } = await admit(x);
      const policy = (await t.api("post", `/patients/${patient.id}/policies`, desk.token).send({ insurerId: insurer.id, policyNumber: `POL-${uniqueWord(6)}`, validFrom: iso(-30), validTo: iso(300), sumInsured: "500000", copayPercent: "10" })).body.data as { id: string };
      const opened = await t.api("post", "/claims", desk.token).send({ patientId: patient.id, policyId: policy.id, type: "CASHLESS", encounterId: adm.encounterId, diagnosis: "Pneumonia" });
      assert.equal(opened.status, 201, JSON.stringify(opened.body));
      const claimId = opened.body.data.id as string;
      assert.equal((await step(x, adm.id, "INSURANCE")).status, "PENDING", "a valid policy but nothing sent to the insurer yet: the insurance stage waits");

      // ── 1. payer verification ──
      assert.equal((await at(`${claimId}/verification`, { outcome: "NOT_ELIGIBLE", reference: "TPA-CALL-1", note: "Policy lapsed on 1 Oct" })).status, 200);
      assert.equal((await at(`${claimId}/preauth`, { requestedAmount: "30000" })).status, 409, "the insurer said not eligible: no pre-authorisation until checked again");
      assert.equal((await at(`${claimId}/verification`, { outcome: "VERIFIED", reference: "TPA-CALL-2", note: "Renewed and active" })).status, 200);

      // ── 2. pre-authorisation ──
      assert.equal((await at(`${claimId}/preauth`, { requestedAmount: "30000" })).status, 200);
      assert.equal((await step(x, adm.id, "INSURANCE")).status, "PENDING", "waiting for the insurer's answer");
      assert.equal((await at(`${claimId}/preauth-decision`, { decision: "APPROVE", amount: "25000" })).status, 200);
      assert.equal((await t.api("post", `/claims/${claimId}/documents`, desk.token).query({ filename: "preauth.pdf", label: "Pre-authorisation form" }).set("Content-Type", "application/pdf").send(PDF)).status, 201);

      // ── 3. treatment: charges against the admission ──
      const care = await svc(x, `Inpatient care ${uniqueWord(4)}`, "20000");
      assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.cashier.token).send({ type: "SERVICE", serviceId: care, quantity: 1 })).status, 201);
      assert.equal((await step(x, adm.id, "INSURANCE")).status, "PENDING", "the doctor has not advised discharge yet");

      // ── 4. enhancement request while admitted ──
      const enh = await at(`${claimId}/enhancements`, { requestedAmount: "10000", reason: "Two extra ICU days after a complication" });
      assert.equal(enh.status, 201, JSON.stringify(enh.body));
      assert.equal((await at(`${claimId}/enhancements/${enh.body.data.id}/decision`, { decision: "APPROVE", amount: "8000", reason: "Approved for 2 days" })).status, 200);
      assert.equal((await view(claimId)).preauthApproved, "33000.00", "25,000 + 8,000");

      // ── 5. discharge decision, summary, clearances; the insurance stage clears from the claim ──
      await sign(x, adm.id);
      await clearAll(x, adm.id);
      const ins = await step(x, adm.id, "INSURANCE");
      assert.equal(ins.status, "CLEARED", JSON.stringify(ins.checks));
      assert.match(ins.reconciliation.claim.claimNumber, /^CLM-/);
      assert.equal(ins.reconciliation.claim.preauthApproved, "33,000.00".replace(",", ""), "the stage shows the enhanced authorisation");

      // ── 6. final bill, then the insurer's non-payable items ──
      const bill = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      const total = Number(bill.total);
      assert.ok(total >= 20000, "the final bill carries the treatment");
      assert.equal((await at(`${claimId}/non-payables`, { description: "Admission kit", amount: "1000", reason: "Excluded in the policy schedule" })).status, 201);

      // ── 7. patient share: co-pay on what is payable; non-payable items come on top ──
      const claimable = total - 1000;
      const claimed = cents(claimable * 0.9);
      const share = cents(total - Number(claimed));
      const prev = (await at(`${claimId}/copay-preview`, { invoiceId: bill.id })).body.data;
      assert.deepEqual([prev.nonPayable, prev.claimAmount, prev.patientShare], ["1000.00", claimed, share]);
      const sub = await at(`${claimId}/submit`, { invoiceId: bill.id, note: "Final bill and discharge summary attached" });
      assert.equal(sub.status, 200, JSON.stringify(sub.body));
      const submitted = await view(claimId);
      assert.deepEqual([submitted.status, submitted.claimedAmount, submitted.copay.patientShare], ["SUBMITTED", claimed, share]);

      // ── 8. discharge: the patient pays their share; the insurer's share is awaited, not the patient's liability ──
      const billing = await step(x, adm.id, "BILLING");
      assert.equal(billing.reconciliation.patientLiability, share, "the patient owes the co-pay and the non-payable items");
      assert.equal(billing.reconciliation.insurerShare, claimed, "the insurer's share is what the claim asked for, not the whole pre-authorisation");
      assert.equal((await complete(x, adm.id)).status, 409, "the patient's share is unpaid: not discharged yet");
      assert.equal((await payUpi(bill.id, share, x.cashier.token)).status, 201);
      const ledger = (await t.api("get", `/patients/${patient.id}/ledger`, x.cashier.token)).body.data;
      assert.deepEqual([ledger.totals.insurerShare, ledger.totals.patientBalance, ledger.position], [claimed, "0.00", "AWAITING_INSURER"], "the statement shows what the insurer still owes and that the patient has paid theirs");
      const out = await complete(x, adm.id);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.equal((await t.api("get", `/admissions/${adm.id}`, x.rec.token)).body.data.status, "DISCHARGED");
      assert.match((await step(x, adm.id, "INSURANCE")).checks.find((c: { name: string }) => c.name === "Authorisation").detail, /Pre-authorisation approved for 33000\.00/, "before the insurer's decision the stage shows the authorisation");

      // ── 9. after discharge: the insurer decides, pays with TDS deducted; the claim settles and the bill closes ──
      assert.equal((await at(`${claimId}/decision`, { decision: "APPROVE", approvedAmount: claimed })).status, 200);
      assert.match((await step(x, adm.id, "INSURANCE")).checks.find((c: { name: string }) => c.name === "Authorisation").detail, new RegExp(`Claim approved by the insurer for ${Number(claimed).toFixed(2)}`), "after the decision it shows what the insurer approved");
      const owed = ((await t.api("get", "/post-discharge", mrd.token)).body.data.ageing as { insurer: string }[]).reduce((n, a) => n + Number(a.insurer), 0);
      assert.ok(owed >= Number(claimed), "the post-discharge list shows the insurer still owes this");
      const tds = cents(Number(claimed) * 0.1);
      const cash = cents(Number(claimed) - Number(tds));
      const paid = await t.api("post", `/claims/${claimId}/settlements`, desk.token).set("Idempotency-Key", key()).send({ amount: cash, tdsAmount: tds, reference: `UTR${uniqueWord(8)}`, receivedOn: iso(0) });
      assert.equal(paid.status, 201, JSON.stringify(paid.body));
      const done = await view(claimId);
      assert.deepEqual([done.status, done.settledAmount, done.outstanding], ["SETTLED", claimed, "0.00"]);
      const inv = (await t.api("get", `/invoices/${bill.id}`, x.cashier.token)).body.data;
      assert.deepEqual([inv.status, inv.paidTotal], ["PAID", cents(total)], "patient share + insurer cash + TDS = the bill");
      const after = (await t.api("get", `/patients/${patient.id}/ledger`, x.cashier.token)).body.data;
      assert.equal(after.position, "SETTLED");

      // ── the whole story is on the record, in order, and audited ──
      assert.deepEqual(done.events.map((e: { to: string }) => e.to).filter((v: string, i: number, a: string[]) => v !== a[i - 1]), ["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED", "SUBMITTED", "APPROVED", "SETTLED"]);
      for (const action of ["CLAIM_PAYER_VERIFIED", "CLAIM_PREAUTH_REQUESTED", "CLAIM_PREAUTH_APPROVED", "CLAIM_ENHANCEMENT_REQUESTED", "CLAIM_ENHANCEMENT_APPROVED", "CLAIM_NON_PAYABLE_ADDED", "CLAIM_SUBMITTED", "CLAIM_APPROVED", "CLAIM_SETTLEMENT_RECEIVED"]) {
        assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action, entityId: claimId } }), `${action} is audited`);
      }
      // ── nobody else can see or touch it ──
      const y = await world("cashless-journey-other");
      const outsider = await t.makeUser(y.tenant, ["CLAIMS_OFFICER"]);
      assert.equal((await t.api("get", `/claims/${claimId}`, outsider.token)).status, 404);
      assert.equal((await at(`${claimId}/appeals`, { reason: "Trying from another hospital" }, outsider.token)).status, 404);
      assert.equal((await at(`${claimId}/verification`, { outcome: "VERIFIED", reference: "NOPE-1" }, x.nurse.token)).status, 403);
    });
  });
  describe("discharge to bed-ready, end to end", () => {
    it("MANDATORY DISCHARGE-TO-BED-READY FLOW: advice → summary → departmental clearance → bill → discharge → physical exit → housekeeping → bed available for the next patient", async () => {
      const x = await world("bed-ready-journey");
      const keeper = await t.makeUser(x.tenant, ["HOUSEKEEPING"]);
      const manager = await t.makeUser(x.tenant, ["MANAGER"]);
      const care = await svc(x, `Inpatient care ${uniqueWord(4)}`, "3000");
      const { adm, bed, patient } = await admit(x);
      const bedOf = async () => ((await t.api("get", "/beds", x.tenant.admin.token)).body.data as { id: string; status: string }[]).find((b) => b.id === bed.id)?.status;
      const stepOf = async (name: string) => (await status(x, adm.id)).steps.find((r: { step: string }) => r.step === name);
      const turn = async () => (await status(x, adm.id)).turnover;
      const exit = async () => (await status(x, adm.id)).exit;
      assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.cashier.token).send({ type: "SERVICE", serviceId: care, quantity: 2 })).status, 201);
      assert.equal(await bedOf(), "OCCUPIED");

      // ── the stages, each with its owner, in the order the doctor's advice opens them ──
      const owners = Object.fromEntries((await status(x, adm.id)).steps.map((r: { step: string; responsible: string }) => [r.step, r.responsible]));
      assert.equal(owners["MEDICALLY_FIT"], "Treating doctor");
      assert.equal(owners["NURSING"], "Ward nurse / in-charge");
      assert.equal(owners["PHARMACY"], "Inpatient pharmacist");
      assert.equal(owners["LAB_RADIOLOGY"], "Relevant departments");
      assert.equal(owners["INSURANCE"], "TPA desk + external payer");
      assert.equal(owners["BILLING"], "IP billing");

      // ── 1. nothing starts before the doctor advises discharge ──
      assert.equal((await clear(x, adm.id, "NURSING", x.nurse.token)).status, 409, "the doctor's decision comes first");
      assert.equal((await complete(x, adm.id)).status, 409, "no discharge before the advice");
      assert.equal((await clear(x, adm.id, "MEDICALLY_FIT", x.nurse.token)).status, 403, "only the treating doctor advises discharge");
      assert.equal((await clear(x, adm.id, "MEDICALLY_FIT", x.doc.token)).status, 200);
      assert.equal((await stepOf("MEDICALLY_FIT")).status, "CLEARED");

      // ── 2. the summary ──
      assert.equal((await complete(x, adm.id)).status, 409, "no discharge without a signed summary");
      await sign(x, adm.id);
      assert.equal((await status(x, adm.id)).summary.status, "SIGNED");

      // ── 3. departmental clearance: each by its own team ──
      assert.equal((await clear(x, adm.id, "NURSING", x.cashier.token)).status, 403, "billing cannot clear the ward's stage");
      assert.equal((await clear(x, adm.id, "PHARMACY", x.nurse.token)).status, 403, "the nurse cannot clear the pharmacy's stage");
      assert.equal((await clear(x, adm.id, "NURSING", x.nurse.token)).status, 200);
      assert.equal((await clear(x, adm.id, "CHARGES_REVIEWED", x.cashier.token)).status, 200);
      assert.equal((await clear(x, adm.id, "PHARMACY", x.pharm.token)).status, 200);
      for (const auto of ["LAB_RADIOLOGY", "OT_PROCEDURE", "INSURANCE"]) assert.equal((await stepOf(auto)).status, "CLEARED", `${auto} reconciles itself (nothing ordered, nothing planned, self-pay)`);

      // ── 4. bill: the final bill, then the patient's payment ──
      assert.equal((await stepOf("BILLING")).status, "PENDING", "the final bill is not generated yet");
      const bill = (await finalInvoice(x, adm.id)).body.data.invoice as { id: string; total: string };
      assert.equal((await complete(x, adm.id)).status, 409, "the bill is unpaid: not discharged");
      assert.equal((await payUpi(bill.id, bill.total, x.cashier.token)).status, 201);
      assert.equal((await stepOf("BILLING")).status, "CLEARED");
      assert.equal((await stepOf("FINANCIAL_RELEASE")).status, "CLEARED");

      // ── 5. the doctor completes the discharge; the bed is kept until the patient has really gone ──
      assert.equal((await complete(x, adm.id, {}, x.nurse.token)).status, 403, "only the doctor discharges");
      assert.equal((await complete(x, adm.id)).status, 200);
      assert.equal((await t.api("get", `/admissions/${adm.id}`, x.rec.token)).body.data.status, "DISCHARGED");
      assert.equal((await exit()).status, "PENDING");
      assert.equal((await turn()).status, "AWAITING_DEPARTURE", "the bed is still theirs");
      assert.equal(await bedOf(), "OCCUPIED");
      const other = await registerPatient(t, x.rec.token);
      const admitNext = () => t.api("post", "/admissions", x.rec.token).send({ patientId: other.id, consultantId: x.doc.practitionerId, bedId: bed.id, reason: "Fever needing observation" });
      assert.equal((await admitNext()).status, 409, "the next patient cannot take a bed that is not free");

      // ── 6. physical exit, confirmed by the ward nurse ──
      assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/departure`, keeper.token).send({ mode: "WALKED" })).status, 403, "housekeeping does not confirm departures");
      assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/departure`, x.nurse.token).send({ mode: "WHEELCHAIR", escortedBy: "Son" })).status, 200);
      assert.equal((await exit()).status, "CONFIRMED");
      assert.equal((await turn()).status, "VACATED");
      assert.equal(await bedOf(), "CLEANING", "vacated: cleaning has not started");
      assert.equal((await admitNext()).status, 409, "a bed being cleaned cannot take a patient");

      // ── 7. housekeeping: sees the bed (never the patient), starts cleaning, marks it ready ──
      const queue = (await t.api("get", "/bed-turnovers", keeper.token)).body.data as { id: string; bed: string; stage: string }[];
      const mine = queue.find((r) => r.bed === bed.code)!;
      assert.equal(mine.stage, "VACATED");
      assert.ok(!JSON.stringify(queue).includes(patient.id), "housekeeping never sees the patient");
      assert.equal((await t.api("post", `/bed-turnovers/${mine.id}/ready`, keeper.token).send({})).status, 409, "cleaning has to start first");
      assert.equal((await t.api("post", `/bed-turnovers/${mine.id}/start`, keeper.token).send({})).status, 200);
      assert.equal((await turn()).status, "CLEANING");
      assert.equal(await bedOf(), "CLEANING");
      assert.equal((await t.api("post", `/bed-turnovers/${mine.id}/ready`, keeper.token).send({})).status, 200);

      // ── 8. the bed is available again, and the next patient can have it ──
      assert.equal((await turn()).status, "READY");
      assert.equal(await bedOf(), "AVAILABLE");
      const next = await admitNext();
      assert.equal(next.status, 201, JSON.stringify(next.body));
      assert.equal(await bedOf(), "OCCUPIED", "the bed is in use again");

      // ── the manager sees this journey in the turnaround report; everything was audited ──
      const rep = (await t.api("get", "/reports/ipd/discharge-turnaround", manager.token)).body.data as { discharges: number; admissions: { admissionNumber: string; adviceToBedReadyMinutes: number | null; departureToBedReadyMinutes: number | null }[] };
      const row = rep.admissions.find((r) => r.admissionNumber === adm.admissionNumber)!;
      assert.ok(row && row.adviceToBedReadyMinutes !== null && row.departureToBedReadyMinutes !== null, "advice-to-bed-ready is measured");
      for (const action of ["PATIENT_DEPARTURE_CONFIRMED", "BED_CLEANING_STARTED", "BED_TURNOVER_READY"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action } }), `${action} is audited`);
      // ── and nobody in another hospital can reach any of it ──
      const y = await world("bed-ready-journey-other");
      const strangerKeeper = await t.makeUser(y.tenant, ["HOUSEKEEPING"]);
      assert.equal((await t.api("post", `/bed-turnovers/${mine.id}/start`, strangerKeeper.token).send({})).status, 404);
      assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/departure`, y.nurse.token).send({ mode: "WALKED" })).status, 404);
    });
  });
});
