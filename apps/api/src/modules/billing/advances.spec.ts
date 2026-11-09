import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeUserWithPermissions, registerPatient, startApp, type TestApp, type TestTenant } from "../../test/harness";

describe("advance payments: deposits taken, used against invoices, given back", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let approver: { id: string; token: string };

  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const cashierWithShift = async (tenant = a, cash = "1000") => {
    const u = await t.makeUser(tenant, ["CASHIER"]);
    const s = await t.api("post", "/shifts/open", u.token).send({ openingCash: cash });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    return { ...u, shiftId: s.body.data.id as string };
  };
  const take = (patientId: string, tenders: unknown[], tok: string, k = key(), note?: string) =>
    t.api("post", `/patients/${patientId}/advances`, tok).set("Idempotency-Key", k).send({ tenders, ...(note ? { note } : {}) });
  const apply = (invoiceId: string, amount: string, tok: string, k = key()) => t.api("post", `/invoices/${invoiceId}/advances`, tok).set("Idempotency-Key", k).send({ amount });
  const giveBack = (depositId: string, body: Record<string, unknown>, tok: string, k = key()) => t.api("post", `/advances/${depositId}/refunds`, tok).set("Idempotency-Key", k).send(body);
  const issued = async (total: string, patientId: string, tok: string) => {
    const d = await t.api("post", "/invoices", tok).send({ patientId, lines: [{ description: "Procedure", unitPrice: total, taxPercent: 0, quantity: 1 }] });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.equal((await t.api("post", `/invoices/${d.body.data.id}/issue`, tok)).status, 200);
    return d.body.data.id as string;
  };
  const list = async (patientId: string, tok: string) => (await t.api("get", `/patients/${patientId}/advances`, tok)).body.data as { balance: string; items: { id: string; balance: string }[] };
  const invoice = async (id: string, tok: string) => (await t.api("get", `/invoices/${id}`, tok)).body.data;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("adv-a");
    b = await t.makeTenant("adv-b");
    // These tests check the strict rule (cash needs an open shift), which a hospital can choose; the default opens one automatically (cash-shift.spec.ts).
    assert.equal((await t.api("put", "/settings/CASH_AUTO_OPEN_SHIFT", a.admin.token).send({ value: false })).status, 200);
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    approver = await makeUserWithPermissions(t, a, ["INVOICE_READ", "INVOICE_ADJUST", "INVOICE_CANCEL", "PAYMENT_REFUND"]);
  });
  after(async () => { await t.close(); });

  describe("taking an advance", () => {
    it("takes a split advance, gives a receipt number, and an identical retry is replayed, not charged twice", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      const k = key();
      const tenders = [{ method: "CASH", amount: "500" }, { method: "UPI", amount: "700", reference: "UPI-123456" }];
      const r = await take(p.id, tenders, c.token, k, "For the planned surgery");
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.match(r.body.data.receiptNumber, /^RCT-/);
      assert.deepEqual([r.body.data.amount, r.body.data.balance], ["1200.00", "1200.00"]);
      const again = await take(p.id, tenders, c.token, k, "For the planned surgery");
      assert.equal(again.status, 200);
      assert.equal(again.body.data.id, r.body.data.id);
      assert.equal(await t.prisma.advanceDeposit.count({ where: { tenantId: a.tenantId, patientId: p.id } }), 1);
      assert.equal((await list(p.id, c.token)).balance, "1200.00");
    });
    it("needs an idempotency key, a reference for non-cash, an open shift for cash, and a real amount", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      assert.equal((await t.api("post", `/patients/${p.id}/advances`, c.token).send({ tenders: [{ method: "CASH", amount: "10" }] })).status, 400);
      assert.equal((await take(p.id, [{ method: "UPI", amount: "10" }], c.token)).status, 400);
      assert.equal((await take(p.id, [{ method: "CASH", amount: "0" }], c.token)).status, 400);
      assert.equal((await take(p.id, [{ method: "CASH", amount: "10.505" }], c.token)).status, 400);
      const noShift = await t.makeUser(a, ["CASHIER"]);
      const r = await take(p.id, [{ method: "CASH", amount: "10" }], noShift.token);
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "SHIFT_NOT_OPEN");
      assert.equal((await take(p.id, [{ method: "UPI", amount: "10", reference: "UPI-777777" }], noShift.token)).status, 201, "non-cash needs no shift");
    });
    it("is for cashiers and reception; other roles and other hospitals are refused", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      const body = [{ method: "CASH", amount: "50" }];
      const nurse = await t.makeUser(a, ["NURSE"]);
      assert.equal((await take(p.id, body, nurse.token)).status, 403);
      assert.equal((await t.api("post", `/patients/${p.id}/advances`).set("Idempotency-Key", key()).send({ tenders: body })).status, 401);
      const bc = await cashierWithShift(b);
      assert.equal((await take(p.id, body, bc.token)).status, 404, "another hospital cannot see this patient");
      assert.equal((await take(p.id, body, c.token)).status, 201);
    });
  });

  describe("using an advance against an invoice", () => {
    it("pays an invoice step by step; the invoice, the receipt and the balance all agree", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      const dep = (await take(p.id, [{ method: "CASH", amount: "1200" }], c.token)).body.data;
      const invId = await issued("1000", p.id, c.token);

      const first = await apply(invId, "600", c.token);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      let i = await invoice(invId, c.token);
      assert.deepEqual([i.status, i.paidTotal, i.balanceDue], ["PARTIALLY_PAID", "600.00", "400.00"]);
      assert.equal((await list(p.id, c.token)).balance, "600.00");

      assert.equal((await apply(invId, "500", c.token)).body.error.code, "PAYMENT_EXCEEDS_BALANCE", "more than the invoice owes");
      const second = await apply(invId, "400", c.token);
      assert.equal(second.status, 201);
      i = await invoice(invId, c.token);
      assert.deepEqual([i.status, i.balanceDue], ["PAID", "0.00"]);
      const view = (await t.api("get", `/advances/${dep.id}`, c.token)).body.data;
      assert.deepEqual([view.used, view.balance, view.uses.length], ["1000.00", "200.00", 2]);

      const pay = await t.prisma.payment.findMany({ where: { tenantId: a.tenantId, receipt: { invoiceId: invId } } });
      assert.ok(pay.every((x) => x.method === "OTHER" && x.advanceUseId), "paid through ordinary receipts, marked as advance-funded");
    });
    it("cannot use more than the patient has, or on a draft, and an identical retry does not spend twice", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      await take(p.id, [{ method: "CASH", amount: "300" }], c.token);
      const invId = await issued("1000", p.id, c.token);
      const over = await apply(invId, "301", c.token);
      assert.equal(over.status, 409);
      assert.equal(over.body.error.code, "INSUFFICIENT_ADVANCE");
      const draft = await t.api("post", "/invoices", c.token).send({ patientId: p.id, lines: [{ description: "Draft", unitPrice: "50", taxPercent: 0, quantity: 1 }] });
      assert.equal((await apply(draft.body.data.id, "50", c.token)).status, 409);
      const k = key();
      assert.equal((await apply(invId, "200", c.token, k)).status, 201);
      assert.equal((await apply(invId, "200", c.token, k)).status, 200, "replayed");
      assert.equal((await list(p.id, c.token)).balance, "100.00");
    });
    it("spends the oldest advance first and can draw on several in one go", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      const d1 = (await take(p.id, [{ method: "CASH", amount: "100" }], c.token)).body.data;
      const d2 = (await take(p.id, [{ method: "UPI", amount: "300", reference: "UPI-222222" }], c.token)).body.data;
      const invId = await issued("250", p.id, c.token);
      assert.equal((await apply(invId, "250", c.token)).status, 201);
      const one = (await t.api("get", `/advances/${d1.id}`, c.token)).body.data;
      const two = (await t.api("get", `/advances/${d2.id}`, c.token)).body.data;
      assert.deepEqual([one.balance, two.balance], ["0.00", "150.00"]);
      const receipts = await t.prisma.receipt.count({ where: { tenantId: a.tenantId, invoiceId: invId } });
      assert.equal(receipts, 1, "one receipt for the invoice");
    });
    it("two cashiers spending the same advance at once cannot overspend it", async () => {
      const c1 = await cashierWithShift();
      const c2 = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      await take(p.id, [{ method: "CASH", amount: "500" }], c1.token);
      const i1 = await issued("500", p.id, c1.token);
      const i2 = await issued("500", p.id, c1.token);
      const [x, y] = await Promise.all([apply(i1, "500", c1.token), apply(i2, "500", c2.token)]);
      assert.deepEqual([x.status, y.status].sort(), [201, 409], JSON.stringify([x.body.error, y.body.error]));
      assert.equal((await list(p.id, c1.token)).balance, "0.00");
    });
    it("is refused for other hospitals' invoices and for people who cannot take payments", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      await take(p.id, [{ method: "CASH", amount: "100" }], c.token);
      const invId = await issued("100", p.id, c.token);
      assert.equal((await apply(invId, "100", (await t.makeUser(a, ["NURSE"])).token)).status, 403);
      const bc = await cashierWithShift(b);
      assert.equal((await apply(invId, "100", bc.token)).status, 404);
      assert.equal((await t.api("get", `/advances/${randomUUID()}`, c.token)).status, 404);
    });
  });

  describe("giving an advance back", () => {
    it("gives back what is left, by the method it came in, and never more", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      const dep = (await take(p.id, [{ method: "CASH", amount: "400" }, { method: "UPI", amount: "600", reference: "UPI-888888" }], c.token)).body.data;
      const invId = await issued("700", p.id, c.token);
      await apply(invId, "700", c.token);
      const reason = "Patient discharged, balance returned";
      assert.equal((await giveBack(dep.id, { method: "CASH", amount: "301", reason }, c.token)).status, 409, "more than is left");
      const r = await giveBack(dep.id, { method: "CASH", amount: "300", reason }, c.token);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.advance.balance, "0.00");
      assert.equal((await giveBack(dep.id, { method: "CASH", amount: "1", reason }, c.token)).status, 409);
    });
    it("only by a method it was received through, with a reference for non-cash and an open shift for cash, and only by people allowed to refund", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      const dep = (await take(p.id, [{ method: "CASH", amount: "500" }], c.token)).body.data;
      const reason = "Patient asked for the money back";
      assert.equal((await giveBack(dep.id, { method: "UPI", amount: "100", reason, reference: "UPI-999999" }, c.token)).status, 409, "no UPI was taken");
      assert.equal((await giveBack(dep.id, { method: "CASH", amount: "100", reason: "no" }, c.token)).status, 400);
      const noShift = await t.makeUser(a, ["CASHIER"]);
      assert.equal((await giveBack(dep.id, { method: "CASH", amount: "100", reason }, noShift.token)).body.error.code, "SHIFT_NOT_OPEN");
      assert.equal((await giveBack(dep.id, { method: "CASH", amount: "100", reason }, rec.token)).status, 403);
      assert.equal((await giveBack(dep.id, { method: "CASH", amount: "100", reason }, c.token)).status, 201);
    });
  });

  describe("refunding a bill that was paid from an advance", () => {
    const refundInvoice = (invoiceId: string, body: Record<string, unknown>, tok: string, k = key()) => t.api("post", `/invoices/${invoiceId}/refunds`, tok).set("Idempotency-Key", k).send(body);
    const REASON = "Procedure was not done";
    const creditNote = (invoiceId: string, amount: string) => t.api("post", `/invoices/${invoiceId}/credit-notes`, approver.token).set("Idempotency-Key", key()).send({ amount, reason: REASON });
    const cancelWith = (invoiceId: string, amount: string) => t.api("post", `/invoices/${invoiceId}/cancel`, approver.token).send({ reason: "Billed to the wrong patient", refunds: [{ method: "OTHER", amount }] });

    it("puts the advance-funded part back into the advance, with no cash paid out and no reference needed", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      const dep = (await take(p.id, [{ method: "CASH", amount: "800" }], c.token)).body.data;
      const invId = await issued("500", p.id, c.token);
      await apply(invId, "500", c.token);
      assert.equal((await list(p.id, c.token)).balance, "300.00");
      assert.equal((await creditNote(invId, "200")).status, 201, "the bill is reduced first; the overpayment is then refundable");
      const r = await refundInvoice(invId, { method: "OTHER", amount: "200", reason: REASON }, approver.token);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await list(p.id, c.token)).balance, "500.00", "200 came back into the advance");
      const row = await t.prisma.refund.findFirstOrThrow({ where: { tenantId: a.tenantId, invoiceId: invId } });
      assert.equal(row.advanceReturned.toString(), "200");
      const view = (await t.api("get", `/advances/${dep.id}`, c.token)).body.data;
      assert.deepEqual([view.used, view.returned, view.balance, view.returns.length], ["500.00", "200.00", "500.00", 1]);
      const i = await invoice(invId, c.token);
      assert.deepEqual([i.refundedTotal, i.netReceived], ["200.00", "300.00"]);
      assert.equal(i.status, "PAID");
    });
    it("cancelling a paid bill returns everything to the advance, and the patient can use it again", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      await take(p.id, [{ method: "UPI", amount: "400", reference: "UPI-343434" }], c.token);
      const first = await issued("400", p.id, c.token);
      await apply(first, "400", c.token);
      assert.equal((await list(p.id, c.token)).balance, "0.00");
      const cancel = await cancelWith(first, "400");
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      assert.equal((await list(p.id, c.token)).balance, "400.00");
      const second = await issued("250", p.id, c.token);
      assert.equal((await apply(second, "250", c.token)).status, 201);
      assert.equal((await list(p.id, c.token)).balance, "150.00");
    });
    it("a real payment on the same bill is refunded normally: only the advance part goes back, the rest needs a reference", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      await take(p.id, [{ method: "CASH", amount: "100" }], c.token);
      const invId = await issued("300", p.id, c.token);
      await apply(invId, "100", c.token);
      const pay = await t.api("post", `/invoices/${invId}/payments`, c.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: "200" }] });
      assert.equal(pay.status, 201);
      assert.equal((await creditNote(invId, "100")).status, 201);
      const tooMuch = await refundInvoice(invId, { method: "OTHER", amount: "100", reason: REASON, reference: "REF-123456" }, approver.token);
      assert.equal(tooMuch.status, 201, JSON.stringify(tooMuch.body));
      assert.equal((await list(p.id, c.token)).balance, "100.00", "the whole 100 went back to the advance, none paid out");
      const row = await t.prisma.refund.findFirstOrThrow({ where: { tenantId: a.tenantId, invoiceId: invId } });
      assert.equal(row.advanceReturned.toString(), "100");
      const split = await refundInvoice(invId, { method: "OTHER", amount: "50", reason: REASON, reference: "REF-654321" }, approver.token);
      assert.equal(split.status, 409, "nothing more is refundable");
    });
    it("the books do not count the returned part as money paid out", async () => {
      const c = await cashierWithShift(a, "0");
      const p = await registerPatient(t, rec.token);
      await take(p.id, [{ method: "CASH", amount: "600" }], c.token);
      const invId = await issued("600", p.id, c.token);
      await apply(invId, "600", c.token);
      assert.equal((await cancelWith(invId, "600")).status, 200);
      const shift = (await t.api("get", `/shifts/${c.shiftId}`, c.token)).body.data;
      assert.equal(shift.expectedCash, "600.00", "the 600 taken is still in the drawer");
      assert.equal(shift.refundsByMethod.OTHER, "0.00");
      const report = (await t.api("get", "/reports/collections", a.admin.token)).body.data;
      assert.ok(Number(report.byMode.find((x: { method: string }) => x.method === "OTHER").refunded) >= 0);
    });
    it("the database refuses to return more to an advance than a bill took from it", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      await take(p.id, [{ method: "CASH", amount: "100" }], c.token);
      const invId = await issued("100", p.id, c.token);
      await apply(invId, "100", c.token);
      const use = await t.prisma.advanceUse.findFirstOrThrow({ where: { tenantId: a.tenantId, invoiceId: invId } });
      assert.equal((await cancelWith(invId, "100")).status, 200);
      const refund = await t.prisma.refund.findFirstOrThrow({ where: { tenantId: a.tenantId, invoiceId: invId } });
      await assert.rejects(
        t.prisma.$executeRawUnsafe(`INSERT INTO "AdvanceReturn" ("tenantId", "facilityId", "useId", "depositId", "invoiceId", "refundId", amount) VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${use.id}'::uuid, '${use.depositId}'::uuid, '${invId}'::uuid, '${refund.id}'::uuid, 0.01)`),
        /More returned|says/,
      );
    });
  });

  describe("printed advance receipt", () => {
    it("prints the receipt with the amounts, the tender lines and the balance, and audits the print", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      const dep = (await take(p.id, [{ method: "CASH", amount: "500" }, { method: "UPI", amount: "700", reference: "UPI-565656" }], c.token, key(), "For the planned surgery")).body.data;
      const res = await t.api("get", `/print/advance-receipts/${dep.id}`, c.token);
      assert.equal(res.status, 200);
      assert.match(res.text, new RegExp(`Advance receipt ${dep.receiptNumber}`));
      assert.match(res.text, /1200\.00/);
      assert.match(res.text, /UPI-565656/);
      assert.match(res.text, /For the planned surgery/);
      assert.match(res.text, /Balance held/);
      const second = await t.api("get", `/print/advance-receipts/${dep.id}`, c.token);
      assert.match(second.text, /DUPLICATE COPY/);
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "DOCUMENT_PRINTED", entityType: "AdvanceDeposit", entityId: dep.id } }), 2);
      const pdf = await t.api("get", `/print/advance-receipts/${dep.id}?format=pdf`, c.token).buffer(true).parse((r, cb) => { const d: Buffer[] = []; r.on("data", (x: Buffer) => d.push(x)); r.on("end", () => cb(null, Buffer.concat(d))); });
      assert.equal((pdf.body as Buffer).subarray(0, 5).toString(), "%PDF-");
    });
    it("is for people who can read bills; other hospitals and strangers cannot see it", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      const dep = (await take(p.id, [{ method: "CASH", amount: "50" }], c.token)).body.data;
      assert.equal((await t.api("get", `/print/advance-receipts/${dep.id}`).send()).status, 401);
      assert.equal((await t.api("get", `/print/advance-receipts/${dep.id}`, (await cashierWithShift(b)).token)).status, 404);
      const nurse = await t.makeUser(a, ["NURSE"]);
      assert.equal((await t.api("get", `/print/advance-receipts/${dep.id}`, nurse.token)).status, 403);
    });
  });

  describe("the books", () => {
    it("the cashier's drawer and the day's collections count the money once: when it came in and went out, not when it was used", async () => {
      const c = await cashierWithShift(a, "1000");
      const p = await registerPatient(t, rec.token);
      const dep = (await take(p.id, [{ method: "CASH", amount: "500" }, { method: "UPI", amount: "700", reference: "UPI-121212" }], c.token)).body.data;
      const invId = await issued("900", p.id, c.token);
      await apply(invId, "900", c.token);
      assert.equal((await giveBack(dep.id, { method: "CASH", amount: "200", reason: "Balance returned to patient" }, c.token)).status, 201);

      const shift = (await t.api("get", `/shifts/${c.shiftId}`, c.token)).body.data;
      assert.equal(shift.expectedCash, "1300.00", "1000 opening + 500 cash taken - 200 cash given back");
      assert.deepEqual([shift.collectionsByMethod.CASH, shift.collectionsByMethod.UPI, shift.collectionsByMethod.OTHER], ["500.00", "700.00", "0.00"]);
      assert.equal(shift.refundsByMethod.CASH, "200.00");
      assert.equal(shift.netCollections, "1000.00");

      const report = (await t.api("get", "/reports/collections", a.admin.token)).body.data;
      const mode = (m: string) => report.byMode.find((x: { method: string }) => x.method === m);
      assert.equal(mode("OTHER").received, "0.00", "advance-funded payments are not counted again");
      assert.ok(Number(mode("CASH").received) >= 500 && Number(mode("UPI").received) >= 700);
      const closed = await t.api("post", `/shifts/${c.shiftId}/close`, c.token).send({ actualCash: "1300.00" });
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      assert.equal(closed.body.data.difference, "0.00");
    });
    it("the database itself refuses to overdraw an advance or to change one", async () => {
      const c = await cashierWithShift();
      const p = await registerPatient(t, rec.token);
      const dep = (await take(p.id, [{ method: "CASH", amount: "100" }], c.token)).body.data;
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "AdvanceDeposit" SET amount = 999 WHERE id = '${dep.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "AdvanceTender" WHERE "depositId" = '${dep.id}'::uuid`), /append-only/);
      await assert.rejects(
        t.prisma.$executeRawUnsafe(`INSERT INTO "AdvanceRefund" (id, "tenantId", "facilityId", "depositId", "refundNumber", method, amount, reason, "createdById") VALUES (gen_random_uuid(), '${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${dep.id}'::uuid, 'RF-TEST-${randomUUID().slice(0, 6)}', 'CASH', 100.01, 'overdraw', '${c.id}'::uuid)`),
        /overdrawn/,
      );
    });
  });

  describe("merged patient records", () => {
    it("an advance taken on a duplicate shows on the real patient and can pay the real patient's bill", async () => {
      const c = await cashierWithShift();
      const real = await registerPatient(t, rec.token);
      const dup = await registerPatient(t, rec.token);
      await take(dup.id, [{ method: "CASH", amount: "250" }], c.token);
      const m = await t.api("post", `/patients/${dup.id}/merge`, a.admin.token).send({ intoPatientId: real.id, version: 1, reason: "Same person registered twice" });
      assert.equal(m.status, 200, JSON.stringify(m.body));
      assert.equal((await list(real.id, c.token)).balance, "250.00");
      const refused = await take(dup.id, [{ method: "CASH", amount: "10" }], c.token);
      assert.equal(refused.body.error.code, "PATIENT_MERGED");
      const invId = await issued("250", real.id, c.token);
      assert.equal((await apply(invId, "250", c.token)).status, 201);
      assert.equal((await list(real.id, c.token)).balance, "0.00");
    });
  });
});
