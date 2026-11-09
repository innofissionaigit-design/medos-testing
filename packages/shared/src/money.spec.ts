import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotals, money, sum } from "./money";

describe("money", () => {
  it("avoids floating point error", () => {
    assert.equal(sum(["0.1", "0.2"]).toString(), "0.3");
  });
  it("rounds half up to 2dp", () => {
    assert.equal(money("1.005").toString(), "1.01");
  });
  it("computes line totals server-side", () => {
    const t = lineTotals({ quantity: 3, unitPrice: "33.33", taxPercent: 12, discount: "1.00" });
    assert.equal(t.net.toString(), "98.99");
    assert.equal(t.tax.toString(), "11.88");
    assert.equal(t.total.toString(), "110.87");
  });
  it("rejects negative line totals", () => {
    assert.throws(() => lineTotals({ quantity: 1, unitPrice: 10, taxPercent: 0, discount: 11 }));
  });
  it("rejects non-finite amounts", () => {
    assert.throws(() => money(NaN));
  });
});


