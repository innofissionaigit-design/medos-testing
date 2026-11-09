import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
const key = () => `k-${randomUUID().slice(0, 18)}`;

describe("pharmacy: masters, stock ledger, procurement, dispensing", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let pharm: { id: string; token: string };
  let nurse: { id: string; token: string };

  const mkMedicine = async (o: Record<string, unknown> = {}, tok = pharm.token) => {
    const r = await t.api("post", "/medicines", tok).send({ brandName: `Brand${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "500 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 5, ...o });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string; brandName: string; genericName: string };
  };
  const opening = (medicineId: string, batchNo: string, qty: number, o: Record<string, unknown> = {}, tok = pharm.token) =>
    t.api("post", "/pharmacy/batches", tok).set("Idempotency-Key", key()).send({ medicineId, batchNo, expiryDate: ymd(365), mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.50", quantity: qty, ...o });
  const stockOf = async (batchId: string) => (await t.prisma.stockBalance.findFirstOrThrow({ where: { batchId } })).quantity;
  const dispense = (body: Record<string, unknown>, tok = pharm.token, k = key()) => t.api("post", "/pharmacy/dispenses", tok).set("Idempotency-Key", k).send(body);
  /** The pharmacy only bills; the cashier collects. */
  const collect = (invoiceId: string, amount: string, method = "UPI", reference: string | undefined = "UPI-PH-0001") =>
    t.api("post", `/invoices/${invoiceId}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method, amount, ...(method === "CASH" ? {} : { reference }) }] });
  const assertReconciled = async (batchId: string) => {
    const r = await t.api("get", `/pharmacy/batches/${batchId}/ledger`, pharm.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.reconciliation.reconciles, true, JSON.stringify(r.body.data.reconciliation));
    assert.ok(r.body.data.reconciliation.balance >= 0);
  };

  let cashier: { id: string; token: string };
  before(async () => {
    t = await startApp();
    a = await t.makeTenant("ph-a");
    b = await t.makeTenant("ph-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]);
    nurse = await t.makeUser(a, ["NURSE"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    assert.equal((await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "0" })).status, 201);
  });
  after(async () => { await t.close(); });

  // ───────────────────────── masters ─────────────────────────
  describe("medicine and supplier masters", () => {
    it("pharmacists maintain the medicine master; duplicates are impossible; prescribers can search", async () => {
      const brand = `Dolo${uniqueWord(5)}`;
      const m = await t.api("post", "/medicines", pharm.token).send({ brandName: brand, genericName: "Paracetamol", strength: "650 mg", dosageForm: "TABLET", gstPercent: "12", hsnCode: "30049099", manufacturer: "Micro Labs" });
      assert.equal(m.status, 201);
      assert.equal(m.body.data.gstPercent, "12.00");
      assert.equal((await t.api("post", "/medicines", pharm.token).send({ brandName: brand.toUpperCase(), genericName: "PARACETAMOL", strength: "650  mg", dosageForm: "TABLET" })).status, 409);
      assert.equal((await t.api("post", "/medicines", pharm.token).send({ brandName: brand, genericName: "Paracetamol", strength: "500 mg", dosageForm: "TABLET" })).status, 201, "different strength is a different product");
      const doc = await makeDoctor(t, a);
      const found = await t.api("get", "/medicines", doc.token).query({ q: brand.slice(0, 6) });
      assert.equal(found.status, 200);
      assert.ok(found.body.data.some((x: { id: string }) => x.id === m.body.data.id));
      assert.equal(found.body.data[0].purchasePrice, undefined, "no stock or cost data leaks to prescribers");
      // Each word may match brand, generic name or strength, in any order.
      const ids = async (q: string) => ((await t.api("get", "/medicines", doc.token).query({ q })).body.data as { id: string; strength: string }[]).filter((x) => x.id === m.body.data.id || x.strength === "500 mg");
      const withStrength = await ids(`${brand} 650 mg`);
      assert.deepEqual(withStrength.map((x) => x.id), [m.body.data.id], "name plus strength finds exactly that product");
      assert.deepEqual((await ids(`650 mg ${brand.toLowerCase()}`)).map((x) => x.id), [m.body.data.id], "word order and case do not matter");
      assert.equal((await t.api("get", "/medicines", doc.token).query({ q: `${brand} 999 mg` })).body.data.length, 0, "a strength that does not exist finds nothing");
    });

    it("validates medicine input and enforces permissions and tenant isolation", async () => {
      const base = { brandName: "Valid Brand", genericName: "Valid Generic", dosageForm: "SYRUP" };
      for (const bad of [{ dosageForm: "GAS" }, { gstPercent: 101 }, { gstPercent: -1 }, { hsnCode: "12" }, { reorderLevel: -1 }, { brandName: "x" }, { tenantId: b.tenantId }, { status: "INACTIVE" }]) {
        assert.equal((await t.api("post", "/medicines", pharm.token).send({ ...base, brandName: `Vb${uniqueWord(4)}`, ...bad })).status, 400, JSON.stringify(bad));
      }
      for (const u of [rec, nurse]) assert.equal((await t.api("post", "/medicines", u.token).send({ ...base, brandName: `Nb${uniqueWord(4)}` })).status, 403);
      const m = await mkMedicine();
      const bPharm = await t.makeUser(b, ["PHARMACIST"]);
      assert.equal((await t.api("patch", `/medicines/${m.id}`, bPharm.token).send({ gstPercent: 5 })).status, 404);
      assert.ok(!(await t.api("get", "/medicines", bPharm.token).query({ q: m.brandName })).body.data.some((x: { id: string }) => x.id === m.id));
      assert.equal((await t.api("get", "/medicines")).status, 401);
    });

    it("GST and field changes are audited; inactive medicines disappear from search", async () => {
      const m = await mkMedicine({ gstPercent: 5 });
      await t.api("patch", `/medicines/${m.id}`, pharm.token).send({ gstPercent: 12 });
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "MEDICINE_GST_CHANGED", entityId: m.id } });
      assert.deepEqual((evt.metadata as { gstPercent: string[] }).gstPercent, ["5.00", "12.00"]);
      await t.api("patch", `/medicines/${m.id}`, pharm.token).send({ status: "INACTIVE" });
      assert.ok(!(await t.api("get", "/medicines", rec.token).query({ q: m.brandName })).body.data.some((x: { id: string }) => x.id === m.id));
      await assert.rejects(() => t.prisma.medicine.delete({ where: { tenantId_id: { tenantId: a.tenantId, id: m.id } } }), /append-only/);
    });

    it("suppliers: unique per tenant, GSTIN validated, write needs PHARMACY_MASTERS", async () => {
      const name = `Supplier ${uniqueWord(5)}`;
      assert.equal((await t.api("post", "/pharmacy/suppliers", pharm.token).send({ name, gstin: "19ABCDE1234F1Z5", phone: "+91 33 2222 3333" })).status, 201);
      assert.equal((await t.api("post", "/pharmacy/suppliers", pharm.token).send({ name })).status, 409);
      assert.equal((await t.api("post", "/pharmacy/suppliers", pharm.token).send({ name: `${name} 2`, gstin: "BADGSTIN" })).status, 400);
      assert.equal((await t.api("post", "/pharmacy/suppliers", rec.token).send({ name: `${name} 3` })).status, 403);
      assert.equal((await t.api("get", "/pharmacy/suppliers", nurse.token)).status, 403);
    });
  });

  // ───────────────────────── stock ledger ─────────────────────────
  describe("batches and the stock ledger", () => {
    it("opening stock creates the batch, a ledger row and a reconciled balance; replays are safe", async () => {
      const m = await mkMedicine();
      const k = key();
      const body = { medicineId: m.id, batchNo: "b-001", expiryDate: ymd(300), mrp: "10", purchasePrice: "6", sellingPrice: "9.5", quantity: 100 };
      const r = await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", k).send(body);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.batchNo, "B-001");
      assert.equal(r.body.data.quantity, 100);
      assert.equal(r.body.data.sellingPrice, "9.50");
      const replay = await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", k).send(body);
      assert.equal(replay.status, 200);
      assert.equal(await t.prisma.stockLedger.count({ where: { batchId: r.body.data.id } }), 1, "no double stock from a retry");
      assert.equal(await stockOf(r.body.data.id), 100);
      await assertReconciled(r.body.data.id);
      const led = await t.api("get", `/pharmacy/batches/${r.body.data.id}/ledger`, pharm.token);
      assert.equal(led.body.data.items[0].type, "ADJUSTMENT");
      assert.equal(led.body.data.items[0].direction, "IN");
      assert.equal(led.body.data.items[0].reason, "Opening stock");
    });

    it("rejects expired batches, selling price above MRP, bad quantities and missing keys", async () => {
      const m = await mkMedicine();
      const cases: [string, Record<string, unknown>][] = [
        ["expired", { expiryDate: ymd(-1) }], ["selling above MRP", { sellingPrice: "10.01" }], ["zero qty", { quantity: 0 }], ["fractional qty", { quantity: 1.5 }],
        ["negative price", { purchasePrice: "-1" }], ["bad batch no", { batchNo: "no spaces allowed!" }], ["bad date", { expiryDate: "2030-02-30" }],
        ["unknown medicine", { medicineId: randomUUID() }], ["foreign field", { facilityId: b.facilityId }],
      ];
      for (const [label, o] of cases) assert.equal((await opening(m.id, `X${uniqueWord(4)}`, 5, o)).status, 400, label);
      assert.equal((await t.api("post", "/pharmacy/batches", pharm.token).send({ medicineId: m.id, batchNo: "NK1", expiryDate: ymd(100), mrp: "10", purchasePrice: "5", sellingPrice: "9", quantity: 5 })).status, 400, "idempotency key required");
      assert.equal((await opening(m.id, "NOPE1", 5, {}, nurse.token)).status, 403);
      assert.equal((await opening(m.id, "NOPE2", 5, {}, rec.token)).status, 403);
    });

    it("adjustments need a reason, never go negative, are idempotent and audited", async () => {
      const m = await mkMedicine();
      const batch = (await opening(m.id, "ADJ1", 20)).body.data;
      const adj = (o: Record<string, unknown>, k = key()) => t.api("post", "/pharmacy/stock/adjustments", pharm.token).set("Idempotency-Key", k).send({ batchId: batch.id, ...o });
      assert.equal((await adj({ direction: "OUT", quantity: 5 })).status, 400, "reason required");
      assert.equal((await adj({ direction: "OUT", quantity: 5, reason: "no" })).status, 400);
      assert.equal((await adj({ direction: "IN", quantity: 5, kind: "DAMAGE", reason: "Damaged in transit" })).status, 400, "damage can only remove stock");
      const k = key();
      const first = await adj({ direction: "OUT", quantity: 5, kind: "DAMAGE", reason: "Broken ampoules found" }, k);
      assert.equal(first.status, 201);
      assert.equal(first.body.data.balanceAfter, 15);
      assert.equal((await adj({ direction: "OUT", quantity: 5, kind: "DAMAGE", reason: "Broken ampoules found" }, k)).status, 200, "replayed");
      assert.equal(await stockOf(batch.id), 15);
      const under = await adj({ direction: "OUT", quantity: 16, reason: "Stock count correction" });
      assert.equal(under.status, 409);
      assert.equal(under.body.error.code, "INSUFFICIENT_STOCK");
      assert.equal(await stockOf(batch.id), 15);
      assert.equal((await adj({ direction: "IN", quantity: 2, reason: "Found during stock count" })).body.data.balanceAfter, 17);
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "STOCK_ADJUSTED", entityId: batch.id }, orderBy: { createdAt: "asc" } });
      assert.equal(evt.actorUserId, pharm.id);
      assert.equal((evt.metadata as { reason: string }).reason, "Broken ampoules found");
      await assertReconciled(batch.id);
      const noPerm = await t.makeUser(a, ["RECEPTIONIST"]);
      assert.equal((await t.api("post", "/pharmacy/stock/adjustments", noPerm.token).set("Idempotency-Key", key()).send({ batchId: batch.id, direction: "IN", quantity: 1, reason: "Free stock please" })).status, 403);
    });

    it("concurrent adjustments serialise: 10 parallel removals of 3 from 20 allow exactly 6", async () => {
      const m = await mkMedicine();
      const batch = (await opening(m.id, "RACE1", 20)).body.data;
      const rs = await Promise.all(Array.from({ length: 10 }, () => t.api("post", "/pharmacy/stock/adjustments", pharm.token).set("Idempotency-Key", key()).send({ batchId: batch.id, direction: "OUT", quantity: 3, reason: "Parallel adjustment race" })));
      assert.equal(rs.filter((r) => r.status === 201).length, 6);
      assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.error.code === "INSUFFICIENT_STOCK"));
      assert.equal(await stockOf(batch.id), 2);
      await assertReconciled(batch.id);
    });

    it("DATABASE: the ledger is append-only and the balance can never drift from it", async () => {
      const m = await mkMedicine();
      const batch = (await opening(m.id, "DB1", 10)).body.data;
      const row = await t.prisma.stockLedger.findFirstOrThrow({ where: { batchId: batch.id } });
      await assert.rejects(() => t.prisma.stockLedger.update({ where: { id: row.id }, data: { quantity: 99 } }), /append-only/);
      await assert.rejects(() => t.prisma.stockLedger.delete({ where: { id: row.id } }), /append-only/);
      await assert.rejects(() => t.prisma.$executeRawUnsafe(`TRUNCATE "StockLedger"`), /append-only/);
      await assert.rejects(() => t.prisma.stockBalance.update({ where: { batchId: batch.id }, data: { quantity: 500 } }), /does not match the ledger/);
      await assert.rejects(() => t.prisma.stockBalance.update({ where: { batchId: batch.id }, data: { quantity: -1 } }), /stock_balance_nonneg|check/i);
      await assert.rejects(() => t.prisma.stockLedger.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchId: batch.id, type: "SALE", direction: "IN", quantity: 1, balanceAfter: 11, userId: pharm.id } }), /ledger_direction_matches_type|check/i);
      await assert.rejects(() => t.prisma.stockLedger.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchId: batch.id, type: "ADJUSTMENT", direction: "IN", quantity: 5, balanceAfter: 15, userId: pharm.id, reason: "Phantom stock via SQL" } }), /does not match the ledger/);
      assert.equal(await stockOf(batch.id), 10);
    });

    it("DATABASE: expired or blocked batches cannot be sold even by raw SQL; selling price above MRP is rejected", async () => {
      const m = await mkMedicine();
      const batch = (await opening(m.id, "EXP1", 10)).body.data;
      await t.prisma.$executeRaw`UPDATE "MedicineBatch" SET "expiryDate" = CURRENT_DATE - 400 WHERE id = ${batch.id}::uuid`.catch(() => undefined);
      await assert.rejects(() => t.prisma.medicineBatch.update({ where: { tenantId_id: { tenantId: a.tenantId, id: batch.id } }, data: { sellingPrice: 99 } }), /immutable|batch_prices|check/i);
      const old = await t.prisma.medicineBatch.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchNo: "OLD1", expiryDate: new Date(Date.now() - 5 * 86_400_000), mrp: 10, purchasePrice: 5, sellingPrice: 9 } });
      await t.prisma.stockBalance.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, batchId: old.id, medicineId: m.id, quantity: 0 } });
      await assert.rejects(() => t.prisma.$transaction(async (tx) => {
        await tx.stockBalance.update({ where: { batchId: old.id }, data: { quantity: 1 } });
        await tx.stockLedger.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchId: old.id, type: "PURCHASE", direction: "IN", quantity: 1, balanceAfter: 1, userId: pharm.id } });
        await tx.stockBalance.update({ where: { batchId: old.id }, data: { quantity: 0 } });
        await tx.stockLedger.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchId: old.id, type: "SALE", direction: "OUT", quantity: 1, balanceAfter: 0, userId: pharm.id } });
      }), /expired and cannot be dispensed/);
      await assert.rejects(() => t.prisma.medicineBatch.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchNo: "BAD1", expiryDate: new Date(Date.now() + 86_400_000 * 30), mrp: 10, purchasePrice: 5, sellingPrice: 10.5 } }), /batch_prices|check/i);
    });

    it("blocking a batch (recall) removes it from dispensing until unblocked; needs a reason", async () => {
      const m = await mkMedicine();
      const batch = (await opening(m.id, "BLK1", 10)).body.data;
      const patient = await registerPatient(t, rec.token);
      assert.equal((await t.api("post", `/pharmacy/batches/${batch.id}/block`, pharm.token).send({})).status, 400);
      assert.equal((await t.api("post", `/pharmacy/batches/${batch.id}/block`, pharm.token).send({ reason: "Manufacturer recall notice" })).status, 200);
      assert.equal((await t.api("post", `/pharmacy/batches/${batch.id}/block`, pharm.token).send({ reason: "Again again" })).status, 409);
      const blocked = await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1 }] });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, "INSUFFICIENT_STOCK");
      assert.equal((await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1, batchId: batch.id }] })).status, 400, "explicit blocked batch refused");
      await t.api("post", `/pharmacy/batches/${batch.id}/unblock`, pharm.token);
      assert.equal((await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1 }] })).status, 201);
    });
  });

  // ───────────────────────── procurement ─────────────────────────
  describe("procurement", () => {
    const supplier = async () => (await t.api("post", "/pharmacy/suppliers", pharm.token).send({ name: `Sup ${uniqueWord(6)}` })).body.data.id as string;
    const receive = (body: Record<string, unknown>, k = key(), tok = pharm.token) => t.api("post", "/pharmacy/purchases", tok).set("Idempotency-Key", k).send(body);

    it("receiving a purchase creates batches, PURCHASE ledger rows and exact totals", async () => {
      const m1 = await mkMedicine({ gstPercent: 12 });
      const m2 = await mkMedicine({ gstPercent: 5 });
      const s = await supplier();
      const r = await receive({
        supplierId: s, supplierInvoiceNo: `INV-${uniqueWord(5)}`, supplierInvoiceDate: ymd(-2),
        items: [
          { medicineId: m1.id, batchNo: "p1", expiryDate: ymd(400), quantity: 100, purchasePrice: "6.25", mrp: "10", sellingPrice: "9.5" },
          { medicineId: m2.id, batchNo: "p2", expiryDate: ymd(200), quantity: 50, purchasePrice: "20", mrp: "30", sellingPrice: "28", gstPercent: "18" },
        ],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.match(r.body.data.purchaseNumber, /^PUR-\d{4}-\d{6}$/);
      assert.equal(r.body.data.subtotal, "1625.00");
      assert.equal(r.body.data.taxTotal, "255.00", "625 x 12% = 75; 1000 x 18% = 180");
      assert.equal(r.body.data.total, "1880.00");
      const batches = await t.prisma.medicineBatch.findMany({ where: { medicineId: { in: [m1.id, m2.id] } }, include: { balance: true } });
      assert.deepEqual(batches.map((x) => x.balance?.quantity).sort(), [100, 50]);
      for (const bt of batches) { assert.equal(bt.receivedQuantity, bt.balance?.quantity); await assertReconciled(bt.id); }
      const led = await t.prisma.stockLedger.findMany({ where: { sourceId: r.body.data.id } });
      assert.equal(led.length, 2);
      assert.ok(led.every((l) => l.type === "PURCHASE" && l.direction === "IN" && l.userId === pharm.id));
    });

    it("is idempotent, rejects a duplicate supplier invoice, and tops up an identical batch", async () => {
      const m = await mkMedicine();
      const s = await supplier();
      const body = { supplierId: s, supplierInvoiceNo: `INV-${uniqueWord(5)}`, supplierInvoiceDate: ymd(-1), items: [{ medicineId: m.id, batchNo: "TOP1", expiryDate: ymd(300), quantity: 10, purchasePrice: "5", mrp: "9", sellingPrice: "8" }] };
      const k = key();
      assert.equal((await receive(body, k)).status, 201);
      assert.equal((await receive(body, k)).status, 200);
      const dup = await receive(body, key());
      assert.equal(dup.status, 409);
      assert.match(dup.body.error.message, /supplier invoice number/);
      const second = await receive({ ...body, supplierInvoiceNo: `INV-${uniqueWord(5)}`, items: [{ ...body.items[0], quantity: 5 }] });
      assert.equal(second.status, 201);
      const batch = await t.prisma.medicineBatch.findFirstOrThrow({ where: { medicineId: m.id, batchNo: "TOP1" }, include: { balance: true } });
      assert.equal(batch.balance?.quantity, 15);
      assert.equal(batch.receivedQuantity, 15);
      const clash = await receive({ ...body, supplierInvoiceNo: `INV-${uniqueWord(5)}`, items: [{ ...body.items[0], mrp: "12", sellingPrice: "11" }] });
      assert.equal(clash.status, 409, "same batch number with different prices/expiry is refused");
      assert.equal(await t.prisma.stockLedger.count({ where: { batchId: batch.id } }), 2);
    });

    it("validates the purchase and enforces permissions and tenant boundaries", async () => {
      const m = await mkMedicine();
      const s = await supplier();
      const ok = { supplierId: s, supplierInvoiceNo: `INV-${uniqueWord(5)}`, supplierInvoiceDate: ymd(0), items: [{ medicineId: m.id, batchNo: "V1", expiryDate: ymd(100), quantity: 5, purchasePrice: "5", mrp: "9", sellingPrice: "8" }] };
      for (const [label, o] of [
        ["no items", { items: [] }], ["unknown supplier", { supplierId: randomUUID() }], ["expired batch", { items: [{ ...ok.items[0], expiryDate: ymd(-1) }] }],
        ["selling above MRP", { items: [{ ...ok.items[0], sellingPrice: "9.01" }] }], ["zero qty", { items: [{ ...ok.items[0], quantity: 0 }] }], ["unknown medicine", { items: [{ ...ok.items[0], medicineId: randomUUID() }] }],
        ["bad date", { supplierInvoiceDate: "yesterday" }], ["extra field", { status: "RETURNED" }],
      ] as [string, Record<string, unknown>][]) assert.equal((await receive({ ...ok, supplierInvoiceNo: `INV-${uniqueWord(5)}`, ...o })).status, 400, label);
      assert.equal(await t.prisma.purchase.count({ where: { supplierId: s } }), 0, "rejected purchases left nothing behind");
      for (const u of [rec, nurse]) assert.equal((await receive(ok, key(), u.token)).status, 403);
      assert.equal((await t.api("post", "/pharmacy/purchases", pharm.token).send(ok)).status, 400, "idempotency key required");
      const bPharm = await t.makeUser(b, ["PHARMACIST"]);
      assert.equal((await receive(ok, key(), bPharm.token)).status, 400, "another tenant's supplier/medicine do not exist for them");
    });

    it("purchase returns are capped by what was bought and by what is still on the shelf", async () => {
      const m = await mkMedicine();
      const s = await supplier();
      const p = (await receive({ supplierId: s, supplierInvoiceNo: `INV-${uniqueWord(5)}`, supplierInvoiceDate: ymd(0), items: [{ medicineId: m.id, batchNo: "RET1", expiryDate: ymd(300), quantity: 20, purchasePrice: "10", mrp: "15", sellingPrice: "14", gstPercent: "5" }] })).body.data;
      const ret = (n: number, k = key()) => t.api("post", `/pharmacy/purchases/${p.id}/returns`, pharm.token).set("Idempotency-Key", k).send({ reason: "Supplier shipped near-expiry stock", items: [{ purchaseItemId: p.items[0].id, quantity: n }] });
      const r1 = await ret(5);
      assert.equal(r1.status, 201);
      assert.match(r1.body.data.returnNumber, /^PRN-\d{4}-\d{6}$/);
      assert.equal(r1.body.data.total, "52.50", "5 x 10 + 5% GST");
      assert.equal(r1.body.data.purchase.status, "PARTIALLY_RETURNED");
      const batch = await t.prisma.medicineBatch.findFirstOrThrow({ where: { medicineId: m.id } });
      assert.equal(await stockOf(batch.id), 15);
      assert.equal((await ret(16)).status, 409, "only 15 left to return");
      const patient = await registerPatient(t, rec.token);
      assert.equal((await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 12 }] })).status, 201);
      const sold = await ret(10);
      assert.equal(sold.status, 409, "stock already sold cannot be returned to the supplier");
      assert.equal(sold.body.error.code, "INSUFFICIENT_STOCK");
      assert.equal((await ret(3)).status, 201);
      assert.equal(await stockOf(batch.id), 0);
      assert.equal((await ret(0)).status, 400);
      const k = key();
      assert.equal((await ret(0, k)).status, 400);
      await assertReconciled(batch.id);
    });

    it("purchases are immutable and listed per facility only", async () => {
      const m = await mkMedicine();
      const s = await supplier();
      const p = (await receive({ supplierId: s, supplierInvoiceNo: `INV-${uniqueWord(5)}`, supplierInvoiceDate: ymd(0), items: [{ medicineId: m.id, batchNo: "IM1", expiryDate: ymd(200), quantity: 5, purchasePrice: "5", mrp: "9", sellingPrice: "8" }] })).body.data;
      await assert.rejects(() => t.prisma.purchase.update({ where: { id: p.id }, data: { total: 1, subtotal: 1 } }), /cannot be changed/);
      await assert.rejects(() => t.prisma.purchase.delete({ where: { id: p.id } }), /append-only/);
      await assert.rejects(() => t.prisma.purchaseItem.update({ where: { id: p.items[0].id }, data: { quantity: 500 } }), /cannot be changed/);
      assert.equal((await t.api("get", `/pharmacy/purchases/${p.id}`, pharm.token)).status, 200);
      const bPharm = await t.makeUser(b, ["PHARMACIST"]);
      assert.equal((await t.api("get", `/pharmacy/purchases/${p.id}`, bPharm.token)).status, 404);
      const f2 = await t.makeUser(a, ["PHARMACIST"], { facilityIds: [a.facility2Id] });
      assert.equal((await t.api("get", `/pharmacy/purchases/${p.id}`, f2.token)).status, 404);
      assert.equal((await t.api("post", `/pharmacy/purchases/${p.id}/returns`, f2.token).set("Idempotency-Key", key()).send({ reason: "Cross facility attempt", items: [{ purchaseItemId: p.items[0].id, quantity: 1 }] })).status, 404);
    });
  });

  // ───────────────────────── stock views ─────────────────────────
  it("stock summary shows sellable, near-expiry, expired and low-stock quantities", async () => {
    const m = await mkMedicine({ reorderLevel: 50 });
    await opening(m.id, "S-LATE", 30, { expiryDate: ymd(400) });
    await opening(m.id, "S-NEAR", 20, { expiryDate: ymd(30) });
    const old = await t.prisma.medicineBatch.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchNo: "S-OLD", expiryDate: new Date(Date.now() - 10 * 86_400_000), mrp: 10, purchasePrice: 5, sellingPrice: 9, receivedQuantity: 7 } });
    await t.prisma.stockBalance.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, batchId: old.id, medicineId: m.id, quantity: 0 } });
    await t.prisma.$transaction(async (tx) => {
      await tx.stockBalance.update({ where: { batchId: old.id }, data: { quantity: 7 } });
      await tx.stockLedger.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchId: old.id, type: "PURCHASE", direction: "IN", quantity: 7, balanceAfter: 7, userId: pharm.id } });
    });
    const r = await t.api("get", "/pharmacy/stock", pharm.token).query({ q: m.brandName, nearExpiryDays: 60 });
    assert.equal(r.status, 200);
    const row = r.body.data[0];
    assert.equal(row.sellableQuantity, 50);
    assert.equal(row.nearExpiryQuantity, 20);
    assert.equal(row.expiredQuantity, 7);
    assert.equal(row.lowStock, true);
    assert.equal(row.batches.length, 3);
    assert.ok((await t.api("get", "/pharmacy/stock", pharm.token).query({ lowStock: "true", q: m.brandName })).body.data.length === 1);
    assert.equal((await t.api("get", "/pharmacy/stock", rec.token)).status, 403);
    assert.equal((await t.api("get", "/pharmacy/stock", pharm.token).query({ nearExpiryDays: 1000 })).status, 400);
    const bPharm = await t.makeUser(b, ["PHARMACIST"]);
    assert.equal((await t.api("get", "/pharmacy/stock", bPharm.token).query({ q: m.brandName })).body.data.length, 0);
  });

  // ───────────────────────── dispensing ─────────────────────────
  describe("dispensing", () => {
    it("FEFO: takes from the earliest-expiring unexpired batch first and spans batches when needed", async () => {
      const m = await mkMedicine();
      const late = (await opening(m.id, "F-LATE", 10, { expiryDate: ymd(500) })).body.data;
      const soon = (await opening(m.id, "F-SOON", 4, { expiryDate: ymd(60) })).body.data;
      const mid = (await opening(m.id, "F-MID", 10, { expiryDate: ymd(200) })).body.data;
      const patient = await registerPatient(t, rec.token);
      const sug = await t.api("get", `/pharmacy/medicines/${m.id}/suggest-batches`, pharm.token).query({ quantity: 6 });
      assert.deepEqual(sug.body.data.map((s: { batchNo: string; quantity: number }) => [s.batchNo, s.quantity]), [["F-SOON", 4], ["F-MID", 2]]);
      const r = await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 6 }] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body.data.dispense.items.map((i: { batchNo: string; quantity: number }) => [i.batchNo, i.quantity]), [["F-SOON", 4], ["F-MID", 2]]);
      assert.equal(await stockOf(soon.id), 0);
      assert.equal(await stockOf(mid.id), 8);
      assert.equal(await stockOf(late.id), 10);
      for (const bt of [soon, mid, late]) await assertReconciled(bt.id);
      const led = await t.prisma.stockLedger.findMany({ where: { sourceId: r.body.data.dispense.id } });
      assert.ok(led.every((l) => l.type === "SALE" && l.direction === "OUT" && l.sourceType === "DISPENSE" && l.userId === pharm.id));
    });

    it("never dispenses expired stock and refuses when only expired or too little stock exists", async () => {
      const m = await mkMedicine();
      const patient = await registerPatient(t, rec.token);
      const old = await t.prisma.medicineBatch.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchNo: "E-OLD", expiryDate: new Date(Date.now() - 2 * 86_400_000), mrp: 10, purchasePrice: 5, sellingPrice: 9, receivedQuantity: 9 } });
      await t.prisma.stockBalance.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, batchId: old.id, medicineId: m.id, quantity: 0 } });
      await t.prisma.$transaction(async (tx) => {
        await tx.stockBalance.update({ where: { batchId: old.id }, data: { quantity: 9 } });
        await tx.stockLedger.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchId: old.id, type: "PURCHASE", direction: "IN", quantity: 9, balanceAfter: 9, userId: pharm.id } });
      });
      const onlyExpired = await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1 }] });
      assert.equal(onlyExpired.status, 409);
      assert.equal(onlyExpired.body.error.code, "INSUFFICIENT_STOCK");
      assert.equal(onlyExpired.body.error.details.available, 0);
      const explicit = await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1, batchId: old.id }] });
      assert.equal(explicit.status, 409);
      assert.equal(explicit.body.error.code, "BATCH_EXPIRED");
      const good = (await opening(m.id, "E-GOOD", 3)).body.data;
      const short = await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 4 }] });
      assert.equal(short.status, 409);
      assert.equal(short.body.error.details.available, 3);
      assert.equal(await stockOf(good.id), 3, "a refused dispense moved nothing");
      assert.equal(await stockOf(old.id), 9);
      assert.equal(await t.prisma.dispense.count({ where: { patientId: patient.id } }), 0);
    });

    it("bills the pharmacy sale exactly (qty x selling price, never above MRP) and is collected only by the cashier", async () => {
      const m = await mkMedicine({ gstPercent: 12 });
      await opening(m.id, "BILL1", 50, { mrp: "10.00", sellingPrice: "9.35" });
      const patient = await registerPatient(t, rec.token);
      const r = await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 7 }] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const d = r.body.data.dispense;
      assert.match(d.dispenseNumber, /^PH-\d{4}-\d{6}$/);
      assert.equal(d.total, "65.45");
      assert.equal(d.taxTotal, "7.01", "GST component included in the MRP-inclusive price: 65.45 x 12/112");
      assert.equal(d.subtotal, "58.44");
      assert.equal(d.invoice.status, "ISSUED", "the bill is issued and waits for the cashier");
      assert.equal(d.invoice.paidTotal, "0.00");
      assert.match(d.invoice.invoiceNumber, /^INV-/);
      // The cashiers are told a bill is waiting (once); the pharmacist who dispensed is not (notifications.md).
      assert.equal(await t.prisma.notification.count({ where: { tenantId: a.tenantId, recipientUserId: cashier.id, type: "PHARMACY_BILL_WAITING", entityId: d.invoiceId } }), 1);
      assert.equal(await t.prisma.notification.count({ where: { tenantId: a.tenantId, recipientUserId: pharm.id, entityId: d.invoiceId } }), 0);
      assert.equal(r.body.data.receipt, undefined, "the pharmacy never produces a receipt");
      // The pharmacy cannot take payment in any way.
      assert.equal((await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1 }], payments: [{ method: "UPI", amount: "9.35", reference: "UPI-PH-0002" }] })).status, 400, "payments are not accepted when dispensing");
      assert.equal((await t.api("post", `/invoices/${d.invoiceId}/payments`, pharm.token).set("Idempotency-Key", key()).send({ payments: [{ method: "UPI", amount: "65.45", reference: "UPI-PH-0003" }] })).status, 403, "the pharmacist holds no payment permission");
      assert.equal((await t.api("post", "/shifts/open", pharm.token).send({ openingCash: "0" })).status, 403, "nor a cash shift");
      assert.equal((await t.api("post", "/invoices", pharm.token).send({ patientId: patient.id, kind: "OPD", lines: [{ description: "x", unitPrice: "1", taxPercent: 0, quantity: 1 }] })).status, 403, "nor hand-made bills");
      const pending = await t.api("get", "/invoices?kind=PHARMACY&outstanding=true", cashier.token);
      assert.ok((pending.body.data as { id: string }[]).some((x) => x.id === d.invoiceId), "the cashier sees it in the pharmacy bills to collect");
      const paid = await collect(d.invoiceId, "65.45");
      assert.equal(paid.status, 201, JSON.stringify(paid.body));
      assert.match(paid.body.data.receipt.receiptNumber, /^RCT-/);
      assert.equal((await t.api("get", `/invoices/${d.invoiceId}`, cashier.token)).body.data.status, "PAID");
      const inv = await t.prisma.invoice.findFirstOrThrow({ where: { id: d.invoiceId }, include: { lines: true } });
      assert.equal(inv.kind, "PHARMACY");
      assert.equal(inv.lines[0]?.sourceType, "DISPENSE");
      assert.equal(inv.total.toFixed(2), "65.45");
      assert.equal(await stockOf((await t.prisma.medicineBatch.findFirstOrThrow({ where: { medicineId: m.id } })).id), 43, "the refused request took no stock");
      const unpaid = await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1 }] });
      assert.equal(unpaid.body.data.dispense.invoice.status, "ISSUED");
    });

    it("double-submit with one key dispenses once; a repeated request with a new key is a new sale", async () => {
      const m = await mkMedicine();
      const batch = (await opening(m.id, "IDEM1", 30)).body.data;
      const patient = await registerPatient(t, rec.token);
      const k = key();
      const rs = await Promise.all(Array.from({ length: 8 }, () => dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 2 }] }, pharm.token, k)));
      assert.ok(rs.every((r) => [200, 201].includes(r.status)), rs.map((r) => r.status).join());
      assert.equal(rs.filter((r) => r.status === 201).length, 1);
      assert.equal(new Set(rs.map((r) => r.body.data.dispense.dispenseNumber)).size, 1);
      assert.equal(await stockOf(batch.id), 28);
      assert.equal(await t.prisma.dispense.count({ where: { patientId: patient.id } }), 1);
      assert.equal((await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 5 }] }, pharm.token, k)).status, 422);
      assert.equal((await t.api("post", "/pharmacy/dispenses", pharm.token).send({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1 }] })).status, 400);
    });

    it("cannot oversell under concurrency: 25 parallel single-unit sales against 10 units yield exactly 10", async () => {
      const m = await mkMedicine();
      const batch = (await opening(m.id, "OVR1", 10)).body.data;
      const patients = await Promise.all(Array.from({ length: 25 }, () => registerPatient(t, rec.token)));
      const rs = await Promise.all(patients.map((p) => dispense({ patientId: p.id, items: [{ medicineId: m.id, quantity: 1 }] })));
      assert.equal(rs.filter((r) => r.status === 201).length, 10);
      assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.error.code === "INSUFFICIENT_STOCK"));
      assert.equal(await stockOf(batch.id), 0);
      assert.equal(await t.prisma.stockLedger.count({ where: { batchId: batch.id, type: "SALE" } }), 10);
      await assertReconciled(batch.id);
    });

    it("concurrent multi-batch, multi-medicine sales neither deadlock nor oversell", async () => {
      const m1 = await mkMedicine();
      const m2 = await mkMedicine();
      const batches = [
        (await opening(m1.id, "MB-1A", 6, { expiryDate: ymd(100) })).body.data, (await opening(m1.id, "MB-1B", 6, { expiryDate: ymd(200) })).body.data,
        (await opening(m2.id, "MB-2A", 6, { expiryDate: ymd(100) })).body.data, (await opening(m2.id, "MB-2B", 6, { expiryDate: ymd(200) })).body.data,
      ];
      const patients = await Promise.all(Array.from({ length: 10 }, () => registerPatient(t, rec.token)));
      const rs = await Promise.all(patients.map((p, i) => dispense({ patientId: p.id, items: i % 2 ? [{ medicineId: m1.id, quantity: 3 }, { medicineId: m2.id, quantity: 3 }] : [{ medicineId: m2.id, quantity: 3 }, { medicineId: m1.id, quantity: 3 }] })));
      assert.equal(rs.filter((r) => r.status === 201).length, 4, "12 units per medicine / 3 per sale");
      assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409));
      for (const bt of batches) { assert.equal(await stockOf(bt.id), 0); await assertReconciled(bt.id); }
    });

    it("permissions and isolation: only dispensers dispense; other tenants/facilities see nothing", async () => {
      const m = await mkMedicine();
      await opening(m.id, "ISO1", 10);
      const patient = await registerPatient(t, rec.token);
      for (const u of [rec, nurse]) assert.equal((await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1 }] }, u.token)).status, 403);
      const r = await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1 }] });
      const id = r.body.data.dispense.id as string;
      const bPharm = await t.makeUser(b, ["PHARMACIST"]);
      assert.equal((await t.api("get", `/pharmacy/dispenses/${id}`, bPharm.token)).status, 404);
      assert.equal((await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1 }] }, bPharm.token)).status, 404, "another tenant's patient does not exist");
      const f2 = await t.makeUser(a, ["PHARMACIST"], { facilityIds: [a.facility2Id] });
      assert.equal((await t.api("get", `/pharmacy/dispenses/${id}`, f2.token)).status, 404);
      const f2Try = await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 1 }] }, f2.token);
      assert.equal(f2Try.status, 409, "facility 2 holds no stock of its own");
      assert.equal((await t.api("get", `/pharmacy/dispenses/${randomUUID()}`, pharm.token)).status, 404);
    });

    it("validates the request body", async () => {
      const m = await mkMedicine();
      await opening(m.id, "VAL1", 10);
      const patient = await registerPatient(t, rec.token);
      const ok = { patientId: patient.id, items: [{ medicineId: m.id, quantity: 1 }] };
      for (const [label, o] of [
        ["no items", { items: [] }], ["zero qty", { items: [{ medicineId: m.id, quantity: 0 }] }], ["fractional", { items: [{ medicineId: m.id, quantity: 1.5 }] }],
        ["unknown medicine", { items: [{ medicineId: randomUUID(), quantity: 1 }] }], ["unknown field", { total: "1" }], ["price override", { items: [{ medicineId: m.id, quantity: 1, unitPrice: "0.01" }] }],
        ["bad payment", { payments: [{ method: "CASH", amount: "-5" }] }],
      ] as [string, Record<string, unknown>][]) assert.equal((await dispense({ ...ok, ...o })).status, 400, label);
      assert.equal((await dispense({ ...ok, patientId: randomUUID() })).status, 404);
      assert.equal((await dispense({ ...ok, medicationOrderId: randomUUID() })).status, 404);
    });
  });

  // ───────────────────────── prescription → dispense ─────────────────────────
  describe("prescription queue and dispensing", () => {
    /** A signed OPD prescription containing the given medicines (linked to the pharmacy master). */
    const signedRx = async (items: Record<string, unknown>[]) => {
      const patient = await registerPatient(t, rec.token);
      const doctor = await makeDoctor(t, a);
      const v = await startVisit(t, rec.token, doctor, patient.id);
      const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, doctor.token).send({ content: { chiefComplaint: "Fever" } });
      await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doctor.token).send({ text: "Viral fever", type: "PROVISIONAL" });
      const rx = await t.api("put", `/encounters/${v.encounterId}/prescription`, doctor.token).send({ items });
      assert.equal(rx.status, 200, JSON.stringify(rx.body));
      const s = await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doctor.token).send({ version: c.body.data.version, acknowledgeAllergyWarnings: true });
      assert.equal(s.status, 200, JSON.stringify(s.body));
      const order = (await t.api("get", `/encounters/${v.encounterId}/prescription`, doctor.token)).body.data.orders.find((o: { status: string }) => o.status === "SIGNED");
      return { patient, doctor, v, order };
    };
    const line = (med: { id: string; genericName: string; brandName: string }, o: Record<string, unknown> = {}) =>
      ({ medicineId: med.id, genericName: med.genericName, brandName: med.brandName, strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "BD", durationDays: 5, quantity: 10, ...o });

    it("a signed prescription appears in the pharmacy queue with patient, doctor and remaining quantities; drafts do not", async () => {
      const m = await mkMedicine();
      const patient = await registerPatient(t, rec.token);
      const doctor = await makeDoctor(t, a);
      const v = await startVisit(t, rec.token, doctor, patient.id);
      await t.api("put", `/encounters/${v.encounterId}/prescription`, doctor.token).send({ items: [line(m)] });
      const before = await t.api("get", "/pharmacy/queue", pharm.token).query({ q: patient.mrn });
      assert.equal(before.body.data.length, 0, "a draft is not visible to pharmacy");
      const s = await signedRx([line(m)]);
      const q = await t.api("get", "/pharmacy/queue", pharm.token).query({ q: s.patient.mrn });
      assert.equal(q.status, 200);
      assert.equal(q.body.data.length, 1);
      const e = q.body.data[0];
      assert.equal(e.orderNumber, s.order.orderNumber);
      assert.equal(e.status, "PENDING");
      assert.equal(e.doctorName, (await t.prisma.practitioner.findFirstOrThrow({ where: { id: s.doctor.practitionerId } })).displayName);
      assert.equal(e.items[0].remaining, 10);
      assert.equal(e.items[0].medicineId, m.id);
      assert.equal((await t.api("get", "/pharmacy/queue", rec.token)).status, 403);
      assert.equal((await t.api("get", "/pharmacy/queue", nurse.token)).status, 403, "nurses lack pharmacy access");
      const bPharm = await t.makeUser(b, ["PHARMACIST"]);
      assert.equal((await t.api("get", "/pharmacy/queue", bPharm.token).query({ q: s.patient.mrn })).body.data.length, 0);
    });

    it("prescription -> dispense -> stock deduction is atomic; partial dispensing tracks what remains; over-dispensing is refused", async () => {
      const m = await mkMedicine();
      const batch = (await opening(m.id, "RX1", 30)).body.data;
      const s = await signedRx([line(m, { quantity: 10 })]);
      const itemId = s.order.items[0].id as string;
      const first = await dispense({ patientId: s.patient.id, medicationOrderId: s.order.id, items: [{ medicationOrderItemId: itemId, medicineId: m.id, quantity: 4 }] });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.data.dispense.prescriptionNumber, s.order.orderNumber);
      assert.equal(await stockOf(batch.id), 26);
      assert.equal((await t.prisma.medicationOrderItem.findFirstOrThrow({ where: { id: itemId } })).dispensedQuantity, 4);
      const q = await t.api("get", "/pharmacy/queue", pharm.token).query({ q: s.patient.mrn });
      assert.equal(q.body.data[0].status, "PARTIAL");
      assert.equal(q.body.data[0].items[0].remaining, 6);
      const over = await dispense({ patientId: s.patient.id, medicationOrderId: s.order.id, items: [{ medicationOrderItemId: itemId, medicineId: m.id, quantity: 7 }] });
      assert.equal(over.status, 409);
      assert.equal(await stockOf(batch.id), 26, "the refused over-dispense took no stock");
      assert.equal((await dispense({ patientId: s.patient.id, medicationOrderId: s.order.id, items: [{ medicationOrderItemId: itemId, medicineId: m.id, quantity: 6 }] })).status, 201);
      assert.equal((await t.api("get", "/pharmacy/queue", pharm.token).query({ q: s.patient.mrn })).body.data.length, 0, "fully dispensed prescriptions leave the queue");
      assert.equal((await dispense({ patientId: s.patient.id, medicationOrderId: s.order.id, items: [{ medicationOrderItemId: itemId, medicineId: m.id, quantity: 1 }] })).status, 409);
      await assertReconciled(batch.id);
    });

    it("two pharmacists dispensing the same prescription line at once cannot exceed the prescribed quantity", async () => {
      const m = await mkMedicine();
      const batch = (await opening(m.id, "RXR1", 100)).body.data;
      const s = await signedRx([line(m, { quantity: 10 })]);
      const itemId = s.order.items[0].id as string;
      const pharm2 = await t.makeUser(a, ["PHARMACIST"]);
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => dispense({ patientId: s.patient.id, medicationOrderId: s.order.id, items: [{ medicationOrderItemId: itemId, medicineId: m.id, quantity: 4 }] }, i % 2 ? pharm.token : pharm2.token)));
      assert.equal(rs.filter((r) => r.status === 201).length, 2, "10 / 4 = two full dispenses");
      assert.equal((await t.prisma.medicationOrderItem.findFirstOrThrow({ where: { id: itemId } })).dispensedQuantity, 8);
      assert.equal(await stockOf(batch.id), 92);
      await assertReconciled(batch.id);
    });

    it("enforces prescription integrity: right patient, right line, matching medicine, signed and active only", async () => {
      const m = await mkMedicine({ genericName: "Cefixime" });
      const wrong = await mkMedicine({ genericName: "Metformin" });
      await opening(m.id, "RXI1", 20);
      await opening(wrong.id, "RXI2", 20);
      const s = await signedRx([line(m)]);
      const itemId = s.order.items[0].id as string;
      const other = await registerPatient(t, rec.token);
      assert.equal((await dispense({ patientId: other.id, medicationOrderId: s.order.id, items: [{ medicationOrderItemId: itemId, medicineId: m.id, quantity: 1 }] })).status, 400, "someone else's prescription");
      const mismatch = await dispense({ patientId: s.patient.id, medicationOrderId: s.order.id, items: [{ medicationOrderItemId: itemId, medicineId: wrong.id, quantity: 1 }] });
      assert.equal(mismatch.status, 400);
      assert.match(mismatch.body.error.message, /does not match the prescribed/);
      assert.equal((await dispense({ patientId: s.patient.id, medicationOrderId: s.order.id, items: [{ medicineId: m.id, quantity: 1 }] })).status, 400, "must reference the prescription line");
      assert.equal((await dispense({ patientId: s.patient.id, medicationOrderId: s.order.id, items: [{ medicationOrderItemId: randomUUID(), medicineId: m.id, quantity: 1 }] })).status, 400);
      assert.equal((await dispense({ patientId: s.patient.id, items: [{ medicationOrderItemId: itemId, medicineId: m.id, quantity: 1 }] })).status, 400, "line without prescription");
      const draftPatient = await registerPatient(t, rec.token);
      const doctor = await makeDoctor(t, a);
      const v = await startVisit(t, rec.token, doctor, draftPatient.id);
      const draft = await t.api("put", `/encounters/${v.encounterId}/prescription`, doctor.token).send({ items: [line(m)] });
      assert.equal((await dispense({ patientId: draftPatient.id, medicationOrderId: draft.body.data.order.id, items: [{ medicationOrderItemId: draft.body.data.order.items[0].id, medicineId: m.id, quantity: 1 }] })).status, 409, "drafts cannot be dispensed");
      const bPharm = await t.makeUser(b, ["PHARMACIST"]);
      assert.equal((await dispense({ patientId: s.patient.id, medicationOrderId: s.order.id, items: [{ medicationOrderItemId: itemId, medicineId: m.id, quantity: 1 }] }, bPharm.token)).status, 404);
    });

    it("blocks dispensing a medicine that matches a recorded allergy until the pharmacist confirms; the override is audited", async () => {
      const m = await mkMedicine({ genericName: "Amoxicillin" });
      await opening(m.id, "ALG1", 20);
      const patient = await registerPatient(t, rec.token);
      await t.api("post", `/patients/${patient.id}/allergies`, nurse.token).send({ allergen: "Amoxicillin", type: "DRUG", reaction: "Hives", severity: "SEVERE" });
      const blocked = await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 2 }] });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, "ALLERGY_CONFLICT");
      assert.equal(blocked.body.error.details.allergyWarnings[0].severity, "SEVERE");
      assert.equal(await t.prisma.dispense.count({ where: { patientId: patient.id } }), 0);
      const ok = await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 2 }], acknowledgeAllergyWarnings: true });
      assert.equal(ok.status, 201);
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "DISPENSE_ALLERGY_ACKNOWLEDGED", entityId: ok.body.data.dispense.id } });
      assert.equal(evt.actorUserId, pharm.id);
    });

    it("amending a prescription after partial dispensing is refused so pharmacy records are never contradicted", async () => {
      const m = await mkMedicine();
      await opening(m.id, "AMD1", 30);
      const s = await signedRx([line(m)]);
      await dispense({ patientId: s.patient.id, medicationOrderId: s.order.id, items: [{ medicationOrderItemId: s.order.items[0].id, medicineId: m.id, quantity: 2 }] });
      const doc = await t.api("get", `/encounters/${s.v.encounterId}/consultation`, s.doctor.token);
      const r = await t.api("post", `/encounters/${s.v.encounterId}/consultation/amend`, s.doctor.token).send({
        expectedVersion: doc.body.data.document.currentVersion, reason: "Dose change after review of reports", content: { chiefComplaint: "Fever" }, prescription: { items: [line(m, { quantity: 3 })] },
      });
      assert.equal(r.status, 409);
      assert.match(r.body.error.message, /already dispensed/);
    });
  });

  // ───────────────────────── returns ─────────────────────────
  describe("patient returns", () => {
    it("returns stock via PATIENT_RETURN, credits the invoice, caps quantities, and settles a full return", async () => {
      const m = await mkMedicine();
      const batch = (await opening(m.id, "PR1", 20, { mrp: "10.00", sellingPrice: "10.00" })).body.data;
      const patient = await registerPatient(t, rec.token);
      const sale = (await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 5 }] })).body.data.dispense;
      assert.equal((await collect(sale.invoiceId, "50.00", "UPI", "UPI-RET-001")).status, 201);
      const itemId = sale.items[0].id as string;
      const ret = (n: number, k = key()) => t.api("post", `/pharmacy/dispenses/${sale.id}/returns`, pharm.token).set("Idempotency-Key", k).send({ reason: "Patient stopped treatment", items: [{ dispenseItemId: itemId, quantity: n }] });
      const r1 = await ret(2);
      assert.equal(r1.status, 201, JSON.stringify(r1.body));
      assert.equal(r1.body.data.creditedAmount, "20.00");
      assert.match(r1.body.data.creditNoteNumber, /^CN-/);
      assert.equal(r1.body.data.dispense.status, "PARTIALLY_RETURNED");
      assert.equal(await stockOf(batch.id), 17);
      const inv = await t.api("get", `/invoices/${sale.invoiceId}`, pharm.token);
      assert.equal(inv.body.data.creditedTotal, "20.00");
      assert.equal(inv.body.data.refundable, "20.00", "the cashier can now refund the overpayment");
      assert.equal((await ret(4)).status, 409, "only 3 left to return");
      const k = key();
      const rs = await Promise.all(Array.from({ length: 5 }, () => ret(3, k)));
      assert.equal(rs.filter((r) => r.status === 201).length, 1);
      assert.equal((await t.prisma.dispenseItem.findFirstOrThrow({ where: { id: itemId } })).returnedQuantity, 5);
      assert.equal((await t.prisma.dispense.findFirstOrThrow({ where: { id: sale.id } })).status, "RETURNED");
      assert.equal(await stockOf(batch.id), 20);
      const full = await t.api("get", `/invoices/${sale.invoiceId}`, pharm.token);
      assert.equal(full.body.data.status, "PAID", "nothing is owed after a full return");
      assert.equal(full.body.data.refundable, "50.00");
      const types = (await t.prisma.stockLedger.findMany({ where: { batchId: batch.id }, orderBy: { seq: "asc" } })).map((l) => l.type);
      assert.deepEqual(types, ["ADJUSTMENT", "SALE", "PATIENT_RETURN", "PATIENT_RETURN"]);
      await assertReconciled(batch.id);
      assert.equal((await ret(1)).status, 409, "nothing left to return");
    });

    it("validates returns, enforces permissions and isolation, and keeps sold-stock history", async () => {
      const m = await mkMedicine();
      await opening(m.id, "PR2", 10);
      const patient = await registerPatient(t, rec.token);
      const sale = (await dispense({ patientId: patient.id, items: [{ medicineId: m.id, quantity: 3 }] })).body.data.dispense;
      const item = sale.items[0].id as string;
      const post = (body: object, tok = pharm.token) => t.api("post", `/pharmacy/dispenses/${sale.id}/returns`, tok).set("Idempotency-Key", key()).send(body);
      assert.equal((await post({ items: [{ dispenseItemId: item, quantity: 1 }] })).status, 400, "reason required");
      assert.equal((await post({ reason: "Wrong item dispensed", items: [{ dispenseItemId: randomUUID(), quantity: 1 }] })).status, 400);
      assert.equal((await post({ reason: "Wrong item dispensed", items: [{ dispenseItemId: item, quantity: 0 }] })).status, 400);
      assert.equal((await post({ reason: "Wrong item dispensed", items: [{ dispenseItemId: item, quantity: 1 }] }, rec.token)).status, 403);
      const bPharm = await t.makeUser(b, ["PHARMACIST"]);
      assert.equal((await post({ reason: "Cross tenant return", items: [{ dispenseItemId: item, quantity: 1 }] }, bPharm.token)).status, 404);
      await assert.rejects(() => t.prisma.dispenseItem.update({ where: { id: item }, data: { quantity: 99 } }), /cannot be changed/);
      await assert.rejects(() => t.prisma.dispenseItem.update({ where: { id: item }, data: { returnedQuantity: 4 } }), /dispense_item_numbers|check/i);
      await assert.rejects(() => t.prisma.dispense.delete({ where: { id: sale.id } }), /append-only/);
    });
  });

  it("every stock-changing action is audited with an attributable actor", async () => {
    const evts = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: { in: ["PHARMACY_DISPENSED", "PURCHASE_RECEIVED", "STOCK_ADJUSTED", "PHARMACY_RETURN", "PURCHASE_RETURNED", "STOCK_OPENING_RECORDED"] } } });
    assert.ok(evts.length > 15);
    assert.ok(evts.every((e) => e.actorUserId && e.facilityId === a.facilityId && e.requestId));
  });

  it("system-wide stock reconciliation: every batch's balance equals its ledger", async () => {
    const rows = await t.prisma.$queryRaw<{ batchId: string; balance: number; ledger: bigint }[]>`
      SELECT s."batchId", s.quantity AS balance,
             COALESCE((SELECT SUM(CASE l.direction WHEN 'IN' THEN l.quantity ELSE -l.quantity END) FROM "StockLedger" l WHERE l."batchId" = s."batchId"), 0) AS ledger
      FROM "StockBalance" s WHERE s."tenantId" = ${a.tenantId}::uuid`;
    assert.ok(rows.length > 20);
    assert.deepEqual(rows.filter((r) => BigInt(r.balance) !== r.ledger || r.balance < 0), []);
  });
});
