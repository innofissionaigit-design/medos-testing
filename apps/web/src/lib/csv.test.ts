import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, reportToCsv } from "./csv";

test("cells are quoted when they contain commas, quotes or line breaks", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(12.5), "12.5");
});

test("spreadsheet formulas in text are neutralised, real negative numbers are not", () => {
  for (const evil of ["=HYPERLINK(\"http://x\")", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\tcmd", "=1+1"]) assert.ok(csvCell(evil).replace(/^"/, "").startsWith("'"), evil);
  assert.equal(csvCell("-150.50"), "-150.50");
  assert.equal(csvCell("-3"), "-3");
});

test("a report becomes a summary plus one section per list, without internal ids", () => {
  const csv = reportToCsv("Collections", { from: "2026-10-05", totals: { received: "250.00", net: "250.00" }, byMode: [{ method: "CASH", received: "100.00", id: "x", practitionerId: "y" }, { method: "UPI", received: "150.00" }] });
  assert.ok(csv.startsWith("\ufeffCollections\r\n"), "BOM so Excel reads UTF-8");
  assert.match(csv, /From,2026-10-05/);
  assert.match(csv, /Totals Received,250\.00/);
  assert.match(csv, /By Mode\r\nMethod,Received\r\nCASH,100\.00\r\nUPI,150\.00/);
  assert.ok(!/practitionerId|Practitioner Id/i.test(csv));
});