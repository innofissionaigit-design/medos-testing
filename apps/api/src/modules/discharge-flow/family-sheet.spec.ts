import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFamilySheet, FAMILY_LANGS, OWNER_KEY, REASON_WORDS } from "./family-sheet";
import { DELAY_REASONS } from "./discharge-flow.domain";
import { FLOW_STAGES } from "./discharge-flow.service";

describe("family sheet", () => {
  it("lists what is pending, who handles it, and the reason, in each language", () => {
    for (const lang of FAMILY_LANGS) {
      const s = buildFamilySheet({ lang, patientName: "Asha Das", expectedDate: "2026-03-05", fitAt: "5 Mar, 10:00", pending: [{ stage: "PHARMACY" }, { stage: "BILLING" }], reasonCodes: { BILLING: "FAMILY_ARRANGING_MONEY" } });
      assert.equal(s.allDone, false);
      assert.equal(s.pending.length, 2);
      assert.ok(s.pending.every((p) => p.what && p.handledBy), `${lang}: every item names the work and who handles it`);
      assert.ok(s.pending[1]!.reason, `${lang}: the recorded reason is shown`);
      assert.equal(s.pending[0]!.reason, null);
      assert.ok(s.lines.join("\n").includes("Asha Das"));
    }
  });
  it("says everything is ready when nothing is pending", () => {
    const s = buildFamilySheet({ lang: "hi", patientName: "Ravi", expectedDate: null, fitAt: null, pending: [] });
    assert.equal(s.allDone, true);
  });
  it("never carries the staff's free-text note", () => {
    const s = buildFamilySheet({ lang: "en", patientName: "Ravi", expectedDate: null, fitAt: null, pending: [{ stage: "INSURANCE" }], reasonCodes: { INSURANCE: "OTHER" } });
    assert.ok(!JSON.stringify(s).includes("note"));
  });
  it("has words for every stage, owner and reason in every language", () => {
    for (const stage of FLOW_STAGES) {
      assert.ok(OWNER_KEY[stage], `owner for ${stage}`);
      for (const lang of FAMILY_LANGS) assert.ok(buildFamilySheet({ lang, patientName: "x", expectedDate: null, fitAt: null, pending: [{ stage }] }).pending[0]!.what !== stage, `${lang} ${stage}`);
    }
    for (const r of DELAY_REASONS) for (const lang of FAMILY_LANGS) assert.ok(REASON_WORDS[r]?.[lang], `${lang} ${r}`);
  });
});
