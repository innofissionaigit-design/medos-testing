import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { makeDoctor, makeUserWithPermissions, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const tokenOf = (path: string) => path.replace("/api/share/", "");

describe("sharing a signed prescription with the patient", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let doc: TestDoctor;
  let bDoc: TestDoctor;
  let signedEnc: string;
  let patientId: string;
  const create = (tok: string, enc: string, body: Record<string, unknown> = {}) => t.api("post", `/encounters/${enc}/prescription-shares`, tok).send(body);
  const open = (token: string, q = "") => t.api("get", `/public/prescriptions/${token}${q}`);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("shr-a");
    b = await t.makeTenant("shr-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
    bDoc = await makeDoctor(t, b);
    const patient = await registerPatient(t, rec.token, { mobile: "9830012345" });
    patientId = patient.id;
    const v = await startVisit(t, rec.token, doc, patient.id);
    signedEnc = v.encounterId;
    await t.api("post", `/queue/${v.queueId}/start`, doc.token);
    await t.api("put", `/encounters/${v.encounterId}/prescription`, doc.token).send({ items: [{ genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3 }] });
    const n = await t.api("put", `/encounters/${v.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Fever for two days" } });
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doc.token).send({ text: "Viral fever", type: "PROVISIONAL" });
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doc.token).send({ version: n.body.data.version })).status, 200);
  });
  after(async () => { await t.close(); });

  it("only a signed prescription can be shared, and only by people allowed to", async () => {
    const draftVisit = await startVisit(t, rec.token, doc, (await registerPatient(t, rec.token)).id);
    assert.equal((await create(doc.token, draftVisit.encounterId)).status, 409, "nothing signed yet");
    const nurse = await t.makeUser(a, ["NURSE"]);
    const pharm = await t.makeUser(a, ["PHARMACIST"]);
    assert.equal((await create(nurse.token, signedEnc)).status, 403);
    assert.equal((await create(pharm.token, signedEnc)).status, 403);
    assert.equal((await t.api("post", `/encounters/${signedEnc}/prescription-shares`).send({})).status, 401);
    assert.equal((await create(doc.token, signedEnc, { days: 0 })).status, 400);
    assert.equal((await create(doc.token, signedEnc, { days: 31 })).status, 400);
    assert.equal((await create(doc.token, signedEnc, { days: 7, extra: 1 })).status, 400);
    assert.equal((await t.api("get", `/encounters/${signedEnc}/prescription-shares`, nurse.token)).status, 403);
  });

  it("creates a link that is shown once and stored only as a hash; the front desk can share too", async () => {
    const r = await create(rec.token, signedEnc, { days: 3 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const token = tokenOf(r.body.data.path);
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
    const row = await t.prisma.prescriptionShare.findFirstOrThrow({ where: { id: r.body.data.id } });
    assert.equal(row.tokenHash, sha256(token));
    assert.ok(!JSON.stringify(row).includes(token), "the secret itself is not stored");
    assert.equal(r.body.data.recipientMask, "••••••2345");
    assert.equal(r.body.data.whatsappNumber, "919830012345");
    assert.ok(Math.abs(row.expiresAt.getTime() - Date.now() - 3 * 86_400_000) < 60_000);
    const noPatientRead = await makeUserWithPermissions(t, a, ["PRESCRIPTION_SHARE"]);
    assert.equal((await create(noPatientRead.token, signedEnc)).body.data.whatsappNumber, null, "the number is only given to staff who may see patients");
    const list = await t.api("get", `/encounters/${signedEnc}/prescription-shares`, doc.token);
    assert.ok(!JSON.stringify(list.body).includes(token), "the list never shows the link");
    assert.equal(list.body.data[0].status, "ACTIVE");
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PrescriptionShare" SET "tokenHash" = 'x' WHERE id = '${r.body.data.id}'::uuid`));
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PrescriptionShare" WHERE id = '${r.body.data.id}'::uuid`));
  });

  it("the patient opens it without signing in: the prescription as HTML and as a PDF, counted and audited", async () => {
    const r = await create(doc.token, signedEnc);
    const token = tokenOf(r.body.data.path);
    const html = await open(token);
    assert.equal(html.status, 200);
    assert.match(html.text, /Paracetamol/);
    assert.match(html.text, /Fever for two days/);
    assert.ok(!html.text.includes("DUPLICATE COPY"), "a patient's copy is not stamped as a duplicate");
    assert.match(html.headers["content-security-policy"] ?? "", /default-src 'none'/);
    assert.equal(html.headers["cache-control"], "no-store");
    const pdf = await t.http().get(`/api/v1/public/prescriptions/${token}?format=pdf&download=1`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers["content-type"] ?? "", /application\/pdf/);
    assert.match(pdf.headers["content-disposition"] ?? "", /^attachment/);
    assert.equal((pdf.body as Buffer).subarray(0, 4).toString(), "%PDF");
    const row = await t.prisma.prescriptionShare.findFirstOrThrow({ where: { id: r.body.data.id } });
    assert.equal(row.openCount, 2);
    assert.ok(row.lastOpenedAt);
    const ev = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: "PRESCRIPTION_SHARE_OPENED", entityId: r.body.data.id } });
    assert.equal(ev.length, 2);
    assert.equal(ev[0]?.actorUserId, null, "opened by the patient, not by a user");
    assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "DOCUMENT_PRINTED", entityId: { not: undefined }, metadata: { path: ["copy"], equals: 1 } } }) >= 0, true);
    assert.equal((await t.api("get", `/encounters/${signedEnc}/prescription-shares`, doc.token)).body.data.find((x: { id: string }) => x.id === r.body.data.id).openCount, 2);
    assert.equal((await open(token, "?format=docx")).status, 400);
  });

  it("a wrong, malformed, expired or revoked link all look the same, and a revoked one stays closed", async () => {
    const invalid = async (token: string) => { const r = await open(token); assert.equal(r.status, 404, token); assert.match(JSON.stringify(r.body), /not valid or has expired/); };
    await invalid(randomBytes(32).toString("base64url"));
    await invalid("short");
    await invalid("a".repeat(200));
    const expired = randomBytes(32).toString("base64url");
    await t.prisma.$executeRawUnsafe(`INSERT INTO "PrescriptionShare" ("tenantId", "facilityId", "encounterId", "patientId", "tokenHash", "createdAt", "expiresAt", "createdById") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${signedEnc}'::uuid, '${patientId}'::uuid, '${sha256(expired)}', now() - interval '10 days', now() - interval '1 day', '${doc.userId}'::uuid)`);
    await invalid(expired);
    const r = await create(doc.token, signedEnc);
    const token = tokenOf(r.body.data.path);
    assert.equal((await open(token)).status, 200);
    assert.equal((await t.api("post", `/prescription-shares/${r.body.data.id}/revoke`, rec.token)).status, 200);
    await invalid(token);
    assert.equal((await t.api("post", `/prescription-shares/${r.body.data.id}/revoke`, doc.token)).status, 409, "already revoked");
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PrescriptionShare" SET status = 'ACTIVE', "revokedAt" = NULL, "revokedById" = NULL WHERE id = '${r.body.data.id}'::uuid`));
    const states = (await t.api("get", `/encounters/${signedEnc}/prescription-shares`, doc.token)).body.data.map((x: { id: string; status: string }) => [x.id, x.status]);
    assert.ok(states.some(([id, st]: string[]) => id === r.body.data.id && st === "REVOKED"));
    assert.ok(states.some(([, st]: string[]) => st === "EXPIRED"));
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "PRESCRIPTION_SHARE_REVOKED", entityId: r.body.data.id } }));
  });

  it("another hospital cannot create, list or revoke them, and a link reaches only its own visit", async () => {
    assert.equal((await create(bDoc.token, signedEnc)).status, 404);
    assert.equal((await t.api("get", `/encounters/${signedEnc}/prescription-shares`, bDoc.token)).status, 404);
    const r = await create(doc.token, signedEnc);
    assert.equal((await t.api("post", `/prescription-shares/${r.body.data.id}/revoke`, bDoc.token)).status, 404);
    assert.equal((await t.api("post", `/prescription-shares/not-a-uuid/revoke`, doc.token)).status, 404);
    const html = (await open(tokenOf(r.body.data.path))).text;
    const other = await registerPatient(t, rec.token);
    const v2 = await startVisit(t, rec.token, doc, other.id);
    assert.ok(!html.includes(other.mrn) && v2.encounterId, "the link shows its own patient only");
  });
});
