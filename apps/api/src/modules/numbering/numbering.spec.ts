import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startApp, type TestApp, type TestTenant } from "../../test/harness";
import { NumberingService } from "./numbering.service";

describe("number sequence engine", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let numbering: NumberingService;
  const next = (tenant: TestTenant, type: Parameters<NumberingService["next"]>[3], facilityId = tenant.facilityId, at?: Date) =>
    t.prisma.$transaction((tx) => numbering.next(tx, tenant.tenantId, facilityId, type, at));

  before(async () => {
    t = await startApp();
    numbering = t.app.get(NumberingService);
    a = await t.makeTenant("seq-a");
    b = await t.makeTenant("seq-b");
  });
  after(async () => { await t.close(); });

  it("formats numbers from the configured pattern, padding and facility code", async () => {
    const f = await t.prisma.facility.findFirstOrThrow({ where: { id: a.facilityId } });
    assert.equal(await next(a, "MRN"), `${f.code}-000001`);
    assert.equal(await next(a, "MRN"), `${f.code}-000002`);
    const year = new Date().getFullYear();
    assert.equal(await next(a, "INVOICE"), `INV-${year}-000001`);
  });

  it("generates unique, gap-free numbers under heavy parallel load", async () => {
    const N = 60;
    const results = await Promise.all(Array.from({ length: N }, () => next(a, "RECEIPT")));
    assert.equal(new Set(results).size, N, "no duplicates");
    const seqs = results.map((r) => Number(r.split("-").pop())).sort((x, y) => x - y);
    assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1));
  });

  it("rolls the number back with its transaction (no gaps from failed work)", async () => {
    await assert.rejects(() => t.prisma.$transaction(async (tx) => {
      await numbering.next(tx, a.tenantId, a.facilityId, "PRESCRIPTION");
      throw new Error("simulated business failure");
    }));
    const n = await next(a, "PRESCRIPTION");
    assert.ok(n.endsWith("-000001"), n);
  });

  it("keeps counters independent per tenant, per facility and per type", async () => {
    const x = await next(b, "ADMISSION");
    const y = await next(a, "ADMISSION");
    const z = await next(a, "ADMISSION", a.facility2Id);
    for (const v of [x, y, z]) assert.ok(v.endsWith("-000001"), v);
    assert.ok((await next(a, "OPD_VISIT")).endsWith("-000001"));
  });

  it("resets yearly sequences at the facility's local new year (Asia/Kolkata)", async () => {
    const lateDec = new Date("2026-12-31T17:00:00Z"); // 22:30 IST, still 2026
    const newYearIst = new Date("2026-12-31T19:00:00Z"); // 00:30 IST on 1 Jan 2027
    const a1 = await next(a, "CREDIT_NOTE", a.facilityId, lateDec);
    const a2 = await next(a, "CREDIT_NOTE", a.facilityId, newYearIst);
    const a3 = await next(a, "CREDIT_NOTE", a.facilityId, newYearIst);
    assert.equal(a1, "CN-2026-000001");
    assert.equal(a2, "CN-2027-000001");
    assert.equal(a3, "CN-2027-000002");
  });

  it("rejects an unknown facility without leaking whether it exists in another tenant", async () => {
    await assert.rejects(() => next(a, "MRN", b.facilityId), (e: unknown) => (e as { code?: string }).code === "FACILITY_NOT_FOUND");
  });

  it("admin can view and change the pattern; changes apply to future numbers and are audited", async () => {
    const list = await t.api("get", "/number-sequences", a.admin.token);
    assert.equal(list.status, 200);
    assert.ok(list.body.data.find((s: { type: string }) => s.type === "MRN"));
    const put = await t.api("put", "/number-sequences/EMPTYTYPE", a.admin.token).send({ pattern: "X-{SEQ}", padding: 4, resetPolicy: "NEVER" });
    assert.equal(put.status, 404);
    const ok = await t.api("put", "/number-sequences/PURCHASE", a.admin.token).send({ pattern: "PO/{FACILITY}/{YEAR}/{SEQ}", padding: 4, resetPolicy: "YEARLY" });
    assert.equal(ok.status, 200);
    const f = await t.prisma.facility.findFirstOrThrow({ where: { id: a.facilityId } });
    assert.match(await next(a, "PURCHASE"), new RegExp(`^PO/${f.code}/\\d{4}/0001$`));
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "NUMBER_SEQUENCE_CONFIG_CHANGED" } }));
  });

  it("restarts at 1 April when set to the financial year, using the facility's local date", async () => {
    const put = (body: Record<string, unknown>, type = "STOCK_TRANSFER") => t.api("put", `/number-sequences/${type}`, a.admin.token).send(body);
    assert.equal((await put({ pattern: "TRF/{FY}/{SEQ}", padding: 4, resetPolicy: "FINANCIAL_YEAR" })).status, 200);
    const lateMarch = new Date("2027-03-31T18:00:00Z"); // 23:30 IST on 31 March 2027: still financial year 2026-27
    const aprilFirst = new Date("2027-03-31T19:00:00Z"); // 00:30 IST on 1 April 2027: the new financial year
    assert.equal(await next(a, "STOCK_TRANSFER", a.facilityId, new Date("2026-11-04T05:00:00Z")), "TRF/2026-27/0001");
    assert.equal(await next(a, "STOCK_TRANSFER", a.facilityId, new Date("2027-01-15T05:00:00Z")), "TRF/2026-27/0002", "January is still the same financial year");
    assert.equal(await next(a, "STOCK_TRANSFER", a.facilityId, lateMarch), "TRF/2026-27/0003");
    assert.equal(await next(a, "STOCK_TRANSFER", a.facilityId, aprilFirst), "TRF/2027-28/0001");
    assert.equal(await next(a, "STOCK_TRANSFER", a.facilityId, aprilFirst), "TRF/2027-28/0002");
    // The restart rule and the pattern have to agree.
    assert.equal((await put({ pattern: "TRF-{SEQ}", padding: 4, resetPolicy: "FINANCIAL_YEAR" })).status, 400, "needs {FY}");
    assert.equal((await put({ pattern: "TRF/{FY}/{SEQ}", padding: 4, resetPolicy: "YEARLY" })).status, 400, "{FY} needs the financial-year restart");
    assert.equal((await put({ pattern: "TRF/{FY}/{SEQ}", padding: 4, resetPolicy: "NEVER" })).status, 400);
  });

  it("changing the restart rule never issues a number that was already issued", async () => {
    const year = new Date().getFullYear();
    const put = (resetPolicy: string) => t.api("put", "/number-sequences/DOCTOR_PAYOUT", a.admin.token).send({ pattern: "DPV-{YEAR}-{SEQ}", padding: 6, resetPolicy });
    assert.deepEqual([await next(a, "DOCTOR_PAYOUT"), await next(a, "DOCTOR_PAYOUT"), await next(a, "DOCTOR_PAYOUT")], [1, 2, 3].map((n) => `DPV-${year}-${String(n).padStart(6, "0")}`));
    // Yearly -> never: the counter would start again at 1 and re-issue DPV-<year>-000001. It continues instead.
    const never = await put("NEVER");
    assert.equal(never.status, 200);
    assert.equal(never.body.data.nextNumber, 4);
    assert.equal(await next(a, "DOCTOR_PAYOUT"), `DPV-${year}-000004`);
    const back = await put("YEARLY");
    assert.equal(back.body.data.nextNumber, 5, "and back again");
    assert.equal(await next(a, "DOCTOR_PAYOUT"), `DPV-${year}-000005`);
    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "NUMBER_SEQUENCE_CONFIG_CHANGED", entityId: "DOCTOR_PAYOUT" }, orderBy: { createdAt: "desc" } });
    assert.deepEqual((evt.metadata as { restart: string[] }).restart, ["NEVER", "YEARLY"]);
  });

  it("an administrator can continue an existing series: the next number can be raised, never lowered, and stays gap-free and unique under load", async () => {
    const year = new Date().getFullYear();
    const put = (nextNumber: number) => t.api("put", "/number-sequences/CLAIM", a.admin.token).send({ pattern: "CLM-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY", nextNumber });
    const raised = await put(1500);
    assert.deepEqual([raised.status, raised.body.data.nextNumber], [200, 1500]);
    const shown = (await t.api("get", "/number-sequences", a.admin.token)).body.data.find((x: { type: string }) => x.type === "CLAIM");
    assert.deepEqual([shown.nextNumber, shown.example], [1500, `CLM-${year}-001500`], "the list shows what comes next");
    assert.equal(await next(a, "CLAIM"), `CLM-${year}-001500`);
    const lower = await put(10);
    assert.equal(lower.body.data.nextNumber, 1501, "a lower number is ignored: issued numbers are never issued again");
    const batch = await Promise.all(Array.from({ length: 12 }, () => next(a, "CLAIM")));
    assert.deepEqual(batch.map((n) => Number(n.split("-").pop())).sort((x, y) => x - y), Array.from({ length: 12 }, (_, i) => 1501 + i));
    assert.equal((await put(0)).status, 400);
    const fresh = (await t.api("get", "/number-sequences", a.admin.token)).body.data.find((x: { type: string }) => x.type === "LAB_ACCESSION");
    assert.equal(fresh.nextNumber, 1, "an unused series starts at 1");
    const unchanged = (await t.api("get", "/number-sequences", a.admin.token)).body.data;
    assert.equal(unchanged.find((x: { type: string }) => x.type === "LAB_ACCESSION").isDefault, true, "an unchanged format is not shown as custom");
    assert.equal(unchanged.find((x: { type: string }) => x.type === "STOCK_TRANSFER").isDefault, false, "a changed one is");
  });

  it("bills that carry GST keep to the 16 character rule: only letters, digits, - and /", async () => {
    const put = (type: string, pattern: string, padding = 6) => t.api("put", `/number-sequences/${type}`, a.admin.token).send({ pattern, padding, resetPolicy: pattern.includes("{YEAR}") ? "YEARLY" : "NEVER" });
    const long = await put("INVOICE", "INVOICE/{FACILITY}/{YEAR}/{SEQ}");
    assert.equal(long.status, 400);
    assert.match(long.body.error.message, /at most 16 characters/);
    assert.equal((await put("INVOICE", "INV_{YEAR}_{SEQ}")).status, 400, "underscore is not allowed");
    assert.equal((await put("CREDIT_NOTE", "CN.{SEQ}")).status, 400, "nor a dot");
    assert.equal((await put("INVOICE", "INV/{YEAR}/{SEQ}", 8)).status, 400, "INV/2026/ + 8 digits is 17");
    assert.equal((await put("INVOICE", "INV/{YEAR}/{SEQ}", 7)).status, 200, "exactly 16 is fine");
    assert.equal((await put("INVOICE", "INV-{YEAR}-{SEQ}", 6)).status, 200, "the default shape");
    // Other records are not tax bills and may be longer.
    assert.equal((await put("PURCHASE", "PURCHASE/{FACILITY}/{YEAR}/{SEQ}", 8)).status, 200);
  });

  it("rejects unsafe or collision-prone configurations", async () => {
    const bad = [
      { pattern: "NOSEQ-{YEAR}", padding: 6, resetPolicy: "YEARLY" },
      { pattern: "INV-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
      { pattern: "INV-{BOGUS}-{SEQ}", padding: 6, resetPolicy: "NEVER" },
      { pattern: "INV-{SEQ}-<script>", padding: 6, resetPolicy: "NEVER" },
      { pattern: "INV-{SEQ}", padding: 0, resetPolicy: "NEVER" },
      { pattern: "INV-{SEQ}", padding: 13, resetPolicy: "NEVER" },
    ];
    for (const body of bad) assert.equal((await t.api("put", "/number-sequences/INVOICE", a.admin.token).send(body)).status, 400, JSON.stringify(body));
  });

  it("only administrators with settings permission can configure sequences", async () => {
    const cashier = await t.makeUser(a, ["CASHIER"]);
    assert.equal((await t.api("put", "/number-sequences/INVOICE", cashier.token).send({ pattern: "I-{SEQ}", padding: 6, resetPolicy: "NEVER" })).status, 403);
  });

  it("the database refuses negative counters", async () => {
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "NumberSequence" SET "lastValue" = -1 WHERE "tenantId" = ${a.tenantId}::uuid`);
  });
});
