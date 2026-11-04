import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const key = () => `k-${randomUUID().slice(0, 18)}`;

interface Voucher { id: string; payoutNumber: string; kind: string; gross: string; tdsPercent: string; tds: string; net: string; method: string; reversedBy: string | null; reverses: string | null }

describe("doctor payouts: vouchers, tax deducted at source, statements", () => {
  let t: TestApp;
  type World = { tenant: TestTenant; rec: { id: string; token: string }; cashier: { id: string; token: string }; manager: { id: string; token: string }; nurse: { id: string; token: string }; doc: TestDoctor };
  let other: TestTenant;

  const world = async (label: string, earned = "1000"): Promise<World & { earned: string }> => {
    const tenant = await t.makeTenant(label);
    const x = {
      tenant, rec: await t.makeUser(tenant, ["RECEPTIONIST"]), cashier: await t.makeUser(tenant, ["CASHIER"]), manager: await t.makeUser(tenant, ["MANAGER"]), nurse: await t.makeUser(tenant, ["NURSE"]), doc: await makeDoctor(t, tenant),
    };
    assert.equal((await t.api("post", "/shifts/open", x.cashier.token).send({ openingCash: "0" })).status, 201);
    assert.equal((await t.api("post", "/earnings/rules", tenant.admin.token).send({ mode: "PERCENT", percent: 40 })).status, 201);
    await earn(x, earned);
    return { ...x, earned };
  };
  /** A visit whose consultation bill is paid in full: the doctor earns 40% of it. */
  const earn = async (x: World, amount: string) => {
    const p = await registerPatient(t, x.rec.token);
    const v = await startVisit(t, x.rec.token, x.doc, p.id);
    const inv = await t.api("post", "/invoices", x.cashier.token).send({ patientId: p.id, encounterId: v.encounterId, kind: "OPD", lines: [{ description: "Consultation", unitPrice: amount, taxPercent: 0, quantity: 1 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal((await t.api("post", `/invoices/${inv.body.data.id}/issue`, x.cashier.token)).status, 200);
    assert.equal((await t.api("post", `/invoices/${inv.body.data.id}/payments`, x.cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount }] })).status, 201);
  };
  const pay = (x: World, body: Record<string, unknown>, tok = x.tenant.admin.token, k = key()) => t.api("post", "/earnings/payouts", tok).set("Idempotency-Key", k).send({ practitionerId: x.doc.practitionerId, method: "CASH", ...body });
  const reverse = (x: World, id: string, reason = "Paid to the wrong doctor", tok = x.tenant.admin.token, k = key()) => t.api("post", `/earnings/payouts/${id}/reverse`, tok).set("Idempotency-Key", k).send({ reason });
  const balance = async (x: World, tok = x.tenant.admin.token) => ((await t.api("get", "/earnings/payouts/balances", tok)).body.data.doctors as { practitionerId: string; earned: string; paid: string; owed: string; tdsDeducted: string; netPaid: string }[]).find((d) => d.practitionerId === x.doc.practitionerId);

  before(async () => {
    t = await startApp();
    other = await t.makeTenant("pay-other");
  });
  after(async () => { await t.close(); });

  it("what is owed is what the ledger earned less what was paid; each voucher has its number, tax deducted and net", async () => {
    const x = await world("pay-a1");
    assert.deepEqual(await balance(x), { practitionerId: x.doc.practitionerId, doctor: (await balance(x))!["doctor" as never], earned: "400.00", paid: "0.00", tdsDeducted: "0.00", netPaid: "0.00", owed: "400.00" });
    const first = await pay(x, { amount: "100" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const v1 = first.body.data as Voucher;
    assert.match(v1.payoutNumber, /^DPV-\d{4}-\d{6}$/);
    assert.deepEqual([v1.gross, v1.tdsPercent, v1.tds, v1.net, v1.kind], ["100.00", "0.00", "0.00", "100.00", "PAYMENT"]);
    const second = await pay(x, { amount: "200", tdsPercent: 10, method: "UPI", reference: "UPI-DOC-0001" });
    const v2 = second.body.data as Voucher;
    assert.deepEqual([v2.gross, v2.tdsPercent, v2.tds, v2.net], ["200.00", "10.00", "20.00", "180.00"]);
    assert.deepEqual(await balance(x), { ...(await balance(x))!, earned: "400.00", paid: "300.00", tdsDeducted: "20.00", netPaid: "280.00", owed: "100.00" });
    const over = await pay(x, { amount: "150" });
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, "PAYOUT_EXCEEDS_BALANCE");
    assert.equal((await balance(x))!.owed, "100.00", "a refused payout changes nothing");
    assert.equal((await pay(x, { amount: "100" })).status, 201, "exactly what is left");
    assert.equal((await balance(x))!.owed, "0.00");
    assert.equal((await pay(x, { amount: "0.01" })).status, 409, "nothing is owed any more");
    const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: x.tenant.tenantId, action: "DOCTOR_PAYOUT_PAID", entityId: v2.id } });
    assert.deepEqual([(ev.metadata as Record<string, unknown>)["gross"], (ev.metadata as Record<string, unknown>)["tds"], (ev.metadata as Record<string, unknown>)["net"]], ["200.00", "20.00", "180.00"]);
  });

  it("rounds tax to the paisa, and the hospital's default tax rate is used when none is given", async () => {
    const x = await world("pay-a2", "2500");
    assert.equal((await t.api("put", "/settings/DOCTOR_PAYOUT_TDS_PERCENT", x.tenant.admin.token).send({ value: 31 })).status, 400, "at most 30%");
    assert.equal((await t.api("put", "/settings/DOCTOR_PAYOUT_TDS_PERCENT", x.tenant.admin.token).send({ value: 10 })).status, 200);
    const a = (await pay(x, { amount: "333.33" })).body.data as Voucher;
    assert.deepEqual([a.tdsPercent, a.tds, a.net], ["10.00", "33.33", "300.00"], "10% of 333.33 is 33.333, rounded to 33.33");
    const b = (await pay(x, { amount: "100", tdsPercent: 0 })).body.data as Voucher;
    assert.deepEqual([b.tdsPercent, b.tds, b.net], ["0.00", "0.00", "100.00"], "the administrator can change it for one payout");
  });

  it("validates input; non-cash needs a reference; the doctor must be of this hospital", async () => {
    const x = await world("pay-a3");
    for (const bad of [{ amount: "0" }, { amount: "-5" }, { amount: "1.234" }, { amount: "abc" }, { amount: "10", tdsPercent: 31 }, { amount: "10", tdsPercent: -1 }, { amount: "10", tdsPercent: 10.123 }, { amount: "10", method: "BARTER" }, { amount: "10", extra: 1 }, { amount: "10", reference: "ab" }]) {
      assert.equal((await pay(x, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await pay(x, { amount: "10", method: "BANK_TRANSFER" })).status, 400, "a bank transfer needs a reference");
    assert.equal((await pay(x, { amount: "10", method: "BANK_TRANSFER", reference: "NEFT-778812" })).status, 201);
    assert.equal((await pay(x, { amount: "10", practitionerId: randomUUID() })).status, 404);
    const bDoc = await makeDoctor(t, other);
    assert.equal((await pay(x, { amount: "10", practitionerId: bDoc.practitionerId })).status, 404, "another hospital's doctor");
    assert.equal((await t.api("post", "/earnings/payouts", x.tenant.admin.token).send({ practitionerId: x.doc.practitionerId, method: "CASH", amount: "10" })).status, 400, "the Idempotency-Key header is required");
  });

  it("a repeated request with the same key gives the same voucher and pays once", async () => {
    const x = await world("pay-a4");
    const k = key();
    const first = await pay(x, { amount: "100" }, x.tenant.admin.token, k);
    const again = await pay(x, { amount: "100" }, x.tenant.admin.token, k);
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.headers["idempotent-replayed"], "true");
    assert.equal(again.body.data.payoutNumber, first.body.data.payoutNumber);
    assert.equal((await balance(x))!.paid, "100.00");
    assert.equal((await pay(x, { amount: "50" }, x.tenant.admin.token, k)).status, 422, "the same key for another request is refused");
  });

  it("only people with EARNINGS_CONFIGURE pay or reverse; finance and report staff read; reception, nurses and doctors see nothing but their own statement", async () => {
    const x = await world("pay-a5");
    const v = (await pay(x, { amount: "50" })).body.data as Voucher;
    for (const [who, tok] of [["cashier", x.cashier.token], ["manager", x.manager.token], ["reception", x.rec.token], ["nurse", x.nurse.token], ["doctor", x.doc.token]] as const) {
      assert.equal((await pay(x, { amount: "10" }, tok)).status, 403, `${who} cannot pay`);
      assert.equal((await reverse(x, v.id, "Some good reason here", tok)).status, 403, `${who} cannot reverse`);
    }
    for (const path of ["/earnings/payouts/balances", "/earnings/payouts", `/earnings/payouts/${v.id}`, `/earnings/statement?practitionerId=${x.doc.practitionerId}`]) {
      for (const [who, tok] of [["admin", x.tenant.admin.token], ["cashier", x.cashier.token], ["manager", x.manager.token]] as const) assert.equal((await t.api("get", path, tok)).status, 200, `${who} ${path}`);
      for (const [who, tok] of [["reception", x.rec.token], ["nurse", x.nurse.token], ["doctor", x.doc.token]] as const) assert.equal((await t.api("get", path, tok)).status, 403, `${who} ${path}`);
      assert.equal((await t.api("get", path)).status, 401, path);
    }
    assert.equal((await t.api("get", "/earnings/my-statement", x.doc.token)).status, 200);
    for (const [who, tok] of [["cashier", x.cashier.token], ["reception", x.rec.token], ["nurse", x.nurse.token]] as const) assert.equal((await t.api("get", "/earnings/my-statement", tok)).status, 403, `${who} has no doctor record`);
  });

  it("a payout made in error is undone with a mirror voucher; it can be undone once, and a reversal cannot be undone", async () => {
    const x = await world("pay-a6");
    const v = (await pay(x, { amount: "150", tdsPercent: 10 })).body.data as Voucher;
    assert.equal((await balance(x))!.owed, "250.00");
    assert.equal((await reverse(x, v.id, "no")).status, 400, "a reason of at least 5 characters");
    const r = await reverse(x, v.id);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rv = r.body.data as Voucher;
    assert.deepEqual([rv.kind, rv.gross, rv.tds, rv.net, rv.reverses], ["REVERSAL", "-150.00", "-15.00", "-135.00", v.payoutNumber]);
    assert.equal((await balance(x))!.owed, "400.00", "what is owed goes back up by the gross amount");
    assert.equal((await reverse(x, v.id)).status, 409, "already reversed");
    assert.equal((await reverse(x, rv.id)).status, 409, "a reversal cannot be reversed");
    assert.equal((await reverse(x, randomUUID())).status, 404);
    assert.equal((await reverse({ ...x, tenant: other }, v.id, "Not our payout at all", other.admin.token)).status, 404, "another hospital's voucher");
    const list = (await t.api("get", "/earnings/payouts", x.tenant.admin.token)).body.data;
    assert.equal(list.total, 2);
    assert.equal(list.items.find((i: Voucher) => i.id === v.id).reversedBy, rv.payoutNumber);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action: "DOCTOR_PAYOUT_REVERSED", entityId: rv.id } }));
  });

  it("the statement shows what was owed at the start, what was earned, each voucher with its tax, and what is owed at the end; a doctor sees only their own", async () => {
    const x = await world("pay-a7", "500");
    await pay(x, { amount: "120", tdsPercent: 10 });
    const s = (await t.api("get", `/earnings/statement?practitionerId=${x.doc.practitionerId}`, x.cashier.token)).body.data;
    assert.deepEqual([s.opening, s.earned, s.paid, s.tdsDeducted, s.netPaid, s.closing], ["0.00", "200.00", "120.00", "12.00", "108.00", "80.00"]);
    assert.deepEqual(s.entries.map((e: { type: string; amount: string }) => [e.type, e.amount]), [["EARNED", "200.00"], ["PAID", "-120.00"]]);
    const mine = (await t.api("get", "/earnings/my-statement", x.doc.token)).body.data;
    const listed = await t.api("get", "/reports/earnings/my-statement", x.doc.token);
    assert.equal(listed.status, 200, "the doctor finds it among the reports too");
    assert.deepEqual([listed.body.data.earned, listed.body.data.closing], [mine.earned, mine.closing]);
    assert.equal((await t.api("get", "/reports/earnings/my-statement", x.cashier.token)).status, 403);
    assert.deepEqual([mine.earned, mine.paid, mine.closing, mine.practitionerId], ["200.00", "120.00", "80.00", x.doc.practitionerId]);
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const later = (await t.api("get", `/earnings/statement?practitionerId=${x.doc.practitionerId}&from=${tomorrow}&to=${tomorrow}`, x.cashier.token)).body.data;
    assert.deepEqual([later.opening, later.earned, later.paid, later.closing, later.entries.length], ["80.00", "0.00", "0.00", "80.00", 0], "a later day opens with what was left");
    assert.equal((await t.api("get", `/earnings/statement?practitionerId=${x.doc.practitionerId}&from=2026-01-01&to=2027-12-31`, x.cashier.token)).status, 400, "at most a year");
    assert.equal((await t.api("get", `/earnings/statement?practitionerId=${x.doc.practitionerId}&from=2026-05-02&to=2026-05-01`, x.cashier.token)).status, 400);
    assert.equal((await t.api("get", `/earnings/statement?practitionerId=${randomUUID()}`, x.cashier.token)).status, 404);
    assert.equal((await t.api("get", `/earnings/statement?practitionerId=${x.doc.practitionerId}`, other.admin.token)).status, 404, "another hospital");
    assert.equal((await t.api("get", "/earnings/statement", x.cashier.token)).status, 400, "a doctor must be named");
  });

  it("a refund after a payout can leave a doctor owed less than zero; the payout still cannot exceed what is owed", async () => {
    const x = await world("pay-a8", "1000");
    assert.equal((await pay(x, { amount: "400" })).status, 201);
    assert.equal((await balance(x))!.owed, "0.00");
    assert.equal((await pay(x, { amount: "1" })).status, 409);
  });

  it("two payouts at the same moment cannot pay the same earnings twice", async () => {
    const x = await world("pay-a9", "1000");
    const [a, b] = await Promise.all([pay(x, { amount: "300" }), pay(x, { amount: "300" })]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409], JSON.stringify([a.body, b.body]));
    assert.equal((await balance(x))!.paid, "300.00");
    assert.equal((await balance(x))!.owed, "100.00");
  });

  it("DATABASE: vouchers cannot be edited or deleted, must add up, and a reversal must mirror its voucher", async () => {
    const x = await world("pay-a10");
    const v = (await pay(x, { amount: "100", tdsPercent: 10 })).body.data as Voucher;
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "DoctorPayout" SET "netAmount" = 1 WHERE id = '${v.id}'::uuid`), /append-only/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "DoctorPayout" WHERE id = '${v.id}'::uuid`), /append-only/);
    const base = `"tenantId", "facilityId", "practitionerId", "payoutNumber", method, "createdById"`;
    const vals = (n: string) => `'${x.tenant.tenantId}'::uuid, '${x.tenant.facilityId}'::uuid, '${x.doc.practitionerId}'::uuid, '${n}', 'CASH', '${x.tenant.admin.id}'::uuid`;
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "DoctorPayout" (${base}, kind, "grossAmount", "tdsPercent", "tdsAmount", "netAmount") VALUES (${vals("DPV-BAD-1")}, 'PAYMENT', 100, 10, 10, 95)`), /doctor_payout_amounts|check constraint/i);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "DoctorPayout" (${base}, kind, "grossAmount", "tdsPercent", "tdsAmount", "netAmount") VALUES (${vals("DPV-BAD-2")}, 'PAYMENT', -5, 0, 0, -5)`), /doctor_payout_amounts|check constraint/i);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "DoctorPayout" (${base}, kind, "reversesId", "grossAmount", "tdsPercent", "tdsAmount", "netAmount") VALUES (${vals("DPV-BAD-3")}, 'REVERSAL', '${v.id}'::uuid, -50, 10, -5, -45)`), /mirror one payment voucher/);
    const bDoc = await makeDoctor(t, other);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "DoctorPayout" ("tenantId", "facilityId", "practitionerId", "payoutNumber", method, "createdById", kind, "grossAmount", "tdsPercent", "tdsAmount", "netAmount") VALUES ('${x.tenant.tenantId}'::uuid, '${x.tenant.facilityId}'::uuid, '${bDoc.practitionerId}'::uuid, 'DPV-BAD-4', 'CASH', '${x.tenant.admin.id}'::uuid, 'PAYMENT', 10, 0, 0, 10)`), /same hospital and facility/);
    assert.equal((await balance(x))!.paid, "100.00", "none of the attempts changed the books");
  });

  it("the voucher prints with the doctor, the tax and the net; a reversal prints as a reversal; every print is audited", async () => {
    const x = await world("pay-a11");
    const v = (await pay(x, { amount: "200", tdsPercent: 10, note: "November share" })).body.data as Voucher;
    const html = await t.api("get", `/print/doctor-payouts/${v.id}`, x.cashier.token);
    assert.equal(html.status, 200, JSON.stringify(html.body));
    for (const text of [v.payoutNumber, "Doctor payout voucher", "Share paid", "Tax deducted at source (10.00%)", "200.00", "20.00", "180.00", "November share", "Received by the doctor"]) assert.ok(html.text.includes(text), `the voucher shows "${text}"`);
    const r = (await reverse(x, v.id)).body.data as Voucher;
    const rev = await t.api("get", `/print/doctor-payouts/${r.id}`, x.cashier.token);
    assert.match(rev.text, /REVERSAL OF DPV-/);
    assert.match(rev.text, /Payout reversal/);
    assert.equal((await t.api("get", `/print/doctor-payouts/${v.id}?format=pdf`, x.cashier.token).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); })).status, 200);
    assert.equal((await t.api("get", `/print/doctor-payouts/${v.id}`, x.rec.token)).status, 403);
    assert.equal((await t.api("get", `/print/doctor-payouts/${v.id}`, other.admin.token)).status, 404);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action: "DOCUMENT_PRINTED", entityId: v.id } }));
  });
});
