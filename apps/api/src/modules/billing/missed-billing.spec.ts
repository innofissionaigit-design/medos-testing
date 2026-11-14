import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_ROLES } from "@medos/shared";
import { makeDoctor, makeUserWithPermissions, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
interface Item { key: string; type: string; amount: string | null; detail: string; patient: { id: string; name: string }; link: { kind: string; id: string }; review: { decision: string } | null }
interface Report { note: string; openCount: number; possibleMissedIncome: string; unpricedOpen: number; summary: { type: string; open: number; reviewed: number; openAmount: string }[]; items: Item[] }

const DAY = 86_400_000;

/** "Done but not billed": the flags are worked out from the real records, a billing person decides on each, and the decision is kept for good. */
describe("missed billing: possible missed income", () => {
  let t: TestApp; let a: TestTenant; let b: TestTenant;
  let rec: User; let cashier: User; let billing: User; let bBilling: User; let readOnly: User;
  let doc: TestDoctor;
  let patientId = ""; let patient2Id = ""; let patient3Id = ""; let patient4Id = "";
  const ids: Record<string, string> = {};

  const report = async (tok = billing.token, q: Record<string, string> = {}) => {
    const r = await t.api("get", "/billing/missed-income", tok).query(q);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data as Report;
  };
  const find = (r: Report, key: string) => r.items.find((i) => i.key === key);
  const review = (flagKey: string, decision: string, reason: string, tok = billing.token) => t.api("post", "/billing/missed-income/reviews", tok).send({ flagKey, decision, reason });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("missed-a"); b = await t.makeTenant("missed-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]); cashier = await t.makeUser(a, ["CASHIER"]); billing = await t.makeUser(a, ["BILLING"]); bBilling = await t.makeUser(b, ["BILLING"]);
    readOnly = await makeUserWithPermissions(t, a, ["MISSED_BILLING_READ"]);
    doc = await makeDoctor(t, a);
    patientId = (await registerPatient(t, rec.token)).id;
    patient2Id = (await registerPatient(t, rec.token)).id;
    patient3Id = (await registerPatient(t, rec.token)).id;
    patient4Id = (await registerPatient(t, rec.token)).id;
    const me = await t.prisma.user.findFirstOrThrow({ where: { id: billing.id } });
    const own = { tenantId: a.tenantId, facilityId: a.facilityId };

    // 1. a test advised three days ago and never billed, and one advised just now (still inside the waiting period)
    const v1 = await startVisit(t, rec.token, doc, patientId);
    const old = await t.prisma.testOrder.create({ data: { ...own, patientId, encounterId: v1.encounterId, category: "LABORATORY", name: "CBC", orderedById: me.id, createdAt: new Date(Date.now() - 3 * DAY) } });
    const fresh = await t.prisma.testOrder.create({ data: { ...own, patientId, encounterId: v1.encounterId, category: "LABORATORY", name: "ESR", orderedById: me.id } });
    ids["oldTest"] = old.id; ids["freshTest"] = fresh.id;

    // 2. a completed visit with no consultation fee, and one whose fee is on an issued bill
    const noFee = await startVisit(t, rec.token, doc, patient3Id);
    const withFee = await startVisit(t, rec.token, doc, patient2Id);
    const consult = await t.api("post", "/services", a.admin.token).send({ code: `CN${uniqueWord(4).toUpperCase()}`, name: `Consultation ${uniqueWord(4)}`, category: "CONSULTATION", price: "500.00", taxPercent: 0 });
    assert.equal(consult.status, 201, JSON.stringify(consult.body));
    const inv = await t.api("post", "/invoices", rec.token).send({ patientId: patient2Id, encounterId: withFee.encounterId, lines: [{ serviceId: consult.body.data.id, quantity: 1 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    await t.api("post", `/invoices/${inv.body.data.id}/issue`, rec.token);
    await t.prisma.encounter.updateMany({ where: { id: { in: [noFee.encounterId, withFee.encounterId] } }, data: { status: "COMPLETED", endedAt: new Date() } });
    ids["noFee"] = noFee.encounterId; ids["withFee"] = withFee.encounterId;

    // 3. medicine handed over with no bill
    const dispense = await t.prisma.dispense.create({ data: { ...own, patientId, dispenseNumber: `DSP-${uniqueWord(6)}`, subtotal: "114.00", taxTotal: "0.00", total: "114.00", dispensedById: me.id } });
    ids["dispense"] = dispense.id;

    // 4. an admission three days ago whose bed nights were never charged
    const ward = (await t.api("post", "/wards", a.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: `W${uniqueWord(4).toUpperCase()}` })).body.data as { id: string };
    const room = (await t.api("post", "/rooms", a.admin.token).send({ wardId: ward.id, name: `Room ${uniqueWord(3)}`, code: `R${uniqueWord(4).toUpperCase()}` })).body.data as { id: string };
    const bed = (await t.api("post", "/beds", a.admin.token).send({ roomId: room.id, code: `B${uniqueWord(4).toUpperCase()}`, dailyRate: "1000" })).body.data as { id: string };
    const adm = await t.api("post", "/admissions", rec.token).send({ patientId: patient4Id, consultantId: doc.practitionerId, bedId: bed.id, reason: "Pneumonia, needs IV antibiotics" });
    assert.equal(adm.status, 201, JSON.stringify(adm.body));
    ids["admission"] = adm.body.data.id;
    // An admission's start is fixed by the database, so to make this one three days old the test switches the table's own guards off for these two updates.
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Admission" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "BedAssignment" DISABLE TRIGGER USER'),
      t.prisma.$executeRaw`UPDATE "Admission" SET "admittedAt" = now() - interval '3 days' WHERE id = ${ids["admission"]!}::uuid`,
      t.prisma.$executeRaw`UPDATE "BedAssignment" SET "assignedAt" = now() - interval '3 days' WHERE "admissionId" = ${ids["admission"]!}::uuid`,
      t.prisma.$executeRawUnsafe('ALTER TABLE "Admission" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "BedAssignment" ENABLE TRIGGER USER'),
    ]);
  });
  after(async () => { await t.close(); });

  it("points out a test advised and never billed, but not one that is still inside the waiting period", async () => {
    const r = await report();
    const hit = find(r, `TEST_NOT_BILLED:${ids["oldTest"]}`);
    assert.ok(hit, "the old test is flagged");
    assert.match(hit.detail, /CBC/);
    assert.equal(hit.link.kind, "VISIT");
    assert.equal(find(r, `TEST_NOT_BILLED:${ids["freshTest"]}`), undefined, "advised a moment ago: the cashier has not had time to bill it");
    const soon = await report(billing.token, { graceHours: "0" });
    assert.ok(find(soon, `TEST_NOT_BILLED:${ids["freshTest"]}`), "with no waiting period it is flagged too");
  });

  it("points out a completed visit with no consultation fee, and leaves one whose fee is on a bill", async () => {
    const r = await report();
    assert.ok(find(r, `CONSULTATION_NO_FEE:${ids["noFee"]}`), "no fee on any bill");
    assert.equal(find(r, `CONSULTATION_NO_FEE:${ids["withFee"]}`), undefined, "the fee is on an issued bill");
  });

  it("points out medicine given out with no bill, with its amount", async () => {
    const hit = find(await report(), `MEDICINE_NOT_BILLED:${ids["dispense"]}`);
    assert.ok(hit);
    assert.equal(hit.amount, "114.00");
  });

  it("points out the nights a patient in the ward has no bed charge for, at the bed's rate, and not tonight", async () => {
    const r = await report();
    const nights = r.items.filter((i) => i.type === "BED_NIGHT_NOT_CHARGED" && i.link.id === ids["admission"]);
    assert.equal(nights.length, 3, "three days ago, two days ago and yesterday; today is not yet due");
    assert.ok(nights.every((n) => n.amount === "1000.00"));
    // Once the days are charged the flags go.
    const posted = await t.api("post", `/admissions/${ids["admission"]}/charges/bed-days`, rec.token);
    if (posted.status === 200 || posted.status === 201) {
      const after = await report();
      assert.equal(after.items.filter((i) => i.type === "BED_NIGHT_NOT_CHARGED" && i.link.id === ids["admission"]).length, 0, "charged nights are no longer flagged");
    }
  });

  it("totals the open flags, says 'possible missed income' and counts the flags with no amount", async () => {
    const r = await report();
    assert.match(r.note, /possible missed income/i);
    assert.doesNotMatch(r.note, /lost/i);
    assert.equal(r.summary.length, 7);
    assert.ok(r.openCount >= 3);
    assert.ok(Number(r.possibleMissedIncome) >= 114, "the unbilled dispense is in the total");
    assert.ok(r.unpricedOpen >= 1, "a consultation flag has no amount");
    const filtered = await report(billing.token, { type: "MEDICINE_NOT_BILLED" });
    assert.ok(filtered.items.every((i) => i.type === "MEDICINE_NOT_BILLED"));
  });

  it("a billing person decides on a flag: it leaves the open list, stays in the reviewed list, and is audited", async () => {
    const key = `CONSULTATION_NO_FEE:${ids["noFee"]}`;
    const done = await review(key, "NOT_A_GAP", "free follow-up visit");
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(find(await report(), key), undefined, "decided flags are not open");
    const seen = find(await report(billing.token, { status: "REVIEWED" }), key);
    assert.equal(seen?.review?.decision, "NOT_A_GAP");
    assert.equal(find(await report(billing.token, { status: "ALL" }), key)?.key, key);
    assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "MISSED_BILLING_REVIEWED", entityId: done.body.data.id } }), 1);
  });

  it("a flag is decided once, and the decision can never be changed or deleted", async () => {
    const key = `MEDICINE_NOT_BILLED:${ids["dispense"]}`;
    assert.equal((await review(key, "BILLED", "billed on INV-0001")).status, 201);
    assert.equal((await review(key, "NOT_A_GAP", "changed my mind")).status, 409, "the same flag again");
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "MissedBillingReview" SET "decision" = 'WAIVED' WHERE "flagKey" = ${key}`, "decisions are append-only");
    await assert.rejects(() => t.prisma.$executeRaw`DELETE FROM "MissedBillingReview" WHERE "flagKey" = ${key}`);
  });

  it("refuses nonsense: a made-up flag, a missing record, a short reason, a waiver without a real reason", async () => {
    assert.equal((await review("not-a-flag-at-all", "NOT_A_GAP", "fine")).status, 400);
    assert.equal((await review(`TEST_NOT_BILLED:${ids["oldTest"]}`, "MAYBE", "fine")).status, 400, "unknown decision");
    assert.equal((await review(`TEST_NOT_BILLED:${ids["oldTest"]}`, "NOT_A_GAP", "no")).status, 400, "reason too short");
    assert.equal((await review(`TEST_NOT_BILLED:${ids["oldTest"]}`, "WAIVED", "family")).status, 400, "a waiver needs ten characters");
    assert.equal((await review(`TEST_NOT_BILLED:${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`, "NOT_A_GAP", "not there")).status, 404, "no such record");
    assert.equal((await review(`CONSULTATION_NO_FEE:${ids["withFee"]}`, "NOT_A_GAP", "fee is on a bill")).status, 404, "a record that is not a gap cannot be marked");
    assert.equal((await t.api("post", "/billing/missed-income/reviews", billing.token).send({ flagKey: `TEST_NOT_BILLED:${ids["oldTest"]}`, decision: "BILLED", reason: "done", extra: 1 })).status, 400, "unknown fields are refused");
    assert.equal((await t.api("get", "/billing/missed-income", billing.token).query({ from: "2026-01-01", to: "2026-12-31" })).status, 400, "at most 92 days at a time");
    assert.equal((await t.api("get", "/billing/missed-income", billing.token).query({ type: "NOPE" })).status, 400);
  });

  it("only the billing desk, manager and administrator may look; only a reviewer may decide", async () => {
    assert.equal((await t.api("get", "/billing/missed-income", rec.token)).status, 403, "reception");
    assert.equal((await t.api("get", "/billing/missed-income", cashier.token)).status, 403, "cashier");
    assert.equal((await t.api("get", "/billing/missed-income")).status, 401);
    assert.equal((await t.api("get", "/billing/missed-income", a.admin.token)).status, 200, "administrator");
    assert.equal((await t.api("get", "/billing/missed-income", readOnly.token)).status, 200, "may look");
    assert.equal((await review(`TEST_NOT_BILLED:${ids["oldTest"]}`, "NOT_A_GAP", "just looking", readOnly.token)).status, 403, "may not decide");
    assert.equal((await review(`TEST_NOT_BILLED:${ids["oldTest"]}`, "NOT_A_GAP", "cashier tries", cashier.token)).status, 403);
  });

  it("the Billing role raises bills and reviews flags but does not take money", () => {
    const perms = SYSTEM_ROLES["BILLING"] ?? [];
    for (const p of ["MISSED_BILLING_READ", "MISSED_BILLING_REVIEW", "IPD_FINAL_BILL", "INVOICE_CREATE", "INVOICE_ISSUE"]) assert.ok(perms.includes(p as never), p);
    for (const p of ["PAYMENT_CREATE", "PAYMENT_REFUND", "CASHIER_SHIFT_MANAGE", "INVOICE_CANCEL", "INVOICE_DISCOUNT"]) assert.ok(!perms.includes(p as never), `Billing must not hold ${p}`);
    assert.ok(!(SYSTEM_ROLES["CASHIER"] ?? []).includes("MISSED_BILLING_REVIEW" as never), "the cashier does not review");
  });

  it("another hospital sees none of it and cannot decide on it", async () => {
    const theirs = await report(bBilling.token);
    assert.equal(theirs.openCount, 0);
    assert.equal(theirs.items.length, 0);
    for (const key of [`TEST_NOT_BILLED:${ids["oldTest"]}`, `BED_NIGHT_NOT_CHARGED:${ids["admission"]}:${new Date(Date.now() - DAY).toISOString().slice(0, 10)}`]) {
      assert.equal((await review(key, "NOT_A_GAP", "trying another hospital's flag", bBilling.token)).status, 404, key);
    }
    assert.equal(await t.prisma.missedBillingReview.count({ where: { tenantId: b.tenantId } }), 0, "nothing was written for the other hospital");
  });
});
