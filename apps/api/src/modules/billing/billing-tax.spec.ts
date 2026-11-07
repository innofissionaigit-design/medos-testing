import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Decimal } from "@medos/shared";
import { registerPatient, startApp, type TestApp, type TestTenant } from "../../test/harness";
import { computeLine, computeTotals } from "./billing.domain";

const f = (v: Decimal) => v.toFixed(2);

describe("tax split and round-off: the arithmetic", () => {
  it("a split line is two equal halves, each rounded on its own", () => {
    const a = computeLine({ quantity: 1, unitPrice: "1000", taxPercent: 12 }, { split: true });
    assert.deepEqual([f(a.tax), f(a.cgst), f(a.sgst), f(a.total)], ["120.00", "60.00", "60.00", "1120.00"]);
    const b = computeLine({ quantity: 1, unitPrice: "133.33", taxPercent: 5 }, { split: true });
    assert.deepEqual([f(b.cgst), f(b.sgst), f(b.tax)], ["3.33", "3.33", "6.66"], "each half is rounded, so the pair is always equal");
    assert.equal(f(computeLine({ quantity: 1, unitPrice: "133.33", taxPercent: 5 }).tax), "6.67", "unsplit is unchanged");
    for (const price of ["99.99", "0.01", "12345.67", "1.5"]) for (const pct of [5, 12, 18, 28]) {
      const c = computeLine({ quantity: 3, unitPrice: price, taxPercent: pct }, { split: true });
      assert.ok(c.cgst.equals(c.sgst) && c.tax.equals(c.cgst.times(2)) && c.tax.times(100).mod(2).isZero(), `${price} at ${pct}%`);
    }
  });
  it("the total rounds to the nearest rupee, half a rupee up, and the round-off is the difference", () => {
    const line = (price: string) => [computeLine({ quantity: 1, unitPrice: price, taxPercent: 0 })];
    const r = (price: string) => { const t = computeTotals(line(price), { roundToRupee: true }); return [f(t.total), f(t.roundOff)]; };
    assert.deepEqual(r("1234.49"), ["1234.00", "-0.49"]);
    assert.deepEqual(r("1234.50"), ["1235.00", "0.50"]);
    assert.deepEqual(r("1234.51"), ["1235.00", "0.49"]);
    assert.deepEqual(r("1234.00"), ["1234.00", "0.00"]);
    const plain = computeTotals(line("1234.49"));
    assert.deepEqual([f(plain.total), f(plain.roundOff)], ["1234.49", "0.00"], "off by default");
  });
});

describe("tax split and round-off on invoices", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let cashier: { id: string; token: string };
  let rec: { id: string; token: string };
  let svc: { dressing: string; inj: string };

  const setting = (k: string, value: unknown, tok = a.admin.token) => t.api("put", `/settings/${k}`, tok).send({ value });
  const lines = () => [{ serviceId: svc.dressing, quantity: 1 }, { serviceId: svc.inj, quantity: 1 }];
  const draft = async (tok = cashier.token, patientId?: string) => {
    const p = patientId ?? (await registerPatient(t, rec.token)).id;
    const r = await t.api("post", "/invoices", tok).send({ patientId: p, lines: lines() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("tax-a"); b = await t.makeTenant("tax-b");
    cashier = await t.makeUser(a, ["CASHIER"]); rec = await t.makeUser(a, ["RECEPTIONIST"]);
    const mk = async (body: Record<string, unknown>) => (await t.api("post", "/services", a.admin.token).send(body)).body.data.id as string;
    svc = {
      dressing: await mk({ code: "DRESS", name: "Dressing (small)", category: "INJECTION_DRESSING", price: "133.33", taxPercent: "12" }),
      inj: await mk({ code: "INJ", name: "Injection charge", category: "INJECTION_DRESSING", price: "75", taxPercent: "5" }),
    };
  });
  after(async () => { await t.close(); });

  it("by default nothing changes: one tax amount, no round-off", async () => {
    const d = await draft();
    assert.deepEqual([d.taxSplit, d.roundsToRupee, d.roundOff, d.cgstTotal, d.total, d.taxTotal], [false, false, "0.00", null, "228.08", "19.75"], "16.00 + 3.75 with each line rounded once");
    assert.equal(d.lines[0].cgstAmount, null);
  });

  it("with both switched on a new invoice splits tax, rounds the total, and keeps the rule for life", async () => {
    assert.equal((await setting("INVOICE_TAX_SPLIT", true)).status, 200);
    assert.equal((await setting("INVOICE_ROUND_OFF", true)).status, 200);
    assert.equal((await setting("INVOICE_TAX_SPLIT", true, cashier.token)).status, 403, "settings are for the administrator");
    const d = await draft();
    assert.deepEqual([d.taxSplit, d.roundsToRupee, d.taxTotal, d.cgstTotal, d.sgstTotal, d.roundOff, d.total], [true, true, "19.76", "9.88", "9.88", "-0.09", "228.00"]);
    assert.deepEqual([d.lines[0].taxAmount, d.lines[0].cgstAmount, d.lines[0].sgstAmount, d.lines[1].taxAmount, d.lines[1].cgstAmount], ["16.00", "8.00", "8.00", "3.76", "1.88"]);
    assert.equal(d.subtotal, "208.33");

    // the hospital switches the rules off again: this invoice keeps what it was created with, a new one follows the new rule
    assert.equal((await setting("INVOICE_TAX_SPLIT", false)).status, 200);
    assert.equal((await setting("INVOICE_ROUND_OFF", false)).status, 200);
    const upd = await t.api("put", `/invoices/${d.id}`, cashier.token).send({ version: d.version, lines: lines() });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.deepEqual([upd.body.data.taxSplit, upd.body.data.roundOff, upd.body.data.total], [true, "-0.09", "228.00"], "editing a draft does not change its rule");
    const issued = await t.api("post", `/invoices/${d.id}/issue`, cashier.token);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.deepEqual([issued.body.data.total, issued.body.data.roundOff, issued.body.data.cgstTotal, issued.body.data.lines[0].cgstAmount], ["228.00", "-0.09", "9.88", "8.00"]);
    const fresh = await draft();
    assert.deepEqual([fresh.taxSplit, fresh.roundsToRupee, fresh.total], [false, false, "228.08"]);

    // the rounded total is what must be paid
    const pay = (amount: string) => t.api("post", `/invoices/${d.id}/payments`, cashier.token).set("Idempotency-Key", `k-${randomUUID().slice(0, 18)}`).send({ payments: [{ method: "CASH", amount }] });
    assert.equal((await pay("228.09")).status, 409, "more than the rounded total is an overpayment");
    const paid = await pay("228.00");
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.equal((await t.api("get", `/invoices/${d.id}`, cashier.token)).body.data.status, "PAID");

    // the printed invoice shows the halves and the round-off
    const printed = await t.api("get", `/print/invoices/${d.id}`, cashier.token);
    assert.equal(printed.status, 200);
    const html = String(printed.text);
    assert.ok(html.includes("CGST") && html.includes("SGST") && html.includes("Round off") && html.includes("-0.09"), "CGST, SGST and Round off appear");
    const plain = await t.api("get", `/print/invoices/${fresh.id}`, cashier.token);
    assert.equal(plain.status, 409, "a draft cannot be printed");
  });

  it("DATABASE: the rule is fixed at creation; the round-off is bounded and frozen; split tax divides into equal halves", async () => {
    await setting("INVOICE_TAX_SPLIT", true); await setting("INVOICE_ROUND_OFF", true);
    const d = await draft();
    await setting("INVOICE_TAX_SPLIT", false); await setting("INVOICE_ROUND_OFF", false);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Invoice" SET "taxSplit" = false WHERE id = '${d.id}'::uuid`), /identity fields are immutable/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Invoice" SET "roundsToRupee" = false WHERE id = '${d.id}'::uuid`), /identity fields are immutable/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "InvoiceLine" SET "taxAmount" = 9.01 WHERE "invoiceId" = '${d.id}'::uuid AND "lineNo" = 1`), /equal CGST and SGST/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Invoice" SET "roundOff" = 0.70, total = total + 0.79 WHERE id = '${d.id}'::uuid`), /check/i, "more than 50 paise");
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Invoice" SET total = 228.50, "roundOff" = -0.09 + 0.50 WHERE id = '${d.id}'::uuid`), /check/i, "a rounding invoice must have a whole-rupee total");
    const plain = await draft();
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Invoice" SET "roundOff" = 0.09, total = total + 0.09 WHERE id = '${plain.id}'::uuid`), /check/i, "an invoice that does not round has no round-off");
    assert.equal((await t.api("post", `/invoices/${d.id}/issue`, cashier.token)).status, 200);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Invoice" SET "roundOff" = 0, total = total + 0.09 WHERE id = '${d.id}'::uuid`), /cannot be changed|check/i);
  });

  it("each hospital's switches are its own", async () => {
    await setting("INVOICE_TAX_SPLIT", true); await setting("INVOICE_ROUND_OFF", true);
    const p = (await registerPatient(t, (await t.makeUser(b, ["RECEPTIONIST"])).token)).id;
    const bCashier = await t.makeUser(b, ["CASHIER"]);
    const r = await t.api("post", "/invoices", bCashier.token).send({ patientId: p, lines: [{ description: "Procedure", unitPrice: "100.50", taxPercent: 12, quantity: 1 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.data.taxSplit, r.body.data.roundsToRupee, r.body.data.total], [false, false, "112.56"], "the other hospital did not switch them on");
    await setting("INVOICE_TAX_SPLIT", false); await setting("INVOICE_ROUND_OFF", false);
  });
});
