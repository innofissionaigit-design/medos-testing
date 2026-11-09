import { test } from "node:test";
import assert from "node:assert/strict";
import { canEditTests } from "./cashier-edit";

test("a handwritten prescription with no tests entered yet can be edited, so the Cashier can enter them", () => {
  assert.equal(canEditTests(0, 1, false), true, "no tests listed, one handwritten picture to read");
  assert.equal(canEditTests(0, 2, false), true);
});

test("a visit with tests can be edited, with or without a picture", () => {
  assert.equal(canEditTests(3, 0, false), true);
  assert.equal(canEditTests(1, 1, false), true);
});

test("nothing to edit, or already editing: no Edit button", () => {
  assert.equal(canEditTests(0, 0, false), false, "no tests and no handwritten picture to read");
  assert.equal(canEditTests(2, 1, true), false, "already in edit mode");
});
