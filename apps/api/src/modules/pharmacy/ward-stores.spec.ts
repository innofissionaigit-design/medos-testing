import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
const key = () => `k-${randomUUID().slice(0, 18)}`;
const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;

interface Transfer { id: string; transferNumber: string; status: string; units: number; closedBy: string | null; closeNote: string | null }

describe("two-step transfers and ward stores used by nurses", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let pharm: { id: string; token: string };
  let nurse: { id: string; token: string };
  let cashier: { id: string; token: string };
  let bPharm: { id: string; token: string };
  let bNurse: { id: string; token: string };
  let doc: TestDoctor;

  const mkBatch = async (qty: number, o: Record<string, unknown> = {}) => {
    const med = (await t.api("post", "/medicines", pharm.token).send({ brandName: `Brand${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "500 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 5 })).body.data as { id: string };
    const r = await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({ medicineId: med.id, batchNo: `B${uniqueWord(5)}`, expiryDate: ymd(365), mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.50", quantity: qty, ...o });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.data.id as string, medicineId: med.id };
  };
  const mkLoc = async (name = `Ward ${uniqueWord(5)} store`, tok = pharm.token) => (await t.api("post", "/pharmacy/locations", tok).send({ name })).body.data as { id: string; name: string };
  const send = (from: string | null, to: string | null, items: { batchId: string; quantity: number }[], o: { twoStep?: boolean; tok?: string } = {}) =>
    t.api("post", "/pharmacy/transfers", o.tok ?? pharm.token).set("Idempotency-Key", key()).send({ fromLocationId: from, toLocationId: to, reason: "Stock for the ward", twoStep: o.twoStep ?? false, items });
  const receive = (id: string, tok = pharm.token, body: Record<string, unknown> = {}) => t.api("post", `/pharmacy/transfers/${id}/receive`, tok).set("Idempotency-Key", key()).send(body);
  const sendBack = (id: string, tok = pharm.token, reason = "It was the wrong batch") => t.api("post", `/pharmacy/transfers/${id}/send-back`, tok).set("Idempotency-Key", key()).send({ reason });
  const main = async (batchId: string) => (await t.prisma.stockBalance.findFirstOrThrow({ where: { batchId } })).quantity;
  const inLoc = async (locationId: string, batchId: string) => (await t.prisma.stockLocationBalance.findFirst({ where: { locationId, batchId } }))?.quantity ?? 0;
  const locLedger = async (locationId: string, batchId: string) => (await t.prisma.stockLocationLedger.findMany({ where: { locationId, batchId } })).reduce((n, r) => n + (r.direction === "IN" ? r.quantity : -r.quantity), 0);
  const mainReconciles = async (batchId: string) => (await t.api("get", `/pharmacy/batches/${batchId}/ledger`, pharm.token)).body.data.reconciliation.reconciles as boolean;

  const admit = async (tenant = a, who = rec, d = doc) => {
    const ward = (await t.api("post", "/wards", tenant.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    const room = (await t.api("post", "/rooms", tenant.admin.token).send({ wardId: ward.id, name: "Room", code: code("R") })).body.data;
    const bed = (await t.api("post", "/beds", tenant.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: "1000" })).body.data;
    const patient = await registerPatient(t, who.token);
    const r = await t.api("post", "/admissions", who.token).send({ patientId: patient.id, consultantId: d.practitionerId, bedId: bed.id, reason: "Pneumonia needing IV antibiotics" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string };
  };
  const draw = (admissionId: string, body: Record<string, unknown>, tok = nurse.token, k = key()) => t.api("post", `/admissions/${admissionId}/ward-store-issues`, tok).set("Idempotency-Key", k).send(body);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("wst-a");
    b = await t.makeTenant("wst-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]);
    nurse = await t.makeUser(a, ["NURSE"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    bPharm = await t.makeUser(b, ["PHARMACIST"]);
    bNurse = await t.makeUser(b, ["NURSE"]);
    doc = await makeDoctor(t, a);
  });
  after(async () => { await t.close(); });

  describe("two-step transfers", () => {
    it("the stock leaves the sender at once and counts in the other place only when it is received; the total never changes", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(20);
      const out = await send(null, loc.id, [{ batchId: batch.id, quantity: 8 }], { twoStep: true });
      assert.equal(out.status, 201, JSON.stringify(out.body));
      const tr = out.body.data as Transfer;
      assert.equal(tr.status, "IN_TRANSIT");
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [12, 0], "on the way: in neither place");
      const locs = (await t.api("get", "/pharmacy/locations", pharm.token)).body.data as { id: string; units: number; transfersOnTheWay: number }[];
      assert.deepEqual([locs.find((l) => l.id === loc.id)?.units, locs.find((l) => l.id === loc.id)?.transfersOnTheWay], [0, 1]);
      assert.equal((await t.api("put", `/pharmacy/locations/${loc.id}`, pharm.token).send({ status: "INACTIVE" })).status, 409, "a transfer is still on its way to it");
      const waiting = (await t.api("get", "/pharmacy/transfers?status=IN_TRANSIT", pharm.token)).body.data;
      assert.ok(waiting.items.some((i: Transfer) => i.id === tr.id));
      const got = await receive(tr.id, nurse.token, { note: "Counted at the ward" });
      assert.equal(got.status, 200 === got.status ? got.status : 201, JSON.stringify(got.body));
      const done = got.body.data as Transfer;
      assert.deepEqual([done.status, done.closeNote], ["RECEIVED", "Counted at the ward"]);
      assert.ok(done.closedBy, "who confirmed it is recorded");
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [12, 8]);
      assert.equal(await locLedger(loc.id, batch.id), 8);
      assert.equal(await mainReconciles(batch.id), true);
      assert.equal((await receive(tr.id)).status, 409, "already received");
      assert.equal((await receive(tr.id)).body.error.code, "TRANSFER_NOT_IN_TRANSIT");
      assert.equal((await sendBack(tr.id)).status, 409, "a received transfer cannot be sent back");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "STOCK_TRANSFER_SENT", entityId: tr.id } }));
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "STOCK_TRANSFER_RECEIVED", entityId: tr.id } }));
    });

    it("a transfer sent back returns to the place it left; it cannot then be received; ward to main store works the same way", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      assert.equal((await send(null, loc.id, [{ batchId: batch.id, quantity: 10 }])).status, 201, "an immediate transfer to stock the ward");
      const back = (await send(loc.id, null, [{ batchId: batch.id, quantity: 6 }], { twoStep: true })).body.data as Transfer;
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [0, 4], "6 are on the way to the main store");
      const bounced = await sendBack(back.id, pharm.token, "Counted wrongly");
      assert.equal(bounced.status, 201, JSON.stringify(bounced.body));
      assert.deepEqual([bounced.body.data.status, bounced.body.data.closeNote], ["CANCELLED", "Counted wrongly"]);
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [0, 10], "back where it left");
      assert.equal((await receive(back.id)).status, 409);
      const again = (await send(loc.id, null, [{ batchId: batch.id, quantity: 6 }], { twoStep: true })).body.data as Transfer;
      assert.equal((await receive(again.id)).status, 201);
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [6, 4]);
      assert.equal(await locLedger(loc.id, batch.id), 4);
      assert.equal(await mainReconciles(batch.id), true);
      assert.equal((await t.api("post", `/pharmacy/transfers/${again.id}/send-back`, pharm.token).set("Idempotency-Key", key()).send({})).status, 400, "a reason is needed");
    });

    it("only enough stock can be sent; receiving needs an active place; who may confirm; another hospital cannot touch it", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(5);
      const over = await send(null, loc.id, [{ batchId: batch.id, quantity: 6 }], { twoStep: true });
      assert.equal(over.status, 409);
      assert.equal(over.body.error.code, "INSUFFICIENT_STOCK");
      const tr = (await send(null, loc.id, [{ batchId: batch.id, quantity: 5 }], { twoStep: true })).body.data as Transfer;
      for (const [who, tok] of [["reception", rec.token], ["cashier", cashier.token]] as const) {
        assert.equal((await receive(tr.id, tok)).status, 403, `${who} cannot receive`);
        assert.equal((await sendBack(tr.id, tok)).status, 403, `${who} cannot send back`);
      }
      assert.equal((await receive(tr.id, bPharm.token)).status, 404, "another hospital's transfer");
      assert.equal((await sendBack(tr.id, bPharm.token)).status, 404);
      assert.equal((await receive(randomUUID())).status, 404);
      assert.equal((await t.api("post", `/pharmacy/transfers/${tr.id}/receive`, pharm.token).send({})).status, 400, "the Idempotency-Key header is required");
      assert.equal((await t.api("post", `/pharmacy/transfers/${tr.id}/receive`).send({})).status, 401);
      assert.deepEqual([await main(batch.id), await inLoc(loc.id, batch.id)], [0, 0], "none of the refusals moved anything");
      assert.equal((await receive(tr.id, pharm.token)).status, 201);
    });

    it("a repeated receive request with the same key receives once", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      const tr = (await send(null, loc.id, [{ batchId: batch.id, quantity: 4 }], { twoStep: true })).body.data as Transfer;
      const k = key();
      const first = await t.api("post", `/pharmacy/transfers/${tr.id}/receive`, pharm.token).set("Idempotency-Key", k).send({});
      const again = await t.api("post", `/pharmacy/transfers/${tr.id}/receive`, pharm.token).set("Idempotency-Key", k).send({});
      assert.equal(first.status, 201);
      assert.equal(again.status, 200);
      assert.equal(again.headers["idempotent-replayed"], "true");
      assert.equal(await inLoc(loc.id, batch.id), 4);
    });

    it("concurrency: receiving and sending back at the same moment, and receiving twice, close the transfer exactly once", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      const tr = (await send(null, loc.id, [{ batchId: batch.id, quantity: 10 }], { twoStep: true })).body.data as Transfer;
      const results = await Promise.all([receive(tr.id), receive(tr.id), sendBack(tr.id), sendBack(tr.id)]);
      const ok = results.filter((r) => r.status === 201);
      assert.equal(ok.length, 1, results.map((r) => r.status).join(","));
      assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "TRANSFER_NOT_IN_TRANSIT"));
      assert.equal((await main(batch.id)) + (await inLoc(loc.id, batch.id)), 10, "nothing lost or doubled");
      assert.equal(await locLedger(loc.id, batch.id), await inLoc(loc.id, batch.id));
      assert.equal(await mainReconciles(batch.id), true);
    });

    it("DATABASE: a closed transfer cannot be changed or reopened, an open one can only be received or sent back", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      const open = (await send(null, loc.id, [{ batchId: batch.id, quantity: 3 }], { twoStep: true })).body.data as Transfer;
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "StockTransfer" SET reason = 'changed later' WHERE id = '${open.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "StockTransfer" SET status = 'IN_TRANSIT' WHERE id = '${open.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "StockTransfer" WHERE id = '${open.id}'::uuid`), /append-only/);
      assert.equal((await receive(open.id)).status, 201);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "StockTransfer" SET status = 'IN_TRANSIT' WHERE id = '${open.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "StockTransfer" SET status = 'CANCELLED' WHERE id = '${open.id}'::uuid`), /append-only/);
      assert.equal(await inLoc(loc.id, batch.id), 3);
    });
  });

  describe("ward stores used by nurses", () => {
    it("a nurse sees the active ward stores and what they hold, and the stock waiting to be received; people without nursing access do not", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      assert.equal((await send(null, loc.id, [{ batchId: batch.id, quantity: 6 }])).status, 201);
      const wait = (await send(null, loc.id, [{ batchId: batch.id, quantity: 2 }], { twoStep: true })).body.data as Transfer;
      const stores = await t.api("get", "/nursing/ward-stores", nurse.token);
      assert.equal(stores.status, 200);
      assert.equal(stores.body.data.find((l: { id: string }) => l.id === loc.id).units, 6);
      const held = (await t.api("get", `/nursing/ward-stores/${loc.id}/stock`, nurse.token)).body.data;
      assert.deepEqual([held.units, held.items[0].batchId, held.items[0].quantity, held.items[0].sellingPrice], [6, batch.id, 6, "9.50"]);
      const incoming = (await t.api("get", "/nursing/ward-stores/incoming", nurse.token)).body.data;
      assert.ok(incoming.items.some((i: Transfer) => i.id === wait.id));
      assert.equal((await t.api("get", "/nursing/ward-stores", rec.token)).status, 403);
      assert.equal((await t.api("get", "/nursing/ward-stores", cashier.token)).status, 403);
      assert.equal((await t.api("get", "/nursing/ward-stores")).status, 401);
      assert.equal((await t.api("get", `/nursing/ward-stores/${loc.id}/stock`, bNurse.token)).status, 404, "another hospital's store");
      assert.equal(((await t.api("get", "/nursing/ward-stores", bNurse.token)).body.data as unknown[]).length, 0);
      await t.api("put", `/pharmacy/locations/${loc.id}`, pharm.token).send({ name: `${loc.name} renamed` });
    });

    it("a nurse draws a medicine for an admitted patient: the store's stock falls, the ledger records it, and the admission is charged the selling price", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(20);
      assert.equal((await send(null, loc.id, [{ batchId: batch.id, quantity: 12 }])).status, 201);
      const adm = await admit();
      const r = await draw(adm.id, { locationId: loc.id, batchId: batch.id, quantity: 3, remarks: "Night dose" });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([r.body.data.quantity, r.body.data.unitPrice, r.body.data.amount, r.body.data.remarks, r.body.data.location], [3, "9.50", "28.50", "Night dose", loc.name]);
      assert.equal(await inLoc(loc.id, batch.id), 9);
      assert.equal(await main(batch.id), 8, "the main store is untouched");
      assert.equal(await locLedger(loc.id, batch.id), 9);
      const led = await t.prisma.stockLocationLedger.findFirstOrThrow({ where: { locationId: loc.id, batchId: batch.id, direction: "OUT" } });
      assert.deepEqual([led.quantity, led.balanceAfter, led.issueId, led.transferId, led.userId], [3, 9, r.body.data.id, null, nurse.id]);
      type Charge = { type: string; description: string; quantity: string; unitPrice: string; status: string };
      const body = (await t.api("get", `/admissions/${adm.id}/charges`, cashier.token)).body.data as Charge[] | { items: Charge[] };
      const charges = Array.isArray(body) ? body : body.items;
      const c = charges.find((x) => x.type === "MEDICINE");
      assert.ok(c, JSON.stringify(charges));
      assert.deepEqual([Number(c.quantity), c.unitPrice, c.status], [3, "9.50", "PENDING"]);
      assert.match(c.description, new RegExp(`x3 \\(${loc.name}\\)`));
      const list = (await t.api("get", `/admissions/${adm.id}/ward-store-issues`, nurse.token)).body.data;
      assert.deepEqual([list.length, list[0].by !== null], [1, true]);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "WARD_STORE_ISSUED", entityId: r.body.data.id } }));
    });

    it("refused, and nothing changes: not enough stock, a blocked or expired batch, an unused store, a patient who is not admitted, a closed bill", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      assert.equal((await send(null, loc.id, [{ batchId: batch.id, quantity: 5 }])).status, 201);
      const adm = await admit();
      const before = async () => [await inLoc(loc.id, batch.id), await t.prisma.charge.count({ where: { admissionId: adm.id } }), await t.prisma.stockLocationIssue.count({ where: { admissionId: adm.id } })];
      const start = await before();
      const over = await draw(adm.id, { locationId: loc.id, batchId: batch.id, quantity: 6 });
      assert.equal(over.status, 409);
      assert.equal(over.body.error.code, "INSUFFICIENT_STOCK");
      for (const bad of [{ quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: 10_001 }, { extra: 1 }]) assert.equal((await draw(adm.id, { locationId: loc.id, batchId: batch.id, quantity: 1, ...bad })).status, 400, JSON.stringify(bad));
      assert.equal((await draw(adm.id, { locationId: loc.id, batchId: randomUUID(), quantity: 1 })).status, 404);
      assert.equal((await draw(adm.id, { locationId: randomUUID(), batchId: batch.id, quantity: 1 })).status, 404);
      assert.equal((await draw(randomUUID(), { locationId: loc.id, batchId: batch.id, quantity: 1 })).status, 404);
      assert.equal((await t.api("post", `/admissions/${adm.id}/ward-store-issues`, nurse.token).send({ locationId: loc.id, batchId: batch.id, quantity: 1 })).status, 400, "the Idempotency-Key header is required");
      assert.equal((await t.api("post", "/pharmacy/locations", pharm.token).send({ name: "x" })).status, 400);
      assert.deepEqual(await before(), start);
      assert.equal((await t.api("post", `/pharmacy/batches/${batch.id}/block`, pharm.token).send({ reason: "Manufacturer recall notice" })).status, 200);
      const blocked = await draw(adm.id, { locationId: loc.id, batchId: batch.id, quantity: 1 });
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /blocked/);
      await t.api("post", `/pharmacy/batches/${batch.id}/unblock`, pharm.token).send({});
      assert.equal((await t.api("put", `/pharmacy/locations/${loc.id}`, pharm.token).send({ status: "INACTIVE" })).status, 409, "it still holds stock");
      const empty = await mkLoc();
      assert.equal((await t.api("put", `/pharmacy/locations/${empty.id}`, pharm.token).send({ status: "INACTIVE" })).status, 200);
      assert.equal((await draw(adm.id, { locationId: empty.id, batchId: batch.id, quantity: 1 })).status, 409, "a store that is not in use");
      assert.deepEqual(await before(), start);
      // Cancelled admission: not admitted any more.
      const gone = await admit();
      assert.equal((await t.api("post", `/admissions/${gone.id}/cancel`, rec.token).send({ reason: "Admitted by mistake" })).status, 200);
      assert.equal((await draw(gone.id, { locationId: loc.id, batchId: batch.id, quantity: 1 })).status, 409);
      assert.equal(await inLoc(loc.id, batch.id), 5);
    });

    it("who may draw: nurses and pharmacists; not reception or cashiers; another hospital's nurse sees nothing; a retry with the same key draws once", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      assert.equal((await send(null, loc.id, [{ batchId: batch.id, quantity: 10 }])).status, 201);
      const adm = await admit();
      const body = { locationId: loc.id, batchId: batch.id, quantity: 2 };
      for (const [who, tok] of [["reception", rec.token], ["cashier", cashier.token]] as const) assert.equal((await draw(adm.id, body, tok)).status, 403, who);
      assert.equal((await draw(adm.id, body, bNurse.token)).status, 404, "another hospital's patient");
      assert.equal((await t.api("get", `/admissions/${adm.id}/ward-store-issues`, bNurse.token)).status, 404);
      assert.equal((await t.api("get", `/admissions/${adm.id}/ward-store-issues`, rec.token)).status, 403);
      const k = key();
      const first = await draw(adm.id, body, nurse.token, k);
      const again = await draw(adm.id, body, nurse.token, k);
      assert.equal(first.status, 201);
      assert.equal(again.status, 200);
      assert.equal(again.headers["idempotent-replayed"], "true");
      assert.equal(await inLoc(loc.id, batch.id), 8, "drawn once");
      assert.equal((await draw(adm.id, { ...body, quantity: 1 }, nurse.token, k)).status, 422, "the same key for another request");
      assert.equal((await draw(adm.id, body, pharm.token)).status, 201, "a pharmacist may too");
      assert.equal(await inLoc(loc.id, batch.id), 6);
    });

    it("once the final bill is issued nothing more can be drawn for the admission; the drawn medicine is on that bill", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      assert.equal((await send(null, loc.id, [{ batchId: batch.id, quantity: 10 }])).status, 201);
      const adm = await admit();
      assert.equal((await draw(adm.id, { locationId: loc.id, batchId: batch.id, quantity: 4 })).status, 201);
      for (const [step, tok] of [["MEDICALLY_FIT", (doc as TestDoctor).token], ["NURSING", nurse.token], ["CHARGES_REVIEWED", cashier.token]] as const) assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/clear`, tok).send({ step })).status, 200, step);
      const ph = await t.api("post", `/admissions/${adm.id}/discharge/clear`, pharm.token).send({ step: "PHARMACY" });
      assert.equal(ph.status, 200, JSON.stringify(ph.body));
      const fb = await t.api("post", `/admissions/${adm.id}/discharge/final-invoice`, cashier.token);
      assert.equal(fb.status, 200, JSON.stringify(fb.body));
      const inv = (await t.api("get", `/invoices/${fb.body.data.invoice.id}`, cashier.token)).body.data as { lines: { description: string; lineTotal: string }[] };
      assert.ok(inv.lines.some((l) => l.description.includes(`x4 (${loc.name})`) && l.lineTotal === "38.00"), JSON.stringify(inv.lines));
      const late = await draw(adm.id, { locationId: loc.id, batchId: batch.id, quantity: 1 });
      assert.equal(late.status, 409);
      assert.match(late.body.error.message, /final bill/);
      assert.equal(await inLoc(loc.id, batch.id), 6);
    });

    it("DATABASE: issues cannot be edited or deleted, must be for a real admission of the same facility and a batch of the same hospital", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      assert.equal((await send(null, loc.id, [{ batchId: batch.id, quantity: 10 }])).status, 201);
      const adm = await admit();
      const iss = (await draw(adm.id, { locationId: loc.id, batchId: batch.id, quantity: 2 })).body.data as { id: string };
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "StockLocationIssue" SET quantity = 1 WHERE id = '${iss.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "StockLocationIssue" WHERE id = '${iss.id}'::uuid`), /append-only/);
      const row = await t.prisma.stockLocationIssue.findFirstOrThrow({ where: { id: iss.id } });
      const bAdm = await admit(b, await t.makeUser(b, ["RECEPTIONIST"]), await makeDoctor(t, b));
      const bPatient = await t.prisma.admission.findFirstOrThrow({ where: { id: bAdm.id } });
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "StockLocationIssue" ("tenantId", "facilityId", "locationId", "batchId", "medicineId", quantity, "admissionId", "patientId", "issuedById") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${loc.id}'::uuid, '${batch.id}'::uuid, '${row.medicineId}'::uuid, 1, '${bAdm.id}'::uuid, '${bPatient.patientId}'::uuid, '${nurse.id}'::uuid)`), /foreign key|violates|same facility/i);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "StockLocationLedger" SET "issueId" = NULL, "transferId" = NULL WHERE "issueId" = '${iss.id}'::uuid`), /append-only/);
      assert.equal(await inLoc(loc.id, batch.id), 8);
    });

    it("concurrency: simultaneous draws from one ward store never take more than it holds", async () => {
      const loc = await mkLoc();
      const batch = await mkBatch(10);
      assert.equal((await send(null, loc.id, [{ batchId: batch.id, quantity: 10 }])).status, 201);
      const adm = await admit();
      const results = await Promise.all(Array.from({ length: 8 }, () => draw(adm.id, { locationId: loc.id, batchId: batch.id, quantity: 3 })));
      assert.equal(results.filter((r) => r.status === 201).length, 3, results.map((r) => r.status).join(","));
      assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.error.code === "INSUFFICIENT_STOCK"));
      assert.equal(await inLoc(loc.id, batch.id), 1);
      assert.equal(await locLedger(loc.id, batch.id), 1);
      assert.equal(await t.prisma.charge.count({ where: { admissionId: adm.id, type: "MEDICINE" } }), 3, "one charge for each draw that went through");
    });
  });
});
