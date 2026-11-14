import { test } from "node:test";
import assert from "node:assert/strict";
import { CANCEL_REASONS, OTHER_MIN, reasonText } from "./reason-select";

test("a standard reason is recorded with its standard wording", () => {
  assert.equal(reasonText("Doctor not available", ""), "Doctor not available");
  assert.equal(reasonText("Doctor not available", "ignored text typed earlier"), "Doctor not available");
});

test("with nothing chosen there is no reason yet", () => {
  assert.equal(reasonText("", ""), "");
  assert.equal(reasonText("", "something typed"), "");
});

test("'Other' needs a few words of explanation before it counts", () => {
  const other = "__other__";
  assert.equal(reasonText(other, ""), "");
  assert.equal(reasonText(other, "x".repeat(OTHER_MIN - 1)), "");
  assert.equal(reasonText(other, "  Family emergency  "), "Family emergency");
});

test("every standard reason is long enough for the cancel rules and is not listed twice", () => {
  for (const [kind, list] of Object.entries(CANCEL_REASONS)) {
    assert.equal(new Set(list).size, list.length, `${kind}: a reason is listed twice`);
    for (const r of list) assert.ok(r.length >= 5, `${kind}: "${r}" is too short for the server's rule`);
  }
});
