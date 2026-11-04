import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

let seq = 0;
const code = (p: string) => `${p}${(++seq).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`.slice(0, 14);
const key = () => `k-${randomUUID().slice(0, 18)}`;

interface Line { collected: string; doctorShare: string; hospitalShare: string; trigger: string }
interface Visit { encounterId: string; doctor: string; model: string; billed: string; collected: string; doctorShare: string; hospitalNet: string; paidFromDeposit: string; bills: { id: string; kind: string }[]; entries: Line[]; rule: { mode: string; percent: string | null; fixedAmount: string | null } | null }

describe("doctor share ledger: commission or fixed value, the ledger, the final bill and deposits", () => {
  let t: TestApp;
  type World = { tenant: TestTenant; manager: { id: string; token: string }; rec: { id: string; token: string }; cashier: { id: string; token: string }; nurse: { id: string; token: string }; pharm: { id: string; token: string }; doc: TestDoctor };
  let other: TestTenant;

  const world = async (label: string) => {
    const tenant = await t.makeTenant(label);
    const x = { tenant, manager: await t.makeUser(tenant, ["MANAGER"]), rec: await t.makeUser(tenant, ["RECEPTIONIST"]), cashier: await t.makeUser(tenant, ["CASHIER"]), nurse: await t.makeUser(tenant, ["NURSE"]), pharm: await t.makeUser(tenant, ["PHARMACIST"]), doc: await makeDoctor(t, tenant) };
    assert.equal((await t.api("post", "/shifts/open", x.cashier.token).send({ openingCash: "0" })).status, 201);
    return x;
  };
  const addRule = (x: World, body: Record<string, unknown>, tok = x.tenant.admin.token) => t.api("post", "/earnings/rules", tok).send(body);
  const setModel = (x: World, model: string, tok = x.tenant.admin.token) => t.api("put", "/earnings/model", tok).send({ model });
  /** A visit with a consultation bill of the given amount, issued and not yet paid. */
  const visit = async (x: World, billed: string, kind: "OPD" | "IPD" = "OPD") => {
    const p = await registerPatient(t, x.rec.token);
    const v = await startVisit(t, x.rec.token, x.doc, p.id);
    const inv = await t.api("post", "/invoices", x.cashier.token).send({ patientId: p.id, encounterId: v.encounterId, kind, lines: [{ description: "Consultation", unitPrice: billed, taxPercent: 0, quantity: 1 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal((await t.api("post", `/invoices/${inv.body.data.id}/issue`, x.cashier.token)).status, 200);
    return { patient: p, encounterId: v.encounterId, invoiceId: inv.body.data.id as string };
  };
  const bill = async (x: World, patientId: string, encounterId: string, amount: string) => {
    const inv = await t.api("post", "/invoices", x.cashier.token).send({ patientId, encounterId, kind: "OPD", lines: [{ description: "Procedure", unitPrice: amount, taxPercent: 0, quantity: 1 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal((await t.api("post", `/invoices/${inv.body.data.id}/issue`, x.cashier.token)).status, 200);
    return inv.body.data.id as string;
  };
  const pay = (x: World, invoiceId: string, amount: string) => t.api("post", `/invoices/${invoiceId}/payments`, x.cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount }] });
  /** Money given back on a paid bill: the bill is first reduced with a credit note (the rule of the billing ledger), then the overpayment is refunded. */
  const refund = async (x: World, invoiceId: string, amount: string, method = "CASH") => {
    const c = await t.api("post", `/invoices/${invoiceId}/credit-notes`, x.manager.token).set("Idempotency-Key", key()).send({ amount, reason: "Part of the service was not given" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    return t.api("post", `/invoices/${invoiceId}/refunds`, x.cashier.token).set("Idempotency-Key", key()).send({ method, amount, reason: "Patient left before treatment" });
  };
  const view = async (x: World, encounterId: string, tok = x.cashier.token) => (await t.api("get", `/earnings/visits/${encounterId}`, tok)).body.data as Visit;
  const nums = (v: Visit) => [v.collected, v.doctorShare, v.hospitalNet];
  const entryCount = (x: World, encounterId: string) => t.prisma.doctorShareEntry.count({ where: { tenantId: x.tenant.tenantId, encounterId } });

  before(async () => {
    t = await startApp();
    other = await t.makeTenant("shr-b");
  });
  after(async () => { await t.close(); });

  describe("choosing commission or fixed value", () => {
    it("starts as either one for each doctor; only EARNINGS_CONFIGURE changes it, reports staff and cashiers can read it", async () => {
      const x = await world("shr-m1");
      assert.deepEqual((await t.api("get", "/earnings/model", x.tenant.admin.token)).body.data, { model: "BOTH" });
      for (const [who, tok] of [["reception", x.rec.token], ["cashier", x.cashier.token], ["doctor", x.doc.token], ["nurse", x.nurse.token]] as const) assert.equal((await setModel(x, "COMMISSION", tok)).status, 403, `${who} cannot change the model`);
      assert.equal((await t.api("get", "/earnings/model", x.cashier.token)).status, 200);
      assert.equal((await t.api("get", "/earnings/model", x.rec.token)).status, 403);
      assert.equal((await t.api("get", "/earnings/model")).status, 401);
      assert.equal((await setModel(x, "SOMETHING")).status, 400);
      assert.equal((await t.api("put", "/earnings/model", x.tenant.admin.token).send({ model: "COMMISSION", extra: 1 })).status, 400);
      assert.deepEqual((await setModel(x, "FIXED_VALUE")).body.data, { model: "FIXED_VALUE" });
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action: "SETTING_CHANGED", entityId: "EARNINGS_MODEL" } }), "the change is audited");
    });

    it("new rules must follow the choice: commission takes percentage rules, fixed value takes fixed amounts, either takes any", async () => {
      const x = await world("shr-m2");
      assert.equal((await setModel(x, "COMMISSION")).status, 200);
      assert.equal((await addRule(x, { mode: "FIXED", fixedAmount: "300" })).status, 400);
      assert.equal((await addRule(x, { mode: "MIXED", fixedAmount: "100", percent: 10 })).status, 400);
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 40 })).status, 201);
      assert.equal((await setModel(x, "FIXED_VALUE")).status, 200);
      const refused = await addRule(x, { mode: "PERCENT", percent: 40 });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error.message, /fixed value/);
      assert.equal((await addRule(x, { mode: "FIXED", fixedAmount: "300" })).status, 201);
      assert.equal((await setModel(x, "BOTH")).status, 200);
      assert.equal((await addRule(x, { mode: "MIXED", fixedAmount: "100", percent: 10 })).status, 201);
      assert.equal(((await t.api("get", "/earnings/rules", x.tenant.admin.token)).body.data as unknown[]).length, 3, "earlier rules stay as history");
    });
  });

  describe("commission in the ledger", () => {
    it("every payment and refund adds a ledger line; the final numbers are the sum of the lines", async () => {
      const x = await world("shr-c1");
      assert.equal((await setModel(x, "COMMISSION")).status, 200);
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 40 })).status, 201);
      const v = await visit(x, "500");
      assert.equal(await entryCount(x, v.encounterId), 0, "nothing is earned before money is received");
      assert.equal((await pay(x, v.invoiceId, "200")).status, 201);
      assert.deepEqual(nums(await view(x, v.encounterId)), ["200.00", "80.00", "120.00"]);
      assert.equal((await pay(x, v.invoiceId, "300")).status, 201);
      const full = await view(x, v.encounterId);
      assert.deepEqual(nums(full), ["500.00", "200.00", "300.00"]);
      assert.deepEqual(full.entries.map((e) => [e.trigger, e.collected, e.doctorShare, e.hospitalShare]), [["PAYMENT", "200.00", "80.00", "120.00"], ["PAYMENT", "300.00", "120.00", "180.00"]]);
      assert.equal(full.billed, "500.00");
      assert.equal(full.model, "COMMISSION");
      assert.deepEqual(full.rule, { mode: "PERCENT", percent: "40.00", fixedAmount: null });
      // A refund gives a negative line, so the doctor's share falls with the money.
      assert.equal((await refund(x, v.invoiceId, "100")).status, 201);
      const afterRefund = await view(x, v.encounterId);
      assert.deepEqual(nums(afterRefund), ["400.00", "160.00", "240.00"]);
      assert.deepEqual(afterRefund.entries.at(-1), { ...afterRefund.entries.at(-1)!, trigger: "REFUND", collected: "-100.00", doctorShare: "-40.00", hospitalShare: "-60.00" });
      const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: x.tenant.tenantId, action: "DOCTOR_SHARE_POSTED", entityType: "DoctorShareEntry" }, orderBy: { createdAt: "asc" } });
      assert.equal((ev.metadata as Record<string, unknown>)["ruleMode"], "PERCENT");
      assert.equal(JSON.stringify(ev.metadata).includes(v.patient.id), false, "no patient details in the audit line");
    });

    it("the ledger page lists the lines with totals for the hospital and for each doctor", async () => {
      const x = await world("shr-c2");
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 25 })).status, 201);
      const v1 = await visit(x, "400");
      const v2 = await visit(x, "1000");
      assert.equal((await pay(x, v1.invoiceId, "400")).status, 201);
      assert.equal((await pay(x, v2.invoiceId, "600")).status, 201);
      const r = await t.api("get", "/earnings/ledger", x.cashier.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.data.totals, { collected: "1000.00", doctorShare: "250.00", hospitalShare: "750.00" });
      assert.equal(r.body.data.entries.length, 2);
      assert.equal(r.body.data.doctors.length, 1);
      assert.deepEqual([r.body.data.doctors[0].collected, r.body.data.doctors[0].doctorShare], ["1000.00", "250.00"]);
      assert.equal((await t.api("get", `/earnings/ledger?practitionerId=${randomUUID()}`, x.cashier.token)).body.data.entries.length, 0);
      assert.equal((await t.api("get", "/earnings/ledger?from=2026-01-01&to=2026-12-31", x.cashier.token)).status, 400, "at most 93 days");
      assert.equal((await t.api("get", "/earnings/ledger?from=2026-05-02&to=2026-05-01", x.cashier.token)).status, 400);
      assert.equal((await t.api("get", "/earnings/ledger?foo=1", x.cashier.token)).status, 400);
    });

    it("a rule added later never changes a visit that has already earned: the visit keeps the rule it started with", async () => {
      const x = await world("shr-c3");
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 40 })).status, 201);
      const v = await visit(x, "1000");
      assert.equal((await pay(x, v.invoiceId, "500")).status, 201);
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 90 })).status, 201);
      assert.equal((await pay(x, v.invoiceId, "500")).status, 201);
      assert.deepEqual(nums(await view(x, v.encounterId)), ["1000.00", "400.00", "600.00"], "40% of 1000, not 90%");
      const fresh = await visit(x, "100");
      assert.equal((await pay(x, fresh.invoiceId, "100")).status, 201);
      assert.deepEqual(nums(await view(x, fresh.encounterId)), ["100.00", "90.00", "10.00"], "a new visit uses the newest rule");
    });

    it("other bills (not the doctor's fee), credit notes and unpaid bills do not move the ledger; no rule means nothing is posted", async () => {
      const x = await world("shr-c4");
      const noRule = await visit(x, "300");
      assert.equal((await pay(x, noRule.invoiceId, "300")).status, 201);
      assert.equal(await entryCount(x, noRule.encounterId), 0, "no rule, no lines");
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 50 })).status, 201);
      const v = await visit(x, "400");
      const other2 = await t.api("post", "/invoices", x.cashier.token).send({ patientId: v.patient.id, encounterId: v.encounterId, kind: "OTHER", lines: [{ description: "Dressing", unitPrice: "200", taxPercent: 0, quantity: 1 }] });
      assert.equal(other2.status, 201, JSON.stringify(other2.body));
      assert.equal((await t.api("post", `/invoices/${other2.body.data.id}/issue`, x.cashier.token)).status, 200);
      assert.equal((await pay(x, other2.body.data.id, "200")).status, 201);
      assert.equal(await entryCount(x, v.encounterId), 0, "other charges are not the doctor's fee");
      assert.equal((await pay(x, v.invoiceId, "100")).status, 201);
      assert.equal(await entryCount(x, v.encounterId), 1);
      const credit = await t.api("post", `/invoices/${v.invoiceId}/credit-notes`, x.manager.token).set("Idempotency-Key", key()).send({ amount: "50", reason: "Discount allowed afterwards" });
      assert.equal(credit.status, 201, JSON.stringify(credit.body));
      assert.equal(await entryCount(x, v.encounterId), 1, "a credit note moves no money");
      assert.deepEqual(nums(await view(x, v.encounterId)), ["100.00", "50.00", "50.00"]);
    });
  });

  describe("fixed value in the ledger", () => {
    it("the fixed amount is earned as money comes in, never more than was collected, and falls back when money is returned", async () => {
      const x = await world("shr-f1");
      assert.equal((await setModel(x, "FIXED_VALUE")).status, 200);
      assert.equal((await addRule(x, { mode: "FIXED", fixedAmount: "300" })).status, 201);
      const v = await visit(x, "500");
      assert.equal((await pay(x, v.invoiceId, "100")).status, 201);
      assert.deepEqual(nums(await view(x, v.encounterId)), ["100.00", "100.00", "0.00"], "the doctor cannot get more than was collected");
      assert.equal((await pay(x, v.invoiceId, "400")).status, 201);
      assert.deepEqual(nums(await view(x, v.encounterId)), ["500.00", "300.00", "200.00"], "the fixed 300, however much is paid");
      assert.equal((await refund(x, v.invoiceId, "450")).status, 201);
      assert.deepEqual(nums(await view(x, v.encounterId)), ["50.00", "50.00", "0.00"]);
      assert.equal((await view(x, v.encounterId)).model, "FIXED_VALUE");
    });

    it("a doctor's own rule beats the default: fixed for one doctor, commission for another", async () => {
      const x = await world("shr-f2");
      const other3 = await makeDoctor(t, x.tenant);
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 20 })).status, 201);
      assert.equal((await addRule(x, { mode: "FIXED", fixedAmount: "250", practitionerId: other3.practitionerId })).status, 201);
      const a1 = await visit(x, "1000");
      assert.equal((await pay(x, a1.invoiceId, "1000")).status, 201);
      const p = await registerPatient(t, x.rec.token);
      const v = await startVisit(t, x.rec.token, other3, p.id);
      const inv = await t.api("post", "/invoices", x.cashier.token).send({ patientId: p.id, encounterId: v.encounterId, kind: "OPD", lines: [{ description: "Consultation", unitPrice: "1000", taxPercent: 0, quantity: 1 }] });
      assert.equal((await t.api("post", `/invoices/${inv.body.data.id}/issue`, x.cashier.token)).status, 200);
      assert.equal((await pay(x, inv.body.data.id, "1000")).status, 201);
      assert.deepEqual(nums(await view(x, a1.encounterId)), ["1000.00", "200.00", "800.00"]);
      assert.deepEqual(nums(await view(x, v.encounterId)), ["1000.00", "250.00", "750.00"]);
      const r = await t.api("get", "/earnings/ledger", x.cashier.token);
      assert.deepEqual(r.body.data.totals, { collected: "2000.00", doctorShare: "450.00", hospitalShare: "1550.00" });
      assert.equal(r.body.data.doctors.length, 2);
    });
  });

  describe("the final bill and deposits", () => {
    it("money used from the patient's advance counts when it is applied to the bill, not when it is taken; giving it back reverses the share", async () => {
      const x = await world("shr-d1");
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 40 })).status, 201);
      const v = await visit(x, "1000");
      const dep = await t.api("post", `/patients/${v.patient.id}/advances`, x.cashier.token).set("Idempotency-Key", key()).send({ tenders: [{ method: "CASH", amount: "600" }] });
      assert.equal(dep.status, 201, JSON.stringify(dep.body));
      assert.equal(await entryCount(x, v.encounterId), 0, "an advance is the patient's money held, not a collection for the visit");
      assert.equal((await t.api("post", `/invoices/${v.invoiceId}/advances`, x.cashier.token).set("Idempotency-Key", key()).send({ amount: "600" })).status, 201);
      const used = await view(x, v.encounterId);
      assert.deepEqual(nums(used), ["600.00", "240.00", "360.00"]);
      assert.equal(used.paidFromDeposit, "600.00");
      assert.equal((await pay(x, v.invoiceId, "400")).status, 201);
      const done = await view(x, v.encounterId);
      assert.deepEqual(nums(done), ["1000.00", "400.00", "600.00"]);
      assert.equal(done.billed, "1000.00");
      assert.equal(done.paidFromDeposit, "600.00");
      // Refunding "by other" goes back into the advance first, and the doctor's share falls with it.
      const back = await refund(x, v.invoiceId, "300", "OTHER");
      assert.equal(back.status, 201, JSON.stringify(back.body));
      const refunded = await view(x, v.encounterId);
      assert.deepEqual(nums(refunded), ["700.00", "280.00", "420.00"]);
      assert.equal(refunded.paidFromDeposit, "300.00", "the part returned to the advance is no longer used");
    });

    it("the in-patient final bill counts: raise it, pay it in two parts, and the visit shows what was billed, collected, earned and kept", async () => {
      const x = await world("shr-d2");
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 30 })).status, 201);
      const svc = (await t.api("post", "/services", x.tenant.admin.token).send({ code: code("S"), name: "Nebulisation", category: "PROCEDURE", price: "500", taxPercent: 0 })).body.data.id as string;
      const ward = (await t.api("post", "/wards", x.tenant.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
      const room = (await t.api("post", "/rooms", x.tenant.admin.token).send({ wardId: ward.id, name: "Room", code: code("R") })).body.data;
      const bed = (await t.api("post", "/beds", x.tenant.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: "1000" })).body.data;
      const patient = await registerPatient(t, x.rec.token);
      const adm = (await t.api("post", "/admissions", x.rec.token).send({ patientId: patient.id, consultantId: x.doc.practitionerId, bedId: bed.id, reason: "Pneumonia needing IV antibiotics" })).body.data as { id: string; encounterId: string };
      assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: svc, quantity: 2 })).status, 201);
      for (const [step, tok] of [["MEDICALLY_FIT", x.doc.token], ["NURSING", x.nurse.token], ["CHARGES_REVIEWED", x.cashier.token], ["PHARMACY", x.pharm.token]] as const) assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/clear`, tok).send({ step })).status, 200);
      const fb = await t.api("post", `/admissions/${adm.id}/discharge/final-invoice`, x.cashier.token);
      assert.equal(fb.status, 200, JSON.stringify(fb.body));
      const invoiceId = fb.body.data.invoice.id as string;
      const total = Number(fb.body.data.invoice.total);
      assert.ok(total >= 2000, "two nebulisations and a bed day");
      const first = (total / 2).toFixed(2);
      assert.equal((await pay(x, invoiceId, first)).status, 201);
      assert.equal((await pay(x, invoiceId, (total - Number(first)).toFixed(2))).status, 201);
      const v = await view(x, adm.encounterId);
      assert.equal(v.bills[0]!.kind, "IPD");
      assert.equal(v.billed, total.toFixed(2));
      assert.equal(v.collected, total.toFixed(2));
      assert.equal(v.doctorShare, (total * 0.3).toFixed(2));
      assert.equal(v.hospitalNet, (total * 0.7).toFixed(2));
      assert.equal(v.entries.length, 2);
    });
  });

  describe("safety", () => {
    it("who can read it: hospital managers and finance staff, never reception, nurses, pharmacists or doctors; nothing crosses hospitals", async () => {
      const x = await world("shr-s1");
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 40 })).status, 201);
      const v = await visit(x, "500");
      assert.equal((await pay(x, v.invoiceId, "500")).status, 201);
      for (const path of ["/earnings/ledger", `/earnings/visits/${v.encounterId}`, "/earnings/model"]) {
        assert.equal((await t.api("get", path, x.cashier.token)).status, 200, path);
        assert.equal((await t.api("get", path, x.tenant.admin.token)).status, 200, path);
        for (const [who, tok] of [["reception", x.rec.token], ["nurse", x.nurse.token], ["pharmacist", x.pharm.token], ["doctor", x.doc.token]] as const) assert.equal((await t.api("get", path, tok)).status, 403, `${who} ${path}`);
        assert.equal((await t.api("get", path)).status, 401, path);
      }
      assert.equal((await t.api("get", `/earnings/visits/${v.encounterId}`, other.admin.token)).status, 404, "another hospital's visit cannot be found");
      assert.equal((await t.api("get", `/earnings/visits/${randomUUID()}`, x.cashier.token)).status, 404);
      assert.equal((await t.api("get", "/earnings/visits/not-an-id", x.cashier.token)).status, 404);
      const theirs = await t.api("get", "/earnings/ledger", other.admin.token);
      assert.equal(theirs.status, 200);
      assert.equal(theirs.body.data.entries.length, 0, "the other hospital sees none of these lines");
      assert.deepEqual(theirs.body.data.totals, { collected: "0.00", doctorShare: "0.00", hospitalShare: "0.00" });
    });

    it("ledger lines cannot be edited or deleted, must add up, and must belong to the same hospital's visit, bill and rule", async () => {
      const x = await world("shr-s2");
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 40 })).status, 201);
      const v = await visit(x, "500");
      assert.equal((await pay(x, v.invoiceId, "500")).status, 201);
      const line = await t.prisma.doctorShareEntry.findFirstOrThrow({ where: { encounterId: v.encounterId } });
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "DoctorShareEntry" SET "doctorDelta" = 1 WHERE id = '${line.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "DoctorShareEntry" WHERE id = '${line.id}'::uuid`), /append-only/);
      const cols = `"tenantId", "facilityId", "encounterId", "patientId", "practitionerId", "invoiceId", trigger, "ruleId", "ruleMode", "createdById"`;
      const vals = (tenantId: string, facilityId: string) => `'${tenantId}'::uuid, '${facilityId}'::uuid, '${v.encounterId}'::uuid, '${v.patient.id}'::uuid, '${x.doc.practitionerId}'::uuid, '${v.invoiceId}'::uuid, 'PAYMENT', '${line.ruleId}'::uuid, 'PERCENT', '${x.tenant.admin.id}'::uuid`;
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "DoctorShareEntry" (${cols}, "collectedDelta", "doctorDelta", "hospitalDelta") VALUES (${vals(x.tenant.tenantId, x.tenant.facilityId)}, 10, 4, 5)`), /doctor_share_entry_adds_up|check constraint/i);
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "DoctorShareEntry" (${cols}, "collectedDelta", "doctorDelta", "hospitalDelta") VALUES (${vals(other.tenantId, other.facilityId)}, 10, 4, 6)`), /same hospital|foreign key|violates/i);
    });

    it("two payments at the same moment on two bills of one visit post the share exactly once", async () => {
      const x = await world("shr-s3");
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 40 })).status, 201);
      const v = await visit(x, "300");
      const second = await bill(x, v.patient.id, v.encounterId, "700");
      const [r1, r2] = await Promise.all([pay(x, v.invoiceId, "300"), pay(x, second, "700")]);
      assert.deepEqual([r1.status, r2.status], [201, 201], JSON.stringify([r1.body, r2.body]));
      const done = await view(x, v.encounterId);
      assert.deepEqual(nums(done), ["1000.00", "400.00", "600.00"], "40% of 1000, posted once");
      const sum = await t.prisma.doctorShareEntry.aggregate({ where: { encounterId: v.encounterId }, _sum: { collectedDelta: true, doctorDelta: true, hospitalDelta: true } });
      assert.deepEqual([String(sum._sum.collectedDelta), String(sum._sum.doctorDelta), String(sum._sum.hospitalDelta)], ["1000", "400", "600"]);
    });

    it("a repeated payment request (same key) replays the receipt and posts nothing twice", async () => {
      const x = await world("shr-s4");
      assert.equal((await addRule(x, { mode: "PERCENT", percent: 40 })).status, 201);
      const v = await visit(x, "500");
      const k = key();
      const send = () => t.api("post", `/invoices/${v.invoiceId}/payments`, x.cashier.token).set("Idempotency-Key", k).send({ payments: [{ method: "CASH", amount: "500" }] });
      const [a1, a2] = [await send(), await send()];
      assert.equal(a1.status, 201);
      assert.ok([200, 201].includes(a2.status));
      assert.equal(await entryCount(x, v.encounterId), 1);
      assert.deepEqual(nums(await view(x, v.encounterId)), ["500.00", "200.00", "300.00"]);
    });
  });
});
