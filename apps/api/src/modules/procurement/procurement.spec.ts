import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
const key = () => `k-${randomUUID().slice(0, 18)}`;
const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

describe("procurement to consumption", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let pharm: User; let proc: User; let mgr: User; let nurse: User; let cashier: User; let bProc: User; let bMgr: User;

  const medicine = async (o: Record<string, unknown> = {}) => {
    const r = await t.api("post", "/medicines", pharm.token).send({ brandName: `Brand${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "500 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 0, ...o });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string };
  };
  const supplier = async (tok = pharm.token) => (await t.api("post", "/pharmacy/suppliers", tok).send({ name: `Supplier ${uniqueWord(6)}` })).body.data as { id: string };
  const opening = (medicineId: string, batchNo: string, qty: number, o: Record<string, unknown> = {}) =>
    t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({ medicineId, batchNo, expiryDate: ymd(365), mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.50", quantity: qty, ...o });
  const indent = (items: Record<string, unknown>[], tok = pharm.token, extra: Record<string, unknown> = {}) => t.api("post", "/procurement/indents", tok).send({ items, ...extra });
  const act = (path: string, body: Record<string, unknown> = {}, tok = mgr.token) => t.api("post", `/procurement/${path}`, tok).send(body);
  const view = async (path: string, tok = mgr.token) => (await t.api("get", `/procurement/${path}`, tok)).body.data;
  /** An indent raised, submitted and approved by someone else. */
  const approved = async (items: Record<string, unknown>[]) => {
    const i = await indent(items);
    assert.equal(i.status, 201, JSON.stringify(i.body));
    assert.equal((await act(`indents/${i.body.data.id}/submit`, {}, pharm.token)).status, 200);
    assert.equal((await act(`indents/${i.body.data.id}/approve`)).status, 200);
    return view(`indents/${i.body.data.id}`) as Promise<{ id: string; status: string; items: { id: string; medicineId: string; quantity: number; orderedQuantity: number }[] }>;
  };
  const order = (body: Record<string, unknown>, tok = proc.token) => t.api("post", "/procurement/orders", tok).send(body);
  const receive = (body: Record<string, unknown>, tok = pharm.token) => t.api("post", "/pharmacy/purchases", tok).set("Idempotency-Key", key()).send(body);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("proc-a"); b = await t.makeTenant("proc-b");
    pharm = await t.makeUser(a, ["PHARMACIST"]); proc = await t.makeUser(a, ["PROCUREMENT"]); mgr = await t.makeUser(a, ["MANAGER"]);
    nurse = await t.makeUser(a, ["NURSE"]); cashier = await t.makeUser(a, ["CASHIER"]);
    bProc = await t.makeUser(b, ["PROCUREMENT"]); bMgr = await t.makeUser(b, ["MANAGER"]);
  });
  after(async () => { await t.close(); });

  it("stock requirement: medicines at their reorder level are suggested; what is already on an indent or an order is counted; only people in the chain may see it", async () => {
    const m = await medicine({ reorderLevel: 20 });
    assert.equal((await opening(m.id, `B${uniqueWord(4)}`, 5)).status, 201);
    const find = async () => ((await view("requirement", proc.token)).items as { medicineId: string; suggestedQuantity: number; onHand: number; onIndent: number; onOrder: number }[]).find((x) => x.medicineId === m.id);
    const first = await find();
    assert.deepEqual([first?.onHand, first?.suggestedQuantity], [5, 35], "5 on hand, reorder level 20: top up to 40");
    const fine = await medicine({ reorderLevel: 3 });
    assert.equal((await opening(fine.id, `B${uniqueWord(4)}`, 50)).status, 201);
    assert.ok(!((await view("requirement", proc.token)).items as { medicineId: string }[]).some((x) => x.medicineId === fine.id), "well stocked: not suggested");
    const i = await indent([{ medicineId: m.id, quantity: 35 }]);
    assert.equal((await act(`indents/${i.body.data.id}/submit`, {}, pharm.token)).status, 200);
    assert.equal(await find(), undefined, "once the quantity is on a submitted indent it is no longer short");
    assert.equal((await t.api("get", "/procurement/requirement", cashier.token)).status, 403, "billing is not part of the chain");
    assert.ok(!((await view("requirement", bProc.token)).items as { medicineId: string }[]).some((x) => x.medicineId === m.id), "another hospital sees only its own stock");
  });

  it("indents: raised for what is needed, submitted, approved by someone other than the requester; a draft is edited, anything else is fixed; each step is audited", async () => {
    const m1 = await medicine(); const m2 = await medicine();
    for (const bad of [{ items: [] }, { items: [{ medicineId: m1.id, quantity: 0 }] }, { items: [{ medicineId: m1.id, quantity: 5 }, { medicineId: m1.id, quantity: 6 }] }, { items: [{ medicineId: randomUUID(), quantity: 5 }] }, { items: [{ medicineId: m1.id, quantity: 5 }], extra: 1 }]) assert.equal((await t.api("post", "/procurement/indents", pharm.token).send(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await indent([{ medicineId: m1.id, quantity: 5 }], cashier.token)).status, 403, "only people who may ask can raise an indent");
    assert.equal((await indent([{ medicineId: m1.id, quantity: 5 }], pharm.token, { forLocationId: randomUUID() })).status, 404, "an unknown place");
    const made = await indent([{ medicineId: m1.id, quantity: 5 }, { medicineId: m2.id, quantity: 12, note: "For the OT" }], pharm.token, { note: "Monthly order" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.data.id as string;
    assert.match(made.body.data.indentNumber, /^IND-/);
    assert.equal(made.body.data.status, "DRAFT");
    assert.equal((await act(`indents/${id}/approve`)).status, 409, "a draft is not yet submitted");
    assert.equal((await t.api("put", `/procurement/indents/${id}`, pharm.token).send({ items: [{ medicineId: m1.id, quantity: 8 }] })).status, 200, "a draft can be edited by its requester");
    assert.equal((await t.api("put", `/procurement/indents/${id}`, nurse.token).send({ items: [{ medicineId: m1.id, quantity: 9 }] })).status, 404, "another person's draft is not theirs");
    assert.equal((await act(`indents/${id}/submit`, {}, nurse.token)).status, 404);
    assert.equal((await act(`indents/${id}/submit`, {}, pharm.token)).status, 200);
    assert.equal((await t.api("put", `/procurement/indents/${id}`, pharm.token).send({ items: [{ medicineId: m1.id, quantity: 9 }] })).status, 409, "once submitted it is fixed");
    assert.equal((await act(`indents/${id}/approve`, {}, pharm.token)).status, 403, "the pharmacist has no approval rights");
    assert.equal((await act(`indents/${id}/approve`, {}, proc.token)).status, 403, "nor does procurement: the one who buys does not approve");
    assert.equal((await act(`indents/${id}/approve`, {}, bMgr.token)).status, 404, "another hospital cannot approve it");
    assert.equal((await act(`indents/${id}/reject`, { reason: "no" })).status, 400, "a rejection needs its reason");
    // Whoever raises an indent cannot approve it, even with approval rights.
    const adminIndent = await indent([{ medicineId: m1.id, quantity: 3 }], a.admin.token);
    assert.equal(adminIndent.status, 201);
    assert.equal((await act(`indents/${adminIndent.body.data.id}/submit`, {}, a.admin.token)).status, 200);
    const self = await act(`indents/${adminIndent.body.data.id}/approve`, {}, a.admin.token);
    assert.equal(self.status, 409, JSON.stringify(self.body));
    assert.equal(self.body.error.code, "SELF_APPROVAL");
    assert.equal((await act(`indents/${adminIndent.body.data.id}/approve`, {}, mgr.token)).status, 200, "another person approves it");
    const ok = await act(`indents/${id}/approve`, { note: "Approved" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.data.status, ok.body.data.decisionNote, typeof ok.body.data.decidedBy], ["APPROVED", "Approved", "string"]);
    assert.equal((await act(`indents/${id}/approve`)).status, 409, "decided once");
    const rej = await indent([{ medicineId: m2.id, quantity: 2 }]);
    await act(`indents/${rej.body.data.id}/submit`, {}, pharm.token);
    assert.equal((await act(`indents/${rej.body.data.id}/reject`, { reason: "Not needed this month" })).status, 200);
    assert.equal((await view(`indents/${rej.body.data.id}`)).status, "REJECTED");
    const gone = await indent([{ medicineId: m2.id, quantity: 2 }]);
    assert.equal((await act(`indents/${gone.body.data.id}/cancel`, { reason: "x" }, pharm.token)).status, 400, "a cancellation needs its reason");
    assert.equal((await act(`indents/${gone.body.data.id}/cancel`, { reason: "Raised by mistake" }, nurse.token)).status, 404, "not theirs to cancel");
    assert.equal((await act(`indents/${gone.body.data.id}/cancel`, { reason: "Raised by mistake" }, pharm.token)).status, 200);
    const mine = (await t.api("get", "/procurement/indents", nurse.token)).body.data;
    assert.equal(mine.total, 0, "a person who may only ask sees their own indents");
    assert.ok((await t.api("get", "/procurement/indents", mgr.token)).body.data.total >= 4, "approvers see every indent of the hospital");
    assert.equal((await t.api("get", "/procurement/indents", bMgr.token)).body.data.total, 0, "another hospital sees none of them");
    assert.equal((await t.api("get", `/procurement/indents/${id}`, nurse.token)).status, 404, "nor can a person read an indent that is not theirs");
    for (const action of ["INDENT_CREATED", "INDENT_UPDATED", "INDENT_SUBMITTED", "INDENT_APPROVED", "INDENT_REJECTED", "INDENT_CANCELLED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action } }), `${action} is audited`);
    await assert.rejects(() => t.prisma.purchaseIndent.update({ where: { tenantId_id: { tenantId: a.tenantId, id: adminIndent.body.data.id } }, data: { decidedById: a.admin.id } }), "the database refuses an approval by the requester");
    await assert.rejects(() => t.prisma.purchaseIndent.delete({ where: { tenantId_id: { tenantId: a.tenantId, id } } }), "an indent is never deleted");
    await assert.rejects(() => t.prisma.purchaseIndentItem.updateMany({ where: { indentId: id }, data: { quantity: 1 } }), "the lines of a submitted indent cannot be changed");
  });

  it("purchase orders: made from an approved indent within what it still needs; part orders and cancellations keep the indent right; issued orders are fixed; large orders need another person's approval", async () => {
    const m = await medicine({ gstPercent: 12 }); const s = await supplier();
    const draft = await indent([{ medicineId: m.id, quantity: 100 }]);
    await act(`indents/${draft.body.data.id}/submit`, {}, pharm.token);
    assert.equal((await order({ supplierId: s.id, indentId: draft.body.data.id, items: [{ medicineId: m.id, quantity: 10, rate: "6.00" }] })).status, 409, "only an approved indent can be ordered");
    const ind = await approved([{ medicineId: m.id, quantity: 100 }]);
    const line = ind.items[0]!;
    assert.equal((await order({ supplierId: s.id, indentId: ind.id, items: [{ medicineId: m.id, quantity: 10, rate: "6.00" }] }, pharm.token)).status, 403, "only procurement places orders");
    assert.equal((await order({ supplierId: randomUUID(), indentId: ind.id, items: [{ medicineId: m.id, quantity: 10, rate: "6.00" }] })).status, 400, "an unknown supplier");
    assert.equal((await order({ supplierId: s.id, indentId: ind.id, items: [{ medicineId: m.id, quantity: 101, rate: "6.00" }] })).status, 400, "more than the indent still needs");
    assert.equal((await order({ supplierId: s.id, indentId: ind.id, items: [{ medicineId: (await medicine()).id, quantity: 5, rate: "6.00" }] })).status, 400, "a medicine that is not on the indent");
    assert.equal((await order({ supplierId: s.id, items: [{ medicineId: m.id, quantity: 5, rate: "-1" }] })).status, 400);
    assert.equal((await order({ supplierId: s.id, items: [{ medicineId: m.id, quantity: 5, rate: "6.00", indentItemId: line.id }] })).status, 400, "name the indent the lines come from");
    const first = await order({ supplierId: s.id, indentId: ind.id, expectedOn: ymd(7), notes: "Deliver to the main store", items: [{ medicineId: m.id, quantity: 60, rate: "6.00" }] });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.match(first.body.data.poNumber, /^PO-/);
    assert.deepEqual([first.body.data.status, first.body.data.subtotal, first.body.data.taxTotal, first.body.data.total], ["DRAFT", "360.00", "43.20", "403.20"]);
    let ix = await view(`indents/${ind.id}`);
    assert.deepEqual([ix.status, ix.items[0].orderedQuantity], ["APPROVED", 60], "part of the indent is ordered; it stays open for the rest");
    assert.equal((await order({ supplierId: s.id, indentId: ind.id, items: [{ medicineId: m.id, quantity: 41, rate: "6.00" }] })).status, 400, "only 40 are still to be ordered");
    const second = await order({ supplierId: s.id, indentId: ind.id, items: [{ medicineId: m.id, quantity: 40, rate: "6.00" }] });
    assert.equal(second.status, 201);
    ix = await view(`indents/${ind.id}`);
    assert.equal(ix.status, "ORDERED", "every line is now on an order");
    assert.equal((await act(`indents/${ind.id}/cancel`, { reason: "No longer needed" }, pharm.token)).status, 409, "an indent with orders cannot be cancelled");
    assert.equal((await act(`orders/${second.body.data.id}/cancel`, { reason: "x" }, proc.token)).status, 400, "a reason is needed");
    assert.equal((await act(`orders/${second.body.data.id}/cancel`, { reason: "Supplier cannot deliver" }, proc.token)).status, 200);
    ix = await view(`indents/${ind.id}`);
    assert.deepEqual([ix.status, ix.items[0].orderedQuantity], ["APPROVED", 60], "the cancelled quantity goes back to the indent");
    // Issue: the lines are fixed from then on.
    const id = first.body.data.id as string;
    assert.equal((await act(`orders/${id}/issue`, {}, nurse.token)).status, 403);
    assert.equal((await act(`orders/${id}/issue`, {}, bProc.token)).status, 404, "another hospital cannot issue it");
    const issued = await act(`orders/${id}/issue`, {}, proc.token);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body.data.status, "ISSUED");
    assert.equal((await act(`orders/${id}/issue`, {}, proc.token)).status, 409, "issued once");
    await assert.rejects(() => t.prisma.purchaseOrderItem.updateMany({ where: { orderId: id }, data: { quantity: 1 } }), "the lines of an issued order are fixed");
    await assert.rejects(() => t.prisma.purchaseOrder.update({ where: { tenantId_id: { tenantId: a.tenantId, id } }, data: { total: "1.00" } }), "and so are its totals");
    await assert.rejects(() => t.prisma.purchaseOrder.delete({ where: { tenantId_id: { tenantId: a.tenantId, id } } }), "an order is never deleted");
    // Approval limit.
    assert.equal((await t.api("put", "/settings/PO_APPROVAL_LIMIT", a.admin.token).send({ value: "100.00" })).status, 200);
    const big = await order({ supplierId: s.id, items: [{ medicineId: m.id, quantity: 100, rate: "6.00" }] });
    const blocked = await act(`orders/${big.body.data.id}/issue`, {}, proc.token);
    assert.equal(blocked.status, 403, "above the limit the maker cannot issue it");
    assert.equal(blocked.body.error.code, "NEEDS_APPROVAL");
    const adminBig = await order({ supplierId: s.id, items: [{ medicineId: m.id, quantity: 100, rate: "6.00" }] }, a.admin.token);
    const own = await act(`orders/${adminBig.body.data.id}/issue`, {}, a.admin.token);
    assert.equal(own.status, 409, "nor can an approver approve their own order");
    assert.equal(own.body.error.code, "SELF_APPROVAL");
    const ok = await act(`orders/${big.body.data.id}/issue`, {}, a.admin.token);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.data.approvedBy, "the approval is recorded");
    assert.equal((await t.api("put", "/settings/PO_APPROVAL_LIMIT", a.admin.token).send({ value: "0.00" })).status, 200);
    for (const action of ["PURCHASE_ORDER_CREATED", "PURCHASE_ORDER_ISSUED", "PURCHASE_ORDER_CANCELLED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action } }), `${action} is audited`);
    assert.equal((await t.api("get", "/procurement/orders", cashier.token)).status, 403);
    assert.equal((await t.api("get", "/procurement/orders", bProc.token)).body.data.total, 0, "another hospital sees none of these orders");
  });

  it("goods receipt against an order: matched to the order's lines; the quantity and quality check accepts some and rejects the rest with a reason; only accepted goods enter stock; the order follows", async () => {
    const m = await medicine({ gstPercent: 0 }); const s = await supplier(); const other = await supplier();
    const po = await order({ supplierId: s.id, items: [{ medicineId: m.id, quantity: 100, rate: "6.00", gstPercent: "0" }] });
    const poId = po.body.data.id as string;
    const line = po.body.data.items[0].id as string;
    const goods = (o: Record<string, unknown> = {}) => ({ medicineId: m.id, batchNo: `B${uniqueWord(5)}`, expiryDate: ymd(400), mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.50", quantity: 60, gstPercent: "0", ...o });
    const grn = (items: Record<string, unknown>[], o: Record<string, unknown> = {}) => receive({ supplierId: s.id, supplierInvoiceNo: `INV-${uniqueWord(6)}`, supplierInvoiceDate: ymd(0), purchaseOrderId: poId, items, ...o });
    assert.equal((await grn([goods()])).status, 409, "a draft order is not yet issued to the supplier");
    assert.equal((await act(`orders/${poId}/issue`, {}, proc.token)).status, 200);
    assert.equal((await grn([goods()], { supplierId: other.id })).status, 400, "the order was placed with another supplier");
    assert.equal((await grn([goods({ medicineId: (await medicine()).id })])).status, 400, "a medicine that is not on the order");
    const over = await grn([goods({ quantity: 101 })]);
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.error.code, "OVER_RECEIPT");
    const dear = await grn([goods({ purchasePrice: "6.01" })]);
    assert.equal(dear.status, 409);
    assert.equal(dear.body.error.code, "PRICE_ABOVE_ORDER");
    assert.equal((await grn([goods({ rejectedQuantity: 10 })])).status, 400, "a rejection needs its reason");
    assert.equal((await grn([goods({ rejectedQuantity: 10, rejectReason: "ok" })])).status, 400);
    assert.equal((await receive({ supplierId: s.id, supplierInvoiceNo: "X-1", supplierInvoiceDate: ymd(0), purchaseOrderId: randomUUID(), items: [goods()] })).status, 404, "an unknown order");
    assert.equal((await receive({ supplierId: s.id, supplierInvoiceNo: "X-2", supplierInvoiceDate: ymd(0), purchaseOrderId: poId, items: [goods()] }, nurse.token)).status, 403);
    const batchNo = `B${uniqueWord(5)}`;
    const first = await grn([goods({ batchNo, quantity: 60, rejectedQuantity: 10, rejectReason: "10 strips damaged in transit" })]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.purchaseOrder, po.body.data.poNumber);
    assert.deepEqual([first.body.data.items[0].quantity, first.body.data.items[0].rejectedQuantity, first.body.data.items[0].rejectReason, first.body.data.total], [60, 10, "10 strips damaged in transit", "360.00"], "the bill is for what was accepted");
    const batch = await t.prisma.medicineBatch.findFirstOrThrow({ where: { tenantId: a.tenantId, medicineId: m.id, batchNo: batchNo.toUpperCase() } });
    assert.equal((await t.prisma.stockBalance.findFirstOrThrow({ where: { batchId: batch.id } })).quantity, 60, "only the accepted units entered stock");
    let o = await view(`orders/${poId}`, proc.token);
    assert.deepEqual([o.status, o.items[0].receivedQuantity, o.items[0].pendingQuantity, o.receipts.length], ["PARTIALLY_RECEIVED", 60, 40, 1]);
    assert.equal((await act(`orders/${poId}/cancel`, { reason: "Changed our mind" }, proc.token)).status, 409, "goods have arrived: close the order instead");
    const replacement = await grn([goods({ quantity: 41 })]);
    assert.equal(replacement.status, 409, "only 40 are still expected: the rejected 10 do not count as received");
    assert.equal((await grn([goods({ quantity: 40 })])).status, 201);
    o = await view(`orders/${poId}`, proc.token);
    assert.deepEqual([o.status, o.items[0].pendingQuantity], ["RECEIVED", 0]);
    assert.equal((await grn([goods({ quantity: 1 })])).status, 409, "a completed order takes no more goods");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "PURCHASE_GOODS_REJECTED" } }), "the rejection is audited");
    // Short close: the supplier cannot finish the order.
    const po2 = await order({ supplierId: s.id, items: [{ medicineId: m.id, quantity: 50, rate: "6.00", gstPercent: "0" }] });
    await act(`orders/${po2.body.data.id}/issue`, {}, proc.token);
    assert.equal((await receive({ supplierId: s.id, supplierInvoiceNo: `INV-${uniqueWord(6)}`, supplierInvoiceDate: ymd(0), purchaseOrderId: po2.body.data.id, items: [goods({ quantity: 20 })] })).status, 201);
    assert.equal((await act(`orders/${po2.body.data.id}/close`, { reason: "ok" }, proc.token)).status, 400);
    assert.equal((await act(`orders/${po2.body.data.id}/close`, { reason: "Supplier out of stock" }, proc.token)).status, 200);
    assert.equal((await view(`orders/${po2.body.data.id}`, proc.token)).status, "CLOSED");
    assert.equal((await receive({ supplierId: s.id, supplierInvoiceNo: `INV-${uniqueWord(6)}`, supplierInvoiceDate: ymd(0), purchaseOrderId: po2.body.data.id, items: [goods({ quantity: 5 })] })).status, 409, "a closed order takes no more goods");
    // Where the hospital requires an order, a delivery is received only against one.
    assert.equal((await t.api("put", "/settings/PURCHASE_REQUIRE_PO", a.admin.token).send({ value: true })).status, 200);
    const direct = await receive({ supplierId: s.id, supplierInvoiceNo: `INV-${uniqueWord(6)}`, supplierInvoiceDate: ymd(0), items: [goods({ quantity: 5 })] });
    assert.equal(direct.status, 409);
    assert.equal(direct.body.error.code, "PURCHASE_ORDER_REQUIRED");
    assert.equal((await t.api("put", "/settings/PURCHASE_REQUIRE_PO", a.admin.token).send({ value: false })).status, 200);
    assert.equal((await receive({ supplierId: s.id, supplierInvoiceNo: `INV-${uniqueWord(6)}`, supplierInvoiceDate: ymd(0), items: [goods({ quantity: 5 })] })).status, 201, "without the setting a direct delivery is still received");
    assert.ok(line);
  });

  describe("consumption and cost", () => {
    it("MANDATORY PROCUREMENT FLOW: requirement → indent → approval → order → goods receipt with quality check → allocation to the OT store → OT use for a procedure → cost posted; the cost report adds up", async () => {
      const c = await t.makeTenant("proc-flow");
      const cPharm = await t.makeUser(c, ["PHARMACIST"]); const cProc = await t.makeUser(c, ["PROCUREMENT"]); const cMgr = await t.makeUser(c, ["MANAGER"]);
      const cOt = await t.makeUser(c, ["OT_COORDINATOR"]); const cNurse = await t.makeUser(c, ["NURSE"]); const cRec = await t.makeUser(c, ["RECEPTIONIST"]); const cCashier = await t.makeUser(c, ["CASHIER"]);
      const doc = await makeDoctor(t, c);
      const med = (await t.api("post", "/medicines", cPharm.token).send({ brandName: `Suture${uniqueWord(5)}`, genericName: `Silk${uniqueWord(5)}`, strength: "2-0", dosageForm: "OTHER", gstPercent: 0, reorderLevel: 30 })).body.data as { id: string };
      // 1. requirement
      const need = ((await t.api("get", "/procurement/requirement", cProc.token)).body.data.items as { medicineId: string; suggestedQuantity: number }[]).find((x) => x.medicineId === med.id);
      assert.equal(need?.suggestedQuantity, 60, "nothing on hand, reorder level 30: order 60");
      // 2-3. indent and approval
      const ind = await t.api("post", "/procurement/indents", cPharm.token).send({ note: "OT sutures", items: [{ medicineId: med.id, quantity: need!.suggestedQuantity }] });
      assert.equal(ind.status, 201, JSON.stringify(ind.body));
      assert.equal((await t.api("post", `/procurement/indents/${ind.body.data.id}/submit`, cPharm.token)).status, 200);
      assert.equal((await t.api("post", `/procurement/indents/${ind.body.data.id}/approve`, cMgr.token).send({})).status, 200);
      // 4. purchase order
      const sup = (await t.api("post", "/pharmacy/suppliers", cPharm.token).send({ name: `Surgical Supplies ${uniqueWord(5)}` })).body.data as { id: string };
      const po = await t.api("post", "/procurement/orders", cProc.token).send({ supplierId: sup.id, indentId: ind.body.data.id, items: [{ medicineId: med.id, quantity: 60, rate: "6.00", gstPercent: "0" }] });
      assert.equal(po.status, 201, JSON.stringify(po.body));
      assert.equal((await t.api("post", `/procurement/orders/${po.body.data.id}/issue`, cProc.token).send({})).status, 200);
      // 5-6. goods receipt with the quality and quantity check: 100 delivered would be too many; 60 ordered, 4 turned away
      const grn = await t.api("post", "/pharmacy/purchases", cPharm.token).set("Idempotency-Key", key()).send({
        supplierId: sup.id, supplierInvoiceNo: `INV-${uniqueWord(6)}`, supplierInvoiceDate: ymd(0), purchaseOrderId: po.body.data.id,
        items: [{ medicineId: med.id, batchNo: `S${uniqueWord(5)}`, expiryDate: ymd(500), mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.50", quantity: 56, rejectedQuantity: 4, rejectReason: "4 packs torn at the seal", gstPercent: "0" }],
      });
      assert.equal(grn.status, 201, JSON.stringify(grn.body));
      const batch = await t.prisma.medicineBatch.findFirstOrThrow({ where: { tenantId: c.tenantId, medicineId: med.id } });
      assert.equal((await t.api("get", `/procurement/orders/${po.body.data.id}`, cProc.token)).body.data.status, "PARTIALLY_RECEIVED", "56 of 60 accepted: 4 are still expected");
      // 7. allocation: the pharmacy moves stock to the OT store
      const store = (await t.api("post", "/pharmacy/locations", cPharm.token).send({ name: `OT store ${uniqueWord(4)}` })).body.data as { id: string };
      const moved = await t.api("post", "/pharmacy/transfers", cPharm.token).set("Idempotency-Key", key()).send({ fromLocationId: null, toLocationId: store.id, reason: "OT stock for the week", items: [{ batchId: batch.id, quantity: 40 }] });
      assert.equal(moved.status, 201, JSON.stringify(moved.body));
      // a procedure to use it on
      const ward = (await t.api("post", "/wards", c.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: `W${uniqueWord(3)}` })).body.data;
      const room = (await t.api("post", "/rooms", c.admin.token).send({ wardId: ward.id, name: "Room", code: `R${uniqueWord(3)}` })).body.data;
      const bed = (await t.api("post", "/beds", c.admin.token).send({ roomId: room.id, code: `B${uniqueWord(3)}`, dailyRate: "1000" })).body.data;
      const patient = await registerPatient(t, cRec.token);
      const adm = (await t.api("post", "/admissions", cRec.token).send({ patientId: patient.id, consultantId: doc.practitionerId, bedId: bed.id, reason: "Appendicitis needing surgery" })).body.data;
      const svc = (await t.api("post", "/services", c.admin.token).send({ code: `AP${uniqueWord(4)}`, name: "Appendectomy", category: "PROCEDURE", price: "20000", taxPercent: 0 })).body.data;
      const proc1 = await t.api("post", `/admissions/${adm.id}/procedures`, doc.token).send({ serviceId: svc.id });
      assert.equal(proc1.status, 201, JSON.stringify(proc1.body));
      // 8. OT issue and consumption
      const use = (body: Record<string, unknown>, tok = cOt.token, k = key()) => t.api("post", "/procurement/consumption", tok).set("Idempotency-Key", k).send({ locationId: store.id, batchId: batch.id, ...body });
      for (const bad of [{ quantity: 0, kind: "PROCEDURE", procedureId: proc1.body.data.id }, { quantity: 2, kind: "PROCEDURE" }, { quantity: 2, kind: "DEPARTMENT_USE" }, { quantity: 2, kind: "DEPARTMENT_USE", reason: "ok" }, { quantity: 2, kind: "DEPARTMENT_USE", reason: "Ward dressings", procedureId: proc1.body.data.id }, { quantity: 2, kind: "SOLD" }]) assert.equal((await use(bad)).status, 400, JSON.stringify(bad));
      assert.equal((await use({ quantity: 2, kind: "PROCEDURE", procedureId: proc1.body.data.id }, cCashier.token)).status, 403, "billing does not consume stock");
      assert.equal((await use({ quantity: 2, kind: "PROCEDURE", procedureId: proc1.body.data.id }, cNurse.token)).status, 403);
      assert.equal((await use({ quantity: 2, kind: "PROCEDURE", procedureId: randomUUID() })).status, 404, "an unknown procedure");
      const noKey = await t.api("post", "/procurement/consumption", cOt.token).send({ locationId: store.id, batchId: batch.id, quantity: 2, kind: "PROCEDURE", procedureId: proc1.body.data.id });
      assert.equal(noKey.status, 400, "an idempotency key is required");
      assert.equal((await use({ quantity: 41, kind: "PROCEDURE", procedureId: proc1.body.data.id })).status, 409, "only 40 are in the OT store");
      const k1 = key();
      const used = await use({ quantity: 10, kind: "PROCEDURE", procedureId: proc1.body.data.id }, cOt.token, k1);
      assert.equal(used.status, 201, JSON.stringify(used.body));
      assert.deepEqual([used.body.data.unitCost, used.body.data.totalCost, used.body.data.kind], ["6.00", "60.00", "PROCEDURE"], "the batch's purchase price is posted as the cost");
      assert.equal((await use({ quantity: 10, kind: "PROCEDURE", procedureId: proc1.body.data.id }, cOt.token, k1)).status, 200, "a retry with the same key uses the stock once");
      assert.equal((await use({ quantity: 5, kind: "DEPARTMENT_USE", reason: "Dressing changes in the OT recovery bay" })).status, 201);
      const held = await t.prisma.stockLocationBalance.findFirstOrThrow({ where: { locationId: store.id, batchId: batch.id } });
      assert.equal(held.quantity, 25, "40 moved in, 15 used");
      const ledger = await t.prisma.stockLocationLedger.findMany({ where: { locationId: store.id, batchId: batch.id }, orderBy: { seq: "asc" } });
      assert.deepEqual(ledger.map((l) => [l.direction, l.quantity, l.balanceAfter]), [["IN", 40, 40], ["OUT", 10, 30], ["OUT", 5, 25]], "every movement is in the ledger, which reconciles");
      assert.equal(ledger.filter((l) => l.consumptionId !== null).length, 2);
      const forProc = (await t.api("get", `/procurement/consumption?procedureId=${proc1.body.data.id}`, cOt.token)).body.data as { totalCost: string }[];
      assert.deepEqual(forProc.map((x) => x.totalCost), ["60.00"], "the cost of a procedure is read from its consumption");
      await assert.rejects(() => t.prisma.stockConsumption.updateMany({ where: { tenantId: c.tenantId }, data: { quantity: 1 } }), "a consumption record is never changed");
      await assert.rejects(() => t.prisma.stockConsumption.deleteMany({ where: { tenantId: c.tenantId } }), "nor removed");
      // another hospital cannot reach it
      assert.equal((await t.api("post", "/procurement/consumption", bProc.token).set("Idempotency-Key", key()).send({ locationId: store.id, batchId: batch.id, quantity: 1, kind: "DEPARTMENT_USE", reason: "Trying from another hospital" })).status, 403);
      const bOt = await t.makeUser(b, ["OT_COORDINATOR"]);
      assert.equal((await t.api("post", "/procurement/consumption", bOt.token).set("Idempotency-Key", key()).send({ locationId: store.id, batchId: batch.id, quantity: 1, kind: "DEPARTMENT_USE", reason: "Trying from another hospital" })).status, 404, "another hospital's location does not exist for them");
      // 9. cost posting: write off 4 damaged units, then the report adds up
      assert.equal((await t.api("post", "/pharmacy/stock/adjustments", cPharm.token).set("Idempotency-Key", key()).send({ batchId: batch.id, direction: "OUT", quantity: 4, kind: "DAMAGE", reason: "Water damage in the store" })).status, 201);
      const rep = (await t.api("get", "/reports/pharmacy/consumption-cost", cMgr.token)).body.data;
      assert.deepEqual([rep.received.units, rep.received.cost, rep.received.rejectedUnits], [56, "336.00", 4], "56 accepted at 6.00; the 4 rejected never entered stock");
      assert.deepEqual([rep.procedures.cost, rep.departmentUse.cost, rep.totalConsumptionCost], ["60.00", "30.00", "90.00"]);
      assert.deepEqual([rep.writtenOffDamaged.units, rep.writtenOffDamaged.cost], [4, "24.00"]);
      assert.deepEqual([rep.stockValue.mainStore, rep.stockValue.locations, rep.stockValue.total], ["72.00", "150.00", "222.00"], "12 left in the main store, 25 in the OT store, at 6.00");
      assert.equal(Number(rep.received.cost) - Number(rep.totalConsumptionCost) - Number(rep.writtenOffDamaged.cost), Number(rep.stockValue.total), "received - used - written off = the stock still held");
      assert.deepEqual(rep.byProcedure.map((p: { procedure: string; cost: string }) => [p.procedure, p.cost]), [["Appendectomy", "60.00"]]);
      assert.equal((await t.api("get", "/reports/pharmacy/consumption-cost", cNurse.token)).status, 403, "reports are for finance and stores");
      assert.equal((await t.api("get", "/reports/pharmacy/consumption-cost", bMgr.token)).body.data.received.units, 0, "another hospital's figures are its own");
      for (const action of ["INDENT_APPROVED", "PURCHASE_ORDER_ISSUED", "PURCHASE_RECEIVED", "PURCHASE_GOODS_REJECTED", "STOCK_CONSUMED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: c.tenantId, action } }), `${action} is audited`);
    });
  });
});
