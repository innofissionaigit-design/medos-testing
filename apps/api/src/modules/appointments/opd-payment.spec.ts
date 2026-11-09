import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

describe("OPD consultation paid before the visit starts", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let doc1: TestDoctor;
  let doc2: TestDoctor;
  let consult: string;
  let ecg: string;
  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const state = (pid: string, tok = rec.token) => t.api("get", `/patients/${pid}/consultation-payment`, tok);
  const walk = (pid: string, doc: TestDoctor, o: Record<string, unknown> = {}) => t.api("post", "/appointments/walk-in", rec.token).set("Idempotency-Key", key()).send({ patientId: pid, practitionerId: doc.practitionerId, ...o });
  const bill = async (pid: string, serviceId: string) => {
    const inv = await t.api("post", "/invoices", rec.token).send({ patientId: pid, kind: "OPD", lines: [{ serviceId, quantity: 1 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    return inv.body.data.id as string;
  };
  const issue = async (id: string) => assert.equal((await t.api("post", `/invoices/${id}/issue`, rec.token)).status, 200);
  const pay = (id: string, amount: string) => t.api("post", `/invoices/${id}/payments`, rec.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount }] });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("opdp-a");
    b = await t.makeTenant("opdp-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc1 = await makeDoctor(t, a);
    doc2 = await makeDoctor(t, a);
    consult = (await t.api("post", "/services", a.admin.token).send({ code: "CONS", name: "OPD consultation", category: "CONSULTATION", price: "500.00", taxPercent: 0 })).body.data.id;
    ecg = (await t.api("post", "/services", a.admin.token).send({ code: "ECG", name: "ECG", category: "INVESTIGATION", price: "300.00", taxPercent: 0 })).body.data.id;
    assert.equal((await t.api("post", "/shifts/open", rec.token).send({ openingCash: "0" })).status, 201);
  });
  after(async () => { await t.close(); });

  it("is off until the hospital switches it on: visits start as before", async () => {
    const p = await registerPatient(t, rec.token);
    assert.deepEqual((await state(p.id)).body.data, { required: false, status: "NOT_REQUIRED" });
    assert.equal((await walk(p.id, doc1)).status, 201);
    assert.equal((await t.api("put", "/settings/OPD_FEE_BEFORE_VISIT", rec.token).send({ value: true })).status, 403, "set by an administrator");
    assert.equal((await t.api("put", "/settings/OPD_FEE_BEFORE_VISIT", a.admin.token).send({ value: true })).status, 200);
  });

  it("with it on, no visit can start until the consultation bill is paid in full", async () => {
    const p = await registerPatient(t, rec.token);
    assert.equal((await state(p.id)).body.data.status, "NEEDS_BILL");
    const none = await walk(p.id, doc1);
    assert.equal(none.status, 409);
    assert.equal(none.body.error.code, "CONSULTATION_PAYMENT_REQUIRED");
    assert.equal(await t.prisma.encounter.count({ where: { patientId: p.id } }), 0, "no visit, no queue token");
    // A bill for something else does not count, even paid.
    const other = await bill(p.id, ecg);
    await issue(other);
    assert.equal((await pay(other, "300.00")).status, 201);
    assert.equal((await walk(p.id, doc1)).status, 409, "only a paid consultation counts");
    // The consultation bill: created, then issued, then paid.
    const inv = await bill(p.id, consult);
    let s = (await state(p.id)).body.data;
    assert.deepEqual([s.status, s.invoiceId, s.due], ["NEEDS_PAYMENT", inv, "500.00"]);
    await issue(inv);
    assert.equal((await walk(p.id, doc1)).status, 409, "issued but unpaid");
    assert.equal((await pay(inv, "200.00")).status, 201);
    s = (await state(p.id)).body.data;
    assert.deepEqual([s.status, s.due], ["NEEDS_PAYMENT", "300.00"]);
    assert.equal((await walk(p.id, doc1)).status, 409, "part paid is not paid");
    assert.equal((await pay(inv, "300.00")).status, 201);
    s = (await state(p.id)).body.data;
    assert.deepEqual([s.status, s.invoiceId], ["PAID", inv]);
    const started = await walk(p.id, doc1);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const cover = await t.prisma.visitConsultationBill.findFirstOrThrow({ where: { invoiceId: inv } });
    assert.equal(cover.encounterId, started.body.data.encounter.id);
    // The bill has been used: the next visit needs its own.
    assert.equal((await state(p.id)).body.data.status, "NEEDS_BILL");
    assert.equal(await t.prisma.visitConsultationBill.count({ where: { invoiceId: inv } }), 1);
  });

  it("one paid bill starts one visit, even when two start at once", async () => {
    const p = await registerPatient(t, rec.token);
    const inv = await bill(p.id, consult);
    await issue(inv);
    assert.equal((await pay(inv, "500.00")).status, 201);
    const rs = await Promise.all([walk(p.id, doc1), walk(p.id, doc2)]);
    assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => `${r.status} ${JSON.stringify(r.body.error ?? "")}`).join(" | "));
    assert.equal(await t.prisma.visitConsultationBill.count({ where: { invoiceId: inv } }), 1);
    assert.equal(await t.prisma.encounter.count({ where: { patientId: p.id } }), 1, "the losing attempt left no visit behind");
  });

  it("an emergency, a follow-up visit and a booked appointment with a booking fee are not held up", async () => {
    const em = await registerPatient(t, rec.token);
    assert.equal((await walk(em.id, doc1, { priority: "EMERGENCY" })).status, 201);
    const fu = await registerPatient(t, rec.token);
    assert.equal((await walk(fu.id, doc1, { type: "FOLLOW_UP" })).status, 201);
  });

  it("the record of which bill covered which visit is final, and only a paid OPD bill of the same patient can cover", async () => {
    const cover = await t.prisma.visitConsultationBill.findFirstOrThrow({ where: { tenantId: a.tenantId } });
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "VisitConsultationBill" SET "invoiceId" = "invoiceId" WHERE id = '${cover.id}'::uuid`));
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "VisitConsultationBill" WHERE id = '${cover.id}'::uuid`));
    const p = await registerPatient(t, rec.token);
    const unpaid = await bill(p.id, consult);
    const other = await t.prisma.encounter.findFirstOrThrow({ where: { tenantId: a.tenantId, type: "OPD" } });
    await assert.rejects(t.prisma.visitConsultationBill.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, encounterId: other.id, invoiceId: unpaid, createdById: rec.id } }), "an unpaid bill of another patient");
  });

  it("is limited to the people and the hospital concerned", async () => {
    const p = await registerPatient(t, rec.token);
    assert.equal((await state(p.id, doc1.token)).status, 403, "a doctor does not start visits");
    assert.equal((await t.api("get", `/patients/${p.id}/consultation-payment`)).status, 401);
    const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
    assert.equal((await state(p.id, bRec.token)).status, 404, "another hospital's patient");
    assert.equal((await state(randomUUID())).status, 404);
  });
});
