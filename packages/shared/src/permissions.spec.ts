import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PERMISSIONS, SYSTEM_ROLES } from "./permissions";

describe("permission catalogue", () => {
  it("has no duplicate permissions in the catalogue or in any system role", () => {
    assert.equal(new Set(PERMISSIONS).size, PERMISSIONS.length);
    for (const [role, perms] of Object.entries(SYSTEM_ROLES)) {
      assert.equal(new Set(perms).size, perms.length, `${role} lists a permission twice`);
    }
  });
  it("system roles only grant known permissions", () => {
    const known = new Set<string>(PERMISSIONS);
    for (const [role, perms] of Object.entries(SYSTEM_ROLES)) for (const p of perms) assert.ok(known.has(p), `${role}: ${p}`);
  });
});
