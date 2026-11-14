import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

let seq = 0;
const code = (p: string) => `${p}${(++seq).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`.slice(0, 14);
const key = () => `k-${randomUUID().slice(0, 18)}`;

interface World { tenant: TestTenant; rec: { id: string; token: string }; nurse: { id: string; token: string }; cashier: { id: string; token: string }; pharm: { id: string; token: string }; doc: TestDoctor }

/** Late charges after the final bill go on a separate small bill; the first bill is never altered (docs/discharge-flow.md). */
describe("supplementary bill for charges after the final bill", () => {
  let t: TestApp;

  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  const world = async (label: string): Promise<World> => {
    const tenant = await t.makeTenant(label);
    return { tenant, rec: await t.makeUser(tenant, ["RECEPTIONIST"]), nurse: await t.makeUser(tenant, ["NURSE"]), cashier: await t.makeUser(tenant, ["CASHIER"]), pharm: await t.makeUser(tenant, ["PHARMACIST"]), doc: await makeDoctor(t, tenant) };
  };
  const admit = async (x: World) => {
    const ward = (await t.api("post", "/wards", x.tenant.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    const room = (await t.api("post", "/rooms", x.tenant.admin.token).send({ wardId: ward.id, name: "Room", code: code("R") })).body.data;
    const bed = (await t.api("post", "/beds", x.tenant.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: "1000" })).body.data;
    const patient = await registerPatient(t, x.rec.token);
    const r = await t.api("post", "/admissions", x.rec.token).send({ patientId: patient.id, consultantId: x.doc.practitionerId, bedId: bed.id, reason: "Pneumonia needing IV antibiotics" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string };
  };
  const svc = async (x: World, name: string, price: string) => (await t.api("post", "/services", x.tenant.admin.token).send({ code: code("S"), name, category: "PROCEDURE", price, taxPercent: "0" })).body.data.id as string;
  const clear = (admId: string, step: string, tok: string) => t.api("post", `/admissions/${admId}/discharge/clear`, tok).send({ step });
  const status = async (x: World, admId: string) => (await t.api("get", `/admissions/${admId}/discharge`, x.doc.token)).body.data;
  const pay = (invoiceId: string, amount: string, tok: string) => t.api("post", `/invoices/${invoiceId}/payments`, tok).set("Idempotency-Key", key()).send({ payments: [{ method: "UPI", amount, reference: "UPI-SUPP-01" }] });
  /** Admit, add one charge, clear every pre-billing step, issue and pay the final bill. */
  const billed = async (x: World) => {
    const s1 = await svc(x, "Review", "100");
    const adm = await admit(x);
    assert.equal((await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 })).status, 201);
    for (const [step, tok] of [["MEDICALLY_FIT", x.doc.token], ["NURSING", x.nurse.token], ["CHARGES_REVIEWED", x.cashier.token], ["PHARMACY", x.pharm.token]] as const) assert.equal((await clear(adm.id, step, tok)).status, 200);
    const fb = await t.api("post", `/admissions/${adm.id}/discharge/final-invoice`, x.cashier.token);
    assert.equal(fb.status, 200, JSON.stringify(fb.body));
    const invId = fb.body.data.invoice.id as string;
    const inv = (await t.api("get", `/invoices/${invId}`, x.cashier.token)).body.data;
    assert.equal((await pay(invId, inv.total, x.cashier.token)).status, 201);
    return { s1, adm, invId, total: inv.total as string, lineCount: inv.lines.length as number };
  };

  it("a late charge is accepted, shows as not ready, and the final bill is untouched until it is billed separately", async () => {
    const x = await world("supp-a");
    const { s1, adm, invId, total, lineCount } = await billed(x);
    const before = await status(x, adm.id);
    assert.equal(before.steps.find((s: { step: string }) => s.step === "BILLING").status, "CLEARED");

    const late = await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 2 });
    assert.equal(late.status, 201, JSON.stringify(late.body));
    assert.equal(late.body.data.status, "PENDING");

    // The checklist says so, and the discharge cannot complete over it.
    const st = await status(x, adm.id);
    const billing = st.steps.find((s: { step: string }) => s.step === "BILLING");
    assert.equal(billing.status, "PENDING");
    assert.match(billing.blockers.join(" "), /supplementary bill/);
    assert.equal(st.canComplete, false);
    assert.match(st.blockers.join(" "), /late charges have not been billed/);

    // The preview shows the late charge waiting and the final bill as issued.
    const pv = (await t.api("get", `/admissions/${adm.id}/discharge/bill-preview`, x.doc.token)).body.data;
    assert.equal(pv.waiting.kind, "LATE");
    assert.equal(pv.waiting.count, 1);
    assert.equal(pv.waiting.total, "200.00");
    assert.equal(pv.finalBill.id, invId);

    // Only billing staff bill it.
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/supplementary-invoice`, x.nurse.token)).status, 403);
    const sb = await t.api("post", `/admissions/${adm.id}/discharge/supplementary-invoice`, x.cashier.token);
    assert.equal(sb.status, 200, JSON.stringify(sb.body));
    assert.equal(sb.body.data.invoice.sequence, 1);
    assert.equal(sb.body.data.invoice.total, "200.00");
    assert.notEqual(sb.body.data.invoice.id, invId, "a separate bill");

    // The first bill is exactly as it was.
    const first = (await t.api("get", `/invoices/${invId}`, x.cashier.token)).body.data;
    assert.equal(first.total, total);
    assert.equal(first.lines.length, lineCount, "no line was added to the first bill");
    assert.equal(await t.prisma.charge.count({ where: { admissionId: adm.id, status: "BILLED", invoiceId: sb.body.data.invoice.id } }), 1);
    assert.equal(await t.prisma.charge.count({ where: { admissionId: adm.id, status: "PENDING" } }), 0);

    // Nothing left to bill; the new bill must be paid before the billing stage clears again.
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/supplementary-invoice`, x.cashier.token)).status, 409);
    const owing = await status(x, adm.id);
    assert.equal(owing.steps.find((s: { step: string }) => s.step === "BILLING").status, "PENDING");
    assert.equal(owing.steps.find((s: { step: string }) => s.step === "BILLING").reconciliation.patientLiability, "200.00");
    assert.equal((await pay(sb.body.data.invoice.id, "200.00", x.cashier.token)).status, 201);
    const paid = await status(x, adm.id);
    assert.equal(paid.steps.find((s: { step: string }) => s.step === "BILLING").status, "CLEARED");
    assert.equal(paid.steps.find((s: { step: string }) => s.step === "BILLING").reconciliation.supplementaryBills.length, 1);

    const audit = await t.prisma.auditEvent.count({ where: { tenantId: x.tenant.tenantId, action: "SUPPLEMENTARY_INVOICE_CREATED", entityId: adm.id } });
    assert.equal(audit, 1);
  });

  it("a second late charge makes bill number 2; the first supplementary bill is never changed", async () => {
    const x = await world("supp-b");
    const { s1, adm } = await billed(x);
    await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 });
    const one = await t.api("post", `/admissions/${adm.id}/discharge/supplementary-invoice`, x.cashier.token);
    await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 3 });
    const two = await t.api("post", `/admissions/${adm.id}/discharge/supplementary-invoice`, x.cashier.token);
    assert.equal(one.body.data.invoice.sequence, 1);
    assert.equal(two.body.data.invoice.sequence, 2);
    assert.equal(two.body.data.invoice.total, "300.00");
    assert.equal((await t.api("get", `/invoices/${one.body.data.invoice.id}`, x.cashier.token)).body.data.total, "100.00");
    // The records are append-only.
    await assert.rejects(() => t.prisma.$executeRaw`DELETE FROM "SupplementaryBill" WHERE "admissionId" = ${adm.id}::uuid`);
  });

  it("two cashiers billing at once produce one supplementary bill", async () => {
    const x = await world("supp-c");
    const { s1, adm } = await billed(x);
    await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 });
    const [a, b] = await Promise.all([t.api("post", `/admissions/${adm.id}/discharge/supplementary-invoice`, x.cashier.token), t.api("post", `/admissions/${adm.id}/discharge/supplementary-invoice`, x.cashier.token)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(await t.prisma.supplementaryBill.count({ where: { admissionId: adm.id } }), 1);
  });

  it("refuses a supplementary bill before the final bill, and never crosses hospitals", async () => {
    const x = await world("supp-d");
    const y = await world("supp-e");
    const s1 = await svc(x, "Review", "100");
    const adm = await admit(x);
    await t.api("post", `/admissions/${adm.id}/charges`, x.nurse.token).send({ serviceId: s1, quantity: 1 });
    const early = await t.api("post", `/admissions/${adm.id}/discharge/supplementary-invoice`, x.cashier.token);
    assert.equal(early.status, 409);
    const pv = (await t.api("get", `/admissions/${adm.id}/discharge/bill-preview`, x.doc.token)).body.data;
    assert.equal(pv.waiting.kind, "FINAL");
    assert.equal(pv.finalBillReady, false, "not ready: the doctor has not cleared the patient");
    // Another hospital's staff cannot see or bill this admission (not found, not forbidden).
    assert.equal((await t.api("get", `/admissions/${adm.id}/discharge/bill-preview`, y.doc.token)).status, 404);
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/supplementary-invoice`, y.cashier.token)).status, 404);
  });
});
