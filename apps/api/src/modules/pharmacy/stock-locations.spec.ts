import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
const key = () => `k-${randomUUID().slice(0, 18)}`;

interface Place { id: string | null; name: string }
interface TransferView { id: string; transferNumber: string; from: Place; to: Place; units: number; reason: string; items: { batchId: string; quantity: number; batchNo: string }[] }

describe("stock locations and transfers", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let pharm: { id: string; token: string };
  let nurse: { id: string; token: string };
  let cashier: { id: string; token: string };
  let bPharm: { id: string; token: string };

  const mkMedicine = async () => (await t.api("post", "/medicines", pharm.token).send({ brandName: `Brand${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "500 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 5 })).body.data as { id: string };
  const mkBatch = async (qty: number, o: Record<string, unknown> = {}, tok = pharm.token, medicineId?: string) => {
    const med = medicineId ?? (await mkMedicine()).id;
    const r = await t.api("post", "/pharmacy/batches", tok).set("Idempotency-Key", key()).send({ medicineId: med, batchNo: `B${uniqueWord(5)}`, expiryDate: ymd(365), mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.50", quantity: qty, ...o });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.data.id as string, medicineId: med };
  };
  const mkLoc = async (name = `Ward ${uniqueWord(5)} store`, tok = pharm.token) => {
    const r = await t.api("post", "/pharmacy/locations", tok).send({ name });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string; name: string; code: string; status: string; units: number };
  };
  const move = (from: string | null, to: string | null, items: { batchId: string; quantity: number }[], tok = pharm.token, k = key(), reason = "Stock for the ward") =>
    t.api("post", "/pharmacy/transfers", tok).set("Idempotency-Key", k).send({ fromLocationId: from, toLocationId: to, reason, items });
  const main = async (batchId: string) => (await t.prisma.stockBalance.findFirstOrThrow({ where: { batchId } })).quantity;
  const inLoc = async (locationId: string, batchId: string) => (await t.prisma.stockLocationBalance.findFirst({ where: { locationId, batchId } }))?.quantity ?? 0;
  const ledgerSum = async (locationId: string, batchId: string) => {
    const rows = await t.prisma.stockLocationLedger.findMany({ where: { locationId, batchId } });
    return rows.reduce((n, r) => n + (r.direction === "IN" ? r.quantity : -r.quantity), 0);
  };
  const mainReconciles = async (batchId: string) => (await t.api("get", `/pharmacy/batches/${batchId}/ledger`, pharm.token)).body.data.reconciliation.reconciles as boolean;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("stl-a");
    b = await t.makeTenant("stl-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]);
    nurse = await t.makeUser(a, ["NURSE"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    bPharm = await t.makeUser(b, ["PHARMACIST"]);
  });
  after(async () => { await t.close(); });

  describe("locations", () => {
    it("pharmacists create, rename and list locations; names and codes cannot repeat; others are refused", async () => {
      const l = await t.api("post", "/pharmacy/locations", pharm.token).send({ name: "Ward A store" });
      assert.equal(l.status, 201, JSON.stringify(l.body));
      assert.deepEqual([l.body.data.name, l.body.data.status, l.body.data.units, l.body.data.batches], ["Ward A store", "ACTIVE", 0, 0]);
      assert.match(l.body.data.code, /^[A-Z0-9-]{2,16}$/);
      assert.equal((await t.api("post", "/pharmacy/locations", pharm.token).send({ name: "WARD a STORE" })).status, 409, "the same name in other capitals");
      const coded = await t.api("post", "/pharmacy/locations", pharm.token).send({ name: "OT store", code: "ot-1" });
      assert.equal(coded.body.data.code, "OT-1", "the code is upper-cased");
      assert.equal((await t.api("post", "/pharmacy/locations", pharm.token).send({ name: "Another OT", code: "OT-1" })).status, 409, "the same code");
      for (const bad of [{ name: "x" }, { name: "" }, { name: "Valid name", code: "a b" }, { name: "Valid name", tenantId: b.tenantId }, { name: "Valid name", status: "INACTIVE" }, {}]) {
        assert.equal((await t.api("post", "/pharmacy/locations", pharm.token).send(bad)).status, 400, JSON.stringify(bad));
      }
      for (const [who, tok] of [["nurse", nurse.token], ["reception", rec.token], ["cashier", cashier.token]] as const) {
        assert.equal((await t.api("post", "/pharmacy/locations", tok).send({ name: `Nope ${who}` })).status, 403, who);
        assert.equal((await t.api("get", "/pharmacy/locations", tok)).status, 403, `${who} cannot list`);
      }
      assert.equal((await t.api("get", "/pharmacy/locations")).status, 401);
      const renamed = await t.api("put", `/pharmacy/locations/${l.body.data.id}`, pharm.token).send({ name: "Ward A pharmacy store" });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.data.name, "Ward A pharmacy store");
      assert.equal((await t.api("put", `/pharmacy/locations/${l.body.data.id}`, pharm.token).send({ name: "OT store" })).status, 409, "renaming onto another name");
      assert.equal((await t.api("put", `/pharmacy/locations/${l.body.data.id}`, pharm.token).send({})).status, 400, "nothing to change");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "STOCK_LOCATION_CREATED", entityId: l.body.data.id } }));
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "STOCK_LOCATION_UPDATED", entityId: l.body.data.id } }));
      const list = (await t.api("get", "/pharmacy/locations", pharm.token)).body.data as { id: string }[];
      assert.ok(list.some((x) => x.id === l.body.data.id));
    });

    it("another hospital sees none of them and cannot change them", async () => {
      const l = await mkLoc();
      assert.equal(((await t.api("get", "/pharmacy/locations", bPharm.token)).body.data as { id: string }[]).some((x) => x.id === l.id), false);
      assert.equal((await t.api("put", `/pharmacy/locations/${l.id}`, bPharm.token).send({ name: "Hijacked" })).status, 404);
      assert.equal((await t.api("get", `/pharmacy/locations/${l.id}/stock`, bPharm.token)).status, 404);
      assert.equal((await t.api("get", `/pharmacy/locations/${randomUUID()}/stock`, pharm.token)).status, 404);
      assert.equal((await t.api("get", "/pharmacy/locations/not-an-id/stock", pharm.token)).status, 404);
    });

    it("a location that still holds stock cannot be made inactive; an empty one can, and cannot receive stock until it is active again", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      assert.equal((await move(null, loc.id, [{ batchId: batch.id, quantity: 4 }])).status, 201);
      const refused = await t.api("put", `/pharmacy/locations/${loc.id}`, pharm.token).send({ status: "INACTIVE" });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, "LOCATION_HAS_STOCK");
      assert.equal((await move(loc.id, null, [{ batchId: batch.id, quantity: 4 }])).status, 201);
      assert.equal((await t.api("put", `/pharmacy/locations/${loc.id}`, pharm.token).send({ status: "INACTIVE" })).body.data.status, "INACTIVE");
      const closed = await move(null, loc.id, [{ batchId: batch.id, quantity: 1 }]);
      assert.equal(closed.status, 409, "an inactive location takes no stock");
      assert.match(closed.body.error.message, /not in use/);
      assert.equal((await t.api("put", `/pharmacy/locations/${loc.id}`, pharm.token).send({ status: "ACTIVE" })).body.data.status, "ACTIVE");
      assert.equal((await move(null, loc.id, [{ batchId: batch.id, quantity: 1 }])).status, 201);
    });
  });

  describe("transfers", () => {
    it("main store to a location, back again, and between two locations: stock is conserved, every movement is in a ledger, and both sides reconcile", async () => {
      const ward = await mkLoc(), ot = await mkLoc();
      const batch = await mkBatch(20);
      const out = await move(null, ward.id, [{ batchId: batch.id, quantity: 8 }], pharm.token, key(), "First stock for the ward");
      assert.equal(out.status, 201, JSON.stringify(out.body));
      const v = out.body.data as TransferView;
      assert.match(v.transferNumber, /^TRF-\d{4}-\d{6}$/);
      assert.deepEqual([v.from.name, v.from.id, v.to.id, v.units], ["Main store", null, ward.id, 8]);
      assert.deepEqual([await main(batch.id), await inLoc(ward.id, batch.id)], [12, 8]);
      const ml = await t.prisma.stockLedger.findFirstOrThrow({ where: { batchId: batch.id, type: "TRANSFER" } });
      assert.deepEqual([ml.direction, ml.quantity, ml.balanceAfter, ml.sourceType, ml.sourceId], ["OUT", 8, 12, "StockTransfer", v.id]);
      assert.match(ml.reason ?? "", /Main store to .* First stock for the ward/);
      assert.equal(ml.userId, pharm.id);
      assert.equal((await t.prisma.stockLocationLedger.findFirstOrThrow({ where: { locationId: ward.id, batchId: batch.id } })).transferId, v.id);

      assert.equal((await move(ward.id, ot.id, [{ batchId: batch.id, quantity: 3 }])).status, 201);
      assert.deepEqual([await inLoc(ward.id, batch.id), await inLoc(ot.id, batch.id), await main(batch.id)], [5, 3, 12], "location to location leaves the main store alone");
      assert.equal((await move(ot.id, null, [{ batchId: batch.id, quantity: 3 }])).status, 201);
      assert.equal((await move(ward.id, null, [{ batchId: batch.id, quantity: 5 }])).status, 201);
      assert.deepEqual([await main(batch.id), await inLoc(ward.id, batch.id), await inLoc(ot.id, batch.id)], [20, 0, 0], "everything is back");
      for (const l of [ward, ot]) assert.equal(await ledgerSum(l.id, batch.id), await inLoc(l.id, batch.id), "location ledger equals balance");
      assert.equal(await mainReconciles(batch.id), true);
      const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "STOCK_TRANSFERRED", entityId: v.id } });
      assert.deepEqual([(ev.metadata as Record<string, unknown>)["units"], (ev.metadata as Record<string, unknown>)["from"]], [8, "Main store"]);
    });

    it("a transfer can carry several batches; the location's stock view lists them soonest expiry first; the history lists the transfer for either place", async () => {
      const loc = await mkLoc();
      const m = await mkMedicine();
      const late = await mkBatch(10, { expiryDate: ymd(500) }, pharm.token, m.id);
      const soon = await mkBatch(10, { expiryDate: ymd(60) }, pharm.token, m.id);
      const r = await move(null, loc.id, [{ batchId: late.id, quantity: 6 }, { batchId: soon.id, quantity: 2 }]);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.items.length, 2);
      const stock = (await t.api("get", `/pharmacy/locations/${loc.id}/stock`, pharm.token)).body.data;
      assert.equal(stock.units, 8);
      assert.deepEqual(stock.items.map((i: { batchId: string; quantity: number }) => [i.batchId, i.quantity]), [[soon.id, 2], [late.id, 6]]);
      const hist = (await t.api("get", `/pharmacy/transfers?locationId=${loc.id}`, pharm.token)).body.data;
      assert.equal(hist.total, 1);
      assert.equal(hist.items[0].id, r.body.data.id);
      assert.equal(((await t.api("get", "/pharmacy/locations", pharm.token)).body.data as { id: string; units: number; batches: number }[]).find((x) => x.id === loc.id)?.units, 8);
      assert.equal((await t.api("get", "/pharmacy/transfers?pageSize=500", pharm.token)).status, 400);
    });

    it("refusals change nothing: not enough stock, same place, odd quantities, repeated batches, unknown batches, expired or blocked stock going out", async () => {
      const loc = await mkLoc(), other = await mkLoc();
      const batch = await mkBatch(10);
      const snapshot = async () => [await main(batch.id), await inLoc(loc.id, batch.id), await t.prisma.stockTransfer.count({ where: { tenantId: a.tenantId } })];
      const before = await snapshot();
      const over = await move(null, loc.id, [{ batchId: batch.id, quantity: 11 }]);
      assert.equal(over.status, 409);
      assert.equal(over.body.error.code, "INSUFFICIENT_STOCK");
      const overLoc = await move(loc.id, null, [{ batchId: batch.id, quantity: 1 }]);
      assert.equal(overLoc.status, 409, "nothing is held in the location yet");
      assert.equal(overLoc.body.error.code, "INSUFFICIENT_STOCK");
      assert.match(overLoc.body.error.message, /Only 0 units/);
      assert.equal((await move(null, null, [{ batchId: batch.id, quantity: 1 }])).status, 400, "from and to are both the main store");
      assert.equal((await move(loc.id, loc.id, [{ batchId: batch.id, quantity: 1 }])).status, 400, "the same location");
      for (const q of [0, -3, 1.5, 1_000_001]) assert.equal((await move(null, loc.id, [{ batchId: batch.id, quantity: q }])).status, 400, `quantity ${q}`);
      assert.equal((await move(null, loc.id, [{ batchId: batch.id, quantity: 1 }, { batchId: batch.id, quantity: 2 }])).status, 400, "a batch listed twice");
      assert.equal((await move(null, loc.id, [])).status, 400, "no items");
      assert.equal((await move(null, loc.id, [{ batchId: batch.id, quantity: 1 }], pharm.token, key(), "no")).status, 400, "a reason is needed");
      assert.equal((await t.api("post", "/pharmacy/transfers", pharm.token).set("Idempotency-Key", key()).send({ fromLocationId: null, toLocationId: loc.id, reason: "Stock", items: [{ batchId: batch.id, quantity: 1 }], extra: 1 })).status, 400, "unknown field");
      assert.equal((await move(null, loc.id, [{ batchId: randomUUID(), quantity: 1 }])).status, 404, "unknown batch");
      assert.equal((await move(null, randomUUID(), [{ batchId: batch.id, quantity: 1 }])).status, 404, "unknown location");
      assert.equal((await t.api("post", "/pharmacy/transfers", pharm.token).send({ fromLocationId: null, toLocationId: loc.id, reason: "Stock", items: [{ batchId: batch.id, quantity: 1 }] })).status, 400, "the Idempotency-Key header is required");
      // Blocked stock cannot go out to a location; a good batch after a failed item in the same transfer is not half moved.
      const other2 = await mkBatch(5);
      const mixed = await move(null, loc.id, [{ batchId: batch.id, quantity: 2 }, { batchId: other2.id, quantity: 6 }]);
      assert.equal(mixed.status, 409);
      assert.deepEqual(await snapshot(), before, "an all-or-nothing transfer: the first item was not moved");
      assert.equal((await t.api("post", `/pharmacy/batches/${batch.id}/block`, pharm.token).send({ reason: "Manufacturer recall notice" })).status, 200);
      const blocked = await move(null, loc.id, [{ batchId: batch.id, quantity: 1 }]);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /blocked/);
      assert.deepEqual(await snapshot(), before);
      await t.api("post", `/pharmacy/batches/${batch.id}/unblock`, pharm.token).send({});
      assert.equal((await move(null, other.id, [{ batchId: batch.id, quantity: 1 }])).status, 201, "after the recall is lifted it can move");
    });

    it("blocked stock already in a location can still be brought back to the main store, so it can be written off", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(6);
      assert.equal((await move(null, loc.id, [{ batchId: batch.id, quantity: 6 }])).status, 201);
      assert.equal((await t.api("post", `/pharmacy/batches/${batch.id}/block`, pharm.token).send({ reason: "Manufacturer recall notice" })).status, 200);
      assert.equal((await move(loc.id, null, [{ batchId: batch.id, quantity: 6 }])).status, 201);
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [6, 0]);
    });

    it("expired stock cannot be sent out to a location", async () => {
      const loc = await mkLoc();
      const m = await mkMedicine();
      const old = await t.prisma.medicineBatch.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchNo: `OLD${uniqueWord(4)}`, expiryDate: new Date(Date.now() - 5 * 86_400_000), mrp: 10, purchasePrice: 5, sellingPrice: 9 } });
      await t.prisma.$transaction(async (tx) => {
        await tx.stockBalance.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, batchId: old.id, medicineId: m.id, quantity: 4 } });
        await tx.stockLedger.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchId: old.id, type: "PURCHASE", direction: "IN", quantity: 4, balanceAfter: 4, userId: pharm.id } });
      });
      const r = await move(null, loc.id, [{ batchId: old.id, quantity: 2 }]);
      assert.equal(r.status, 409);
      assert.match(r.body.error.message, /expired/);
      assert.equal(await main(old.id), 4);
    });

    it("a repeated request with the same key moves the stock once; a different request with the same key is refused", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      const k = key();
      const first = await move(null, loc.id, [{ batchId: batch.id, quantity: 4 }], pharm.token, k);
      const again = await move(null, loc.id, [{ batchId: batch.id, quantity: 4 }], pharm.token, k);
      assert.equal(first.status, 201);
      assert.equal(again.status, 200);
      assert.equal(again.headers["idempotent-replayed"], "true");
      assert.equal(again.body.data.transferNumber, first.body.data.transferNumber);
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [6, 4]);
      const clash = await move(null, loc.id, [{ batchId: batch.id, quantity: 1 }], pharm.token, k);
      assert.ok([409, 422].includes(clash.status), `reusing a key for another request is refused (${clash.status})`);
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [6, 4]);
    });

    it("the main store keeps selling what it still has; stock sent to a location is not sold at the counter", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(5);
      const patient = await registerPatient(t, rec.token);
      assert.equal((await move(null, loc.id, [{ batchId: batch.id, quantity: 5 }])).status, 201);
      const none = await t.api("post", "/pharmacy/dispenses", pharm.token).set("Idempotency-Key", key()).send({ patientId: patient.id, items: [{ medicineId: batch.medicineId, quantity: 1 }] });
      assert.equal(none.status, 409);
      assert.equal(none.body.error.code, "INSUFFICIENT_STOCK");
      assert.equal((await move(loc.id, null, [{ batchId: batch.id, quantity: 3 }])).status, 201);
      const sold = await t.api("post", "/pharmacy/dispenses", pharm.token).set("Idempotency-Key", key()).send({ patientId: patient.id, items: [{ medicineId: batch.medicineId, quantity: 2 }] });
      assert.equal(sold.status, 201, JSON.stringify(sold.body));
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [1, 2]);
      assert.equal(await mainReconciles(batch.id), true);
    });
  });

  describe("safety", () => {
    it("only people who may adjust stock can move it; reading needs pharmacy access; another hospital cannot touch these batches or locations", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      for (const [who, tok] of [["nurse", nurse.token], ["reception", rec.token], ["cashier", cashier.token]] as const) {
        assert.equal((await move(null, loc.id, [{ batchId: batch.id, quantity: 1 }], tok)).status, 403, who);
        assert.equal((await t.api("get", "/pharmacy/transfers", tok)).status, 403, `${who} cannot read the history`);
      }
      assert.equal((await t.api("post", "/pharmacy/transfers").set("Idempotency-Key", key()).send({})).status, 401);
      assert.equal((await move(null, loc.id, [{ batchId: batch.id, quantity: 1 }], bPharm.token)).status, 404, "another hospital's location");
      const bLoc = await mkLoc(`Ward ${uniqueWord(5)} store`, bPharm.token);
      assert.equal((await move(null, bLoc.id, [{ batchId: batch.id, quantity: 1 }], bPharm.token)).status, 404, "another hospital's batch");
      assert.equal((await move(bLoc.id, loc.id, [{ batchId: batch.id, quantity: 1 }], bPharm.token)).status, 404);
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [10, 0]);
      const theirs = (await t.api("get", "/pharmacy/transfers", bPharm.token)).body.data;
      assert.equal(theirs.items.every((x: TransferView) => x.from.id === null || x.from.id === bLoc.id || x.to.id === bLoc.id), true);
    });

    it("DATABASE: transfers and location ledgers cannot be edited or deleted, stock cannot go below zero, a transfer needs two different places, and a balance must equal its ledger", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      const tr = (await move(null, loc.id, [{ batchId: batch.id, quantity: 4 }])).body.data as TransferView;
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "StockTransfer" SET reason = 'changed later' WHERE id = '${tr.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "StockTransfer" WHERE id = '${tr.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "StockTransferItem" WHERE "transferId" = '${tr.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "StockLocationLedger" SET quantity = 99 WHERE "transferId" = '${tr.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "StockLocationBalance" WHERE "locationId" = '${loc.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "StockLocation" WHERE id = '${loc.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "StockLocationBalance" SET quantity = -1 WHERE "locationId" = '${loc.id}'::uuid`), /stock_location_balance_nonneg|check constraint/i);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "StockLocationBalance" SET quantity = 9 WHERE "locationId" = '${loc.id}'::uuid`), /does not match the ledger/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "StockTransfer" ("tenantId", "facilityId", "transferNumber", reason, "createdById") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, 'TRF-BAD-1', 'Both main', '${pharm.id}'::uuid)`), /stock_transfer_places|check constraint/i);
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "StockTransfer" ("tenantId", "facilityId", "transferNumber", "fromLocationId", "toLocationId", reason, "createdById") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, 'TRF-BAD-2', '${loc.id}'::uuid, '${loc.id}'::uuid, 'Same place', '${pharm.id}'::uuid)`), /stock_transfer_places|check constraint/i);
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [6, 4], "none of the attempts changed stock");
    });

    it("concurrency: ten simultaneous transfers of the same stock never move more than there is, and never lose or double any", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(20);
      const results = await Promise.all(Array.from({ length: 10 }, () => move(null, loc.id, [{ batchId: batch.id, quantity: 3 }])));
      const ok = results.filter((r) => r.status === 201).length;
      const refused = results.filter((r) => r.status === 409);
      assert.equal(ok, 6, `six of three units fit into twenty (${results.map((r) => r.status).join(",")})`);
      assert.equal(refused.length, 4);
      assert.ok(refused.every((r) => r.body.error.code === "INSUFFICIENT_STOCK"));
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [2, 18]);
      assert.equal(await ledgerSum(loc.id, batch.id), 18);
      assert.equal(await mainReconciles(batch.id), true);
    });

    it("concurrency: transfers in opposite directions at the same moment do not deadlock and conserve the total", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      assert.equal((await move(null, loc.id, [{ batchId: batch.id, quantity: 5 }])).status, 201);
      const jobs = [
        ...Array.from({ length: 5 }, () => move(null, loc.id, [{ batchId: batch.id, quantity: 1 }])),
        ...Array.from({ length: 5 }, () => move(loc.id, null, [{ batchId: batch.id, quantity: 1 }])),
      ];
      const results = await Promise.all(jobs);
      assert.ok(results.every((r) => r.status === 201), results.map((r) => `${r.status}`).join(","));
      assert.equal((await main(batch.id)) + (await inLoc(loc.id, batch.id)), 10, "the total never changes");
      assert.equal(await ledgerSum(loc.id, batch.id), await inLoc(loc.id, batch.id));
      assert.equal(await mainReconciles(batch.id), true);
    });
  });

describe("reports", () => {
    it("the stock reports show what the locations hold beside the main store, including near-expiry stock in a ward store", async () => {
      const loc = await mkLoc();
      const med = (await t.api("post", "/medicines", pharm.token).send({ brandName: `Rep${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "250 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 25 })).body.data as { id: string };
      const batch = await mkBatch(20, { expiryDate: ymd(20) }, pharm.token, med.id);
      assert.equal((await move(null, loc.id, [{ batchId: batch.id, quantity: 6 }])).status, 201);
      const stock = await t.api("get", "/reports/pharmacy/stock", pharm.token);
      assert.equal(stock.status, 200, JSON.stringify(stock.body));
      const row = (stock.body.data.rows as { medicineId: string; quantity: number; inLocations: number; total: number; value: string; locationValue: string; reorderLevel: number }[]).find((r) => r.medicineId === med.id)!;
      assert.deepEqual([row.quantity, row.inLocations, row.total, row.value, row.locationValue], [14, 6, 20, "84.00", "36.00"], "14 in the main store at 6.00 each and 6 in the ward store");
      const low = await t.api("get", "/reports/pharmacy/low-stock", pharm.token);
      const lowRow = (low.body.data.rows as { medicineId: string; quantity: number; inLocations: number; total: number }[]).find((r) => r.medicineId === med.id)!;
      assert.deepEqual([lowRow.quantity, lowRow.inLocations, lowRow.total], [14, 6, 20], "low in the main store, with the ward store's stock shown beside it");
      const expiry = await t.api("get", "/reports/pharmacy/near-expiry?withinDays=30", pharm.token);
      assert.equal(expiry.status, 200, JSON.stringify(expiry.body));
      const mine = (expiry.body.data.rows as { batchId: string; place: string; quantity: number }[]).filter((r) => r.batchId === batch.id).map((r) => [r.place, r.quantity]).sort();
      assert.deepEqual(mine, [["Main store", 14], [loc.name, 6]].sort(), "the batch is listed for each place that holds it");
      for (const [who, tok] of [["nurse", nurse.token], ["reception", rec.token], ["cashier", cashier.token]] as const) {
        for (const path of ["stock", "low-stock", "near-expiry"]) assert.equal((await t.api("get", `/reports/pharmacy/${path}`, tok)).status, 403, `${who} ${path}`);
      }
      assert.equal((await move(loc.id, null, [{ batchId: batch.id, quantity: 6 }])).status, 201);
      const back = (await t.api("get", "/reports/pharmacy/stock", pharm.token)).body.data.rows.find((r: { medicineId: string }) => r.medicineId === med.id);
      assert.deepEqual([back.quantity, back.inLocations, back.total], [20, 0, 20]);
    });
  });
});
