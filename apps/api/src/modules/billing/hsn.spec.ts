import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

const key = () => `k-${randomUUID().slice(0, 18)}`;
const ymd = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
let seq = 0;
const code = (p: string) => `${p}${(++seq).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`.slice(0, 14);

/**
 * HSN/SAC codes on invoice lines (spec gap G6). A code is copied onto each line when it is billed, so changing the master later never alters
 * an issued invoice. Whether the codes are right, and what else a GST invoice must show, is for the tax review (docs/reviews/pending-decisions.md).
 */
describe("HSN/SAC codes on invoices", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let cashier: { id: string; token: string };
  let rec: { id: string; token: string };
  let pharm: { id: string; token: string };

  const mkService = async (o: Record<string, unknown> = {}) => {
    const r = await t.api("post", "/services", a.admin.token).send({ code: code("SV"), name: `Procedure ${uniqueWord(5)}`, category: "PROCEDURE", price: "300.00", taxPercent: 0, availableFor: "BOTH", ...o });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string; name: string; sacCode: string | null };
  };
  const bill = async (patientId: string, serviceId: string) => {
    const d = await t.api("post", "/invoices", cashier.token).send({ patientId, lines: [{ serviceId, quantity: 1 }] });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const i = await t.api("post", `/invoices/${d.body.data.id}/issue`, cashier.token);
    assert.equal(i.status, 200, JSON.stringify(i.body));
    return i.body.data as { id: string; lines: { hsnSac: string | null }[] };
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("hsn-a");
    b = await t.makeTenant("hsn-b");
    cashier = await t.makeUser(a, ["CASHIER"]);
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]);
  });
  after(async () => { await t.close(); });

  it("the service price list holds an optional SAC/HSN code, validated and editable", async () => {
    const s = await mkService({ sacCode: "999311" });
    assert.equal(s.sacCode, "999311");
    assert.equal((await mkService()).sacCode, null, "optional");
    for (const bad of ["12", "123456789", "99-93-11", "ABCDEF", " "]) {
      assert.equal((await t.api("post", "/services", a.admin.token).send({ code: code("SV"), name: "Bad code", category: "OTHER", price: "10", sacCode: bad })).status, 400, `"${bad}"`);
    }
    const upd = await t.api("patch", `/services/${s.id}`, a.admin.token).send({ sacCode: "999312" });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.equal(upd.body.data.sacCode, "999312");
    assert.equal((await t.api("patch", `/services/${s.id}`, a.admin.token).send({ sacCode: null })).body.data.sacCode, null, "can be cleared");
    assert.equal((await t.api("patch", `/services/${s.id}`, a.admin.token).send({ sacCode: "1" })).status, 400);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Service" SET "sacCode" = 'abc' WHERE id = '${s.id}'::uuid`), /service_sac_format|check/i, "the database enforces the format too");
  });

  it("a billed line carries the code as it was at billing; changing the master later never alters an issued invoice", async () => {
    const s = await mkService({ sacCode: "999311" });
    const p = await registerPatient(t, rec.token);
    const inv = await bill(p.id, s.id);
    assert.deepEqual(inv.lines.map((l) => l.hsnSac), ["999311"]);
    assert.equal((await t.api("patch", `/services/${s.id}`, a.admin.token).send({ sacCode: "999399" })).status, 200);
    const again = (await t.api("get", `/invoices/${inv.id}`, cashier.token)).body.data;
    assert.deepEqual(again.lines.map((l: { hsnSac: string | null }) => l.hsnSac), ["999311"], "the issued invoice still shows the original code");
    const p2 = await registerPatient(t, rec.token);
    assert.deepEqual((await bill(p2.id, s.id)).lines.map((l) => l.hsnSac), ["999399"], "new invoices use the new code");
    await assert.rejects(t.prisma.invoiceLine.updateMany({ where: { invoiceId: inv.id }, data: { hsnSac: "111111" } }), /cannot be added, changed or removed/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "InvoiceLine" SET "hsnSac" = 'x' WHERE "invoiceId" = '${inv.id}'::uuid`), /cannot be added|invoice_line_hsn_format|check/i);
  });

  it("a line without a code stays without one, and free-price lines have none", async () => {
    const s = await mkService();
    const p = await registerPatient(t, rec.token);
    assert.deepEqual((await bill(p.id, s.id)).lines.map((l) => l.hsnSac), [null]);
    const d = await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, lines: [{ description: "Special request", unitPrice: "50.00", taxPercent: 0, quantity: 1 }] });
    assert.equal(d.status, 201);
    assert.deepEqual(d.body.data.lines.map((l: { hsnSac: string | null }) => l.hsnSac), [null]);
  });

  it("the printed invoice shows an HSN/SAC column only when a line has a code", async () => {
    const p = await registerPatient(t, rec.token);
    const withCode = await bill(p.id, (await mkService({ sacCode: "999311" })).id);
    const html = await t.api("get", `/print/invoices/${withCode.id}`, cashier.token);
    assert.equal(html.status, 200, html.text?.slice(0, 200));
    assert.ok(html.text.includes("HSN/SAC") && html.text.includes("999311"));
    const without = await bill(p.id, (await mkService()).id);
    assert.ok(!(await t.api("get", `/print/invoices/${without.id}`, cashier.token)).text.includes("HSN/SAC"), "nothing is printed that is not on file");
  });

  it("a pharmacy sale copies the medicine's HSN code onto its invoice line", async () => {
    const med = (await t.api("post", "/medicines", pharm.token).send({ brandName: `Hsn${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "10 mg", dosageForm: "TABLET", gstPercent: 12, hsnCode: "30049099", reorderLevel: 1 })).body.data as { id: string };
    const noHsn = (await t.api("post", "/medicines", pharm.token).send({ brandName: `Nohsn${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "10 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 1 })).body.data as { id: string };
    for (const m of [med, noHsn]) {
      const s = await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({ medicineId: m.id, batchNo: "H1", expiryDate: ymd(300), mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.00", quantity: 50 });
      assert.equal(s.status, 201, JSON.stringify(s.body));
    }
    const p = await registerPatient(t, rec.token);
    const sale = await t.api("post", "/pharmacy/dispenses", pharm.token).set("Idempotency-Key", key()).send({ patientId: p.id, items: [{ medicineId: med.id, quantity: 2 }, { medicineId: noHsn.id, quantity: 1 }] });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const inv = (await t.api("get", `/invoices/${sale.body.data.dispense.invoiceId}`, pharm.token)).body.data as { lines: { description: string; hsnSac: string | null }[] };
    assert.deepEqual(inv.lines.map((l) => l.hsnSac).sort((x, y) => String(x).localeCompare(String(y))), ["30049099", null].sort((x, y) => String(x).localeCompare(String(y))));
    assert.equal(inv.lines.find((l) => l.description.startsWith("Hsn"))!.hsnSac, "30049099");
  });

  it("another hospital's service codes are not reachable", async () => {
    const s = await mkService({ sacCode: "999311" });
    assert.equal((await t.api("patch", `/services/${s.id}`, b.admin.token).send({ sacCode: "999000" })).status, 404);
    assert.equal((await t.prisma.service.findFirstOrThrow({ where: { id: s.id } })).sacCode, "999311");
  });

  it("the MRP ceiling that guards selling prices is still in force (API and database)", async () => {
    const m = (await t.api("post", "/medicines", pharm.token).send({ brandName: `Mrp${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "5 mg", dosageForm: "TABLET", gstPercent: 5, reorderLevel: 1 })).body.data as { id: string };
    const over = await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({ medicineId: m.id, batchNo: "M1", expiryDate: ymd(100), mrp: "10.00", purchasePrice: "5.00", sellingPrice: "10.01", quantity: 5 });
    assert.equal(over.status, 400);
    await assert.rejects(t.prisma.medicineBatch.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, medicineId: m.id, batchNo: "M2", expiryDate: new Date(Date.now() + 86_400_000 * 30), mrp: 10, purchasePrice: 5, sellingPrice: 10.5 } }), /batch_prices|check/i);
  });
});
