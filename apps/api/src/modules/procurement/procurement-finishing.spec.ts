import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
const key = () => `k-${randomUUID().slice(0, 18)}`;
const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

describe("procurement finishing: a second approval on indents, supplier statement payments, the cost ledger", () => {
  let t: TestApp;
  let a: TestTenant; let b: TestTenant;
  let pharm: User; let proc: User; let mgr: User; let mgr2: User; let admin2: User; let req: User; let ot: User; let bMgr: User; let bPharm: User; let rec: User;

  const medicine = async () => (await t.api("post", "/medicines", pharm.token).send({ brandName: `Brand${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "500 mg", dosageForm: "TABLET", gstPercent: 0, reorderLevel: 0 })).body.data as { id: string };
  const supplier = async (tok = pharm.token) => (await t.api("post", "/pharmacy/suppliers", tok).send({ name: `Supplier ${uniqueWord(6)}` })).body.data as { id: string };
  const post = (path: string, body: Record<string, unknown> = {}, tok = mgr.token, k?: string) => { const r = t.api("post", path, tok); return (k ? r.set("Idempotency-Key", k) : r).send(body); };
  const get = async (path: string, tok = mgr.token) => (await t.api("get", path, tok)).body.data;
  const setting = async (k: string, value: unknown) => assert.equal((await t.api("put", `/settings/${k}`, a.admin.token).send({ value })).status, 200);
  /** A goods receipt of `qty` units at `price` with `gst` percent, against no order. */
  const receive = async (supplierId: string, medicineId: string, qty: number, price: string, invDate: string, gst = "0") => {
    const r = await t.api("post", "/pharmacy/purchases", pharm.token).set("Idempotency-Key", key()).send({
      supplierId, supplierInvoiceNo: `INV-${uniqueWord(6)}`, supplierInvoiceDate: invDate,
      items: [{ medicineId, batchNo: `B${uniqueWord(5)}`, expiryDate: ymd(400), mrp: "100.00", purchasePrice: price, sellingPrice: "90.00", quantity: qty, ...(gst !== "0" ? { gstPercent: gst } : {}) }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string; total: string; purchaseNumber: string; items: { id: string; batchId: string }[] };
  };
  const balances = async (tok = mgr.token, q = "") => (await get(`/procurement/cost-ledger${q}`, tok)) as { accounts: { account: string; debit: string; credit: string; closing: string }[]; totalDebit: string; totalCredit: string; balanced: boolean; consumptionByCostCentre: { costCentre: string; cost: string }[] };
  const acct = (b: Awaited<ReturnType<typeof balances>>, name: string) => b.accounts.find((x) => x.account === name)!;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("procf-a"); b = await t.makeTenant("procf-b");
    pharm = await t.makeUser(a, ["PHARMACIST"]); proc = await t.makeUser(a, ["PROCUREMENT"]); mgr = await t.makeUser(a, ["MANAGER"]); mgr2 = await t.makeUser(a, ["MANAGER"]);
    admin2 = await t.makeUser(a, ["ADMINISTRATOR"]); req = await t.makeUser(a, ["ADMINISTRATOR"]); ot = await t.makeUser(a, ["OT_COORDINATOR"]); rec = await t.makeUser(a, ["RECEPTIONIST"]);
    bMgr = await t.makeUser(b, ["MANAGER"]); bPharm = await t.makeUser(b, ["PHARMACIST"]);
  });
  after(async () => { await t.close(); });

  it("a second approval on indents: above the limit two different people approve, neither the requester; below it one is enough", async () => {
    const m = await medicine();
    await receive((await supplier()).id, m.id, 10, "50.00", ymd(0)); // the latest price of the medicine: 50.00
    const indent = async (qty: number, who: User = pharm) => {
      const made = await post("/procurement/indents", { items: [{ medicineId: m.id, quantity: qty }] }, who.token);
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const sub = await post(`/procurement/indents/${made.body.data.id}/submit`, {}, who.token);
      assert.equal(sub.status, 200, JSON.stringify(sub.body));
      return sub.body.data as { id: string; approvalsRequired: number; estimatedValue: string | null; status: string };
    };
    const approve = (id: string, tok: string) => post(`/procurement/indents/${id}/approve`, {}, tok);

    // No limit set: one approval, as before.
    const plain = await indent(100);
    assert.equal(plain.approvalsRequired, 1);
    assert.equal(plain.estimatedValue, "5000.00", "100 units at the latest price of 50.00");
    assert.equal((await approve(plain.id, mgr.token)).body.data.status, "APPROVED");

    await setting("INDENT_SECOND_APPROVAL_LIMIT", "1000.00");
    try {
      const small = await indent(10); // 500.00
      assert.equal(small.approvalsRequired, 1, "below the limit");
      assert.equal((await approve(small.id, mgr.token)).body.data.status, "APPROVED");

      const big = await indent(100, req); // 5000.00
      assert.equal(big.approvalsRequired, 2);
      assert.equal(big.estimatedValue, "5000.00");
      assert.equal((await approve(big.id, req.token)).status, 409, "the requester cannot approve (SELF_APPROVAL)");
      assert.equal((await approve(big.id, pharm.token)).status, 403, "the pharmacy cannot approve");
      assert.equal((await approve(big.id, proc.token)).status, 403, "procurement does not approve");
      const first = await approve(big.id, mgr.token);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.data.status, "SUBMITTED", "still waiting for the second approver");
      assert.equal(first.body.data.awaitingSecondApproval, true);
      assert.ok(first.body.data.firstApprovedBy);
      const dup = await approve(big.id, mgr.token);
      assert.equal(dup.status, 409, "the first approver cannot also give the second");
      assert.equal(dup.body.error.code, "SELF_APPROVAL");
      assert.equal((await post(`/procurement/indents/${big.id}/reject`, { reason: "I changed my mind" }, mgr.token)).status, 409, "nor reject it afterwards");
      assert.equal((await post("/procurement/orders", { indentId: big.id, supplierId: (await supplier()).id, items: [{ medicineId: m.id, quantity: 10, rate: "50.00" }] }, proc.token)).status, 409, "no order until it is approved");
      const second = await approve(big.id, admin2.token);
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.data.status, "APPROVED");
      assert.notEqual(second.body.data.decidedBy, first.body.data.firstApprovedBy);
      const row = await t.prisma.purchaseIndent.findFirstOrThrow({ where: { id: big.id } });
      assert.equal(row.approvalsRequired, 2);
      assert.ok(row.firstApprovedById && row.decidedById && row.firstApprovedById !== row.decidedById && row.decidedById !== row.requestedById);
      for (const action of ["INDENT_FIRST_APPROVED", "INDENT_APPROVED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action, entityId: big.id } }), `${action} is audited`);

      // The need is fixed at submission: raising the limit later does not change an indent already waiting.
      const waiting = await indent(100);
      await setting("INDENT_SECOND_APPROVAL_LIMIT", "1000000.00");
      assert.equal((await approve(waiting.id, mgr.token)).body.data.status, "SUBMITTED");
      // Either approver may reject it, with a reason; a rejection by someone else ends it.
      assert.equal((await post(`/procurement/indents/${waiting.id}/reject`, { reason: "Too much for this month" }, mgr2.token)).body.data.status, "REJECTED");

      // The database holds it too.
      await setting("INDENT_SECOND_APPROVAL_LIMIT", "1000.00");
      const guarded = await indent(100);
      await assert.rejects(() => t.prisma.$executeRaw`UPDATE "PurchaseIndent" SET status = 'APPROVED', "decidedById" = ${mgr.id}::uuid, "decidedAt" = now() WHERE id = ${guarded.id}::uuid`, "two approvals are needed");
      await approve(guarded.id, mgr.token);
      await assert.rejects(() => t.prisma.$executeRaw`UPDATE "PurchaseIndent" SET "firstApprovedById" = ${mgr2.id}::uuid WHERE id = ${guarded.id}::uuid`, "the first approval never changes");
      await assert.rejects(() => t.prisma.$executeRaw`UPDATE "PurchaseIndent" SET status = 'APPROVED', "decidedById" = "firstApprovedById", "decidedAt" = now() WHERE id = ${guarded.id}::uuid`, "the second approver is not the first");
      await assert.rejects(() => t.prisma.$executeRaw`UPDATE "PurchaseIndent" SET "approvalsRequired" = 1 WHERE id = ${guarded.id}::uuid`, "what an indent needs is fixed at submission");
    } finally { await setting("INDENT_SECOND_APPROVAL_LIMIT", "0.00"); }
    // Another hospital cannot approve it.
    const other = await indent(1);
    assert.equal((await approve(other.id, bMgr.token)).status, 404);
  });

  it("paying a supplier's statement: several invoices in one payment, by amount per invoice or one amount spread over the oldest first; never more than owed; one payment run", async () => {
    const s = await supplier(); const m = await medicine();
    const i1 = await receive(s.id, m.id, 10, "10.00", ymd(-30)); // 100.00, oldest
    const i2 = await receive(s.id, m.id, 20, "10.00", ymd(-20)); // 200.00
    const i3 = await receive(s.id, m.id, 30, "10.00", ymd(-10)); // 300.00
    const otherS = await supplier(); const foreign = await receive(otherS.id, m.id, 5, "10.00", ymd(-5));
    const pay = (body: Record<string, unknown>, tok = mgr.token, k = key()) => post("/procurement/payables/statement-payments", body, tok, k);
    const owing = async () => ((await get(`/procurement/payables?supplierId=${s.id}&show=ALL`)).items as { purchaseId: string; balance: string }[]);

    assert.equal((await t.api("post", "/procurement/payables/statement-payments", mgr.token).send({ supplierId: s.id, method: "CASH", amount: "50.00" })).status, 400, "an idempotency key is required");
    for (const bad of [
      { supplierId: s.id, method: "CASH" },
      { supplierId: s.id, method: "CASH", amount: "50.00", lines: [{ purchaseId: i1.id, amount: "50.00" }] },
      { supplierId: s.id, method: "UPI", amount: "50.00" },
      { supplierId: s.id, method: "CASH", amount: "0.00" },
      { supplierId: s.id, method: "CASH", lines: [{ purchaseId: i1.id, amount: "10.00" }, { purchaseId: i1.id, amount: "10.00" }] },
      { supplierId: s.id, method: "CASH", lines: [] },
      { supplierId: s.id, method: "CASH", amount: "50.00", extra: 1 },
    ]) assert.equal((await pay(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await pay({ supplierId: s.id, method: "CASH", amount: "50.00" }, ot.token)).status, 403);
    assert.equal((await pay({ supplierId: s.id, method: "CASH", amount: "50.00" }, pharm.token)).status, 403, "paying is for finance");
    assert.equal((await pay({ supplierId: s.id, method: "CASH", amount: "50.00" }, bMgr.token)).status, 404, "another hospital's supplier");
    assert.equal((await pay({ supplierId: randomUUID(), method: "CASH", amount: "50.00" })).status, 404);

    // More than the supplier is owed, or an invoice that is not theirs, or more than one invoice leaves: refused, nothing paid.
    assert.equal((await pay({ supplierId: s.id, method: "CASH", amount: "600.01" })).status, 409);
    assert.equal((await pay({ supplierId: s.id, method: "CASH", lines: [{ purchaseId: foreign.id, amount: "10.00" }] })).status, 409, "another supplier's invoice");
    assert.equal((await pay({ supplierId: s.id, method: "CASH", lines: [{ purchaseId: i1.id, amount: "100.01" }] })).status, 409);
    assert.equal(await t.prisma.supplierPayment.count({ where: { purchaseId: { in: [i1.id, i2.id, i3.id] } } }), 0);

    // One amount, spread over the oldest invoices first: 100 clears the oldest, 150 more goes to the next one.
    const k = key();
    const spread = await pay({ supplierId: s.id, method: "UPI", reference: "UPI-STATEMENT-01", amount: "250.00" }, mgr.token, k);
    assert.equal(spread.status, 201, JSON.stringify(spread.body));
    assert.equal(spread.body.data.total, "250.00");
    assert.deepEqual(spread.body.data.payments.map((p: { purchaseNumber: string; amount: string }) => [p.purchaseNumber, p.amount]), [[i1.purchaseNumber, "100.00"], [i2.purchaseNumber, "150.00"]]);
    assert.equal((await pay({ supplierId: s.id, method: "UPI", reference: "UPI-STATEMENT-01", amount: "250.00" }, mgr.token, k)).status, 200, "a retry with the same key pays once");
    const after1 = await owing();
    assert.deepEqual(["100.00", "200.00", "300.00"].map((_, n) => after1.find((r) => r.purchaseId === [i1.id, i2.id, i3.id][n])!.balance), ["0.00", "50.00", "300.00"]);
    const run = await t.prisma.supplierPaymentRun.findFirstOrThrow({ where: { id: spread.body.data.runId } });
    assert.equal(run.total.toString(), "250");
    assert.equal(await t.prisma.supplierPayment.count({ where: { runId: run.id } }), 2);
    assert.equal(await t.prisma.supplierPayment.count({ where: { runId: run.id, method: "UPI", reference: "UPI-STATEMENT-01" } }), 2, "each invoice shows how it was paid");

    // An amount for each invoice.
    const lines = await pay({ supplierId: s.id, method: "BANK_TRANSFER", reference: "UTR-9988776655", lines: [{ purchaseId: i2.id, amount: "50.00" }, { purchaseId: i3.id, amount: "120.00" }] });
    assert.equal(lines.status, 201, JSON.stringify(lines.body));
    assert.equal(lines.body.data.total, "170.00");
    assert.equal((await pay({ supplierId: s.id, method: "CASH", amount: "180.01" })).status, 409, "180.00 is all that is left");
    const rest = await pay({ supplierId: s.id, method: "CASH", amount: "180.00" });
    assert.equal(rest.status, 201);
    assert.deepEqual((await owing()).map((r) => r.balance), ["0.00", "0.00", "0.00"]);
    assert.equal((await pay({ supplierId: s.id, method: "CASH", amount: "1.00" })).status, 409, "nothing is owed now");
    // Never edited, and the database holds the totals.
    await assert.rejects(() => t.prisma.supplierPaymentRun.update({ where: { id: run.id }, data: { total: "1.00" } }), "a payment run is never edited");
    await assert.rejects(() => t.prisma.$executeRaw`INSERT INTO "SupplierPayment" ("tenantId", "facilityId", "purchaseId", "amount", "method", "paidOn", "paidById", "runId") VALUES (${a.tenantId}::uuid, ${a.facilityId}::uuid, ${foreign.id}::uuid, 1, 'CASH', CURRENT_DATE, ${mgr.id}::uuid, ${run.id}::uuid)`, "a run only pays its own supplier's invoices");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "SUPPLIER_STATEMENT_PAID", entityId: run.id } }));
    assert.equal((await t.api("get", "/procurement/payables", rec.token)).status, 403);
  });

  it("the cost ledger: purchases, returns, credits, payments and consumption post balanced entries in the same transaction; the totals agree with the stock and payables records", async () => {
    const before0 = await balances();
    const s = await supplier(); const m = await medicine();
    const inv = await receive(s.id, m.id, 10, "100.00", ymd(0), "12"); // net 1000.00, GST 120.00, total 1120.00
    let bal = await balances();
    const d = (name: string, f: "debit" | "credit") => Number(acct(bal, name)[f]) - Number(acct(before0, name)[f]);
    assert.equal(d("INVENTORY", "debit"), 1000);
    assert.equal(d("GST_INPUT", "debit"), 120);
    assert.equal(d("SUPPLIER_PAYABLE", "credit"), 1120);
    assert.equal(bal.balanced, true);
    assert.equal(bal.totalDebit, bal.totalCredit);
    const entries = await get(`/procurement/cost-ledger/entries?account=SUPPLIER_PAYABLE`);
    const rec1 = entries.items.find((e: { sourceId: string }) => e.sourceId === inv.id);
    assert.ok(rec1, "the receipt is an entry");
    assert.equal(rec1.lines.reduce((x: number, l: { debit: string }) => x + Number(l.debit), 0), rec1.lines.reduce((x: number, l: { credit: string }) => x + Number(l.credit), 0), "debits equal credits");

    // Goods rejected at the check: only the accepted units are posted.
    const part = await t.api("post", "/pharmacy/purchases", pharm.token).set("Idempotency-Key", key()).send({
      supplierId: s.id, supplierInvoiceNo: `INV-${uniqueWord(6)}`, supplierInvoiceDate: ymd(0),
      items: [{ medicineId: m.id, batchNo: `B${uniqueWord(5)}`, expiryDate: ymd(400), mrp: "100.00", purchasePrice: "10.00", sellingPrice: "90.00", quantity: 8, rejectedQuantity: 2, rejectReason: "2 packs damaged" }],
    });
    assert.equal(part.status, 201, JSON.stringify(part.body));
    bal = await balances();
    assert.equal(d("INVENTORY", "debit"), 1080, "8 accepted units at 10.00 on top of the first receipt");

    // A supplier return: payables and stock go down together.
    const item = inv.items[0]!;
    assert.equal((await post(`/pharmacy/purchases/${inv.id}/returns`, { reason: "Wrong strength delivered", items: [{ purchaseItemId: item.id, quantity: 2 }] }, pharm.token, key())).status, 201);
    bal = await balances();
    assert.equal(d("SUPPLIER_PAYABLE", "debit"), 224, "2 units at 100.00 + 12% GST");
    assert.equal(d("INVENTORY", "credit"), 200);
    assert.equal(d("GST_INPUT", "credit"), 24);

    // A supplier credit for rejected goods, and a payment.
    const note = (await get("/procurement/debit-notes?status=RAISED")).find((n: { purchaseNumber: string }) => n.purchaseNumber === part.body.data.purchaseNumber) as { id: string; amount: string };
    assert.ok(note);
    assert.equal((await post(`/procurement/debit-notes/${note.id}/credit`, { reference: "CN-0042" })).status, 200);
    bal = await balances();
    assert.equal(d("PURCHASE_RETURNS", "credit"), Number(note.amount));
    const owed = Number((await get(`/procurement/payables?supplierId=${s.id}&show=ALL`)).items.find((r: { purchaseId: string }) => r.purchaseId === inv.id).balance);
    assert.equal(owed, 1120 - 224, "what the payables record says is owed on the receipt");
    assert.equal((await post(`/procurement/payables/${inv.id}/payments`, { amount: "500.00", method: "CASH" }, mgr.token, key())).status, 201);
    assert.equal((await post("/procurement/payables/statement-payments", { supplierId: s.id, method: "UPI", reference: "UPI-LEDGER-01", amount: "100.00" }, mgr.token, key())).status, 201);
    bal = await balances();
    assert.equal(d("CASH", "credit"), 500);
    assert.equal(d("BANK", "credit"), 100);
    assert.equal(d("SUPPLIER_PAYABLE", "debit"), 224 + Number(note.amount) + 500 + 100);

    // Consumption by a department posts the cost to its cost centre.
    const store = (await t.api("post", "/pharmacy/locations", pharm.token).send({ name: `OT store ${uniqueWord(4)}` })).body.data as { id: string; name: string };
    const batchId = (await t.prisma.purchaseItem.findFirstOrThrow({ where: { id: inv.items[0]!.id } })).batchId;
    assert.equal((await t.api("post", "/pharmacy/transfers", pharm.token).set("Idempotency-Key", key()).send({ fromLocationId: null, toLocationId: store.id, reason: "OT stock", items: [{ batchId, quantity: 6 }] })).status, 201);
    assert.equal((await t.api("post", "/procurement/consumption", ot.token).set("Idempotency-Key", key()).send({ locationId: store.id, batchId, quantity: 4, kind: "DEPARTMENT_USE", reason: "Dressings in the OT recovery bay" })).status, 201);
    bal = await balances();
    assert.equal(d("CONSUMPTION_EXPENSE", "debit"), 400, "4 units at 100.00");
    assert.equal(bal.consumptionByCostCentre.find((c) => c.costCentre === store.name)?.cost, "400.00");
    assert.equal(bal.balanced, true);

    // The two sides always agree, on every account, and nothing can be edited.
    assert.equal(Number(bal.totalDebit), Number(bal.totalCredit));
    const rows = await t.prisma.journalEntry.findMany({ where: { tenantId: a.tenantId }, include: { lines: true } });
    for (const e of rows) assert.equal(e.lines.reduce((x, l) => x + Number(l.debit), 0), e.lines.reduce((x, l) => x + Number(l.credit), 0), `entry ${e.sourceKey} balances`);
    await assert.rejects(() => t.prisma.journalLine.updateMany({ where: { tenantId: a.tenantId }, data: { debit: "1.00" } }), "lines are never edited");
    await assert.rejects(() => t.prisma.journalEntry.deleteMany({ where: { tenantId: a.tenantId } }), "entries are never deleted");
    await assert.rejects(() => t.prisma.$transaction(async (tx) => {
      const e = await tx.journalEntry.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, sourceKey: `TEST:${randomUUID()}`, sourceType: "Test", sourceId: randomUUID(), entryDate: new Date(), narration: "Unbalanced", createdById: mgr.id } });
      await tx.journalLine.create({ data: { tenantId: a.tenantId, entryId: e.id, account: "INVENTORY", debit: "10.00", credit: "0" } });
    }), "an entry that does not balance cannot be committed");
    assert.ok(await t.prisma.journalEntry.findFirst({ where: { tenantId: a.tenantId, sourceKey: `RECEIPT:${inv.id}` } }));

    // Permissions, ranges and hospital isolation.
    assert.equal((await t.api("get", "/procurement/cost-ledger", rec.token)).status, 403);
    assert.equal(Number((await balances(bPharm.token)).totalDebit), 0, "a pharmacist of another hospital reads only their own (empty) ledger");
    assert.equal((await t.api("get", "/procurement/cost-ledger?from=2026-12-01&to=2026-01-01", mgr.token)).status, 400);
    assert.equal((await t.api("get", "/procurement/cost-ledger?from=2020-01-01&to=2026-01-01", mgr.token)).status, 400);
    assert.equal((await t.api("get", "/procurement/cost-ledger?bogus=1", mgr.token)).status, 400);
    const theirs = await balances(bMgr.token);
    assert.equal(Number(theirs.totalDebit), 0, "another hospital sees only its own ledger");
    assert.equal((await get("/procurement/cost-ledger/entries", bMgr.token)).total, 0);
  });
});
