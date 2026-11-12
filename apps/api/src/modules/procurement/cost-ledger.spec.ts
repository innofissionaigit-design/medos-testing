import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
const key = () => `k-${randomUUID().slice(0, 18)}`;
const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;

describe("the cost ledger carries sales, ward issues and adjustments too, agrees with the stock held, and can be back-filled", () => {
  let t: TestApp;
  let a: TestTenant; let b: TestTenant;
  let pharm: User; let mgr: User; let nurse: User; let rec: User; let bMgr: User;
  let doc: TestDoctor;

  const get = async (path: string, tok = mgr.token) => (await t.api("get", path, tok)).body.data;
  const post = (path: string, body: Record<string, unknown> = {}, tok = pharm.token, k?: string) => { const r = t.api("post", path, tok); return (k ? r.set("Idempotency-Key", k) : r).send(body); };
  const recon = async (tok = mgr.token) => (await get("/procurement/cost-ledger/reconciliation", tok)) as { stockHeldAtCost: string; ledgerStock: string; difference: string; reconciled: boolean };
  const trial = async (tok = mgr.token) => (await get("/procurement/cost-ledger?from=2000-01-01&to=2000-12-31", tok)) as unknown;
  const accountNet = async (account: string) => {
    const bal = (await get("/procurement/cost-ledger")) as { accounts: { account: string; debit: string; credit: string }[] };
    const x = bal.accounts.find((r) => r.account === account)!;
    return Number(x.debit) - Number(x.credit);
  };
  const medicine = async (gst = 0) => (await t.api("post", "/medicines", pharm.token).send({ brandName: `Brand${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "500 mg", dosageForm: "TABLET", gstPercent: gst, reorderLevel: 0 })).body.data as { id: string };
  const batch = async (medicineId: string, qty: number, price = "10.00") => {
    const r = await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({ medicineId, batchNo: `B${uniqueWord(5)}`, expiryDate: ymd(365), mrp: "100.00", purchasePrice: price, sellingPrice: "90.00", quantity: qty });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string };
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("cl-a"); b = await t.makeTenant("cl-b");
    pharm = await t.makeUser(a, ["PHARMACIST"]); mgr = await t.makeUser(a, ["MANAGER"]); nurse = await t.makeUser(a, ["NURSE"]); rec = await t.makeUser(a, ["RECEPTIONIST"]);
    bMgr = await t.makeUser(b, ["MANAGER"]);
    doc = await makeDoctor(t, a);
  });
  after(async () => { await t.close(); });

  it("opening stock, sales, patient returns, ward issues, damage, adjustments and counts are posted at cost, and the ledger agrees with the stock held at every step", async () => {
    assert.equal((await recon()).reconciled, true, "an empty hospital agrees");
    const m = await medicine();
    const opening = await batch(m.id, 50, "10.00"); // opening stock: 500.00 into stock
    let r = await recon();
    assert.equal(r.stockHeldAtCost, "500.00");
    assert.equal(r.reconciled, true, JSON.stringify(r));
    assert.equal(await accountNet("STOCK_ADJUSTMENT"), -500, "opening stock is a gain against the adjustment account");

    // A sale: 4 units at the cost of 10.00 = 40.00 of cost of goods sold; a patient return puts 1 back.
    const patient = await registerPatient(t, rec.token);
    const sale = await post("/pharmacy/dispenses", { patientId: patient.id, items: [{ medicineId: m.id, quantity: 4 }] }, pharm.token, key());
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const dispense = sale.body.data.dispense as { id: string; items: { id: string }[] };
    assert.equal(await accountNet("COST_OF_GOODS_SOLD"), 40);
    r = await recon();
    assert.equal(r.stockHeldAtCost, "460.00");
    assert.equal(r.reconciled, true, JSON.stringify(r));
    const item = dispense.items[0]!;
    const ret = await post(`/pharmacy/dispenses/${dispense.id}/returns`, { reason: "Patient stopped treatment", items: [{ dispenseItemId: item.id, quantity: 1 }] }, pharm.token, key());
    assert.equal(ret.status, 201, JSON.stringify(ret.body));
    assert.equal(await accountNet("COST_OF_GOODS_SOLD"), 30, "the returned unit comes off the cost of goods sold");
    assert.equal((await recon()).reconciled, true);

    // Damage and adjustments.
    assert.equal((await post("/pharmacy/stock/adjustments", { batchId: opening.id, direction: "OUT", kind: "DAMAGE", quantity: 2, reason: "Broken in storage" }, pharm.token, key())).status, 201);
    assert.equal((await post("/pharmacy/stock/adjustments", { batchId: opening.id, direction: "IN", kind: "ADJUSTMENT", quantity: 1, reason: "Found on the shelf" }, pharm.token, key())).status, 201);
    assert.equal(await accountNet("STOCK_ADJUSTMENT"), -500 + 20 - 10, "two units written off and one found, at 10.00");
    r = await recon();
    assert.equal(r.stockHeldAtCost, "460.00");
    assert.equal(r.reconciled, true, JSON.stringify(r));

    // A ward issue to an admitted patient, and a count in the ward store that finds one unit fewer.
    const ward = (await t.api("post", "/wards", a.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    const room = (await t.api("post", "/rooms", a.admin.token).send({ wardId: ward.id, name: "Room", code: code("R") })).body.data;
    const bed = (await t.api("post", "/beds", a.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: "1000" })).body.data;
    const adm = (await t.api("post", "/admissions", rec.token).send({ patientId: patient.id, consultantId: doc.practitionerId, bedId: bed.id, reason: "Pneumonia needing IV antibiotics" })).body.data as { id: string };
    const store = (await t.api("post", "/pharmacy/locations", pharm.token).send({ name: `Ward store ${uniqueWord(4)}` })).body.data as { id: string; name: string };
    assert.equal((await post("/pharmacy/transfers", { fromLocationId: null, toLocationId: store.id, reason: "Ward stock", items: [{ batchId: opening.id, quantity: 10 }] }, pharm.token, key())).status, 201);
    assert.equal((await recon()).reconciled, true, "a transfer moves stock between places without changing the total");
    assert.equal((await post(`/admissions/${adm.id}/ward-store-issues`, { locationId: store.id, batchId: opening.id, quantity: 3, remarks: "Night dose" }, nurse.token, key())).status, 201);
    assert.equal(await accountNet("COST_OF_GOODS_SOLD"), 30 + 30, "3 units issued to a patient from the ward store");
    r = await recon();
    assert.equal(r.stockHeldAtCost, "430.00");
    assert.equal(r.reconciled, true, JSON.stringify(r));
    const counter = await t.makeUser(a, ["NURSE"]);
    const count = await post("/procurement/stock-counts", { locationId: store.id }, counter.token);
    assert.equal(count.status, 201, JSON.stringify(count.body));
    const line = count.body.data.items[0] as { id: string; systemQuantity: number };
    assert.equal((await t.api("put", `/procurement/stock-counts/${count.body.data.id}/counts`, counter.token).send({ items: [{ itemId: line.id, countedQuantity: line.systemQuantity - 1, reason: "One strip missing from the shelf" }] })).status, 200);
    assert.equal((await post(`/procurement/stock-counts/${count.body.data.id}/submit`, {}, counter.token)).status, 200);
    assert.equal((await post(`/procurement/stock-counts/${count.body.data.id}/approve`, {}, mgr.token)).status, 200);
    assert.equal(await accountNet("STOCK_ADJUSTMENT"), -500 + 20 - 10 + 10, "the missing unit is a loss");
    r = await recon();
    assert.equal(r.stockHeldAtCost, "420.00");
    assert.equal(r.reconciled, true, JSON.stringify(r));

    // Every entry balances, nothing was posted twice, and the ledger is for this hospital only.
    const rows = await t.prisma.journalEntry.findMany({ where: { tenantId: a.tenantId }, include: { lines: true } });
    for (const e of rows) assert.equal(e.lines.reduce((x, l) => x + Number(l.debit), 0), e.lines.reduce((x, l) => x + Number(l.credit), 0), `entry ${e.sourceKey} balances`);
    assert.equal(new Set(rows.map((e) => e.sourceKey)).size, rows.length);
    assert.equal(Number((await recon(bMgr.token)).stockHeldAtCost), 0, "another hospital sees its own stock");
    assert.equal((await t.api("get", "/procurement/cost-ledger/reconciliation", rec.token)).status, 403);
    assert.equal((await t.api("get", "/procurement/cost-ledger?account=NOPE", mgr.token)).status, 400);
    assert.ok(await trial());
  });

  it("back-fill: events from before the ledger existed are posted from their records with the same entries, once; running it again changes nothing; it is for finance only", async () => {
    // Stock history that predates the ledger: remove its postings, as if it had never been made.
    const supplier = (await t.api("post", "/pharmacy/suppliers", pharm.token).send({ name: `Supplier ${uniqueWord(6)}` })).body.data as { id: string };
    const m = await medicine(12);
    const grn = await t.api("post", "/pharmacy/purchases", pharm.token).set("Idempotency-Key", key()).send({
      supplierId: supplier.id, supplierInvoiceNo: `INV-${uniqueWord(6)}`, supplierInvoiceDate: ymd(-3),
      items: [{ medicineId: m.id, batchNo: `B${uniqueWord(5)}`, expiryDate: ymd(400), mrp: "100.00", purchasePrice: "20.00", sellingPrice: "90.00", quantity: 10, gstPercent: "12" }],
    });
    assert.equal(grn.status, 201, JSON.stringify(grn.body));
    const purchaseId = grn.body.data.id as string;
    assert.equal((await post(`/procurement/payables/${purchaseId}/payments`, { amount: "100.00", method: "CASH" }, mgr.token, key())).status, 201);
    const before = await get("/procurement/cost-ledger/reconciliation");
    assert.equal(before.reconciled, true);
    const bal0 = (await get("/procurement/cost-ledger")) as { totalDebit: string; accounts: { account: string; closing: string }[] };

    // Wipe this hospital's ledger the only way the database allows: as its owner, in a way no application path can.
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "JournalLine" DISABLE TRIGGER journal_line_immutable`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "JournalEntry" DISABLE TRIGGER journal_entry_immutable`);
    try {
      await t.prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "tenantId" = ${a.tenantId}::uuid`;
      await t.prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "tenantId" = ${a.tenantId}::uuid`;
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "JournalLine" ENABLE TRIGGER journal_line_immutable`);
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "JournalEntry" ENABLE TRIGGER journal_entry_immutable`);
    }
    const wiped = await get("/procurement/cost-ledger/reconciliation");
    assert.equal(wiped.reconciled, false, "the ledger no longer agrees with the stock");
    assert.equal(wiped.ledgerStock, "0.00");

    const pending = (await get("/procurement/cost-ledger/backfill")) as Record<string, number>;
    assert.ok(pending["RECEIPT"]! >= 1 && pending["STOCK_MOVE"]! >= 1 && pending["SUPPLIER_PAYMENT"]! >= 1, JSON.stringify(pending));
    assert.equal((await t.api("post", "/procurement/cost-ledger/backfill", rec.token).send({})).status, 403);
    assert.equal((await t.api("post", "/procurement/cost-ledger/backfill", pharm.token).send({})).status, 403, "finance only");
    assert.equal((await t.api("get", "/procurement/cost-ledger/backfill", rec.token)).status, 403);
    const theirs = await t.api("post", "/procurement/cost-ledger/backfill", bMgr.token).send({});
    assert.equal(theirs.status, 200, "another hospital's manager can only post their own (empty) history");
    assert.equal(Object.values(theirs.body.data.posted as Record<string, number>).reduce((x, y) => x + y, 0), 0);

    const finance = await t.makeUser(a, ["ADMINISTRATOR"]);
    let guard = 0;
    for (;;) {
      const run = await t.api("post", "/procurement/cost-ledger/backfill", finance.token).send({});
      assert.equal(run.status, 200, JSON.stringify(run.body));
      if (run.body.data.done) break;
      assert.ok(++guard < 20, "it finishes");
    }
    const after = await get("/procurement/cost-ledger/reconciliation");
    assert.equal(after.reconciled, true, JSON.stringify(after));
    const bal1 = (await get("/procurement/cost-ledger")) as { totalDebit: string; accounts: { account: string; closing: string }[] };
    assert.deepEqual(bal1.accounts.map((x) => [x.account, x.closing]), bal0.accounts.map((x) => [x.account, x.closing]), "the same balances as when they were posted live");
    assert.equal(bal1.totalDebit, bal0.totalDebit);
    const entry = await t.prisma.journalEntry.findFirstOrThrow({ where: { tenantId: a.tenantId, sourceKey: `RECEIPT:${purchaseId}` } });
    assert.ok(entry.entryDate.getTime() < Date.now() - 1000, "dated when the receipt happened, not when it was back-filled (or at least not in the future)");

    // Again: nothing new.
    const count = await t.prisma.journalEntry.count({ where: { tenantId: a.tenantId } });
    const again = await t.api("post", "/procurement/cost-ledger/backfill", finance.token).send({});
    assert.equal(again.body.data.done, true);
    assert.equal(Object.values(again.body.data.posted as Record<string, number>).reduce((x, y) => x + y, 0), 0);
    assert.equal(await t.prisma.journalEntry.count({ where: { tenantId: a.tenantId } }), count);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "COST_LEDGER_BACKFILLED" } }));
    // Another hospital's history was never touched.
    assert.equal(await t.prisma.journalEntry.count({ where: { tenantId: b.tenantId } }), 0);
  });
});
