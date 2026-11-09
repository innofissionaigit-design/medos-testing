import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";
import { Decimal } from "@medos/shared";
import { calculateCopay, type CopayRule, hasCopayRule, nextStatus, stepsFrom, type ClaimStatus, type ClaimStep } from "./claims.domain";

type User = { id: string; token: string };
const key = () => `k-${randomUUID().slice(0, 18)}`;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("claims: the order of steps", () => {
  it("only the allowed steps lead anywhere; a finished claim goes nowhere", () => {
    assert.equal(nextStatus("DRAFT", "REQUEST_PREAUTH"), "PREAUTH_PENDING");
    assert.equal(nextStatus("PREAUTH_PENDING", "DECIDE_PREAUTH", "PREAUTH_APPROVED"), "PREAUTH_APPROVED");
    assert.equal(nextStatus("PREAUTH_PENDING", "DECIDE_PREAUTH"), null, "two outcomes: one must be chosen");
    assert.equal(nextStatus("SUBMITTED", "DECIDE", "APPROVED"), "APPROVED");
    assert.equal(nextStatus("QUERY", "DECIDE", "APPROVED"), null, "a claim under query cannot be approved before it is resubmitted");
    assert.equal(nextStatus("DRAFT", "DECIDE", "APPROVED"), null);
    for (const done of ["REJECTED", "SETTLED", "CLOSED"] as ClaimStatus[]) assert.deepEqual(stepsFrom(done), []);
    const all: ClaimStep[] = ["REQUEST_PREAUTH", "DECIDE_PREAUTH", "SUBMIT", "RAISE_QUERY", "RESUBMIT", "DECIDE", "SETTLE", "CLOSE"];
    for (const s of all) assert.equal(nextStatus("SETTLED", s, "APPROVED"), null);
  });
});

describe("claims: the co-pay calculation", () => {
  const rule = (o: { pct?: string | null; ded?: string; used?: string; sum?: string | null } = {}): CopayRule => ({
    copayPercent: o.pct === null ? null : new Decimal(o.pct ?? "0"), deductible: new Decimal(o.ded ?? "0"), deductibleUsed: new Decimal(o.used ?? "0"), sumInsured: o.sum ? new Decimal(o.sum) : null,
  });
  const figures = (base: string, r: CopayRule) => { const x = calculateCopay(new Decimal(base), r); return [x.deductibleApplied, x.copayAmount, x.claim, x.patientShare].map((d) => d.toFixed(2)); };

  it("a policy with no percentage and no deductible has no rule", () => {
    assert.equal(hasCopayRule(rule({ pct: null })), false);
    assert.equal(hasCopayRule(rule({ pct: "0" })), true, "a stated 0% is a rule");
    assert.equal(hasCopayRule(rule({ pct: null, ded: "500" })), true);
  });

  it("applies the deductible first, then the percentage to what is left", () => {
    assert.deepEqual(figures("10000", rule({ pct: "10" })), ["0.00", "1000.00", "9000.00", "1000.00"]);
    assert.deepEqual(figures("10000", rule({ pct: "10", ded: "2000" })), ["2000.00", "800.00", "7200.00", "2800.00"]);
    assert.deepEqual(figures("10000", rule({ pct: "10", ded: "2000", used: "500" })), ["1500.00", "850.00", "7650.00", "2350.00"], "only the deductible still to be met comes off");
    assert.deepEqual(figures("10000", rule({ pct: "10", ded: "2000", used: "2000" })), ["0.00", "1000.00", "9000.00", "1000.00"], "a met deductible is not taken again");
  });

  it("edge cases: a deductible bigger than the bill, 100% co-pay, 0% co-pay, and rounding to the paisa", () => {
    assert.deepEqual(figures("1000", rule({ pct: "10", ded: "5000" })), ["1000.00", "0.00", "0.00", "1000.00"]);
    assert.deepEqual(figures("500", rule({ pct: "100" })), ["0.00", "500.00", "0.00", "500.00"]);
    assert.deepEqual(figures("500", rule({ pct: "0" })), ["0.00", "0.00", "500.00", "0.00"]);
    assert.deepEqual(figures("333.33", rule({ pct: "10" })), ["0.00", "33.33", "300.00", "33.33"]);
    assert.deepEqual(figures("0.05", rule({ pct: "50" })), ["0.00", "0.03", "0.02", "0.03"], "half a paisa rounds up, and the two parts still add up to the bill");
  });

  it("the claim never exceeds the sum insured, and the rest is the patient's; the two always add up to the bill", () => {
    const capped = calculateCopay(new Decimal("10000"), rule({ pct: "0", sum: "5000" }));
    assert.deepEqual([capped.claim.toFixed(2), capped.patientShare.toFixed(2), capped.cappedBySumInsured], ["5000.00", "5000.00", true]);
    for (const [base, r] of [["12345.67", rule({ pct: "12.5", ded: "750.25", used: "100" })], ["99.99", rule({ pct: "33.33" })], ["1000000", rule({ pct: "7", sum: "400000" })]] as [string, CopayRule][]) {
      const x = calculateCopay(new Decimal(base), r);
      assert.ok(x.claim.plus(x.patientShare).eq(base), `${base}: claim + patient share = bill`);
      assert.ok(x.claim.gte(0) && x.patientShare.gte(0));
    }
  });
});

describe("claims: insurers, policies, and a claim from pre-authorisation to settlement", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let officer: User; let cashier: User; let rec: User; let nurse: User; let bOfficer: User;
  let insurer: { id: string; name: string };

  const mkInsurer = async (tok = officer.token, name = `Star ${uniqueWord(6)}`) => { const r = await t.api("post", "/claims/insurers", tok).send({ name, kind: "TPA" }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data as { id: string; name: string }; };
  const policy = async (patientId: string, over: Record<string, unknown> = {}, tok = officer.token) => t.api("post", `/patients/${patientId}/policies`, tok).send({ insurerId: insurer.id, policyNumber: `POL-${uniqueWord(6)}`, validFrom: iso(-30), validTo: iso(300), sumInsured: "500000", ...over });
  /** An issued invoice for exactly `total`. */
  const issued = async (patientId: string, total = "10000") => {
    const d = await t.api("post", "/invoices", cashier.token).send({ patientId, lines: [{ description: "Procedure", unitPrice: total, taxPercent: 0, quantity: 1 }] });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.equal((await t.api("post", `/invoices/${d.body.data.id}/issue`, cashier.token)).status, 200);
    return d.body.data.id as string;
  };
  const invoice = async (id: string) => (await t.api("get", `/invoices/${id}`, cashier.token)).body.data as { paidTotal: string; status: string };
  const post = (path: string, body: Record<string, unknown> = {}, tok = officer.token) => t.api("post", path, tok).send(body);
  const view = async (id: string, tok = officer.token) => (await t.api("get", `/claims/${id}`, tok)).body.data;
  /** A patient with a valid policy, a draft claim of the given type, and an issued invoice. */
  const setup = async (type = "CASHLESS", total = "10000") => {
    const patient = await registerPatient(t, rec.token);
    const pol = await policy(patient.id);
    assert.equal(pol.status, 201, JSON.stringify(pol.body));
    const c = await post("/claims", { patientId: patient.id, policyId: pol.body.data.id, type, diagnosis: "Appendicitis" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    return { patient, policyId: pol.body.data.id as string, claimId: c.body.data.id as string, invoiceId: await issued(patient.id, total) };
  };
  const submitted = async (type = "REIMBURSEMENT", total = "10000", claimed = "8000") => {
    const s = await setup(type, total);
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: claimed })).status, 200);
    return s;
  };
  const approved = async (approvedAmount = "6000") => {
    const s = await submitted();
    const r = await post(`/claims/${s.claimId}/decision`, { decision: "APPROVE", approvedAmount });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return s;
  };
  const settle = (claimId: string, amount: string, tok = officer.token, k = key(), reference = `UTR${uniqueWord(8)}`) => t.api("post", `/claims/${claimId}/settlements`, tok).set("Idempotency-Key", k).send({ amount, reference, receivedOn: iso(0) });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("claims-a"); b = await t.makeTenant("claims-b");
    officer = await t.makeUser(a, ["CLAIMS_OFFICER"]); cashier = await t.makeUser(a, ["CASHIER"]); rec = await t.makeUser(a, ["RECEPTIONIST"]); nurse = await t.makeUser(a, ["NURSE"]); bOfficer = await t.makeUser(b, ["CLAIMS_OFFICER"]);
    insurer = await mkInsurer();
  });
  after(async () => { await t.close(); });

  it("insurers: the claims officer sets them up; others may only look; names are unique; another hospital's list is its own", async () => {
    assert.equal((await t.api("get", "/claims/insurers", cashier.token)).status, 200);
    assert.equal((await t.api("get", "/claims/insurers", nurse.token)).status, 403);
    assert.equal((await t.api("post", "/claims/insurers", cashier.token).send({ name: "Nope Insurance" })).status, 403);
    assert.equal((await t.api("post", "/claims/insurers", officer.token).send({ name: insurer.name })).status, 409);
    for (const bad of [{ name: "x" }, { name: "Fine Insurance", kind: "BANK" }, { name: "Fine Insurance", extra: 1 }]) assert.equal((await t.api("post", "/claims/insurers", officer.token).send(bad)).status, 400, JSON.stringify(bad));
    const other = await mkInsurer(bOfficer.token, insurer.name);
    assert.notEqual(other.id, insurer.id, "the same name in another hospital is a different insurer");
    assert.equal((await t.api("put", `/claims/insurers/${insurer.id}`, bOfficer.token).send({ name: "Taken over" })).status, 404);
    assert.equal(((await t.api("get", "/claims/insurers", bOfficer.token)).body.data as { id: string }[]).some((i) => i.id === insurer.id), false);
    assert.equal((await t.api("put", `/claims/insurers/${insurer.id}`, officer.token).send({ name: insurer.name, kind: "TPA", contact: "tpa@example.test" })).status, 200);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "INSURER_CREATED", entityId: insurer.id } }));
  });

  it("policies: added to a patient with valid dates; a wrong or duplicate one is refused; other hospitals cannot reach them", async () => {
    const p = await registerPatient(t, rec.token);
    for (const bad of [{ validTo: iso(-60) }, { insurerId: randomUUID() }, { policyNumber: "x" }, { validFrom: "tomorrow" }, { extra: 1 }]) assert.ok([400, 404].includes((await policy(p.id, bad)).status), JSON.stringify(bad));
    const ok = await policy(p.id, { policyNumber: "POL-FIXED-1" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.validToday, true);
    assert.equal((await policy(p.id, { policyNumber: "POL-FIXED-1" })).status, 409, "already on the record");
    assert.equal((await policy(p.id, {}, cashier.token)).status, 403);
    assert.equal((await policy(p.id, {}, bOfficer.token)).status, 404, "another hospital's patient");
    assert.equal(((await t.api("get", `/patients/${p.id}/policies`, rec.token)).body.data as unknown[]).length, 2 - 1 + 0, "reception can see it");
    assert.equal((await t.api("get", `/patients/${p.id}/policies`, bOfficer.token)).status, 404);
    assert.equal((await t.api("get", `/patients/${p.id}/policies`, nurse.token)).status, 403);
    assert.equal((await t.api("put", `/policies/${ok.body.data.id}`, officer.token).send({ status: "INACTIVE" })).status, 200);
    const c = await post("/claims", { patientId: p.id, policyId: ok.body.data.id, type: "CASHLESS" });
    assert.equal(c.status, 409, "an inactive policy cannot start a claim");
    const expired = await policy(p.id, { policyNumber: "POL-OLD-1", validFrom: iso(-400), validTo: iso(-5) });
    assert.equal(expired.status, 201);
    assert.equal((await post("/claims", { patientId: p.id, policyId: expired.body.data.id, type: "CASHLESS" })).status, 409, "an expired policy cannot start a claim");
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PatientPolicy" WHERE id = '${ok.body.data.id}'::uuid`), /cannot be deleted|append-only/);
  });

  it("a cashless claim: pre-authorisation requested and approved, then submitted with the issued invoice, queried, resubmitted and approved", async () => {
    const s = await setup("CASHLESS");
    const c = await view(s.claimId);
    assert.match(c.claimNumber, /^CLM-\d{4}-\d{6}$/);
    assert.deepEqual([c.status, c.nextSteps.sort()], ["DRAFT", ["CLOSE", "REQUEST_PREAUTH", "SUBMIT"]]);
    assert.equal((await post(`/claims/${s.claimId}/preauth-decision`, { decision: "APPROVE", amount: "5000" })).status, 409, "nothing has been requested yet");
    assert.equal((await post(`/claims/${s.claimId}/preauth`, { requestedAmount: "-1" })).status, 400);
    assert.equal((await post(`/claims/${s.claimId}/preauth`, { requestedAmount: "9000" })).status, 200);
    assert.equal((await post(`/claims/${s.claimId}/preauth`, { requestedAmount: "9000" })).status, 409, "already requested");
    assert.equal((await post(`/claims/${s.claimId}/preauth-decision`, { decision: "APPROVE" })).status, 400, "an approval needs an amount");
    assert.equal((await post(`/claims/${s.claimId}/preauth-decision`, { decision: "REJECT" })).status, 400, "a rejection needs a reason");
    assert.equal((await post(`/claims/${s.claimId}/preauth-decision`, { decision: "APPROVE", amount: "7500" })).status, 200);
    const sub = await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "7500", note: "With discharge summary" });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal((await post(`/claims/${s.claimId}/decision`, { decision: "APPROVE", approvedAmount: "7000" }, cashier.token)).status, 403);
    assert.equal((await post(`/claims/${s.claimId}/query`, { note: "Send the final bill with the stamp" })).status, 200);
    assert.equal((await post(`/claims/${s.claimId}/decision`, { decision: "APPROVE", approvedAmount: "7000" })).status, 409, "queried: answer first");
    assert.equal((await post(`/claims/${s.claimId}/resubmit`, { note: "Stamped bill attached" })).status, 200);
    assert.equal((await post(`/claims/${s.claimId}/decision`, { decision: "APPROVE", approvedAmount: "9000" })).status, 400, "more than was claimed");
    assert.equal((await post(`/claims/${s.claimId}/decision`, { decision: "APPROVE", approvedAmount: "7000", reason: "Room rent capped" })).status, 200);
    const done = await view(s.claimId);
    assert.deepEqual([done.status, done.preauthApproved, done.claimedAmount, done.approvedAmount, done.outstanding], ["APPROVED", "7500.00", "7500.00", "7000.00", "7000.00"]);
    assert.deepEqual(done.events.map((e: { to: string }) => e.to), ["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED", "SUBMITTED", "QUERY", "SUBMITTED", "APPROVED"]);
    assert.ok(done.events.every((e: { by: string | null }) => e.by));
    for (const action of ["CLAIM_CREATED", "CLAIM_PREAUTH_REQUESTED", "CLAIM_PREAUTH_APPROVED", "CLAIM_SUBMITTED", "CLAIM_QUERY_RAISED", "CLAIM_RESUBMITTED", "CLAIM_APPROVED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action, entityId: s.claimId } }), action);
  });

  it("a reimbursement claim has no pre-authorisation step; a rejected pre-authorisation or decision ends the claim with the reason", async () => {
    const r = await setup("REIMBURSEMENT");
    assert.equal((await post(`/claims/${r.claimId}/preauth`, { requestedAmount: "100" })).status, 409);
    assert.ok(!(await view(r.claimId)).nextSteps.includes("REQUEST_PREAUTH"));
    const c = await setup("CASHLESS");
    await post(`/claims/${c.claimId}/preauth`, { requestedAmount: "5000" });
    assert.equal((await post(`/claims/${c.claimId}/preauth-decision`, { decision: "REJECT", reason: "Waiting period not over" })).status, 200);
    const rej = await view(c.claimId);
    assert.deepEqual([rej.status, rej.closeReason, rej.nextSteps], ["REJECTED", "Waiting period not over", []]);
    assert.equal((await post(`/claims/${c.claimId}/submit`, { invoiceId: c.invoiceId, claimedAmount: "100" })).status, 409, "a rejected claim is finished");
    const s = await submitted();
    assert.equal((await post(`/claims/${s.claimId}/decision`, { decision: "REJECT" })).status, 400);
    assert.equal((await post(`/claims/${s.claimId}/decision`, { decision: "REJECT", reason: "Not covered under the policy" })).status, 200);
    assert.equal((await view(s.claimId)).status, "REJECTED");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CLAIM_REJECTED", entityId: s.claimId } }));
  });

  it("submitting: only an issued invoice of the same patient, never for more than it is worth, and one live claim per invoice", async () => {
    const s = await setup("REIMBURSEMENT", "10000");
    const draftInv = await t.api("post", "/invoices", cashier.token).send({ patientId: s.patient.id, lines: [{ description: "Dressing", unitPrice: "500", taxPercent: 0, quantity: 1 }] });
    assert.equal(draftInv.status, 201, JSON.stringify(draftInv.body));
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: draftInv.body.data.id, claimedAmount: "500" })).status, 409, "a draft invoice cannot be claimed");
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "10000.01" })).status, 400, "more than the invoice");
    const stranger = await registerPatient(t, rec.token);
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: await issued(stranger.id), claimedAmount: "100" })).status, 404, "another patient's invoice");
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: randomUUID(), claimedAmount: "100" })).status, 404);
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "0" })).status, 400);
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "10000", extra: 1 })).status, 400);
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "10000" })).status, 200);
    const second = await post("/claims", { patientId: s.patient.id, policyId: s.policyId, type: "REIMBURSEMENT" });
    assert.equal((await post(`/claims/${second.body.data.id}/submit`, { invoiceId: s.invoiceId, claimedAmount: "100" })).status, 409, "the invoice already has a live claim");
    assert.equal((await post(`/claims/${s.claimId}/close`, { reason: "Withdrawn by the patient" })).status, 200);
    assert.equal((await post(`/claims/${second.body.data.id}/submit`, { invoiceId: s.invoiceId, claimedAmount: "100" })).status, 200, "free again once the first claim is closed");
  });

  it("settlement posts the insurer's money on the invoice; part payments add up; the claim is settled when the approved amount has arrived", async () => {
    const s = await approved("6000");
    const before = await invoice(s.invoiceId);
    assert.equal((await settle(s.claimId, "2500.50", cashier.token)).status, 403, "only people who settle claims");
    assert.equal((await t.api("post", `/claims/${s.claimId}/settlements`, officer.token).send({ amount: "100", reference: "UTR1234", receivedOn: iso(0) })).status, 400, "an Idempotency-Key is needed");
    for (const bad of [{ amount: "0" }, { reference: "ab" }, { receivedOn: "today" }, { extra: 1 }]) assert.equal((await t.api("post", `/claims/${s.claimId}/settlements`, officer.token).set("Idempotency-Key", key()).send({ amount: "100", reference: "UTR9999", receivedOn: iso(0), ...bad })).status, 400, JSON.stringify(bad));
    const first = await settle(s.claimId, "2500.50");
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([first.body.data.status, first.body.data.settledAmount, first.body.data.outstanding], ["APPROVED", "2500.50", "3499.50"]);
    const mid = await invoice(s.invoiceId);
    assert.equal(Number(mid.paidTotal) - Number(before.paidTotal), 2500.5, "the invoice received exactly this");
    assert.equal(mid.status, "PARTIALLY_PAID");
    assert.equal((await settle(s.claimId, "3499.51")).status, 409, "more than the approved amount");
    const k = key();
    const a1 = await settle(s.claimId, "1000", officer.token, k, "UTRREPLAY");
    const a2 = await settle(s.claimId, "1000", officer.token, k, "UTRREPLAY");
    assert.deepEqual([a1.status, a2.status], [201, 200], "a retry replays");
    assert.equal(Number((await invoice(s.invoiceId)).paidTotal) - Number(before.paidTotal), 3500.5, "and does not pay twice");
    const last = await settle(s.claimId, "2499.50");
    assert.equal(last.status, 201);
    assert.deepEqual([last.body.data.status, last.body.data.outstanding], ["SETTLED", "0.00"]);
    const done = await view(s.claimId);
    assert.deepEqual([done.status, done.settledAmount, done.settlements.length], ["SETTLED", "6000.00", 3]);
    assert.ok(done.settlements.every((x: { receiptId: string | null }) => x.receiptId));
    assert.equal((await settle(s.claimId, "1")).status, 409, "a settled claim takes no more");
    const pay = await t.prisma.payment.findFirst({ where: { tenantId: a.tenantId, receipt: { invoiceId: s.invoiceId }, reference: "UTRREPLAY" } });
    assert.equal(pay?.method, "BANK_TRANSFER");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CLAIM_SETTLEMENT_RECEIVED", entityId: s.claimId } }));
  });

  it("settlement cannot exceed what the invoice still owes; the patient's own payments come off first", async () => {
    const s = await approved("6000");
    const pay = await t.api("post", `/invoices/${s.invoiceId}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "UPI", amount: "7000", reference: "UPIREF123" }] });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    const r = await settle(s.claimId, "4000");
    assert.equal(r.status, 409, "the invoice has only 3000 left to pay");
    assert.equal(r.body.error.code, "PAYMENT_EXCEEDS_BALANCE");
    assert.equal(Number((await view(s.claimId)).settledAmount), 0, "nothing was recorded");
    assert.equal((await settle(s.claimId, "3000")).status, 201);
  });

  it("closing keeps the reason and ends the claim; a closed claim cannot be moved again", async () => {
    const s = await approved("6000");
    await settle(s.claimId, "1000");
    assert.equal((await post(`/claims/${s.claimId}/close`, { reason: "no" })).status, 400);
    assert.equal((await post(`/claims/${s.claimId}/close`, { reason: "Balance written off by the hospital" }, cashier.token)).status, 403);
    assert.equal((await post(`/claims/${s.claimId}/close`, { reason: "Balance written off by the hospital" })).status, 200);
    const c = await view(s.claimId);
    assert.deepEqual([c.status, c.closeReason, c.settledAmount], ["CLOSED", "Balance written off by the hospital", "1000.00"]);
    assert.equal((await settle(s.claimId, "100")).status, 409);
    assert.equal((await post(`/claims/${s.claimId}/close`, { reason: "Trying to close again" })).status, 409);
  });

  it("other hospitals, other roles and made-up ids cannot reach a claim; lists can be filtered and searched", async () => {
    const s = await submitted();
    for (const path of [`/claims/${s.claimId}`]) {
      assert.equal((await t.api("get", path, bOfficer.token)).status, 404);
      assert.equal((await t.api("get", path, nurse.token)).status, 403);
      assert.equal((await t.api("get", path)).status, 401);
    }
    const bodies: Record<string, Record<string, unknown>> = {
      submit: { invoiceId: s.invoiceId, claimedAmount: "10" }, query: { note: "Some note here" }, resubmit: { note: "Some note here" }, decision: { decision: "REJECT", reason: "Some reason here" },
      close: { reason: "Some reason here" }, preauth: { requestedAmount: "10" }, "preauth-decision": { decision: "REJECT", reason: "Some reason here" },
    };
    for (const [step, body] of Object.entries(bodies)) assert.equal((await post(`/claims/${s.claimId}/${step}`, body, bOfficer.token)).status, 404, step);
    assert.equal((await settle(s.claimId, "10", bOfficer.token)).status, 404);
    assert.equal((await t.api("get", `/claims/${randomUUID()}`, officer.token)).status, 404);
    assert.equal((await t.api("get", "/claims/not-an-id", officer.token)).status, 404);
    assert.equal((await post("/claims", { patientId: s.patient.id, policyId: s.policyId, type: "CASHLESS" }, bOfficer.token)).status, 404, "another hospital's patient");
    const claimNo = (await view(s.claimId)).claimNumber as string;
    const found = (await t.api("get", `/claims?q=${claimNo}`, cashier.token)).body.data;
    assert.deepEqual(found.items.map((i: { id: string }) => i.id), [s.claimId]);
    assert.equal(found.items[0].status, "SUBMITTED");
    assert.equal(((await t.api("get", "/claims?status=SUBMITTED&pageSize=100", officer.token)).body.data.items as { id: string }[]).some((i) => i.id === s.claimId), true);
    assert.equal(((await t.api("get", "/claims?pageSize=100", bOfficer.token)).body.data.items as unknown[]).length, 0);
    assert.equal((await t.api("get", "/claims?status=WHATEVER", officer.token)).status, 400);
    assert.equal((await t.api("get", "/claims?pageSize=500", officer.token)).status, 400);
  });

  it("the receivable summary lists what insurers still owe and what is waiting for a decision", async () => {
    const own = await mkInsurer(officer.token, `Summary ${uniqueWord(6)}`);
    const patient = await registerPatient(t, rec.token);
    const pol = await policy(patient.id, { insurerId: own.id });
    const waiting = await post("/claims", { patientId: patient.id, policyId: pol.body.data.id, type: "REIMBURSEMENT" });
    await post(`/claims/${waiting.body.data.id}/submit`, { invoiceId: await issued(patient.id, "4000"), claimedAmount: "3000" });
    const owed = await post("/claims", { patientId: patient.id, policyId: pol.body.data.id, type: "REIMBURSEMENT" });
    await post(`/claims/${owed.body.data.id}/submit`, { invoiceId: await issued(patient.id, "5000"), claimedAmount: "5000" });
    await post(`/claims/${owed.body.data.id}/decision`, { decision: "APPROVE", approvedAmount: "4000" });
    await settle(owed.body.data.id, "1000");
    const row = ((await t.api("get", "/claims/summary", cashier.token)).body.data as { insurerId: string; waitingForDecision: string; toReceive: string; claims: number }[]).find((x) => x.insurerId === own.id)!;
    assert.deepEqual([row.claims, row.waitingForDecision, row.toReceive], [2, "3000.00", "3000.00"]);
    assert.equal((await t.api("get", "/claims/summary", nurse.token)).status, 403);
  });

  it("the claim form prints with the policy, amounts and timeline; reception and other hospitals are kept out", async () => {
    const s = await approved("6000");
    const r = await t.api("get", `/print/claims/${s.claimId}`, officer.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = await view(s.claimId);
    for (const text of ["Insurance claim", c.claimNumber, insurer.name, c.policy.policyNumber, "6000.00", "APPROVED"]) assert.ok(r.text.includes(text), text);
    assert.equal((await t.api("get", `/print/claims/${s.claimId}`, nurse.token)).status, 403);
    assert.equal((await t.api("get", `/print/claims/${s.claimId}`, bOfficer.token)).status, 404);
  });

  it("DATABASE: the timeline and settlements cannot be rewritten; a claim cannot be deleted, moved to another patient, or finished then reopened; amounts keep their order", async () => {
    const s = await approved("6000");
    await settle(s.claimId, "1000");
    const ev = await t.prisma.claimEvent.findFirstOrThrow({ where: { claimId: s.claimId } });
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "ClaimEvent" SET note = 'x' WHERE id = '${ev.id}'::uuid`), /append-only/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "ClaimEvent" WHERE id = '${ev.id}'::uuid`), /append-only/);
    const st = await t.prisma.claimSettlement.findFirstOrThrow({ where: { claimId: s.claimId } });
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "ClaimSettlement" SET amount = 1 WHERE id = '${st.id}'::uuid`), /append-only/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "Claim" WHERE id = '${s.claimId}'::uuid`), /cannot be deleted/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Claim" SET "settledAmount" = 0 WHERE id = '${s.claimId}'::uuid`), /taken back/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Claim" SET "approvedAmount" = 99999 WHERE id = '${s.claimId}'::uuid`), /claim_amounts|check constraint/i);
    const other = await registerPatient(t, rec.token);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Claim" SET "patientId" = '${other.id}'::uuid WHERE id = '${s.claimId}'::uuid`), /moved to another patient/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "ClaimSettlement" ("tenantId", "claimId", amount, reference, "receivedOn", "createdById") VALUES ('${a.tenantId}'::uuid, '${s.claimId}'::uuid, 5000.01, 'UTRRAW1', now(), '${officer.id}'::uuid)`), /more than the approved/);
    await post(`/claims/${s.claimId}/close`, { reason: "Closed for the database check" });
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Claim" SET status = 'APPROVED' WHERE id = '${s.claimId}'::uuid`), /finished claim/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "ClaimSettlement" ("tenantId", "claimId", amount, reference, "receivedOn", "createdById") VALUES ('${a.tenantId}'::uuid, '${s.claimId}'::uuid, 1, 'UTRRAW2', now(), '${officer.id}'::uuid)`), /only be received on an approved claim/);
    const pol = await policy(other.id);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "Claim" ("tenantId", "facilityId", "patientId", "policyId", "claimNumber", type, "createdById") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${s.patient.id}'::uuid, '${pol.body.data.id}'::uuid, 'CLM-RAW-1', 'CASHLESS', '${officer.id}'::uuid)`), /policy of the same patient/);
  });

  it("concurrency: two settlements that together exceed the approved amount cannot both succeed; the same invoice cannot be claimed twice at once", async () => {
    const s = await approved("6000");
    const [x, y] = await Promise.all([settle(s.claimId, "4000"), settle(s.claimId, "4000")]);
    assert.deepEqual([x.status, y.status].sort(), [201, 409], JSON.stringify([x.body, y.body]));
    assert.equal(Number((await view(s.claimId)).settledAmount), 4000);
    assert.equal(await t.prisma.claimSettlement.count({ where: { claimId: s.claimId } }), 1);
    const patient = await registerPatient(t, rec.token);
    const pol = await policy(patient.id);
    const [c1, c2] = [await post("/claims", { patientId: patient.id, policyId: pol.body.data.id, type: "REIMBURSEMENT" }), await post("/claims", { patientId: patient.id, policyId: pol.body.data.id, type: "REIMBURSEMENT" })];
    const inv = await issued(patient.id, "9000");
    const rs = await Promise.all([post(`/claims/${c1.body.data.id}/submit`, { invoiceId: inv, claimedAmount: "9000" }), post(`/claims/${c2.body.data.id}/submit`, { invoiceId: inv, claimedAmount: "9000" })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs.map((r) => r.body)));
  });

  describe("co-pay", () => {
    /** A draft claim on a policy with a co-pay rule (10% after a 2000 deductible by default) and an issued invoice of 10000. */
    const withRule = async (rule: Record<string, unknown> = { copayPercent: "10", deductible: "2000", deductibleUsed: "0" }, total = "10000") => {
      const patient = await registerPatient(t, rec.token);
      const pol = await policy(patient.id, rule);
      assert.equal(pol.status, 201, JSON.stringify(pol.body));
      const c = await post("/claims", { patientId: patient.id, policyId: pol.body.data.id, type: "REIMBURSEMENT" });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      return { patient, policyId: pol.body.data.id as string, claimId: c.body.data.id as string, invoiceId: await issued(patient.id, total) };
    };
    const num = (v: unknown) => Number(v);

    it("previews, then submits the calculated amount by default and keeps the calculation with the claim", async () => {
      const s = await withRule();
      const p = await post(`/claims/${s.claimId}/copay-preview`, { invoiceId: s.invoiceId });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.deepEqual([p.body.data.hasRule, num(p.body.data.invoiceAmount), num(p.body.data.deductibleApplied), num(p.body.data.copayAmount), num(p.body.data.claimAmount), num(p.body.data.patientShare)], [true, 10000, 2000, 800, 7200, 2800]);
      assert.equal((await view(s.claimId)).status, "DRAFT", "a preview changes nothing");
      const r = await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const c = await view(s.claimId);
      assert.deepEqual([num(c.claimedAmount), num(c.copay.calculatedAmount), num(c.copay.patientShare), num(c.copay.copayPercent), num(c.copay.deductibleApplied), c.copay.overrideReason], [7200, 7200, 2800, 10, 2000, null]);
      const audit = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "CLAIM_SUBMITTED", entityId: s.claimId } });
      assert.equal((audit.metadata as { copayPercent?: string }).copayPercent, "10.00");
    });

    it("typing exactly the calculated amount needs no reason; a different amount needs one, and keeps it", async () => {
      const s = await withRule();
      assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "7000" })).status, 400, "no reason");
      assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "7000", overrideReason: "too short" })).status, 400, "reason under 10 characters");
      assert.equal((await view(s.claimId)).status, "DRAFT");
      const ok = await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "7000", overrideReason: "Insurer agreed a lower package rate" });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const c = await view(s.claimId);
      assert.deepEqual([num(c.claimedAmount), num(c.copay.calculatedAmount), num(c.copay.patientShare), c.copay.overrideReason], [7000, 7200, 3000, "Insurer agreed a lower package rate"]);
      const audit = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "CLAIM_SUBMITTED", entityId: s.claimId } });
      assert.equal((audit.metadata as { overridden?: boolean }).overridden, true);
      const same = await withRule();
      assert.equal((await post(`/claims/${same.claimId}/submit`, { invoiceId: same.invoiceId, claimedAmount: "7200.00" })).status, 200, "the calculated amount typed in by hand");
      assert.equal((await view(same.claimId)).copay.overrideReason, null);
      const more = await withRule();
      assert.equal((await post(`/claims/${more.claimId}/submit`, { invoiceId: more.invoiceId, claimedAmount: "10001", overrideReason: "Claiming above the invoice" })).status, 400, "never more than the invoice");
    });

    it("a policy without a rule still needs the amount entered by hand, as before", async () => {
      const s = await setup("REIMBURSEMENT");
      const p = await post(`/claims/${s.claimId}/copay-preview`, { invoiceId: s.invoiceId });
      assert.deepEqual([p.status, p.body.data.hasRule], [200, false]);
      assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId })).status, 400);
      assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "8000" })).status, 200);
      assert.equal((await view(s.claimId)).copay, null);
    });

    it("when the patient's share covers the whole bill there is nothing to claim", async () => {
      const s = await withRule({ copayPercent: "10", deductible: "20000", deductibleUsed: "0" });
      const r = await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId });
      assert.deepEqual([r.status, r.body.error.code], [409, "INVALID_STATE"]);
      assert.equal((await view(s.claimId)).status, "DRAFT");
    });

    it("the rule is validated and changed only by the claims officer; the change is audited and old claims keep their calculation", async () => {
      const s = await withRule();
      assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId })).status, 200);
      const put = (body: Record<string, unknown>, tok = officer.token, id = s.policyId) => t.api("put", `/policies/${id}/copay`, tok).send(body);
      assert.equal((await put({ copayPercent: "101", deductible: "0", deductibleUsed: "0" })).status, 400, "over 100%");
      assert.equal((await put({ copayPercent: "-1", deductible: "0", deductibleUsed: "0" })).status, 400);
      assert.equal((await put({ copayPercent: "10", deductible: "100", deductibleUsed: "200" })).status, 400, "used more than the deductible");
      assert.equal((await put({ copayPercent: "10", deductible: "100" })).status, 400, "missing field");
      assert.equal((await put({ copayPercent: "10", deductible: "0", deductibleUsed: "0", extra: 1 })).status, 400);
      for (const tok of [rec.token, nurse.token, cashier.token]) assert.equal((await put({ copayPercent: "20", deductible: "0", deductibleUsed: "0" }, tok)).status, 403);
      assert.equal((await put({ copayPercent: "20", deductible: "0", deductibleUsed: "0" }, bOfficer.token)).status, 404, "another hospital's policy");
      assert.equal((await put({ copayPercent: "20", deductible: "0", deductibleUsed: "0" }, officer.token, randomUUID())).status, 404);
      const ok = await put({ copayPercent: "20", deductible: "0", deductibleUsed: "0" });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual([num(ok.body.data.copayPercent), ok.body.data.hasCopayRule], [20, true]);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "POLICY_COPAY_CHANGED", entityId: s.policyId } }));
      const c = await view(s.claimId);
      assert.deepEqual([num(c.copay.copayPercent), num(c.copay.patientShare)], [10, 2800], "the submitted claim keeps the calculation it was made with");
      const removed = await put({ copayPercent: null, deductible: "0", deductibleUsed: "0" });
      assert.deepEqual([removed.status, removed.body.data.hasCopayRule, removed.body.data.copayPercent], [200, false, null]);
    });

    it("a resubmitted amount that moves away from the calculation needs a reason", async () => {
      const s = await withRule();
      assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId })).status, 200);
      assert.equal((await post(`/claims/${s.claimId}/query`, { note: "Please send the discharge card" })).status, 200);
      assert.equal((await post(`/claims/${s.claimId}/resubmit`, { note: "Sent the discharge card", claimedAmount: "7000" })).status, 400, "no reason");
      const ok = await post(`/claims/${s.claimId}/resubmit`, { note: "Sent the discharge card", claimedAmount: "7000", overrideReason: "Insurer corrected the package rate" });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const c = await view(s.claimId);
      assert.deepEqual([num(c.claimedAmount), num(c.copay.patientShare), c.copay.overrideReason], [7000, 3000, "Insurer corrected the package rate"]);
    });

    it("other hospitals, other roles and made-up ids cannot preview; database rules hold", async () => {
      const s = await withRule();
      assert.equal((await post(`/claims/${s.claimId}/copay-preview`, { invoiceId: s.invoiceId }, bOfficer.token)).status, 404, "another hospital's claim");
      assert.equal((await post(`/claims/${s.claimId}/copay-preview`, { invoiceId: s.invoiceId }, nurse.token)).status, 403);
      assert.equal((await post(`/claims/${randomUUID()}/copay-preview`, { invoiceId: s.invoiceId })).status, 404);
      assert.equal((await post(`/claims/${s.claimId}/copay-preview`, { invoiceId: randomUUID() })).status, 404, "an invoice that does not exist");
      const other = await registerPatient(t, rec.token);
      assert.equal((await post(`/claims/${s.claimId}/copay-preview`, { invoiceId: await issued(other.id) })).status, 404, "another patient's invoice");
      assert.equal((await post(`/claims/${s.claimId}/copay-preview`, { invoiceId: s.invoiceId, extra: 1 })).status, 400);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientPolicy" SET "copayPercent" = 150 WHERE id = '${s.policyId}'::uuid`), /policy_copay_values|check constraint/i);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientPolicy" SET deductible = -1 WHERE id = '${s.policyId}'::uuid`), /policy_copay_values|check constraint/i);
      assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId })).status, 200);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Claim" SET "amountOverrideReason" = 'short' WHERE id = '${s.claimId}'::uuid`), /claim_copay_values|check constraint/i);
    });
  });

  it("documents: PNG, JPEG and PDF are attached to an open claim; the content is checked; the officer adds and removes; a finished claim keeps what it had", async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not-really-pixels")]);
    const PDF = Buffer.from("%PDF-1.4 not really a pdf");
    const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("not-really-jpeg")]);
    const s = await setup();
    const up = (claimId: string, tok: string, body: Buffer | string, type: string, query: Record<string, string> = { filename: "discharge.pdf", label: "Discharge summary" }) => t.api("post", `/claims/${claimId}/documents`, tok).query(query).set("Content-Type", type).send(body);

    const ok = await up(s.claimId, officer.token, PDF, "application/pdf");
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.data.label, ok.body.data.fileName, ok.body.data.contentType, ok.body.data.sizeBytes], ["Discharge summary", "discharge.pdf", "application/pdf", PDF.length]);
    assert.equal((await up(s.claimId, officer.token, PNG, "image/png", { filename: "policy-card.png", label: "Policy card" })).status, 201);
    assert.equal((await up(s.claimId, officer.token, JPG, "image/jpeg", { filename: "id.jpg", label: "ID proof" })).status, 201);

    // who may add, and what is refused
    assert.equal((await up(s.claimId, cashier.token, PDF, "application/pdf")).status, 403, "reading claims is not managing them");
    assert.equal((await up(s.claimId, rec.token, PDF, "application/pdf")).status, 403);
    assert.equal((await up(s.claimId, nurse.token, PDF, "application/pdf")).status, 403);
    assert.equal((await up(s.claimId, bOfficer.token, PDF, "application/pdf")).status, 404, "another hospital cannot reach this claim");
    assert.equal((await up(randomUUID(), officer.token, PDF, "application/pdf")).status, 404);
    assert.equal((await up(s.claimId, officer.token, "<html><script>alert(1)</script></html>", "application/pdf")).status, 415, "HTML disguised as a PDF");
    assert.equal((await up(s.claimId, officer.token, PDF, "image/png")).status, 415, "type must match the content");
    assert.equal((await up(s.claimId, officer.token, Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]), "application/pdf")).status, 413, "over 5 MB");
    assert.equal((await up(s.claimId, officer.token, PDF, "application/pdf", { filename: "x.pdf", label: "x" })).status, 400, "a label of at least two characters");
    assert.equal((await up(s.claimId, officer.token, PDF, "application/pdf", { filename: "x.pdf" })).status, 400, "a label is needed");

    // who may look
    const list = await t.api("get", `/claims/${s.claimId}/documents`, officer.token);
    assert.deepEqual(list.body.data.map((d: { label: string }) => d.label), ["Discharge summary", "Policy card", "ID proof"]);
    assert.equal((await t.api("get", `/claims/${s.claimId}/documents`, cashier.token)).status, 200);
    assert.equal((await t.api("get", `/claims/${s.claimId}/documents`, nurse.token)).status, 403);
    assert.equal((await t.api("get", `/claims/${s.claimId}/documents`, bOfficer.token)).status, 404);

    const docId = ok.body.data.id as string;
    const got = await t.api("get", `/claim-documents/${docId}/content`, cashier.token).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    assert.equal(got.status, 200);
    assert.deepEqual([got.headers["content-type"], got.headers["x-content-type-options"], got.headers["cache-control"]], ["application/pdf", "nosniff", "private, no-store"]);
    assert.match(String(got.headers["content-disposition"]), /^attachment/);
    assert.ok((got.body as Buffer).equals(PDF), "the same bytes come back");
    assert.equal((await t.api("get", `/claim-documents/${docId}/content`, bOfficer.token)).status, 404);
    assert.equal((await t.api("get", `/claim-documents/${docId}/content`, nurse.token)).status, 403);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CLAIM_DOCUMENT_VIEWED", entityId: docId, actorUserId: cashier.id } }), "opening a document is audited");

    // removing: a reason, the claims officer only, and the record stays
    assert.equal((await t.api("post", `/claim-documents/${docId}/remove`, cashier.token).send({ reason: "Wrong document" })).status, 403);
    assert.equal((await t.api("post", `/claim-documents/${docId}/remove`, officer.token).send({ reason: "no" })).status, 400);
    assert.equal((await t.api("post", `/claim-documents/${docId}/remove`, bOfficer.token).send({ reason: "Wrong document" })).status, 404);
    assert.equal((await t.api("post", `/claim-documents/${docId}/remove`, officer.token).send({ reason: "Wrong document" })).status, 200);
    assert.equal((await t.api("post", `/claim-documents/${docId}/remove`, officer.token).send({ reason: "Wrong document" })).status, 409);
    assert.equal((await t.api("get", `/claim-documents/${docId}/content`, officer.token)).status, 404, "a removed document no longer opens");
    assert.equal((await t.api("get", `/claims/${s.claimId}/documents`, officer.token)).body.data.length, 2);
    const row = await t.prisma.claimDocument.findFirstOrThrow({ where: { id: docId } });
    assert.deepEqual([row.status, row.removeReason, row.removedById], ["REMOVED", "Wrong document", officer.id]);
    assert.deepEqual((await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: docId } })).map((e) => e.action).sort(), ["CLAIM_DOCUMENT_ADDED", "CLAIM_DOCUMENT_REMOVED", "CLAIM_DOCUMENT_VIEWED"]);

    // database rules on an open claim
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "ClaimDocument" WHERE id = '${docId}'::uuid`), /append-only/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "ClaimDocument" SET label = 'Something else' WHERE id = '${docId}'::uuid`), /cannot be edited/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "ClaimDocument" SET status = 'ACTIVE' WHERE id = '${docId}'::uuid`), /cannot be restored/);
    const insert = (patientId: string, claimId: string, type = "application/pdf") => `INSERT INTO "ClaimDocument" ("tenantId", "facilityId", "patientId", "claimId", label, "fileName", "contentType", "sizeBytes", sha256, "storageKey", "uploadedById") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${patientId}'::uuid, '${claimId}'::uuid, 'Label', 'x.pdf', '${type}', 10, 'abc', 'k', '${officer.id}'::uuid)`;
    await assert.rejects(t.prisma.$executeRawUnsafe(insert(randomUUID(), s.claimId)), /same patient and facility/);
    await assert.rejects(t.prisma.$executeRawUnsafe(insert(s.patient.id, s.claimId, "image/svg+xml")), /check/i);

    // a finished claim keeps what it had and takes nothing more
    assert.equal((await post(`/claims/${s.claimId}/close`, { reason: "Patient withdrew the claim" })).status, 200);
    assert.equal((await up(s.claimId, officer.token, PDF, "application/pdf")).status, 409, "no documents for a finished claim");
    const keep = (await t.api("get", `/claims/${s.claimId}/documents`, officer.token)).body.data[0] as { id: string };
    assert.equal((await t.api("post", `/claim-documents/${keep.id}/remove`, officer.token).send({ reason: "Trying to tidy up" })).status, 409, "nor can they be removed");
    assert.equal((await t.api("get", `/claims/${s.claimId}/documents`, officer.token)).body.data.length, 2, "still readable");
    await assert.rejects(t.prisma.$executeRawUnsafe(insert(s.patient.id, s.claimId)), /finished claim/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "ClaimDocument" SET status = 'REMOVED', "removedById" = '${officer.id}'::uuid, "removedAt" = now(), "removeReason" = 'Trying to tidy up' WHERE id = '${keep.id}'::uuid`), /finished claim/);
  });

  it("documents: a claim holds at most 30; removing one makes room", async () => {
    const PDF = Buffer.from("%PDF-1.4 x");
    const s = await setup();
    const up = () => t.api("post", `/claims/${s.claimId}/documents`, officer.token).query({ filename: "d.pdf", label: "Report" }).set("Content-Type", "application/pdf").send(PDF);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) { const r = await up(); assert.equal(r.status, 201, JSON.stringify(r.body)); ids.push(r.body.data.id as string); }
    assert.equal((await up()).status, 409);
    assert.equal((await t.api("post", `/claim-documents/${ids[0]}/remove`, officer.token).send({ reason: "Duplicate scan" })).status, 200);
    assert.equal((await up()).status, 201);
  });

  it("the claims officer role exists with what it needs", async () => {
    const r = await t.prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, name: "CLAIMS_OFFICER", isSystem: true }, include: { permissions: true } });
    for (const p of ["CLAIM_READ", "CLAIM_MANAGE", "CLAIM_SETTLE", "CLAIM_MASTERS"]) assert.ok(r.permissions.some((x) => x.permission === p), p);
  });
});
