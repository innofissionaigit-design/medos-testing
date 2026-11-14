import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
const key = () => `k-${randomUUID().slice(0, 18)}`;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** Insurance money (docs/insurance-money.md), on the real database. */
describe("insurance money: top-up, packages, cuts, payments, write-offs, estimate, reports", () => {
  let t: TestApp;
  let a: TestTenant; let b: TestTenant;
  let officer: User; let cashier: User; let rec: User; let nurse: User; let manager: User; let both: User; let bOfficer: User;
  let insA: { id: string; name: string }; let insB: { id: string; name: string };

  const post = (path: string, body: Record<string, unknown> = {}, tok = officer.token) => t.api("post", path, tok).send(body);
  const get = (path: string, tok = officer.token) => t.api("get", path, tok);
  const mkInsurer = async (name = `Ins ${uniqueWord(6)}`) => { const r = await post("/claims/insurers", { name, kind: "INSURER" }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data as { id: string; name: string }; };
  const policy = (patientId: string, insurerId: string, over: Record<string, unknown> = {}, tok = officer.token) =>
    t.api("post", `/patients/${patientId}/policies`, tok).send({ insurerId, policyNumber: `POL-${uniqueWord(6)}`, validFrom: iso(-30), validTo: iso(300), sumInsured: "500000", ...over });
  const issued = async (patientId: string, total = "10000", lines?: { description: string; unitPrice: string }[]) => {
    const d = await t.api("post", "/invoices", cashier.token).send({ patientId, lines: (lines ?? [{ description: "Procedure", unitPrice: total }]).map((l) => ({ ...l, taxPercent: 0, quantity: 1 })) });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.equal((await t.api("post", `/invoices/${d.body.data.id}/issue`, cashier.token)).status, 200);
    return d.body.data.id as string;
  };
  /** A patient with a main policy, and an issued invoice. */
  const patientWithMain = async (insurerId = insA.id, total = "10000", over: Record<string, unknown> = {}) => {
    const patient = await registerPatient(t, rec.token);
    const pol = await policy(patient.id, insurerId, over);
    assert.equal(pol.status, 201, JSON.stringify(pol.body));
    return { patient, policyId: pol.body.data.id as string, invoiceId: await issued(patient.id, total) };
  };
  const claimOf = async (p: { patient: { id: string }; policyId: string }, type = "REIMBURSEMENT") => {
    const c = await post("/claims", { patientId: p.patient.id, policyId: p.policyId, type, diagnosis: "Appendicitis" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    return c.body.data.id as string;
  };
  /** A claim on the insurer, submitted for `claimed` and approved for `approved`, on its own invoice of `total`. */
  const approvedClaim = async (insurerId: string, claimed: string, approvedAmt: string, total = "10000") => {
    const p = await patientWithMain(insurerId, total);
    const claimId = await claimOf(p);
    assert.equal((await post(`/claims/${claimId}/submit`, { invoiceId: p.invoiceId, claimedAmount: claimed })).status, 200);
    assert.equal((await post(`/claims/${claimId}/decision`, { decision: "APPROVE", approvedAmount: approvedAmt })).status, 200);
    return { ...p, claimId };
  };
  const pay = (body: Record<string, unknown>, tok = officer.token, k = key()) => t.api("post", "/insurance/payments", tok).set("Idempotency-Key", k).send(body);
  const ledger = async (claimId: string) => (await get(`/claims/${claimId}/ledger`)).body.data;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("insmoney-a"); b = await t.makeTenant("insmoney-b");
    officer = await t.makeUser(a, ["CLAIMS_OFFICER"]); cashier = await t.makeUser(a, ["CASHIER"]); rec = await t.makeUser(a, ["RECEPTIONIST"]); nurse = await t.makeUser(a, ["NURSE"]);
    manager = await t.makeUser(a, ["MANAGER"]); both = await t.makeUser(a, ["CLAIMS_OFFICER", "MANAGER"]); bOfficer = await t.makeUser(b, ["CLAIMS_OFFICER"]);
    insA = await mkInsurer(); insB = await mkInsurer();
  });
  after(async () => { await t.close(); });

  it("2, 3, 5: cover with an entitled room, a top-up needs a main policy, and a package must say openly what it leaves out", async () => {
    const patient = await registerPatient(t, rec.token);
    // A top-up needs a valid main policy with another insurer.
    assert.equal((await policy(patient.id, insB.id, { tier: "TOPUP" })).status, 409);
    const main = await policy(patient.id, insA.id, { roomEntitlement: "Semi-private", roomRentLimit: "3000", copayPercent: "10" });
    assert.equal(main.status, 201, JSON.stringify(main.body));
    assert.equal(main.body.data.roomEntitlement, "Semi-private");
    assert.equal(main.body.data.roomRentLimit, "3000.00");
    assert.equal(main.body.data.tier, "PRIMARY");
    assert.equal((await policy(patient.id, insA.id, { tier: "TOPUP" })).status, 409, "the same insurer cannot be its own top-up");
    const top = await policy(patient.id, insB.id, { tier: "TOPUP" });
    assert.equal(top.status, 201, JSON.stringify(top.body));
    assert.equal(top.body.data.tier, "TOPUP");
    const listed = (await get(`/patients/${patient.id}/policies`)).body.data as { tier: string }[];
    assert.deepEqual(listed.map((p) => p.tier).sort(), ["PRIMARY", "TOPUP"]);

    // Packages: implants and consumables are inside by default; leaving them out must be said openly.
    const plain = await post(`/claims/insurers/${insA.id}/packages`, { code: `K${uniqueWord(4)}`, name: "Knee replacement", price: "150000" });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    assert.equal(plain.body.data.includesImplants, true);
    assert.equal(plain.body.data.includesConsumables, true);
    const silent = await post(`/claims/insurers/${insA.id}/packages`, { code: `K${uniqueWord(4)}`, name: "Knee, no implant", price: "100000", includesImplants: false });
    assert.equal(silent.status, 400, "a package that leaves the implant out must say so");
    const open = await post(`/claims/insurers/${insA.id}/packages`, { code: `K${uniqueWord(4)}`, name: "Knee, no implant", price: "100000", includesImplants: false, exclusionNote: "Implant billed at actuals, up to the insurer's cap", exclusions: ["private nursing"], inclusions: ["physiotherapy"] });
    assert.equal(open.status, 201, JSON.stringify(open.body));
    assert.equal(open.body.data.includesImplants, false);
    assert.deepEqual(open.body.data.exclusions, ["private nursing"]);
    const stop = await t.api("put", `/claims/insurers/${insA.id}/packages/${plain.body.data.id}`, officer.token).send({ includesConsumables: false });
    assert.equal(stop.status, 400, "changing an existing package to leave things out also needs the open note");
    assert.equal((await t.api("put", `/claims/insurers/${insA.id}/packages/${plain.body.data.id}`, officer.token).send({ includesConsumables: false, exclusionNote: "Consumables are charged separately" })).status, 200);
  });

  it("3, 8: a top-up claim covers what the main insurer leaves, follows the main approval, is paid second, and the bill splits three ways", async () => {
    const patient = await registerPatient(t, rec.token);
    const main = await policy(patient.id, insA.id); const top = await policy(patient.id, insB.id, { tier: "TOPUP" });
    const invoiceId = await issued(patient.id, "10000");
    const claimId = (await post("/claims", { patientId: patient.id, policyId: main.body.data.id, type: "REIMBURSEMENT", diagnosis: "Appendicitis" })).body.data.id as string;
    // A top-up policy cannot start a claim by itself.
    assert.equal((await post("/claims", { patientId: patient.id, policyId: top.body.data.id, type: "REIMBURSEMENT" })).status, 409);
    // The top-up follows the main claim's invoice, so the main claim is submitted first.
    const topClaim = await post(`/claims/${claimId}/topup`, { policyId: top.body.data.id });
    assert.equal(topClaim.status, 201, JSON.stringify(topClaim.body));
    const topId = topClaim.body.data.id as string;
    assert.equal((await post(`/claims/${claimId}/topup`, { policyId: top.body.data.id })).status, 409, "one top-up claim at a time");
    assert.equal((await post(`/claims/${topId}/submit`, { invoiceId })).status, 409, "the main claim has no invoice yet");
    assert.equal((await post(`/claims/${claimId}/submit`, { invoiceId, claimedAmount: "8000" })).status, 200);

    // The top-up asks for what the main insurer was asked for, left over: 10000 - 8000.
    const sub = await post(`/claims/${topId}/submit`, { invoiceId });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal((await get(`/claims/${topId}`)).body.data.claimedAmount, "2000.00");
    assert.equal((await get(`/claims/${topId}`)).body.data.tier, "TOPUP");

    // The main insurer approves less: the top-up claim updates to match (10000 - 6000).
    assert.equal((await post(`/claims/${claimId}/decision`, { decision: "APPROVE", approvedAmount: "6000" })).status, 200);
    const v = (await get(`/claims/${topId}`)).body.data;
    assert.equal(v.claimedAmount, "4000.00", "the top-up follows the main approval");
    assert.match(JSON.stringify(v.events), /main insurer's approval changed/);
    assert.equal((await get(`/claims/${claimId}`)).body.data.topups.length, 1);

    // The three-way split adds up to the bill: main insurer, top-up insurer, patient.
    const split = (await get(`/claims/${claimId}/split`)).body.data;
    assert.deepEqual([split.total, split.primary.pays, split.topup.pays, split.patient.pays, split.addsUp], ["10000.00", "6000.00", "4000.00", "0.00", true]);
    assert.equal((await get(`/claims/${topId}/split`)).body.data.primary.claimNumber, split.primary.claimNumber, "the same split is seen from the top-up claim");

    // The main insurer is settled first.
    assert.equal((await post(`/claims/${topId}/decision`, { decision: "APPROVE", approvedAmount: "4000" })).status, 200);
    const early = await t.api("post", `/claims/${topId}/settlements`, officer.token).set("Idempotency-Key", key()).send({ amount: "4000", reference: `UTR${uniqueWord(8)}`, receivedOn: iso(0) });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, "PRIMARY_NOT_SETTLED");
    assert.equal((await t.api("post", `/claims/${claimId}/settlements`, officer.token).set("Idempotency-Key", key()).send({ amount: "6000", reference: `UTR${uniqueWord(8)}`, receivedOn: iso(0) })).status, 201);
    const late = await t.api("post", `/claims/${topId}/settlements`, officer.token).set("Idempotency-Key", key()).send({ amount: "4000", reference: `UTR${uniqueWord(8)}`, receivedOn: iso(0) });
    assert.equal(late.status, 201, JSON.stringify(late.body));
    assert.equal((await get(`/claims/${topId}`)).body.data.status, "SETTLED");
    assert.equal((await t.api("get", `/invoices/${invoiceId}`, cashier.token)).body.data.status, "PAID", "both insurers' money is on the one invoice");
  });

  it("10, 11: cuts and their reasons; one payment matched to several claims; short payment follow-up; overpayment and refund; never edited", async () => {
    const c1 = await approvedClaim(insA.id, "8000", "6000");
    const c2 = await approvedClaim(insA.id, "3000", "3000", "3000");
    const other = await approvedClaim(insB.id, "1000", "1000", "1000");

    // What the insurer cut (8000 claimed, 6000 approved) and why; the room-rent cut is entered by hand.
    assert.equal((await post(`/claims/${c1.claimId}/cuts`, { category: "OTHER", amount: "100" })).status, 400, "'other' needs words");
    assert.equal((await post(`/claims/${c1.claimId}/cuts`, { category: "ROOM_RENT_LIMIT", amount: "1500", note: "Room above the 3,000 limit" })).status, 201);
    assert.equal((await post(`/claims/${c1.claimId}/cuts`, { category: "NOT_COVERED", amount: "600" })).status, 400, "only 500 of the cut is left to explain");
    assert.equal((await post(`/claims/${c1.claimId}/cuts`, { category: "PATIENT_COPAY", amount: "500" })).status, 201);
    let l = await ledger(c1.claimId);
    assert.deepEqual([l.claimed, l.approved, l.cut, l.cutExplained, l.cutUnexplained, l.owed], ["8000.00", "6000.00", "2000.00", "2000.00", "0.00", "6000.00"]);
    assert.deepEqual(l.cuts.map((c: { label: string }) => c.label), ["Room rent too high", "Patient co-pay"]);

    // One payment of 10000 from the insurer: 4000 against claim 1 (their last word on it), 3500 against claim 2 (owed 3000), the rest matches nothing.
    assert.equal((await pay({ insurerId: insA.id, reference: "NEFT-ONE", receivedOn: iso(0), amount: "10000", lines: [{ claimId: other.claimId, amount: "1000" }] })).status, 400, "another insurer's claim");
    assert.equal((await pay({ insurerId: insA.id, reference: "NEFT-ONE", receivedOn: iso(0), amount: "1000", lines: [{ claimId: c1.claimId, amount: "2000" }] })).status, 400, "lines add up to more than the payment");
    assert.equal((await t.api("post", "/insurance/payments", officer.token).send({ insurerId: insA.id, reference: "NEFT-ONE", receivedOn: iso(0), amount: "10000", lines: [] })).status, 400, "an Idempotency-Key is needed");
    assert.equal((await pay({ insurerId: insA.id, reference: "NEFT-ONE", receivedOn: iso(0), amount: "10000", lines: [{ claimId: c1.claimId, amount: "4000", final: true }, { claimId: c2.claimId, amount: "3500" }] }, cashier.token)).status, 403, "only the desk that records settlements");
    const k = key();
    const body = { insurerId: insA.id, reference: "NEFT-ONE", receivedOn: iso(0), amount: "10000", lines: [{ claimId: c1.claimId, amount: "4000", final: true }, { claimId: c2.claimId, amount: "3500" }] };
    const p = await pay(body, officer.token, k);
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.data.overpayment, "3000.00", "500 over claim 2 and 2500 matched to no claim");
    assert.deepEqual(p.body.data.posted.map((x: { amount: string; status: string }) => [x.amount, x.status]), [["4000.00", "APPROVED"], ["3000.00", "SETTLED"]]);
    const replay = await pay(body, officer.token, k);
    assert.equal(replay.status, 200, "the same request replays");
    assert.equal(replay.body.data.id, p.body.data.id);
    assert.equal((await pay(body)).status, 409, "the same reference is never recorded twice");

    // Each payment is matched to its claims; the running record shows claimed, approved, received, cut, written off and owed.
    l = await ledger(c1.claimId);
    assert.deepEqual([l.received, l.owed, l.writtenOff], ["4000.00", "2000.00", "0.00"]);
    assert.equal((await ledger(c2.claimId)).owed, "0.00");
    assert.equal((await t.api("get", `/invoices/${c1.invoiceId}`, cashier.token)).body.data.paidTotal, "4000.00");
    const insurerLedger = (await get(`/insurance/ledger/${insA.id}`)).body.data;
    assert.equal(insurerLedger.claims >= 2, true);
    const mine = (await get("/insurance/ledger")).body.data as { insurerId: string; owed: string; refundDue: string }[];
    assert.equal(mine.find((r) => r.insurerId === insA.id)?.refundDue, "3000.00");
    const list = (await get(`/insurance/payments?insurerId=${insA.id}`)).body.data;
    assert.equal(list.items[0].reference, "NEFT-ONE");
    assert.deepEqual(list.items[0].claims.map((c: { amount: string }) => c.amount).sort(), ["3000.00", "4000.00"]);

    // Paid less than approved, and said final: a follow-up task is raised for the desk.
    const tasks = (await get("/insurance/follow-ups")).body.data.items as { id: string; kind: string; amount: string; claimId: string }[];
    const short = tasks.find((x) => x.claimId === c1.claimId && x.kind === "SHORT_PAYMENT");
    assert.ok(short, "short-payment follow-up");
    assert.equal(short.amount, "2000.00");
    assert.equal((await post(`/insurance/follow-ups/${short.id}/done`, { note: "Asked the TPA; they will pay next week" })).status, 200);
    assert.equal((await post(`/insurance/follow-ups/${short.id}/done`, { note: "Again" })).status, 409);

    // The overpayment is recorded, and its refund tracked in parts.
    const over = ((await get("/insurance/overpayments")).body.data.items as { id: string; amount: string; status: string; insurer: string }[]).find((o) => o.amount === "3000.00")!;
    assert.equal(over.status, "OPEN");
    const rk = key();
    const r1 = await t.api("post", `/insurance/overpayments/${over.id}/refunds`, officer.token).set("Idempotency-Key", rk).send({ amount: "1000", reference: "REF-1", refundedOn: iso(0) });
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    assert.equal(r1.body.data.refundDue, "2000.00");
    assert.equal((await t.api("post", `/insurance/overpayments/${over.id}/refunds`, officer.token).set("Idempotency-Key", rk).send({ amount: "1000", reference: "REF-1", refundedOn: iso(0) })).status, 200, "replay");
    assert.equal((await t.api("post", `/insurance/overpayments/${over.id}/refunds`, officer.token).set("Idempotency-Key", key()).send({ amount: "2500", reference: "REF-2", refundedOn: iso(0) })).status, 409, "more than is due");
    const r2 = await t.api("post", `/insurance/overpayments/${over.id}/refunds`, officer.token).set("Idempotency-Key", key()).send({ amount: "2000", reference: "REF-3", refundedOn: iso(0) });
    assert.equal(r2.body.data.status, "REFUNDED");

    // Money received is never edited or removed.
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "InsurerPayment" SET amount = 1 WHERE id = ${p.body.data.id}::uuid`);
    await assert.rejects(() => t.prisma.$executeRaw`DELETE FROM "InsurerPayment" WHERE id = ${p.body.data.id}::uuid`);
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "ClaimSettlement" SET amount = 1 WHERE "claimId" = ${c1.claimId}::uuid`);
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "InsurerRefund" SET amount = 1 WHERE "overpaymentId" = ${over.id}::uuid`);
    await assert.rejects(() => t.prisma.$executeRaw`DELETE FROM "ClaimDeduction" WHERE "claimId" = ${c1.claimId}::uuid`);
  });

  it("11: a write-off needs a manager's approval (never the person who asked) and a reason; money still owed cannot just be closed", async () => {
    const c = await approvedClaim(insA.id, "6000", "6000", "6000");
    assert.equal((await t.api("post", `/claims/${c.claimId}/settlements`, officer.token).set("Idempotency-Key", key()).send({ amount: "1000", reference: `UTR${uniqueWord(8)}`, receivedOn: iso(0) })).status, 201);
    // 5000 is still owed: it cannot be closed away.
    const close = await post(`/claims/${c.claimId}/close`, { reason: "Balance written off by the hospital" });
    assert.equal(close.status, 409);
    assert.equal(close.body.error.code, "WRITEOFF_REQUIRED");
    assert.equal((await post(`/claims/${c.claimId}/write-offs`, { amount: "6000", reason: "Insurer will not pay the balance" })).status, 400, "more than is owed");
    assert.equal((await post(`/claims/${c.claimId}/write-offs`, { amount: "2000", reason: "short" })).status, 400, "a reason is needed");
    const w1 = await post(`/claims/${c.claimId}/write-offs`, { amount: "2000", reason: "Insurer disallowed the room upgrade after audit" });
    assert.equal(w1.status, 201, JSON.stringify(w1.body));
    assert.equal((await post(`/claims/${c.claimId}/write-offs`, { amount: "1000", reason: "A second one at the same time" })).status, 409, "one waits at a time");
    // The person who asked cannot approve it, even holding both rights; the claims officer alone has no right to.
    assert.equal((await post(`/insurance/write-offs/${w1.body.data.id}/decision`, { decision: "APPROVE" }, officer.token)).status, 403);
    // (a manager who is also the requester)
    const mine = await post(`/claims/${c.claimId}/write-offs`, { amount: "1000", reason: "Requested by someone with both rights" }, both.token);
    assert.equal(mine.status, 409, "the first request is still waiting");
    // Another manager decides: first a refusal needs words, then approval.
    assert.equal((await post(`/insurance/write-offs/${w1.body.data.id}/decision`, { decision: "REJECT" }, manager.token)).status, 400);
    const ok = await post(`/insurance/write-offs/${w1.body.data.id}/decision`, { decision: "APPROVE", note: "Approved" }, manager.token);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.stillOwed, "3000.00");
    assert.equal((await post(`/insurance/write-offs/${w1.body.data.id}/decision`, { decision: "APPROVE" }, manager.token)).status, 409, "decided once");
    const l = await ledger(c.claimId);
    assert.deepEqual([l.writtenOff, l.owed, l.received], ["2000.00", "3000.00", "1000.00"]);

    // The rest arrives: what was written off is not part of what is still to be received, so the claim settles.
    const last = await t.api("post", `/claims/${c.claimId}/settlements`, officer.token).set("Idempotency-Key", key()).send({ amount: "3000", reference: `UTR${uniqueWord(8)}`, receivedOn: iso(0) });
    assert.equal(last.status, 201, JSON.stringify(last.body));
    assert.equal(last.body.data.status, "CLOSED", "all the rest is in and the written-off part is not coming: the claim closes");

    // A write-off of the whole balance closes the claim; a requester who also holds approval rights still cannot approve their own.
    const d = await approvedClaim(insA.id, "4000", "4000", "4000");
    const w2 = await post(`/claims/${d.claimId}/write-offs`, { amount: "4000", reason: "Insurer has wound up; nothing more to collect" }, both.token);
    assert.equal(w2.status, 201, JSON.stringify(w2.body));
    assert.equal((await post(`/insurance/write-offs/${w2.body.data.id}/decision`, { decision: "APPROVE" }, both.token)).status, 403, "never the person who asked");
    const w2ok = await post(`/insurance/write-offs/${w2.body.data.id}/decision`, { decision: "APPROVE" }, manager.token);
    assert.equal(w2ok.body.data.claimStatus, "CLOSED");
    assert.equal((await get(`/claims/${d.claimId}`)).body.data.status, "CLOSED");
    const listed = (await get("/insurance/write-offs?status=APPROVED")).body.data.items as { amount: string }[];
    assert.ok(listed.some((x) => x.amount === "4000.00"));
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "ClaimWriteOff" SET amount = 1 WHERE id = ${w2.body.data.id}::uuid`, "a decided write-off cannot change");
  });

  it("5: each charge is marked inside the package or extra", async () => {
    const pkg = await post(`/claims/insurers/${insA.id}/packages`, { code: `P${uniqueWord(4)}`, name: "Hernia repair", price: "60000", exclusions: ["private nursing"] });
    assert.equal(pkg.status, 201);
    const p = await patientWithMain(insA.id, "1000", {});
    const invoiceId = await issued(p.patient.id, "1000", [{ description: "Hernia surgery", unitPrice: "50000" }, { description: "Private nursing, 3 days", unitPrice: "6000" }]);
    const claimId = await claimOf(p);
    assert.equal((await post(`/claims/${claimId}/tariff-package`, { packageId: pkg.body.data.id })).status, 200);
    assert.equal((await get(`/claims/${claimId}/package-lines`)).status, 409, "before submission the invoice must be chosen");
    const r = (await get(`/claims/${claimId}/package-lines?invoiceId=${invoiceId}`)).body.data;
    const by = Object.fromEntries(r.lines.map((l: { description: string; scope: string }) => [l.description, l.scope]));
    assert.equal(by["Hernia surgery"], "INSIDE_PACKAGE");
    assert.equal(by["Private nursing, 3 days"], "EXTRA");
    assert.equal(r.extraTotal, "6000.00");
    assert.equal(r.package.includesImplants, true);
    // Another patient's invoice cannot be previewed.
    const stranger = await patientWithMain();
    assert.equal((await get(`/claims/${claimId}/package-lines?invoiceId=${stranger.invoiceId}`)).status, 404);
  });

  it("4, 7: price list per insurer feeds the family's estimate: what each insurer pays and what the family pays", async () => {
    const patient = await registerPatient(t, rec.token);
    const main = await policy(patient.id, insA.id, { copayPercent: "10", roomRentLimit: "3000", roomEntitlement: "Semi-private" });
    await policy(patient.id, insB.id, { tier: "TOPUP", sumInsured: "200000" });
    const svc = (await t.api("post", "/services", (await t.makeUser(a, ["ADMINISTRATOR"])).token).send({ code: `S${uniqueWord(5)}`, name: "Hernia surgery", category: "PROCEDURE", price: "100000", taxPercent: "0" })).body.data as { id: string };
    // The same service costs the insurer's rate, not the hospital's price: the part above it is the family's.
    assert.equal((await t.api("put", `/claims/insurers/${insA.id}/rates/${svc.id}`, officer.token).send({ price: "80000" })).status, 200);
    const e = await post("/insurance/estimates", { patientId: patient.id, days: 3, roomRatePerDay: "5000", lines: [{ serviceId: svc.id, quantity: 1 }, { description: "Deluxe suite upgrade", kind: "OTHER", quantity: 1, unitPrice: "10000", taxPercent: 0, notCovered: true }] }, rec.token);
    assert.equal(e.status, 201, JSON.stringify(e.body));
    const r = e.body.data;
    assert.equal(r.total, "125000.00", "service 100000 + upgrade 10000 + room 3 x 5000");
    assert.equal(r.roomRentExcess, "6000.00", "(5000 - 3000) x 3 days");
    assert.equal(r.aboveInsurerRate, "20000.00", "billed 100000 against the insurer's 80000");
    assert.equal(r.notCovered, "10000.00");
    assert.equal(r.mainInsurer.insurer, main.body.data.insurer.name);
    assert.equal(r.mainInsurer.roomEntitlement, "Semi-private");
    assert.ok(r.topupInsurer, "the top-up insurer's share is shown");
    assert.equal(r.addsUp, true);
    const sum = ["mainInsurer", "topupInsurer"].reduce((acc, k) => acc + Number(r[k]?.pays ?? 0), Number(r.family.pays));
    assert.equal(sum.toFixed(2), "125000.00", "what each insurer pays plus what the family pays is the whole estimate");
    assert.ok(Number(r.family.pays) >= 36000, "the family at least pays the room excess, the rate excess and the uncovered item");
    // It is kept, and never edited.
    assert.equal((await get(`/insurance/estimates/${r.id}`, rec.token)).body.data.total, "125000.00");
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "ClaimEstimate" SET total = 1 WHERE id = ${r.id}::uuid`);
    // No cover: the whole estimate is the family's. A package from another insurer is refused.
    const bare = await registerPatient(t, rec.token);
    const none = await post("/insurance/estimates", { patientId: bare.id, lines: [{ description: "Consultation", unitPrice: "500", taxPercent: 0 }] }, rec.token);
    assert.equal(none.body.data.family.pays, "500.00");
    assert.equal(none.body.data.mainInsurer, null);
    const bPkg = await post(`/claims/insurers/${insB.id}/packages`, { code: `X${uniqueWord(4)}`, name: "Other insurer package", price: "1000" });
    assert.equal((await post("/insurance/estimates", { patientId: patient.id, packageId: bPkg.body.data.id }, rec.token)).status, 400);
  });

  it("12: reports: old claims, why claims are rejected, who pays late, and what each insurer still owes", async () => {
    // A claim waiting for a decision, and one rejected with a reason.
    const p = await patientWithMain(insB.id, "5000");
    const waiting = await claimOf(p);
    await post(`/claims/${waiting}/submit`, { invoiceId: p.invoiceId, claimedAmount: "4000" });
    const q = await patientWithMain(insB.id, "5000");
    const rej = await claimOf(q);
    await post(`/claims/${rej}/submit`, { invoiceId: q.invoiceId, claimedAmount: "4000" });
    assert.equal((await post(`/claims/${rej}/decision`, { decision: "REJECT", reason: "Pre-existing condition not disclosed" })).status, 200);
    const ar = await get("/reports/insurance/ageing", manager.token);
    assert.equal(ar.status, 200, JSON.stringify(ar.body));
    const r = ar.body.data;
    const row = r.insurers.find((x: { insurerId: string }) => x.insurerId === insB.id);
    assert.ok(row, "the insurer has an old-claims row");
    assert.equal(row.buckets.find((b: { bucket: string }) => b.bucket === "0-30").claims >= 1, true);
    assert.ok(r.oldest.some((c: { claimId: string }) => c.claimId === waiting));
    const rej2 = (await get(`/reports/insurance/rejections?from=${iso(-2)}&to=${iso(1)}`, manager.token)).body.data;
    assert.ok(rej2.reasons.some((x: { reason: string; claims: number }) => x.reason === "Pre-existing condition not disclosed" && x.claims >= 1), "why claims get rejected");
    assert.ok(rej2.cuts.some((c: { label: string }) => c.label === "Room rent too high"), "and what insurers cut");
    const late = (await get(`/reports/insurance/late-payers?from=${iso(-2)}&to=${iso(1)}&slaDays=1`, manager.token)).body.data;
    const la = late.insurers.find((x: { insurerId: string }) => x.insurerId === insA.id);
    assert.ok(la && la.paidClaims >= 1, "the insurer that settled claims has days-to-pay figures");
    assert.equal(typeof la.averageDaysToPay, "number");
    const owed = (await get("/reports/insurance/owed", manager.token)).body.data as { insurerId: string; owed: string; awaitingDecision: string }[];
    assert.ok(Number(owed.find((o) => o.insurerId === insB.id)!.awaitingDecision) >= 4000);
    assert.equal((await get("/reports/insurance/owed", nurse.token)).status, 403);
  });

  it("security: another hospital sees nothing; only the right roles act", async () => {
    const c = await approvedClaim(insA.id, "1000", "1000", "1000");
    for (const path of [`/claims/${c.claimId}/ledger`, `/claims/${c.claimId}/split`, `/claims/${c.claimId}/package-lines`]) assert.equal((await get(path, bOfficer.token)).status, 404, path);
    assert.equal((await post(`/claims/${c.claimId}/cuts`, { category: "NOT_COVERED", amount: "1" }, bOfficer.token)).status, 404);
    assert.equal((await post(`/claims/${c.claimId}/write-offs`, { amount: "100", reason: "Another hospital trying" }, bOfficer.token)).status, 404);
    assert.equal((await post(`/claims/${c.claimId}/topup`, { policyId: randomUUID() }, bOfficer.token)).status, 404);
    assert.equal((await pay({ insurerId: insA.id, reference: "FOREIGN-1", receivedOn: iso(0), amount: "100", lines: [] }, bOfficer.token)).status, 404, "another hospital's insurer");
    assert.equal((await get("/insurance/ledger", nurse.token)).status, 403);
    assert.equal((await post(`/claims/${c.claimId}/write-offs`, { amount: "100", reason: "A nurse cannot ask for this" }, nurse.token)).status, 403);
    assert.equal((await post("/insurance/write-offs/" + randomUUID() + "/decision", { decision: "APPROVE" }, officer.token)).status, 403, "approval needs the manager's right");
    assert.equal((await get("/insurance/ledger", bOfficer.token)).body.data.length, 0, "the other hospital's ledger is its own");
  });
});
