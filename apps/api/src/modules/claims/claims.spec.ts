import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";
import { nextStatus, stepsFrom, type ClaimStatus, type ClaimStep } from "./claims.domain";

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

  it("the claims officer role exists with what it needs", async () => {
    const r = await t.prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, name: "CLAIMS_OFFICER", isSystem: true }, include: { permissions: true } });
    for (const p of ["CLAIM_READ", "CLAIM_MANAGE", "CLAIM_SETTLE", "CLAIM_MASTERS"]) assert.ok(r.permissions.some((x) => x.permission === p), p);
  });
});
