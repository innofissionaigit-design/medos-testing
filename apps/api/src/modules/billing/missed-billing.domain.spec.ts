import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@medos/shared";
import { coveredByPackage, flagKey, parseFlagKey, reasonProblem, stayDays, summarise, unchargedNights } from "./missed-billing.domain";

const ID = "3f2b8c1e-5a47-4d6e-9a10-0c1d2e3f4a5b";

describe("missed billing: flag names", () => {
  it("a flag key can be read back, and anything else is refused", () => {
    assert.deepEqual(parseFlagKey(flagKey("TEST_NOT_BILLED", ID)), { type: "TEST_NOT_BILLED", recordId: ID, day: null });
    assert.deepEqual(parseFlagKey(flagKey("BED_NIGHT_NOT_CHARGED", ID, "2026-11-10")), { type: "BED_NIGHT_NOT_CHARGED", recordId: ID, day: "2026-11-10" });
    for (const bad of ["", "NOPE:" + ID, "TEST_NOT_BILLED:not-an-id", "TEST_NOT_BILLED:" + ID + ":2026-11-10", "BED_NIGHT_NOT_CHARGED:" + ID, "BED_NIGHT_NOT_CHARGED:" + ID + ":soon", "TEST_NOT_BILLED:" + ID + ":x:y"]) {
      assert.equal(parseFlagKey(bad), null, bad);
    }
  });
});

describe("missed billing: reasons", () => {
  it("every decision needs a short reason, and not billing something needs a real one", () => {
    assert.ok(reasonProblem("NOT_A_GAP", "  ok "), "four characters is too short");
    assert.equal(reasonProblem("NOT_A_GAP", "free follow-up"), null);
    assert.equal(reasonProblem("BILLED", "on INV-12"), null);
    assert.ok(reasonProblem("WAIVED", "family"), "a waiver needs ten characters");
    assert.equal(reasonProblem("WAIVED", "approved by the trustee"), null);
  });
});

describe("missed billing: bed nights", () => {
  it("lists the days of a stay, first and last included", () => {
    assert.deepEqual(stayDays("2026-11-09", "2026-11-11"), ["2026-11-09", "2026-11-10", "2026-11-11"]);
    assert.deepEqual(stayDays("2026-11-09", "2026-11-09"), ["2026-11-09"]);
    assert.deepEqual(stayDays("2026-12-30", "2027-01-01"), ["2026-12-30", "2026-12-31", "2027-01-01"]);
  });

  it("flags the nights with no bed charge, at the rate of the bed used that night", () => {
    const stays = [
      { fromDay: "2026-11-09", toDay: "2026-11-10", dailyRate: "1000", bed: "A1" },
      { fromDay: "2026-11-10", toDay: "2026-11-12", dailyRate: "2500", bed: "ICU2" },
    ];
    const out = unchargedNights(stays, new Set(["2026-11-09", "2026-11-11"]), "2026-11-20", false, "2026-11-01", "2026-11-30");
    assert.deepEqual(out.map((n) => [n.day, n.bed, n.rate.toFixed(2)]), [["2026-11-10", "A1", "1000.00"], ["2026-11-12", "ICU2", "2500.00"]], "the transfer day is asked about once");
  });

  it("does not ask about today for a patient still in the ward, nor about days outside the period", () => {
    const stays = [{ fromDay: "2026-11-09", toDay: "2026-11-12", dailyRate: "1000", bed: "A1" }];
    assert.deepEqual(unchargedNights(stays, new Set(), "2026-11-12", true, "2026-11-01", "2026-11-30").map((n) => n.day), ["2026-11-09", "2026-11-10", "2026-11-11"]);
    assert.deepEqual(unchargedNights(stays, new Set(), "2026-11-12", false, "2026-11-10", "2026-11-11").map((n) => n.day), ["2026-11-10", "2026-11-11"]);
    assert.deepEqual(unchargedNights(stays, new Set(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]), "2026-11-20", false, "2026-11-01", "2026-11-30"), [], "every night charged");
  });
});

describe("missed billing: what a package already covers", () => {
  const pkg = { includesImplants: true, includesConsumables: false, inclusions: ["Physiotherapy", " "] };
  it("an implant is covered when the package includes implants; a consumable only if it says so", () => {
    assert.ok(coveredByPackage({ kind: "IMPLANT", description: "Knee implant" }, pkg));
    assert.equal(coveredByPackage({ kind: "CONSUMABLE", description: "Sutures" }, pkg), null, "this package leaves consumables out");
    assert.ok(coveredByPackage({ kind: "CONSUMABLE", description: "Sutures" }, { ...pkg, includesConsumables: true }));
  });
  it("an item the package lists by name is covered, and an unrelated one is not", () => {
    assert.match(coveredByPackage({ kind: null, description: "Physiotherapy session 3" }, pkg) ?? "", /Physiotherapy/);
    assert.equal(coveredByPackage({ kind: null, description: "CT scan" }, pkg), null);
    assert.equal(coveredByPackage({ kind: "IMPLANT", description: "Knee implant" }, { ...pkg, includesImplants: false }), null, "an implant the package leaves out is rightly billed");
  });
});

describe("missed billing: totals", () => {
  it("adds up what is open in exact decimals and counts flags that have no amount", () => {
    const s = summarise([
      { type: "BED_NIGHT_NOT_CHARGED", amount: new Decimal("0.10"), reviewed: false },
      { type: "BED_NIGHT_NOT_CHARGED", amount: new Decimal("0.20"), reviewed: false },
      { type: "BED_NIGHT_NOT_CHARGED", amount: new Decimal("999.00"), reviewed: true },
      { type: "CONSULTATION_NO_FEE", amount: null, reviewed: false },
    ]);
    const bed = s.find((x) => x.type === "BED_NIGHT_NOT_CHARGED")!;
    assert.deepEqual([bed.open, bed.reviewed, bed.openAmount, bed.unpriced], [2, 1, "0.30", 0], "0.1 + 0.2 is exactly 0.30 and a decided flag is not counted");
    const c = s.find((x) => x.type === "CONSULTATION_NO_FEE")!;
    assert.deepEqual([c.open, c.openAmount, c.unpriced], [1, "0.00", 1]);
    assert.equal(s.length, 7, "every kind of flag is listed, even with nothing open");
  });
});
