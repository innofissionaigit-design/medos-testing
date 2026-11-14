import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checklistOf, normLabel, type RequiredDoc } from "./claim-checklist.domain";

const req = (label: string, claimType: RequiredDoc["claimType"] = null, id = label): RequiredDoc => ({ id, label, claimType });

describe("claim documents checklist (domain)", () => {
  it("names match whatever the capitals and spaces", () => {
    assert.equal(normLabel("  Discharge   Summary "), "discharge summary");
  });

  it("nothing required means nothing is missing", () => {
    const c = checklistOf([], [], [], "CASHLESS");
    assert.deepEqual([c.complete, c.items.length, c.missing], [true, 0, []]);
  });

  it("each required document is attached, waived or missing", () => {
    const c = checklistOf([req("Discharge summary"), req("Policy card"), req("ID proof")], [{ id: "d1", label: "discharge SUMMARY" }], [{ label: "Policy card", reason: "Card lost, policy checked online" }], "REIMBURSEMENT");
    assert.deepEqual(c.items.map((i) => [i.label, i.state]), [["Discharge summary", "ATTACHED"], ["Policy card", "WAIVED"], ["ID proof", "MISSING"]]);
    assert.equal(c.items[0]?.documentId, "d1");
    assert.equal(c.items[1]?.waiverReason, "Card lost, policy checked online");
    assert.deepEqual([c.complete, c.missing], [false, ["ID proof"]]);
  });

  it("is complete once everything is attached or waived", () => {
    const c = checklistOf([req("A1"), req("B2")], [{ id: "x", label: "a1" }], [{ label: "b2", reason: "Not applicable here" }], "CASHLESS");
    assert.equal(c.complete, true);
  });

  it("a document required only for cashless claims is not asked of a reimbursement claim", () => {
    const required = [req("Pre-authorisation form", "CASHLESS"), req("Original bills", "REIMBURSEMENT"), req("ID proof")];
    assert.deepEqual(checklistOf(required, [], [], "CASHLESS").missing, ["Pre-authorisation form", "ID proof"]);
    assert.deepEqual(checklistOf(required, [], [], "REIMBURSEMENT").missing, ["Original bills", "ID proof"]);
  });

  it("the same document listed twice is asked once", () => {
    assert.deepEqual(checklistOf([req("ID proof", null, "1"), req("id  proof", "CASHLESS", "2")], [], [], "CASHLESS").missing, ["ID proof"]);
  });
});
