import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { balanceDue, computeLine, computeTotals, deriveStatus, effectiveTotal, fmt, netReceived, refundable, round2 } from "./billing.domain";

describe("billing arithmetic", () => {
  it("rounds half-up and avoids binary floating point error", () => {
    assert.equal(round2("1.005").toString(), "1.01");
    assert.equal(round2("2.675").toString(), "2.68");
    assert.equal(round2(0.1 + 0.2).toString(), "0.3");
    assert.equal(fmt("5"), "5.00");
  });

  it("computes a taxed, discounted line", () => {
    const l = computeLine({ quantity: "3", unitPrice: "33.33", discountAmount: "1.00", taxPercent: "12" });
    assert.equal(l.gross.toString(), "99.99");
    assert.equal(l.net.toString(), "98.99");
    assert.equal(l.tax.toString(), "11.88");
    assert.equal(l.total.toString(), "110.87");
  });

  it("supports fractional quantities with correct rounding", () => {
    assert.equal(computeLine({ quantity: "2.5", unitPrice: "19.99", taxPercent: "0" }).gross.toString(), "49.98");
    assert.equal(computeLine({ quantity: "0.333", unitPrice: "100", taxPercent: "5" }).total.toString(), "34.97");
  });

  it("rejects negative or excessive discounts and zero-rated tax is exact", () => {
    assert.throws(() => computeLine({ quantity: 1, unitPrice: "100", discountAmount: "100.01", taxPercent: 0 }), RangeError);
    assert.throws(() => computeLine({ quantity: 1, unitPrice: "100", discountAmount: "-1", taxPercent: 0 }), RangeError);
    const full = computeLine({ quantity: 1, unitPrice: "100", discountAmount: "100", taxPercent: "18" });
    assert.equal(full.total.toString(), "0");
  });

  it("totals equal the sum of line totals, even with many awkward lines (no drift)", () => {
    const lines = Array.from({ length: 200 }, (_, i) => computeLine({ quantity: "1", unitPrice: (0.1 + i * 0.01).toFixed(2), taxPercent: "5", discountAmount: i % 3 === 0 ? "0.01" : "0" }));
    const t = computeTotals(lines);
    const sumOfLineTotals = lines.reduce((a, l) => a.plus(l.total), computeTotals([]).total);
    assert.equal(t.total.toString(), sumOfLineTotals.toString());
    assert.equal(t.total.toString(), t.subtotal.minus(t.discountTotal).plus(t.taxTotal).toString());
  });

  it("derives balance, refundable amount and status from the money state", () => {
    const s = (paid: string, refunded = "0", credited = "0") => ({ total: "1000", paidTotal: paid, refundedTotal: refunded, creditedTotal: credited });
    assert.equal(deriveStatus(s("0")), "ISSUED");
    assert.equal(deriveStatus(s("400")), "PARTIALLY_PAID");
    assert.equal(deriveStatus(s("1000")), "PAID");
    assert.equal(deriveStatus(s("1000", "1000")), "ISSUED", "fully refunded and not cancelled: owes again");
    assert.equal(deriveStatus(s("1000", "300")), "PARTIALLY_PAID");
    assert.equal(balanceDue(s("400")).toString(), "600");
    assert.equal(balanceDue(s("1000")).toString(), "0");
    assert.equal(refundable(s("1000")).toString(), "0");
    assert.equal(refundable(s("1000", "0", "200")).toString(), "200", "a credit note after full payment creates a refundable overpayment");
    assert.equal(refundable(s("1000", "200", "200")).toString(), "0");
    assert.equal(effectiveTotal(s("0", "0", "250")).toString(), "750");
    assert.equal(netReceived(s("1000", "250")).toString(), "750");
    assert.equal(balanceDue(s("1000", "0", "200")).toString(), "0", "overpaid invoices never show a negative balance");
  });
});
