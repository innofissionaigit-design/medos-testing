import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { patientBody, randomMobile, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";
import { CsvError, parseCsv, readTable } from "./csv";

const COLS = [{ name: "a", required: true, description: "", example: "" }, { name: "bC", description: "", example: "" }];
const year = new Date().getUTCFullYear();

describe("imports: CSV reader", () => {
  it("handles quotes, embedded commas and line breaks, CRLF, BOM and blank lines", () => {
    assert.deepEqual(parseCsv("﻿a,b\r\n\"x,1\",\"he said \"\"hi\"\"\"\n\n\"two\nlines\",\n"), [["a", "b"], ["x,1", 'he said "hi"'], ["two\nlines", ""]]);
  });
  it("rejects an unclosed quote", () => { assert.throws(() => parseCsv('a,b\n"x,1\n'), CsvError); });
  it("matches headers loosely, numbers rows like a spreadsheet and trims empty cells to undefined", () => {
    const t = readTable("A, b_c\n 1 ,\n2,x\n", COLS);
    assert.deepEqual(t.map((r) => [r.row, r.cells["a"], r.cells["bC"]]), [[2, "1", undefined], [3, "2", "x"]]);
  });
  it("explains file-level problems", () => {
    assert.throws(() => readTable("", COLS), /empty/);
    assert.throws(() => readTable("a;b\n1;2\n", COLS), /commas/);
    assert.throws(() => readTable("bC\n1\n", COLS), /Missing required column: a/);
    assert.throws(() => readTable("a,zzz\n1,2\n", COLS), /Unknown column/);
    assert.throws(() => readTable("a,A\n1,2\n", COLS), /twice/);
    assert.throws(() => readTable("a\n", COLS), /no rows/);
    assert.throws(() => readTable("a\n1\n2\n3\n", COLS, 2), /at most 2 rows/);
  });
  it("flags a row with more values than the header", () => {
    assert.equal(readTable("a\n1,2\n", COLS)[0]?.tooManyCells, true);
  });
});

describe("imports: bulk CSV import", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let pharm: { id: string; token: string };

  const csv = (rows: unknown[][]) => Buffer.from(rows.map((r) => r.map((c) => (c === undefined ? "" : /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\r\n"), "utf8");
  const post = (kind: string, body: Buffer, query = "", tok = a.admin.token) => t.api("post", `/imports/${kind}${query}`, tok).set("content-type", "text/csv").send(body);
  const results = (r: { body: { data: { results: { row: number; status: string; message: string | null }[] } } }) => r.body.data.results;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("imp-a");
    b = await t.makeTenant("imp-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]);
  });
  after(async () => { await t.close(); });

  describe("access", () => {
    it("is for administrators only; anonymous and other roles are refused", async () => {
      const body = csv([["code", "name", "category", "price"], ["X1", "X", "OTHER", "10"]]);
      assert.equal((await t.api("post", "/imports/services").set("content-type", "text/csv").send(body)).status, 401);
      assert.equal((await post("services", body, "", rec.token)).status, 403);
      assert.equal((await post("services", body, "", pharm.token)).status, 403);
      assert.equal((await t.api("get", "/imports/services", rec.token)).status, 403);
      assert.equal((await t.api("get", "/imports/services", a.admin.token)).status, 200);
    });
    it("rejects an unknown kind, a missing body and a body that is not text", async () => {
      assert.equal((await post("beds", csv([["a"], ["1"]]))).status, 400);
      assert.equal((await t.api("post", "/imports/services", a.admin.token).send({})).status, 415);
      assert.equal((await t.api("post", "/imports/services", a.admin.token).set("content-type", "text/csv").send(Buffer.from([0xff, 0xfe, 0xfd, 0x41]))).status, 400);
    });
    it("reports file problems as plain errors", async () => {
      const r = await post("services", csv([["code", "nope"], ["A", "B"]]));
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, "VALIDATION_FAILED");
      assert.match(r.body.error.message, /Unknown column/);
    });
  });

  describe("service price list", () => {
    const code = `SVC-${uniqueWord(5).toUpperCase()}`;
    const file = () => csv([["code", "name", "category", "price", "taxPercent"], [code, "Imported consult", "consultation", "300.50", "5"], [code, "Again", "OTHER", "1"], ["bad code!", "Bad", "OTHER", "1"], [`${code}2`, "Dear", "OTHER", "1,000"]]);
    it("previews by default and saves nothing", async () => {
      const r = await post("services", file());
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.dryRun, true);
      assert.deepEqual([r.body.data.wouldCreate, r.body.data.skipped, r.body.data.failed], [1, 1, 2]);
      assert.equal(await t.prisma.service.count({ where: { tenantId: a.tenantId, code } }), 0);
    });
    it("imports the good rows only, then skips them on a second upload, and audits once per commit without row data", async () => {
      const r = await post("services", file(), "?dryRun=false");
      assert.equal(r.body.data.created, 1);
      const row = await t.prisma.service.findFirstOrThrow({ where: { tenantId: a.tenantId, code } });
      assert.equal(row.name, "Imported consult");
      assert.equal(row.price.toString(), "300.5");
      const again = await post("services", file(), "?dryRun=false");
      assert.equal(again.body.data.created, 0);
      assert.match(results(again)[0]?.message ?? "", /already in the price list/);
      const events = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: "DATA_IMPORT_COMPLETED", entityType: "DataImport" } });
      assert.ok(events.length >= 2);
      const meta = JSON.stringify(events[0]?.metadata);
      assert.ok(!meta.includes("Imported consult") && !meta.includes(code), "no row content in the audit trail");
    });
    it("is tenant-scoped: another hospital's file does not see this hospital's codes", async () => {
      const r = await post("services", file(), "?dryRun=false", b.admin.token);
      assert.equal(r.body.data.created, 1);
      assert.equal(await t.prisma.service.count({ where: { tenantId: b.tenantId, code } }), 1);
    });
  });

  describe("medicines and opening stock", () => {
    const brand = `Brand${uniqueWord(5)}`;
    const meds = () => csv([["brandName", "genericName", "strength", "dosageForm", "gstPercent"], [brand, "Paracetamol", "500 mg", "tablet", "12"], [brand, "paracetamol", "500 MG", "TABLET", "12"], ["Z", "Z", "", "PILL", ""]]);
    it("imports medicines, skips repeats in the file and in the list, refuses unknown forms", async () => {
      const r = await post("medicines", meds(), "?dryRun=false");
      assert.deepEqual([r.body.data.created, r.body.data.skipped, r.body.data.failed], [1, 1, 1], JSON.stringify(results(r)));
      const again = await post("medicines", meds(), "?dryRun=false");
      assert.equal(again.body.data.created, 0);
    });
    const stock = (qty: string, exp = `${year + 2}-08-31`, extra: (string | undefined)[][] = []) =>
      csv([["brandName", "strength", "batchNo", "expiryDate", "mrp", "purchasePrice", "sellingPrice", "quantity"], [brand, "500 mg", "b100", exp, "30.00", "21.50", "28.00", qty], ...extra]);
    it("adds a batch once, never twice, and the ledger matches", async () => {
      const first = await post("opening-stock", stock("200"), "?dryRun=false");
      assert.equal(first.body.data.created, 1, JSON.stringify(first.body));
      const second = await post("opening-stock", stock("200"), "?dryRun=false");
      assert.equal(second.body.data.created, 0);
      assert.match(results(second)[0]?.message ?? "", /already recorded/);
      const batch = await t.prisma.medicineBatch.findFirstOrThrow({ where: { tenantId: a.tenantId, batchNo: "B100" } });
      const ledger = await t.prisma.stockLedger.aggregate({ where: { tenantId: a.tenantId, batchId: batch.id }, _sum: { quantity: true } });
      assert.equal(Number(ledger._sum.quantity), 200);
    });
    it("reports bad rows without touching the rest", async () => {
      const r = await post("opening-stock", stock("5", `${year - 1}-01-31`, [["Unknown Brand", "", "B1", `${year + 2}-01-31`, "1", "1", "1", "1"], [brand, "500 mg", "B200", `31/08/${year + 2}`, "10", "5", "9", "3"], [brand, "500 mg", "B201", `${year + 2}-08-31`, "10", "5", "9", "0"]]), "?dryRun=false");
      const s = results(r).map((x) => x.status);
      assert.deepEqual(s, ["ERROR", "ERROR", "CREATED", "ERROR"], JSON.stringify(results(r)));
    });
    it("is refused when the pharmacy module is off", async () => {
      const c = await t.makeTenant("imp-c");
      assert.equal((await t.api("put", "/settings/PHARMACY_ENABLED", c.admin.token).send({ value: false })).status, 200);
      const r = await post("medicines", meds(), "", c.admin.token);
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, "FEATURE_DISABLED");
    });
  });

  describe("patients", () => {
    const head = ["firstName", "lastName", "gender", "dateOfBirth", "mobile", "bloodGroup", "legacyId"];
    it("creates patients with an MRN and a legacy ID, and a re-upload creates nobody twice", async () => {
      const m = randomMobile();
      const fn = uniqueWord(8);
      const ln = uniqueWord(8);
      const file = () => csv([head, [fn, ln, "f", "02/04/1990", m, "o+", `OLD-${fn}`]]);
      const p = await post("patients", file());
      assert.equal(p.body.data.wouldCreate, 1, JSON.stringify(p.body));
      assert.equal(await t.prisma.patient.count({ where: { tenantId: a.tenantId, firstName: fn } }), 0);
      const r = await post("patients", file(), "?dryRun=false");
      assert.equal(r.body.data.created, 1, JSON.stringify(r.body));
      const row = await t.prisma.patient.findFirstOrThrow({ where: { tenantId: a.tenantId, firstName: fn }, include: { identifiers: true } });
      assert.deepEqual(row.identifiers.map((i) => i.type).sort(), ["LEGACY", "MRN"]);
      assert.equal(row.dateOfBirth?.toISOString().slice(0, 10), "1990-04-02");
      const again = await post("patients", file(), "?dryRun=false");
      assert.equal(again.body.data.created, 0);
      assert.equal(await t.prisma.patient.count({ where: { tenantId: a.tenantId, firstName: fn } }), 1);
    });
    it("never merges or silently duplicates: a likely duplicate and a repeated row are skipped and named", async () => {
      const base = patientBody();
      const row = [base["firstName"], base["lastName"], "FEMALE", "1990-04-02", base["mobile"], undefined, undefined];
      const first = await post("patients", csv([head, row]), "?dryRun=false");
      assert.equal(first.body.data.created, 1);
      const dup = await post("patients", csv([head, row, row]), "?dryRun=false");
      assert.equal(dup.body.data.created, 0);
      assert.match(results(dup)[0]?.message ?? "", /Possible duplicate of MRN/);
      assert.match(results(dup)[1]?.message ?? "", /Same person as row 2/);
    });
    it("a shared mobile number is skipped unless the administrator chooses to import it, and the override is recorded", async () => {
      const m = randomMobile();
      const one = csv([head, [uniqueWord(8), uniqueWord(8), "MALE", "1985-01-01", m, undefined, undefined]]);
      const two = csv([head, [uniqueWord(8), uniqueWord(8), "FEMALE", "1992-06-06", m, undefined, undefined]]);
      assert.equal((await post("patients", one, "?dryRun=false")).body.data.created, 1);
      const skipped = await post("patients", two, "?dryRun=false");
      assert.equal(skipped.body.data.created, 0);
      assert.equal(skipped.body.data.skipped, 1);
      const imported = await post("patients", two, "?dryRun=false&sharedMobile=import");
      assert.equal(imported.body.data.created, 1, JSON.stringify(imported.body));
      assert.match(results(imported)[0]?.message ?? "", /Shares a mobile number/);
    });
    it("explains bad rows without leaking what was typed", async () => {
      const r = await post("patients", csv([head, ["", "", "robot", "2090-01-01", "123", undefined, "bad id!"], [uniqueWord(6), "", "FEMALE", "1990-01-01", "98300", undefined, undefined]]));
      assert.equal(r.body.data.failed, 2);
      for (const x of results(r)) assert.ok(!/98300|robot/.test(x.message ?? ""), x.message ?? "");
    });
    it("is tenant-scoped: the same person can be registered at another hospital", async () => {
      const base = patientBody();
      const row = [base["firstName"], base["lastName"], "FEMALE", "1990-04-02", base["mobile"], undefined, undefined];
      assert.equal((await post("patients", csv([head, row]), "?dryRun=false")).body.data.created, 1);
      assert.equal((await post("patients", csv([head, row]), "?dryRun=false", b.admin.token)).body.data.created, 1);
    });
  });

  describe("limits", () => {
    it("refuses more than 2000 rows and an oversized file", async () => {
      const rows = [["code", "name", "category", "price"], ...Array.from({ length: 2001 }, (_, i) => [`C${i}`, "n", "OTHER", "1"])];
      const r = await post("services", csv(rows));
      assert.equal(r.status, 400);
      assert.match(r.body.error.message, /at most 2000 rows/);
      assert.equal((await post("services", Buffer.alloc(5 * 1024 * 1024 + 10, 97))).status, 413);
    });
    it("runs only one import of a kind at a time", async () => {
      const rows = [["code", "name", "category", "price"], ...Array.from({ length: 2000 }, (_, i) => [`R${uniqueWord(4).toUpperCase()}${i}`, "Bulk item", "OTHER", "1"])];
      const [x, y] = await Promise.all([post("services", csv(rows), "?dryRun=false"), post("services", csv(rows), "?dryRun=false")]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409], JSON.stringify([x.body.data?.created, y.body.data?.created, y.body.error, x.body.data?.results?.[0]]));
    });
  });
});
