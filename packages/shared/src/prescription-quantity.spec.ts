import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateQuantity, unitsPerDose } from "./prescription-quantity";

describe("prescription quantity", () => {
  it("works out the tablets for the whole course from dose, frequency and days", () => {
    assert.equal(calculateQuantity("1 tablet", "BD", 3), 6, "one tablet twice a day for three days");
    assert.equal(calculateQuantity("1 tablet", "OD", 5), 5);
    assert.equal(calculateQuantity("2 tablets", "TDS", 5), 30);
    assert.equal(calculateQuantity("1 capsule", "QID", 7), 28);
    assert.equal(calculateQuantity("1", "HS", 10), 10, "a plain number is a count of tablets");
    assert.equal(calculateQuantity("1/2 tab", "BD", 5), 5, "half a tablet twice a day for five days");
    assert.equal(calculateQuantity("0.5 tablet", "OD", 3), 2, "a part tablet rounds up to whole tablets");
    assert.equal(calculateQuantity("1 Tablet", "bd".toUpperCase(), 3), 6, "case does not matter");
  });

  it("a single STAT dose is the dose itself, whatever the days", () => {
    assert.equal(calculateQuantity("1 tablet", "STAT", undefined), 1);
    assert.equal(calculateQuantity("2 tablets", "STAT", 5), 2);
  });

  it("gives no figure when it cannot be counted, so the pharmacy is asked instead of guessing", () => {
    assert.equal(calculateQuantity("5 ml", "BD", 5), null, "liquids are given by the bottle, not counted");
    assert.equal(calculateQuantity("500 mg", "BD", 5), null, "a strength is not a count");
    assert.equal(calculateQuantity("10 drops", "TDS", 3), null);
    assert.equal(calculateQuantity("as directed", "BD", 3), null);
    assert.equal(calculateQuantity("", "BD", 3), null);
    assert.equal(calculateQuantity("1 tablet", "SOS", 5), null, "only when needed");
    assert.equal(calculateQuantity("1 tablet", "OTHER", 5), null);
    assert.equal(calculateQuantity("1 tablet", "BD", undefined), null, "no days");
    assert.equal(calculateQuantity("1 tablet", "BD", null), null);
    assert.equal(calculateQuantity("1 tablet", "BD", 0), null);
    assert.equal(calculateQuantity("1 tablet", "BD", 366), null);
    assert.equal(calculateQuantity("1 tablet", "BD", 2.5), null);
    assert.equal(calculateQuantity("0 tablet", "BD", 3), null);
    assert.equal(calculateQuantity("25 tablets", "QID", 365), null, "an absurd total is not suggested");
  });

  it("reads the dose in the usual written forms", () => {
    assert.equal(unitsPerDose("1 tablet"), 1);
    assert.equal(unitsPerDose("  2  tabs "), 2);
    assert.equal(unitsPerDose("1½ tablet"), null, "a mixed fraction is left for the doctor to enter");
    assert.equal(unitsPerDose("½ tablet"), 0.5);
    assert.equal(unitsPerDose("1-0-1"), null, "a timetable is not a dose");
  });
});
