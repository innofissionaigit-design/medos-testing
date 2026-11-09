import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerPatient, startApp, type TestApp, type TestTenant } from "../../test/harness";

describe("taking cash never needs a manual shift opening", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const bill = async (cashier: string, patientId: string, amount = "100") => {
    const inv = await t.api("post", "/invoices", cashier).send({ patientId, lines: [{ description: "Dressing", unitPrice: amount, taxPercent: 0, quantity: 1 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal((await t.api("post", `/invoices/${inv.body.data.id}/issue`, cashier)).status, 200);
    return inv.body.data.id as string;
  };
  const pay = (cashier: string, id: string, method: string, amount: string) => t.api("post", `/invoices/${id}/payments`, cashier).set("Idempotency-Key", key()).send({ payments: [{ method, amount, ...(method === "CASH" ? {} : { reference: "REF-0001" }) }] });
  const openShifts = (tenant: TestTenant, userId: string) => t.prisma.cashierShift.count({ where: { tenantId: tenant.tenantId, cashierId: userId, status: "OPEN" } });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("shf-a");
    b = await t.makeTenant("shf-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
  });
  after(async () => { await t.close(); });

  it("the first cash payment opens the shift by itself, with no opening cash, and the receipt is on it", async () => {
    const p = await registerPatient(t, rec.token);
    const cashier = await t.makeUser(a, ["CASHIER"]);
    assert.equal(await openShifts(a, cashier.id), 0);
    const inv = await bill(cashier.token, p.id);
    const r = await pay(cashier.token, inv, "CASH", "100.00");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const shifts = await t.prisma.cashierShift.findMany({ where: { tenantId: a.tenantId, cashierId: cashier.id } });
    assert.equal(shifts.length, 1);
    assert.deepEqual([shifts[0]?.status, shifts[0]?.openingCash.toFixed(2)], ["OPEN", "0.00"]);
    const receipt = await t.prisma.receipt.findFirstOrThrow({ where: { id: r.body.data.receipt.id } });
    assert.equal(receipt.shiftId, shifts[0]?.id);
    const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "SHIFT_OPENED", entityId: shifts[0]?.id } });
    assert.equal((ev.metadata as Record<string, unknown>)["automatic"], true);
    const cur = (await t.api("get", "/shifts/current", cashier.token)).body.data;
    assert.deepEqual([cur.status, cur.collectionsByMethod.CASH], ["OPEN", "100.00"]);
    // The next payment uses the same shift; closing it counts the cash as always.
    const inv2 = await bill(cashier.token, p.id, "50");
    assert.equal((await pay(cashier.token, inv2, "CASH", "50.00")).status, 201);
    assert.equal(await t.prisma.cashierShift.count({ where: { tenantId: a.tenantId, cashierId: cashier.id } }), 1);
    const closed = await t.api("post", `/shifts/${cur.id}/close`, cashier.token).send({ actualCash: "150.00" });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.data.difference, "0.00");
  });

  it("several cash payments at once still make exactly one shift", async () => {
    const p = await registerPatient(t, rec.token);
    const cashier = await t.makeUser(a, ["CASHIER"]);
    const ids = await Promise.all(Array.from({ length: 4 }, () => bill(cashier.token, p.id, "10")));
    const rs = await Promise.all(ids.map((id) => pay(cashier.token, id, "CASH", "10.00")));
    assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.status).join());
    assert.equal(await t.prisma.cashierShift.count({ where: { tenantId: a.tenantId, cashierId: cashier.id } }), 1);
    assert.equal(await openShifts(a, cashier.id), 1);
  });

  it("UPI and card do not open a shift; cash taken by Reception, advances and cash refunds work the same way", async () => {
    const p = await registerPatient(t, rec.token);
    const cashier = await t.makeUser(a, ["CASHIER"]);
    const inv = await bill(cashier.token, p.id, "200");
    assert.equal((await pay(cashier.token, inv, "UPI", "50.00")).status, 201);
    assert.equal(await openShifts(a, cashier.id), 0, "no cash, no shift");
    const adv = await t.api("post", `/patients/${p.id}/advances`, rec.token).set("Idempotency-Key", key()).send({ tenders: [{ method: "CASH", amount: "300.00" }] });
    assert.equal(adv.status, 201, JSON.stringify(adv.body));
    assert.equal(await openShifts(a, rec.id), 1, "Reception's own shift opened for the advance");
    assert.equal((await pay(cashier.token, inv, "CASH", "150.00")).status, 201);
    const refund = await t.api("post", `/invoices/${inv}/refunds`, cashier.token).set("Idempotency-Key", key()).send({ method: "CASH", amount: "50.00", reason: "Patient left before the service" });
    assert.ok([201, 409].includes(refund.status), JSON.stringify(refund.body));
    assert.notEqual(refund.body.error?.code, "SHIFT_NOT_OPEN");
  });

  it("a hospital can switch it off, and then cash needs an open shift again; the setting belongs to the hospital", async () => {
    const p = await registerPatient(t, rec.token);
    assert.equal((await t.api("put", "/settings/CASH_AUTO_OPEN_SHIFT", rec.token).send({ value: false })).status, 403, "set by an administrator");
    assert.equal((await t.api("put", "/settings/CASH_AUTO_OPEN_SHIFT", a.admin.token).send({ value: false })).status, 200);
    const strict = await t.makeUser(a, ["CASHIER"]);
    const inv = await bill(strict.token, p.id);
    const r = await pay(strict.token, inv, "CASH", "100.00");
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "SHIFT_NOT_OPEN");
    assert.equal(await openShifts(a, strict.id), 0);
    assert.equal((await t.api("post", "/shifts/open", strict.token).send({ openingCash: "0" })).status, 201);
    assert.equal((await pay(strict.token, inv, "CASH", "100.00")).status, 201);
    // Another hospital is unaffected.
    const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
    const bCashier = await t.makeUser(b, ["CASHIER"]);
    const bp = await registerPatient(t, bRec.token);
    const binv = await bill(bCashier.token, bp.id);
    assert.equal((await pay(bCashier.token, binv, "CASH", "100.00")).status, 201);
    assert.equal((await t.api("put", "/settings/CASH_AUTO_OPEN_SHIFT", a.admin.token).send({ value: true })).status, 200);
  });
});
