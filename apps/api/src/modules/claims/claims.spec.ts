import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";
import { Decimal } from "@medos/shared";
import { CLAIM_TRANSPORT, HttpClaimTransport, type ClaimTransport } from "./claim-transport";
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
  let admin: User; let officer: User; let cashier: User; let rec: User; let nurse: User; let bOfficer: User;
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
    admin = await t.makeUser(a, ["ADMINISTRATOR"]); officer = await t.makeUser(a, ["CLAIMS_OFFICER"]); cashier = await t.makeUser(a, ["CASHIER"]); rec = await t.makeUser(a, ["RECEPTIONIST"]); nurse = await t.makeUser(a, ["NURSE"]); bOfficer = await t.makeUser(b, ["CLAIMS_OFFICER"]);
    insurer = await mkInsurer();
  });
  after(async () => { await t.close(); });

  it("claim package: only for a submitted claim, with the invoice lines and documents; for the claims officer only; audited; never across hospitals", async () => {
    const s = await setup();
    const pkg = (id: string, tok = officer.token) => t.api("get", `/claims/${id}/package`, tok);
    assert.equal((await pkg(s.claimId)).status, 409, "a draft claim has no invoice yet, so no package");
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "8000" })).status, 200);
    const ok = await pkg(s.claimId);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const d = ok.body.data;
    assert.equal(d.format, "medos-claim-package/1");
    assert.equal(d.transmitted, false, "MedOS does not send it");
    assert.equal(d.claim.id, s.claimId);
    assert.equal(d.invoice.total, "10000.00");
    assert.ok(d.invoice.lines.length >= 1);
    assert.deepEqual(d.documents, []);
    assert.equal((await pkg(s.claimId, cashier.token)).status, 403, "claims officer only");
    assert.equal((await pkg(s.claimId, nurse.token)).status, 403);
    assert.equal((await pkg(s.claimId, bOfficer.token)).status, 404, "another hospital cannot see it");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CLAIM_PACKAGE_EXPORTED", entityId: s.claimId } }), "exporting is audited");
  });

  it("payer verification: recorded with the insurer's reference; a 'not eligible' answer needs a reason and stops pre-authorisation until a new check; officer only; audited; not across hospitals", async () => {
    const s = await setup();
    const verify = (id: string, body: Record<string, unknown>, tok = officer.token) => post(`/claims/${id}/verification`, body, tok);
    assert.equal((await view(s.claimId)).verification, null, "nothing recorded yet");
    assert.equal((await verify(s.claimId, { outcome: "VERIFIED" })).status, 400, "the insurer's reference is required");
    assert.equal((await verify(s.claimId, { outcome: "NOT_ELIGIBLE", reference: "CALL-001" })).status, 400, "a not-eligible answer needs the reason given");
    assert.equal((await verify(s.claimId, { outcome: "MAYBE", reference: "CALL-001" })).status, 400);
    assert.equal((await verify(s.claimId, { outcome: "VERIFIED", reference: "CALL-001", extra: 1 })).status, 400, "unexpected fields are refused");
    assert.equal((await verify(s.claimId, { outcome: "NOT_ELIGIBLE", reference: "CALL-001", note: "Policy lapsed on 1 Oct" })).status, 200);
    const no = (await view(s.claimId)).verification;
    assert.deepEqual([no.outcome, no.reference, no.note], ["NOT_ELIGIBLE", "CALL-001", "Policy lapsed on 1 Oct"]);
    assert.equal((await post(`/claims/${s.claimId}/preauth`, { requestedAmount: "9000" })).status, 409, "no pre-authorisation request on a patient the insurer said is not eligible");
    assert.equal((await verify(s.claimId, { outcome: "VERIFIED", reference: "PORTAL-77", note: "Renewed, active" })).status, 200, "a new check replaces the old answer");
    const yes = await view(s.claimId);
    assert.deepEqual([yes.verification.outcome, yes.verification.reference, typeof yes.verification.by], ["VERIFIED", "PORTAL-77", "string"]);
    assert.equal((await post(`/claims/${s.claimId}/preauth`, { requestedAmount: "9000" })).status, 200);
    assert.equal(yes.events.filter((e: { note: string | null }) => e.note?.includes("ref ")).length, 2, "both checks stay on the timeline");
    assert.equal((await verify(s.claimId, { outcome: "VERIFIED", reference: "X-1" }, cashier.token)).status, 403, "claims officer only");
    assert.equal((await verify(s.claimId, { outcome: "VERIFIED", reference: "X-1" }, nurse.token)).status, 403);
    assert.equal((await verify(s.claimId, { outcome: "VERIFIED", reference: "X-1" }, bOfficer.token)).status, 404, "another hospital cannot touch it");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CLAIM_PAYER_VERIFIED", entityId: s.claimId } }), "verification is audited");
    const closed = await setup("REIMBURSEMENT");
    assert.equal((await post(`/claims/${closed.claimId}/close`, { reason: "Patient withdrew" })).status, 200);
    assert.equal((await verify(closed.claimId, { outcome: "VERIFIED", reference: "LATE-1" })).status, 409, "a finished claim is not verified again");
  });

  it("enhancement requests: asked while the pre-authorisation is approved; one at a time; approval adds to the authorised amount; rejection keeps it; decided once; blocks submission while waiting", async () => {
    const s = await setup("CASHLESS", "20000");
    const ask = (id: string, body: Record<string, unknown>, tok = officer.token) => post(`/claims/${id}/enhancements`, body, tok);
    const decide = (id: string, eid: string, body: Record<string, unknown>, tok = officer.token) => post(`/claims/${id}/enhancements/${eid}/decision`, body, tok);
    assert.equal((await ask(s.claimId, { requestedAmount: "3000", reason: "Longer ICU stay than planned" })).status, 409, "nothing is authorised yet, so there is nothing to enhance");
    assert.equal((await post(`/claims/${s.claimId}/preauth`, { requestedAmount: "9000" })).status, 200);
    assert.equal((await ask(s.claimId, { requestedAmount: "3000", reason: "Longer ICU stay than planned" })).status, 409, "the first pre-authorisation is still waiting");
    assert.equal((await post(`/claims/${s.claimId}/preauth-decision`, { decision: "APPROVE", amount: "7500" })).status, 200);
    for (const bad of [{ requestedAmount: "0", reason: "Longer ICU stay than planned" }, { requestedAmount: "-5", reason: "Longer ICU stay than planned" }, { requestedAmount: "3000", reason: "short" }, { requestedAmount: "3000" }, { requestedAmount: "3000", reason: "Longer ICU stay than planned", extra: 1 }]) assert.equal((await ask(s.claimId, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await ask(s.claimId, { requestedAmount: "3000", reason: "Longer ICU stay than planned" }, cashier.token)).status, 403, "claims officer only");
    assert.equal((await ask(s.claimId, { requestedAmount: "3000", reason: "Longer ICU stay than planned" }, bOfficer.token)).status, 404, "another hospital cannot ask on this claim");
    const first = await ask(s.claimId, { requestedAmount: "3000", reason: "Longer ICU stay than planned" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const eid = first.body.data.id as string;
    assert.equal((await ask(s.claimId, { requestedAmount: "1000", reason: "Another request while one waits" })).status, 409, "one request waits at a time");
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "10000" })).status, 409, "cannot submit while the insurer has not answered");
    assert.equal((await decide(s.claimId, eid, { decision: "APPROVE" })).status, 400, "an approval needs an amount");
    assert.equal((await decide(s.claimId, eid, { decision: "APPROVE", amount: "3500" })).status, 400, "not more than was asked for");
    assert.equal((await decide(s.claimId, eid, { decision: "REJECT" })).status, 400, "a rejection needs the insurer's reason");
    assert.equal((await decide(s.claimId, eid, { decision: "APPROVE", amount: "2000" }, nurse.token)).status, 403);
    assert.equal((await decide(s.claimId, eid, { decision: "APPROVE", amount: "2000" }, bOfficer.token)).status, 404);
    assert.equal((await decide(s.claimId, randomUUID(), { decision: "APPROVE", amount: "2000" })).status, 404, "an unknown request");
    const ok = await decide(s.claimId, eid, { decision: "APPROVE", amount: "2000", reason: "Approved for 2 more ICU days" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.authorised, "9500.00", "7,500 + 2,000");
    assert.equal((await decide(s.claimId, eid, { decision: "REJECT", reason: "Changed their mind" })).status, 409, "a decision is made once");
    let v = await view(s.claimId);
    assert.equal(v.preauthApproved, "9500.00");
    assert.deepEqual(v.enhancements.map((e: { status: string; requestedAmount: string; approvedAmount: string | null }) => [e.status, e.requestedAmount, e.approvedAmount]), [["APPROVED", "3000.00", "2000.00"]]);
    const second = await ask(s.claimId, { requestedAmount: "1500", reason: "Complication needs extra tests" });
    assert.equal(second.status, 201, "a new request can follow a decided one");
    assert.equal((await decide(s.claimId, second.body.data.id, { decision: "REJECT", reason: "Not covered under the plan" })).status, 200);
    v = await view(s.claimId);
    assert.equal(v.preauthApproved, "9500.00", "a rejection changes nothing");
    assert.deepEqual(v.enhancements.map((e: { status: string }) => e.status), ["APPROVED", "REJECTED"]);
    assert.ok(v.events.some((e: { note: string | null }) => e.note?.startsWith("Enhancement approved")), "on the timeline");
    for (const action of ["CLAIM_ENHANCEMENT_REQUESTED", "CLAIM_ENHANCEMENT_APPROVED", "CLAIM_ENHANCEMENT_REJECTED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action, entityId: s.claimId } }), `${action} is audited`);
    await assert.rejects(() => t.prisma.claimEnhancement.update({ where: { tenantId_id: { tenantId: a.tenantId, id: eid } }, data: { approvedAmount: "9999.00" } }), "a decided request cannot be changed, even directly in the database");
    await assert.rejects(() => t.prisma.claimEnhancement.delete({ where: { tenantId_id: { tenantId: a.tenantId, id: eid } } }), "nor deleted");
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "10000" })).status, 200, "with nothing waiting, the claim goes to the insurer");
    assert.equal((await ask(s.claimId, { requestedAmount: "500", reason: "Too late, already submitted" })).status, 409, "after submission the stay is over");
    const r = await setup("REIMBURSEMENT");
    assert.equal((await ask(r.claimId, { requestedAmount: "500", reason: "Reimbursement has no pre-authorisation" })).status, 409, "cashless claims only");
  });

  it("non-payable items: left out of the claim and paid by the patient; changed only before submission or under query; never over the invoice; removed with a reason; officer only", async () => {
    const s = await setup("CASHLESS", "10000");
    const add = (id: string, body: Record<string, unknown>, tok = officer.token) => post(`/claims/${id}/non-payables`, body, tok);
    const item = { description: "Consumables excluded by the policy", amount: "1500", reason: "Excluded in the policy schedule" };
    for (const bad of [{ ...item, amount: "0" }, { ...item, amount: "-1" }, { ...item, description: "x" }, { ...item, reason: "no" }, { description: item.description, amount: "10" }, { ...item, extra: 1 }]) assert.equal((await add(s.claimId, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await add(s.claimId, item, cashier.token)).status, 403, "claims officer only");
    assert.equal((await add(s.claimId, item, bOfficer.token)).status, 404, "another hospital cannot add to this claim");
    const one = await add(s.claimId, item);
    assert.equal(one.status, 201, JSON.stringify(one.body));
    assert.equal((await view(s.claimId)).nonPayableTotal, "1500.00");
    const prev = (await post(`/claims/${s.claimId}/copay-preview`, { invoiceId: s.invoiceId })).body.data;
    assert.deepEqual([prev.hasRule, prev.invoiceAmount, prev.nonPayable, prev.mostToClaim], [false, "10000.00", "1500.00", "8500.00"]);
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "9000" })).status, 400, "cannot claim what the insurer will not pay");
    assert.equal((await post(`/claims/${s.claimId}/submit`, { invoiceId: s.invoiceId, claimedAmount: "8500" })).status, 200);
    assert.equal((await add(s.claimId, item)).status, 409, "once submitted the items are fixed");
    assert.equal((await post(`/claims/${s.claimId}/query`, { note: "Please explain the room charges" })).status, 200);
    assert.equal((await add(s.claimId, { description: "Admission kit", amount: "500", reason: "Excluded in the policy schedule" })).status, 201, "while the claim is under query items can be added");
    assert.equal((await post(`/claims/${s.claimId}/resubmit`, { note: "Replied with the room tariff", claimedAmount: "8500" })).status, 400, "the claim must come down to what can still be claimed");
    assert.equal((await post(`/claims/${s.claimId}/resubmit`, { note: "Replied; admission kit not payable", claimedAmount: "8000" })).status, 200);
    assert.equal((await view(s.claimId)).claimedAmount, "8000.00");
    assert.equal((await add(s.claimId, item)).status, 409);

    const r = await setup("CASHLESS", "1000");
    assert.equal((await add(r.claimId, { description: "Everything", amount: "1000.01", reason: "Excluded in the policy schedule" })).status, 201, "before an invoice is attached there is nothing to compare with");
    assert.equal((await post(`/claims/${r.claimId}/submit`, { invoiceId: r.invoiceId, claimedAmount: "100" })).status, 400, "non-payable items above the invoice stop submission");
    const gone = await add(r.claimId, { description: "Wrong entry", amount: "5", reason: "Excluded in the policy schedule" });
    const goneId = gone.body.data.id as string;
    assert.equal((await post(`/claims/${r.claimId}/non-payables/${goneId}/remove`, { reason: "x" })).status, 400, "a reason is needed");
    assert.equal((await post(`/claims/${r.claimId}/non-payables/${goneId}/remove`, { reason: "Entered on the wrong claim" }, cashier.token)).status, 403);
    assert.equal((await post(`/claims/${r.claimId}/non-payables/${goneId}/remove`, { reason: "Entered on the wrong claim" })).status, 200);
    assert.equal((await post(`/claims/${r.claimId}/non-payables/${goneId}/remove`, { reason: "Entered on the wrong claim" })).status, 409, "already removed");
    const shown = (await view(r.claimId)).nonPayables as { id: string; status: string }[];
    assert.deepEqual(shown.map((n) => n.status), ["ACTIVE", "REMOVED"], "a removed item stays on the record");
    await assert.rejects(() => t.prisma.claimNonPayable.delete({ where: { tenantId_id: { tenantId: a.tenantId, id: goneId } } }), "never deleted, even directly in the database");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CLAIM_NON_PAYABLE_REMOVED", entityId: r.claimId } }));
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CLAIM_NON_PAYABLE_ADDED", entityId: s.claimId } }));
  });

  it("non-payable items with a co-pay rule: the percentage applies to what is payable; the patient bears the non-payable items plus the co-pay", async () => {
    const patient = await registerPatient(t, rec.token);
    const pol = await policy(patient.id, { copayPercent: "10" });
    const c = await post("/claims", { patientId: patient.id, policyId: pol.body.data.id, type: "CASHLESS" });
    const invoiceId = await issued(patient.id, "10000");
    assert.equal((await post(`/claims/${c.body.data.id}/non-payables`, { description: "Excluded implant accessories", amount: "2000", reason: "Excluded in the policy schedule" })).status, 201);
    const prev = (await post(`/claims/${c.body.data.id}/copay-preview`, { invoiceId })).body.data;
    assert.deepEqual([prev.nonPayable, prev.copayAmount, prev.claimAmount, prev.patientShare], ["2000.00", "800.00", "7200.00", "2800.00"]);
    assert.equal((await post(`/claims/${c.body.data.id}/submit`, { invoiceId })).status, 200);
    const v = await view(c.body.data.id);
    assert.deepEqual([v.claimedAmount, v.copay.patientShare], ["7200.00", "2800.00"], "patient share = non-payable 2,000 + co-pay 800");
  });

  it("appeals: only against a claim rejected after submission; one at a time; overturned means approved again and settlement follows; upheld stays rejected; decided once; the database refuses any other reopening", async () => {
    const rejected = async () => {
      const s = await submitted();
      assert.equal((await post(`/claims/${s.claimId}/decision`, { decision: "REJECT", reason: "Pre-existing condition" })).status, 200);
      return s;
    };
    const appeal = (id: string, body: Record<string, unknown>, tok = officer.token) => post(`/claims/${id}/appeals`, body, tok);
    const decide = (id: string, aid: string, body: Record<string, unknown>, tok = officer.token) => post(`/claims/${id}/appeals/${aid}/decision`, body, tok);
    const reason = "Records show the condition was declared and covered";

    const live = await submitted();
    assert.equal((await appeal(live.claimId, { reason })).status, 409, "a claim still with the insurer is not appealed");
    const early = await setup("CASHLESS");
    await post(`/claims/${early.claimId}/preauth`, { requestedAmount: "5000" });
    await post(`/claims/${early.claimId}/preauth-decision`, { decision: "REJECT", reason: "Waiting period not over" });
    assert.equal((await appeal(early.claimId, { reason })).status, 409, "a refused pre-authorisation is not appealed; start a new claim");

    const s = await rejected();
    for (const bad of [{ reason: "short" }, {}, { reason, extra: 1 }]) assert.equal((await appeal(s.claimId, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await appeal(s.claimId, { reason }, cashier.token)).status, 403, "claims officer only");
    assert.equal((await appeal(s.claimId, { reason }, bOfficer.token)).status, 404, "another hospital cannot appeal this claim");
    const first = await appeal(s.claimId, { reason });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const aid = first.body.data.id as string;
    assert.equal((await appeal(s.claimId, { reason })).status, 409, "one appeal waits at a time");
    assert.equal((await decide(s.claimId, aid, { decision: "OVERTURN" })).status, 400, "needs the amount now approved");
    assert.equal((await decide(s.claimId, aid, { decision: "OVERTURN", amount: "8000.01" })).status, 400, "not more than was claimed");
    assert.equal((await decide(s.claimId, aid, { decision: "UPHOLD" })).status, 400, "an upheld rejection needs their reason");
    assert.equal((await decide(s.claimId, aid, { decision: "OVERTURN", amount: "6000" }, nurse.token)).status, 403);
    assert.equal((await decide(s.claimId, aid, { decision: "OVERTURN", amount: "6000" }, bOfficer.token)).status, 404);
    assert.equal((await decide(s.claimId, randomUUID(), { decision: "OVERTURN", amount: "6000" })).status, 404);
    const win = await decide(s.claimId, aid, { decision: "OVERTURN", amount: "6000", reason: "Reviewed by the medical board" });
    assert.equal(win.status, 200, JSON.stringify(win.body));
    assert.equal((await decide(s.claimId, aid, { decision: "UPHOLD", reason: "Changed their mind" })).status, 409, "decided once");
    const v = await view(s.claimId);
    assert.deepEqual([v.status, v.approvedAmount, v.closeReason, v.appeals.map((x: { status: string }) => x.status)], ["APPROVED", "6000.00", null, ["OVERTURNED"]]);
    assert.ok(v.events.some((e: { from: string | null; to: string }) => e.from === "REJECTED" && e.to === "APPROVED"), "the reversal is on the timeline");
    const paid = await settle(s.claimId, "6000");
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.equal((await view(s.claimId)).status, "SETTLED", "the normal settlement follows");
    assert.equal((await invoice(s.invoiceId)).paidTotal, "6000.00");

    const u = await rejected();
    const lost = await appeal(u.claimId, { reason });
    assert.equal((await decide(u.claimId, lost.body.data.id, { decision: "UPHOLD", reason: "Exclusion applies" })).status, 200);
    const again = await view(u.claimId);
    assert.deepEqual([again.status, again.appeals.map((x: { status: string }) => x.status)], ["REJECTED", ["UPHELD"]]);
    assert.equal((await appeal(u.claimId, { reason: "A second review with new reports" })).status, 201, "a new appeal can follow a lost one");
    await assert.rejects(() => t.prisma.claim.update({ where: { tenantId_id: { tenantId: a.tenantId, id: u.claimId } }, data: { status: "APPROVED", approvedAmount: "100.00" } }), "no appeal was overturned, so the database refuses to reopen the claim");
    await assert.rejects(() => t.prisma.claimAppeal.update({ where: { tenantId_id: { tenantId: a.tenantId, id: lost.body.data.id } }, data: { status: "OVERTURNED", approvedAmount: "100.00" } }), "a decided appeal cannot change");
    for (const action of ["CLAIM_APPEAL_REQUESTED", "CLAIM_APPEAL_OVERTURNED", "CLAIM_APPEAL_UPHELD"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action } }), `${action} is audited`);
  });

  it("tax deducted at source: cash plus TDS settle the claim; the invoice is credited with both; the TDS is posted as a marked 'other' payment; nothing exceeds the approved amount", async () => {
    const s = await approved("6000");
    const paid = (body: Record<string, unknown>, k = key()) => t.api("post", `/claims/${s.claimId}/settlements`, officer.token).set("Idempotency-Key", k).send({ reference: `UTR${uniqueWord(8)}`, receivedOn: iso(0), ...body });
    assert.equal((await paid({ amount: "100", tdsAmount: "-1" })).status, 400, "TDS cannot be negative");
    assert.equal((await paid({ amount: "100", tdsAmount: "10.123" })).status, 400);
    assert.equal((await paid({ amount: "5500", tdsAmount: "600" })).status, 409, "cash and TDS together cannot pass the approved amount");
    const k = key();
    const body = { amount: "3500", tdsAmount: "400", reference: "UTR-TDS-0001" };
    const first = await paid(body, k);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.settledAmount, "3900.00", "cash and TDS both count");
    assert.equal(first.body.data.outstanding, "2100.00");
    assert.equal((await paid(body, k)).status, 200, "a retry with the same key replays and posts nothing twice");
    const last = await paid({ amount: "2000", tdsAmount: "100" });
    assert.equal(last.status, 201, JSON.stringify(last.body));
    const v = await view(s.claimId);
    assert.deepEqual([v.status, v.settledAmount, v.outstanding], ["SETTLED", "6000.00", "0.00"]);
    assert.deepEqual(v.settlements.map((x: { amount: string; tdsAmount: string }) => [x.amount, x.tdsAmount]), [["3500.00", "400.00"], ["2000.00", "100.00"]]);
    assert.equal((await invoice(s.invoiceId)).paidTotal, "6000.00", "the invoice is credited with cash plus tax deducted");
    const pays = await t.prisma.payment.findMany({ where: { tenantId: a.tenantId, receipt: { invoiceId: s.invoiceId } }, select: { method: true, amount: true, reference: true } });
    const tds = pays.filter((x) => x.method === "OTHER");
    assert.deepEqual(tds.map((x) => x.amount.toString()).sort(), ["100", "400"]);
    assert.ok(tds.every((x) => x.reference?.startsWith("TDS ")), "marked as TDS");
    assert.equal(pays.filter((x) => x.method === "BANK_TRANSFER").reduce((n, x) => n + Number(x.amount), 0), 5500);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CLAIM_SETTLEMENT_RECEIVED", entityId: s.claimId, metadata: { path: ["tds"], equals: "400.00" } } }), "the audit trail shows the TDS");
  });

  it("several invoices on one claim: claimed together, held by this claim only, money allocated main invoice first; more can join while under query", async () => {
    const patient = await registerPatient(t, rec.token);
    const pol = await policy(patient.id);
    const mk = async () => (await post("/claims", { patientId: patient.id, policyId: pol.body.data.id, type: "REIMBURSEMENT" })).body.data.id as string;
    const inv1 = await issued(patient.id, "6000"); const inv2 = await issued(patient.id, "4000"); const inv3 = await issued(patient.id, "1000");
    const claimId = await mk();
    assert.equal((await post(`/claims/${claimId}/submit`, { invoiceId: inv1, extraInvoiceIds: [inv1], claimedAmount: "1000" })).status, 400, "the main invoice is not repeated");
    assert.equal((await post(`/claims/${claimId}/submit`, { invoiceId: inv1, extraInvoiceIds: [inv2], claimedAmount: "10000.01" })).status, 400, "not more than the invoices together");
    assert.equal((await post(`/claims/${claimId}/submit`, { invoiceId: inv1, extraInvoiceIds: [randomUUID()], claimedAmount: "100" })).status, 404, "an unknown invoice");
    const prev = (await post(`/claims/${claimId}/copay-preview`, { invoiceId: inv1, extraInvoiceIds: [inv2] })).body.data;
    assert.deepEqual([prev.invoiceAmount, prev.mostToClaim], ["10000.00", "10000.00"]);
    assert.equal((await post(`/claims/${claimId}/submit`, { invoiceId: inv1, extraInvoiceIds: [inv2], claimedAmount: "9000" })).status, 200);
    const other = await mk();
    assert.equal((await post(`/claims/${other}/submit`, { invoiceId: inv2, claimedAmount: "100" })).status, 409, "an invoice on another live claim cannot be claimed again");
    const v = await view(claimId);
    assert.deepEqual(v.extraInvoices.map((x: { id: string }) => x.id), [inv2]);
    assert.equal((await post(`/claims/${claimId}/invoices`, { invoiceId: inv3 })).status, 409, "only while under query");
    assert.equal((await post(`/claims/${claimId}/query`, { note: "Send the pharmacy bill too" })).status, 200);
    assert.equal((await post(`/claims/${claimId}/invoices`, { invoiceId: inv3 }, cashier.token)).status, 403, "claims officer only");
    assert.equal((await post(`/claims/${claimId}/invoices`, { invoiceId: inv3 }, bOfficer.token)).status, 404, "another hospital");
    assert.equal((await post(`/claims/${claimId}/invoices`, { invoiceId: inv1 })).status, 400, "already the main invoice");
    assert.equal((await post(`/claims/${claimId}/invoices`, { invoiceId: inv3 })).status, 201);
    assert.equal((await post(`/claims/${claimId}/invoices`, { invoiceId: inv3 })).status, 409, "already on this claim");
    assert.equal((await post(`/claims/${claimId}/resubmit`, { note: "Added the pharmacy bill", claimedAmount: "11000.01" })).status, 400);
    assert.equal((await post(`/claims/${claimId}/resubmit`, { note: "Added the pharmacy bill", claimedAmount: "10500" })).status, 200);
    assert.equal((await post(`/claims/${claimId}/decision`, { decision: "APPROVE", approvedAmount: "10500" })).status, 200);
    const pay = await settle(claimId, "10500");
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.deepEqual([(await invoice(inv1)).paidTotal, (await invoice(inv2)).paidTotal, (await invoice(inv3)).paidTotal], ["6000.00", "4000.00", "500.00"], "main invoice first, then the others in the order they joined");
    assert.equal((await view(claimId)).status, "SETTLED");
    const pkg = (await t.api("get", `/claims/${claimId}/package`, officer.token)).body.data;
    assert.equal(pkg.extraInvoices.length, 2, "the claim package carries every invoice");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CLAIM_INVOICE_ADDED", entityId: claimId } }));
    await assert.rejects(() => t.prisma.claimInvoice.deleteMany({ where: { tenantId: a.tenantId, claimId } }), "a link is never removed, even directly in the database");
  });

  it("insurer rate cards and packages: rates set by the claims officer; a line above the insurer's rate has its excess left to the patient; a package caps the claim; claims keep the package price they chose", async () => {
    const mkService = async (price: number) => (await t.api("post", "/services", admin.token).send({ code: `rc${uniqueWord(5)}`, name: `Rate test ${uniqueWord(4)}`, category: "INVESTIGATION", price, taxPercent: "0" })).body.data.id as string;
    const svc = await mkService(1000);
    const ins = await mkInsurer(officer.token, `Rates ${uniqueWord(6)}`);
    const put = (insurerId: string, serviceId: string, body: Record<string, unknown>, tok = officer.token) => t.api("put", `/claims/insurers/${insurerId}/rates/${serviceId}`, tok).send(body);
    assert.equal((await put(ins.id, svc, { price: "800" }, cashier.token)).status, 403, "rate cards are set by the claims masters role");
    assert.equal((await put(ins.id, svc, { price: "-1" })).status, 400);
    assert.equal((await put(ins.id, randomUUID(), { price: "800" })).status, 404);
    assert.equal((await put(ins.id, svc, { price: "800" }, bOfficer.token)).status, 404, "another hospital cannot set this insurer's rates");
    assert.equal((await put(ins.id, svc, { price: "900" })).status, 200);
    assert.equal((await put(ins.id, svc, { price: "800" })).status, 200, "a rate can be changed");
    const list = (await t.api("get", `/claims/insurers/${ins.id}/rates`, cashier.token)).body.data;
    assert.deepEqual(list.map((r: { price: string; standardPrice: string }) => [r.price, r.standardPrice]), [["800.00", "1000.00"]]);
    assert.equal((await t.api("get", `/claims/insurers/${ins.id}/rates`, bOfficer.token)).status, 404);

    const patient = await registerPatient(t, rec.token);
    const pol = await t.api("post", `/patients/${patient.id}/policies`, officer.token).send({ insurerId: ins.id, policyNumber: `POL-${uniqueWord(6)}`, validFrom: iso(-30), validTo: iso(300), sumInsured: "500000" });
    const c = await post("/claims", { patientId: patient.id, policyId: pol.body.data.id, type: "REIMBURSEMENT" });
    const claimId = c.body.data.id as string;
    const d = await t.api("post", "/invoices", cashier.token).send({ patientId: patient.id, lines: [{ serviceId: svc, quantity: 2 }, { description: "Room charges", unitPrice: "3000", taxPercent: 0, quantity: 1 }] });
    assert.equal((await t.api("post", `/invoices/${d.body.data.id}/issue`, cashier.token)).status, 200);
    const invoiceId = d.body.data.id as string;
    const chk = (await t.api("get", `/claims/${claimId}/rate-check?invoiceId=${invoiceId}`, officer.token)).body.data;
    assert.equal(chk.totalExcess, "400.00", "(1000 - 800) x 2; the line with no rate is not touched");
    assert.equal(chk.lines.length, 1);
    assert.equal((await t.api("get", `/claims/${claimId}/rate-check?invoiceId=${invoiceId}`, cashier.token)).status, 403);
    assert.equal((await post(`/claims/${claimId}/rate-check/apply`, { invoiceId })).body.data.added, 1);
    assert.equal((await post(`/claims/${claimId}/rate-check/apply`, { invoiceId })).body.data.added, 0, "running it again adds nothing");
    const v = await view(claimId);
    assert.equal(v.nonPayableTotal, "400.00");
    assert.equal((await post(`/claims/${claimId}/submit`, { invoiceId, claimedAmount: "5000" })).status, 400, "5,000 invoice - 400 above the insurer's rate = 4,600 at most");

    const pk = (id: string, body: Record<string, unknown>, tok = officer.token) => t.api("post", `/claims/insurers/${id}/packages`, tok).send(body);
    assert.equal((await pk(ins.id, { code: "HERNIA", name: "Hernia repair", price: "0" })).status, 400);
    assert.equal((await pk(ins.id, { code: "HERNIA", name: "Hernia repair", price: "3000" }, cashier.token)).status, 403);
    const made = await pk(ins.id, { code: "HERNIA", name: "Hernia repair", price: "3000" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await pk(ins.id, { code: "HERNIA", name: "Again", price: "10" })).status, 409, "one package per code");
    assert.equal((await pk(ins.id, { code: "X", name: "Other hospital", price: "10" }, bOfficer.token)).status, 404);
    const pid = made.body.data.id as string;
    const tariff = (body: Record<string, unknown>, id = claimId, tok = officer.token) => post(`/claims/${id}/tariff-package`, body, tok);
    assert.equal((await tariff({ packageId: randomUUID() })).status, 404, "an unknown package");
    assert.equal((await tariff({ packageId: pid }, claimId, cashier.token)).status, 403);
    assert.equal((await tariff({ packageId: pid })).status, 200);
    assert.equal((await view(claimId)).package.price, "3000.00");
    assert.equal((await t.api("put", `/claims/insurers/${ins.id}/packages/${pid}`, officer.token).send({ price: "3500" })).status, 200, "a package price can change");
    assert.equal((await view(claimId)).package.price, "3000.00", "a claim keeps the price it chose the package at");
    assert.equal((await post(`/claims/${claimId}/submit`, { invoiceId, claimedAmount: "3000.01" })).status, 400, "never more than the package price");
    assert.equal((await post(`/claims/${claimId}/submit`, { invoiceId, claimedAmount: "3000" })).status, 200);
    assert.equal((await tariff({ packageId: null })).status, 409, "the package is fixed once submitted");
    const other = await t.api("post", `/claims/insurers`, officer.token).send({ name: `Other ${uniqueWord(6)}`, kind: "INSURER" });
    const alien = await pk(other.body.data.id, { code: "ALIEN", name: "Another insurer's package", price: "1000" });
    const c2 = await post("/claims", { patientId: patient.id, policyId: pol.body.data.id, type: "REIMBURSEMENT" });
    assert.equal((await tariff({ packageId: alien.body.data.id }, c2.body.data.id)).status, 404, "a claim can only use its own insurer's packages");
    for (const action of ["INSURER_RATE_SET", "INSURER_PACKAGE_ADDED", "INSURER_PACKAGE_UPDATED", "CLAIM_PACKAGE_CHOSEN"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action } }), `${action} is audited`);
  });

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
  it("standard-format exchange: a FHIR eligibility request, pre-authorisation and claim built from the claim; downloaded as FHIR or CSV; sent through the insurer channel, every attempt recorded", async () => {
    const s = await submitted("CASHLESS", "10000", "8000");
    const get = (path: string, tok = officer.token) => t.api("get", path, tok);

    // The eligibility request: patient, cover, insurer and hospital, no clinical notes.
    const el = await get(`/claims/${s.claimId}/eligibility-request`);
    assert.equal(el.status, 200, JSON.stringify(el.body));
    const types = (el.body.data.entry as { resource: { resourceType: string } }[]).map((e) => e.resource.resourceType);
    assert.deepEqual(types, ["CoverageEligibilityRequest", "Patient", "Coverage", "Organization", "Organization"]);
    const request = el.body.data.entry[0].resource;
    assert.equal(request.status, "active");
    assert.ok(request.purpose.includes("benefits"));
    assert.equal(request.patient.reference, `Patient/${s.patient.id}`);
    const cover = el.body.data.entry[2].resource;
    assert.ok(cover.identifier[0].value, "the policy number");
    assert.match(cover.period.start, /^\d{4}-\d{2}-\d{2}$/);

    // The claim: the billed lines become items, the claimed amount is the total.
    const exp = await get(`/claims/${s.claimId}/export?format=fhir`);
    assert.equal(exp.status, 200);
    assert.match(String(exp.headers["content-type"]), /application\/fhir\+json/);
    const bundle = JSON.parse(exp.text) as { resourceType: string; entry: { resource: Record<string, unknown> }[] };
    assert.equal(bundle.resourceType, "Bundle");
    const claim = bundle.entry[0]!.resource as { resourceType: string; use: string; item: { sequence: number; net: { value: number } }[]; total: { value: number; currency: string }; diagnosis: unknown[] };
    assert.equal(claim.resourceType, "Claim");
    assert.equal(claim.use, "claim");
    assert.equal(claim.total.value, 8000);
    assert.equal(claim.total.currency, "INR");
    assert.ok(claim.item.length >= 1);
    assert.equal(claim.item[0]!.sequence, 1);
    assert.equal(claim.diagnosis.length, 1);
    assert.equal(JSON.stringify(bundle).includes("passwordHash"), false);
    const pre = JSON.parse((await get(`/claims/${s.claimId}/export?format=fhir&stage=PREAUTH`)).text);
    assert.equal(pre.entry[0].resource.use, "preauthorization");

    // CSV for a portal upload: one row per billed line.
    const csv = await get(`/claims/${s.claimId}/export?format=csv&download=1`);
    assert.equal(csv.status, 200);
    assert.match(String(csv.headers["content-type"]), /text\/csv/);
    assert.match(String(csv.headers["content-disposition"]), /attachment; filename="claim-.*\.csv"/);
    const rows = csv.text.trim().split("\r\n");
    assert.match(rows[0]!, /^claim_number,stage,insurer,/);
    assert.equal(rows.length - 1, claim.item.length);
    assert.equal((await get(`/claims/${s.claimId}/export?format=xml`)).status, 400);
    assert.equal((await get(`/claims/${s.claimId}/export?bogus=1`)).status, 400);

    // Permissions and hospital isolation.
    assert.equal((await get(`/claims/${s.claimId}/export`, nurse.token)).status, 403);
    assert.equal((await get(`/claims/${s.claimId}/eligibility-request`, bOfficer.token)).status, 404);
    assert.equal((await get(`/claims/${s.claimId}/export`, bOfficer.token)).status, 404);
    assert.equal((await get(`/claims/${s.claimId}/transmissions`, bOfficer.token)).status, 404);
    assert.equal((await post(`/claims/${s.claimId}/transmit`, { kind: "CLAIM" }, bOfficer.token)).status, 404);
    assert.equal((await post(`/claims/${s.claimId}/transmit`, { kind: "CLAIM" }, rec.token)).status, 403);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CLAIM_EXPORTED", entityId: s.claimId } }));

    // Sending with no channel set up: recorded as not sent, and says why.
    const none = await post(`/claims/${s.claimId}/transmit`, { kind: "ELIGIBILITY" });
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.equal(none.body.data.status, "NOT_SENT");
    assert.match(none.body.data.detail, /nothing was sent/i);
    assert.equal((await post(`/claims/${s.claimId}/transmit`, { kind: "BOGUS" })).status, 400);
    assert.equal((await post(`/claims/${s.claimId}/transmit`, { kind: "CLAIM", extra: 1 })).status, 400);

    // Through a real HTTP channel: the FHIR bundle is posted with the key, the insurer's reference is kept, a refusal or an outage is recorded and never lost.
    const seen: { body: string; auth: string | undefined; type: string | undefined; kind: string | undefined }[] = [];
    let mode: "ok" | "refuse" = "ok";
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push({ body, auth: req.headers["authorization"], type: req.headers["content-type"], kind: req.headers["x-medos-kind"] as string | undefined });
        if (mode === "refuse") { res.writeHead(422, { "content-type": "application/json" }); res.end("{}"); return; }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "INS-REF-7788" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const transport = t.app.get<ClaimTransport>(CLAIM_TRANSPORT);
    const original = transport.send.bind(transport);
    const http = new HttpClaimTransport({ url: `http://127.0.0.1:${port}/claims`, apiKey: "test-key-123", timeoutMs: 3000, production: false });
    Object.assign(transport, { send: (m: Parameters<ClaimTransport["send"]>[0]) => http.send(m) });
    try {
      const sent = await post(`/claims/${s.claimId}/transmit`, { kind: "CLAIM" });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.equal(sent.body.data.status, "SENT");
      assert.equal(sent.body.data.httpStatus, 200);
      assert.equal(sent.body.data.externalRef, "INS-REF-7788");
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.auth, "Bearer test-key-123");
      assert.match(String(seen[0]!.type), /application\/fhir\+json/);
      assert.equal(seen[0]!.kind, "CLAIM");
      assert.equal((JSON.parse(seen[0]!.body) as { resourceType: string }).resourceType, "Bundle");
      mode = "refuse";
      const refused = await post(`/claims/${s.claimId}/transmit`, { kind: "CLAIM" });
      assert.equal(refused.body.data.status, "FAILED");
      assert.equal(refused.body.data.httpStatus, 422);
      assert.match(refused.body.data.detail, /HTTP 422/);
    } finally { Object.assign(transport, { send: original }); await new Promise<void>((resolve) => server.close(() => resolve())); }
    const down = await post(`/claims/${s.claimId}/transmit`, { kind: "CLAIM" }); // the channel is back to "log"
    assert.equal(down.body.data.status, "NOT_SENT");
    Object.assign(transport, { send: () => new HttpClaimTransport({ url: `http://127.0.0.1:${port}/claims`, apiKey: undefined, timeoutMs: 1500, production: false }).send({ kind: "CLAIM", reference: "x", payload: {} }) });
    try {
      const unreachable = await post(`/claims/${s.claimId}/transmit`, { kind: "CLAIM" });
      assert.equal(unreachable.status, 200, JSON.stringify(unreachable.body));
      assert.equal(unreachable.body.data.status, "FAILED");
      assert.match(unreachable.body.data.detail, /could not be reached|did not answer/);
    } finally { Object.assign(transport, { send: original }); }

    // The history keeps every attempt, never edited, without the content or the key.
    const hist = (await get(`/claims/${s.claimId}/transmissions`)).body.data as { status: string; payloadHash?: string }[];
    assert.deepEqual(hist.map((h) => h.status).sort(), ["FAILED", "FAILED", "NOT_SENT", "NOT_SENT", "SENT"].sort());
    assert.equal(JSON.stringify(hist).includes("test-key-123"), false);
    await assert.rejects(() => t.prisma.claimTransmission.updateMany({ where: { claimId: s.claimId }, data: { status: "SENT" } }), "a record of what was sent is never edited");
    await assert.rejects(() => t.prisma.claimTransmission.deleteMany({ where: { claimId: s.claimId } }));
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CLAIM_TRANSMITTED", entityId: s.claimId } }));
    assert.equal((await post(`/claims/${s.claimId}/close`, { reason: "Closed for the test of finished claims" })).status, 200);
    assert.equal((await post(`/claims/${s.claimId}/transmit`, { kind: "CLAIM" })).status, 409, "a closed claim is not sent");
  });
});
