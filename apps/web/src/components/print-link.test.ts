import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { openInNewTab } from "./print-link";

const g = globalThis as unknown as { window?: unknown };
afterEach(() => { delete g.window; });

test("a print page is opened in a new tab (no window features, so not a pop-up window) and the current page is left alone", () => {
  const calls: unknown[][] = [];
  const opened: { opener: unknown } = { opener: "the current page" };
  g.window = { open: (...a: unknown[]) => { calls.push(a); return opened; } };
  assert.equal(openInNewTab("/api/proxy/print/invoices/abc"), true);
  assert.deepEqual(calls, [["/api/proxy/print/invoices/abc", "_blank"]]);
  assert.equal(opened.opener, null, "the new tab cannot reach back into the current page");
});

test("when the browser blocks the new tab, it reports that, so the link's own new-tab behaviour takes over", () => {
  g.window = { open: () => null };
  assert.equal(openInNewTab("/api/proxy/print/receipts/abc"), false);
});

test("with no browser around (server rendering) nothing is opened", () => {
  assert.equal(openInNewTab("/x"), false);
});
