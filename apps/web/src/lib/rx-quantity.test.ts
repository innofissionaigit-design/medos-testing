import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateQuantity } from "./rx-quantity";
import { calculateQuantity as shared } from "../../../../packages/shared/src/prescription-quantity";

const doses = ["1 tablet", "2 tablets", "1/2 tab", "½ tablet", "1½ tablet", "0.5 tablet", "1", "1 capsule", "5 ml", "500 mg", "10 drops", "as directed", "", "1-0-1", "0 tablet", "25 tablets", "1 Tablet"];
const frequencies = ["OD", "BD", "TDS", "QID", "HS", "STAT", "SOS", "OTHER", "bd"];
const days = [undefined, null, 0, 1, 2.5, 3, 5, 7, 10, 365, 366];

test("the doctor's screen works out the same quantity as the pharmacy and the Cashier", () => {
  let checked = 0;
  for (const d of doses) for (const f of frequencies) for (const n of days) { assert.equal(calculateQuantity(d, f, n), shared(d, f, n), `${d} | ${f} | ${n}`); checked++; }
  assert.ok(checked > 1000);
});

test("one tablet twice a day for three days is six tablets", () => {
  assert.equal(calculateQuantity("1 tablet", "BD", 3), 6);
  assert.equal(calculateQuantity("5 ml", "BD", 3), null);
  assert.equal(calculateQuantity("1½ tablet", "BD", 3), null, "a mixed fraction is never misread");
});
