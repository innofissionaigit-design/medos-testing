import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const PDF = Buffer.from("%PDF-1.4 checklist test");

/** The claim documents checklist (docs/claim-checklist.md), on the real database. */
describe("claim documents checklist: a claim cannot be sent with a required document missing", () => {
  let t: TestApp; let a: TestTenant; let b: TestTenant;
  let officer: User; let cashier: User; let rec: User; let manager: User; let bOfficer: User; let bManager: User;
  let insurer: { id: string };

  const post = (path: string, body: Record<string, unknown> = {}, tok = officer.token) => t.api("post", path, tok).send(body);
  const get = (path: string, tok = officer.token) => t.api("get", path, tok);
  const need = (label: string, claimType: string | null = null, insurerId = insurer.id, tok = officer.token) => post(`/claims/insurers/${insurerId}/required-documents`, { label, claimType }, tok);
  const upload = (claimId: string, label: string, tok = officer.token) => t.api("post", `/claims/${claimId}/documents`, tok).query({ filename: "f.pdf", label }).set("Content-Type", "application/pdf").send(PDF);

  /** A claim on the insurer with an issued invoice. */
  const newClaim = async (insurerId = insurer.id, type = "REIMBURSEMENT") => {
    const patient = await registerPatient(t, rec.token);
    const pol = await t.api("post", `/patients/${patient.id}/policies`, officer.token).send({ insurerId, policyNumber: `POL-${uniqueWord(6)}`, validFrom: iso(-30), validTo: iso(300), sumInsured: "500000" });
    assert.equal(pol.status, 201, JSON.stringify(pol.body));
    const d = await t.api("post", "/invoices", cashier.token).send({ patientId: patient.id, lines: [{ description: "Procedure", unitPrice: "10000", taxPercent: 0, quantity: 1 }] });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.equal((await t.api("post", `/invoices/${d.body.data.id}/issue`, cashier.token)).status, 200);
    const c = await post("/claims", { patientId: patient.id, policyId: pol.body.data.id, type, diagnosis: "Appendicitis" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    return { claimId: c.body.data.id as string, invoiceId: d.body.data.id as string };
  };
  const submit = (c: { claimId: string; invoiceId: string }, tok = officer.token) => post(`/claims/${c.claimId}/submit`, { invoiceId: c.invoiceId, claimedAmount: "5000" }, tok);
  const status = async (claimId: string) => (await get(`/claims/${claimId}`)).body.data.status as string;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("chk-a"); b = await t.makeTenant("chk-b");
    officer = await t.makeUser(a, ["CLAIMS_OFFICER"]); cashier = await t.makeUser(a, ["CASHIER"]); rec = await t.makeUser(a, ["RECEPTIONIST"]); manager = await t.makeUser(a, ["MANAGER"]);
    bOfficer = await t.makeUser(b, ["CLAIMS_OFFICER"]); bManager = await t.makeUser(b, ["MANAGER"]);
    const ins = await post("/claims/insurers", { name: `Checklist Ins ${uniqueWord(6)}`, kind: "INSURER" });
    assert.equal(ins.status, 201, JSON.stringify(ins.body));
    insurer = ins.body.data;
  });
  after(async () => { await t.close(); });

  it("an insurer with no required documents does not block anything", async () => {
    const other = (await post("/claims/insurers", { name: `Plain Ins ${uniqueWord(6)}`, kind: "TPA" })).body.data as { id: string };
    const c = await newClaim(other.id);
    assert.deepEqual((await get(`/claims/${c.claimId}/checklist`)).body.data, { claimId: c.claimId, status: "DRAFT", items: [], missing: [], complete: true });
    assert.equal((await submit(c)).status, 200);
  });

  it("a claim with a required document missing cannot be sent; attaching it lets it go", async () => {
    assert.equal((await need("Discharge summary")).status, 201);
    assert.equal((await need("Policy card")).status, 201);
    assert.equal((await need("discharge  SUMMARY")).status, 409, "the same document twice (any capitals) is refused");
    const c = await newClaim();
    const list = (await get(`/claims/${c.claimId}/checklist`)).body.data;
    assert.deepEqual(list.items.map((i: { label: string; state: string }) => [i.label, i.state]), [["Discharge summary", "MISSING"], ["Policy card", "MISSING"]]);
    assert.equal(list.complete, false);

    const blocked = await submit(c);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "CLAIM_DOCUMENTS_MISSING");
    assert.match(blocked.body.error.message, /Discharge summary, Policy card/);
    assert.equal(await status(c.claimId), "DRAFT", "nothing was sent");

    assert.equal((await upload(c.claimId, "discharge summary")).status, 201, "the name matches whatever the capitals");
    const after1 = (await get(`/claims/${c.claimId}/checklist`)).body.data;
    assert.deepEqual(after1.missing, ["Policy card"]);
    assert.equal((await submit(c)).status, 409, "one is still missing");

    const card = await upload(c.claimId, "Policy card");
    assert.equal(card.status, 201);
    assert.equal((await get(`/claims/${c.claimId}/checklist`)).body.data.complete, true);
    assert.equal((await submit(c)).status, 200);
    assert.equal(await status(c.claimId), "SUBMITTED");
  });

  it("a document that was removed counts as missing again", async () => {
    const c = await newClaim();
    const d1 = await upload(c.claimId, "Discharge summary"); const d2 = await upload(c.claimId, "Policy card");
    assert.equal((await post(`/claim-documents/${d1.body.data.id}/remove`, { reason: "Wrong patient's file" })).status, 200);
    assert.deepEqual((await get(`/claims/${c.claimId}/checklist`)).body.data.missing, ["Discharge summary"]);
    assert.equal((await submit(c)).status, 409);
    assert.ok(d2.body.data.id);
  });

  it("a manager can waive one missing document with a reason; nobody else can; it cannot be undone", async () => {
    const c = await newClaim();
    assert.equal((await upload(c.claimId, "Discharge summary")).status, 201);
    const waive = (body: Record<string, unknown>, tok = manager.token) => t.api("post", `/claims/${c.claimId}/checklist/waive`, tok).send(body);
    assert.equal((await waive({ label: "Policy card", reason: "Card lost, policy checked on the insurer's portal" }, officer.token)).status, 403, "the insurance desk cannot waive");
    assert.equal((await waive({ label: "Policy card", reason: "Card lost, policy checked on the insurer's portal" }, cashier.token)).status, 403);
    assert.equal((await waive({ label: "Policy card", reason: "short" })).status, 400, "a real reason is needed");
    assert.equal((await waive({ label: "Something else", reason: "Not on the list at all here" })).status, 400, "only a document on the list");
    assert.equal((await waive({ label: "Discharge summary", reason: "It is already attached here" })).status, 409, "an attached document needs no waiver");
    assert.equal((await waive({ label: "Policy card", reason: "Card lost, policy checked on the insurer's portal" }, bManager.token)).status, 404, "another hospital's manager cannot reach this claim");
    const ok = await waive({ label: "policy card", reason: "Card lost, policy checked on the insurer's portal" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.complete, true);
    assert.deepEqual(ok.body.data.items.map((i: { state: string }) => i.state), ["ATTACHED", "WAIVED"]);
    assert.equal((await waive({ label: "Policy card", reason: "Card lost, policy checked on the insurer's portal" })).status, 409, "already waived");
    assert.equal((await submit(c)).status, 200);
    assert.equal((await waive({ label: "Policy card", reason: "Card lost, policy checked on the insurer's portal" })).status, 409, "too late: the claim is already sent");

    // The waiver is part of the record: the database refuses to change or remove it.
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "ClaimDocumentWaiver" SET reason = 'changed afterwards by someone' WHERE "claimId" = '${c.claimId}'::uuid`));
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "ClaimDocumentWaiver" WHERE "claimId" = '${c.claimId}'::uuid`));
    const audit = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: "CLAIM_DOCUMENT_WAIVED", entityId: c.claimId } });
    assert.equal(audit.length, 1);
  });

  it("some documents are needed only for cashless or only for reimbursement claims", async () => {
    const ins = (await post("/claims/insurers", { name: `Typed Ins ${uniqueWord(6)}`, kind: "INSURER" })).body.data as { id: string };
    assert.equal((await need("Pre-authorisation form", "CASHLESS", ins.id)).status, 201);
    assert.equal((await need("Original bills", "REIMBURSEMENT", ins.id)).status, 201);
    assert.equal((await need("ID proof", null, ins.id)).status, 201);
    const reimb = await newClaim(ins.id, "REIMBURSEMENT");
    assert.deepEqual((await get(`/claims/${reimb.claimId}/checklist`)).body.data.missing, ["Original bills", "ID proof"]);
    const cashless = await newClaim(ins.id, "CASHLESS");
    assert.deepEqual((await get(`/claims/${cashless.claimId}/checklist`)).body.data.missing, ["Pre-authorisation form", "ID proof"]);
  });

  it("a requirement is switched off, not deleted, and only the insurance masters desk can change the list", async () => {
    const ins = (await post("/claims/insurers", { name: `Switch Ins ${uniqueWord(6)}`, kind: "INSURER" })).body.data as { id: string };
    assert.equal((await need("Bill summary", null, ins.id, cashier.token)).status, 403);
    assert.equal((await need("x", null, ins.id)).status, 400, "a name of at least two characters");
    const r = await need("Bill summary", null, ins.id);
    assert.equal(r.status, 201);
    const c = await newClaim(ins.id);
    assert.equal((await submit(c)).status, 409);
    const off = (body: Record<string, unknown>, tok = officer.token) => post(`/claims/required-documents/${r.body.data.id}/active`, body, tok);
    assert.equal((await off({ active: false }, cashier.token)).status, 403);
    assert.equal((await off({ active: false }, bOfficer.token)).status, 404);
    assert.equal((await off({ active: false })).status, 200);
    assert.equal((await submit(c)).status, 200, "the requirement is switched off");
    const list = (await get(`/claims/insurers/${ins.id}/required-documents`)).body.data.items as { label: string; active: boolean }[];
    assert.deepEqual(list.map((x) => [x.label, x.active]), [["Bill summary", false]]);
    assert.equal((await need("bill summary", null, ins.id)).status, 201, "adding it again switches it back on");
    assert.equal(((await get(`/claims/insurers/${ins.id}/required-documents`)).body.data.items as unknown[]).length, 1);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "InsurerRequiredDocument" WHERE id = '${r.body.data.id}'::uuid`));
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "InsurerRequiredDocument" SET label = 'Renamed' WHERE id = '${r.body.data.id}'::uuid`));
  });

  it("another hospital cannot see or change this one's checklist", async () => {
    const c = await newClaim();
    assert.equal((await get(`/claims/${c.claimId}/checklist`, bOfficer.token)).status, 404);
    assert.equal((await get(`/claims/insurers/${insurer.id}/required-documents`, bOfficer.token)).status, 404);
    assert.equal((await need("Anything", null, insurer.id, bOfficer.token)).status, 404);
    assert.equal((await get(`/claims/${randomUUID()}/checklist`)).status, 404);
    assert.equal((await get(`/claims/${c.claimId}/checklist`, cashier.token)).status, 200, "reading claims is allowed");
  });
});
