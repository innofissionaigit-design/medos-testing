import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeUserWithPermissions, registerPatient, startApp, type TestApp, type TestTenant } from "../../test/harness";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);

describe("patient photos and documents", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let readOnly: { id: string; token: string };

  const up = (patientId: string, tok: string, body: Buffer | string, type: string, query: Record<string, string>) =>
    t.api("post", `/patients/${patientId}/files`, tok).query(query).set("Content-Type", type).send(body);
  const photo = (patientId: string, body = PNG, type = "image/png") => up(patientId, rec.token, body, type, { kind: "PHOTO", filename: "face.png" });
  const doc = (patientId: string, body = PDF, title = "Lab report") => up(patientId, rec.token, body, "application/pdf", { kind: "DOCUMENT", filename: "report.pdf", title });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("file-a");
    b = await t.makeTenant("file-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    readOnly = await makeUserWithPermissions(t, a, ["PATIENT_READ"]);
  });
  after(async () => { await t.close(); });

  it("stores a photo, lists it and serves exactly the bytes uploaded with safe headers", async () => {
    const p = await registerPatient(t, rec.token);
    const r = await photo(p.id);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.kind, "PHOTO");
    assert.equal(r.body.data.contentType, "image/png");
    assert.equal(r.body.data.sizeBytes, PNG.length);
    assert.equal("storageKey" in r.body.data || "sha256" in r.body.data, false, "internals are not exposed");
    const list = await t.api("get", `/patients/${p.id}/files`, readOnly.token);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    const c = await t.api("get", `/files/${r.body.data.id}/content`, readOnly.token).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on("data", (d: Buffer) => ch.push(d)); res.on("end", () => cb(null, Buffer.concat(ch))); });
    assert.equal(c.status, 200);
    assert.ok(Buffer.compare(c.body as Buffer, PNG) === 0, "bytes round-trip unchanged");
    assert.equal(c.headers["content-type"], "image/png");
    assert.equal(c.headers["x-content-type-options"], "nosniff");
    assert.match(c.headers["content-security-policy"] ?? "", /sandbox/);
    assert.match(c.headers["cache-control"] ?? "", /no-store/);
    assert.match(c.headers["content-disposition"] ?? "", /^inline/);
  });

  it("a new photo replaces the old one; only one photo is ever active", async () => {
    const p = await registerPatient(t, rec.token);
    const first = await photo(p.id);
    const second = await photo(p.id, JPEG, "image/jpeg");
    assert.equal(second.status, 201);
    const list = (await t.api("get", `/patients/${p.id}/files`, rec.token)).body.data as { id: string; kind: string }[];
    assert.deepEqual(list.map((f) => f.id), [second.body.data.id]);
    assert.equal((await t.api("get", `/files/${first.body.data.id}/content`, rec.token)).status, 404, "the replaced photo is no longer served");
    const row = await t.prisma.patientFile.findFirstOrThrow({ where: { id: first.body.data.id } });
    assert.equal(row.status, "REMOVED");
    assert.equal(row.removeReason, "Replaced by a new photo");
  });

  it("documents need a title, download as attachments, and viewing them is audited (photos are not)", async () => {
    const p = await registerPatient(t, rec.token);
    assert.equal((await up(p.id, rec.token, PDF, "application/pdf", { kind: "DOCUMENT", filename: "x.pdf" })).status, 400, "title required");
    const d = await doc(p.id);
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const view = await t.api("get", `/files/${d.body.data.id}/content`, readOnly.token);
    assert.equal(view.status, 200);
    assert.match(view.headers["content-disposition"] ?? "", /^attachment/);
    const ph = await photo(p.id);
    await t.api("get", `/files/${ph.body.data.id}/content`, readOnly.token);
    const viewed = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: "PATIENT_FILE_VIEWED" } });
    assert.ok(viewed.some((e) => e.entityId === d.body.data.id), "document view audited");
    assert.ok(!viewed.some((e) => e.entityId === ph.body.data.id), "profile photo views are not audited");
    const uploaded = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PATIENT_FILE_UPLOADED", entityId: d.body.data.id } });
    assert.equal(uploaded.actorUserId, rec.id);
    assert.ok(!JSON.stringify(uploaded.metadata).includes("report.pdf"), "file names are not copied into the audit log");
  });

  it("rejects anything that is not really a PNG, JPEG or PDF", async () => {
    const p = await registerPatient(t, rec.token);
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    assert.equal((await photo(p.id, html, "image/png")).status, 415, "HTML disguised as PNG");
    assert.equal((await up(p.id, rec.token, html, "text/html", { kind: "DOCUMENT", filename: "a.html", title: "Page" })).status, 415, "HTML as itself");
    assert.equal((await up(p.id, rec.token, PNG, "application/pdf", { kind: "DOCUMENT", filename: "a.pdf", title: "Wrong type" })).status, 415, "declared type must match the bytes");
    assert.equal((await up(p.id, rec.token, PDF, "application/pdf", { kind: "PHOTO", filename: "a.pdf" })).status, 400, "a photo must be an image");
    assert.equal((await up(p.id, rec.token, Buffer.alloc(0), "image/png", { kind: "PHOTO", filename: "a.png" })).status === 201, false, "empty body");
    assert.equal((await t.api("post", `/patients/${p.id}/files`, rec.token).query({ kind: "PHOTO", filename: "a.png", tenantId: b.tenantId }).set("Content-Type", "image/png").send(PNG)).status, 400, "unknown query fields are refused");
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 10)]);
    assert.equal((await photo(p.id, big)).status, 413, "over the size limit");
    assert.equal(await t.prisma.patientFile.count({ where: { patientId: p.id } }), 0, "nothing was stored for any rejected upload");
  });

  it("removal needs a reason, hides the file, and is permanent history", async () => {
    const p = await registerPatient(t, rec.token);
    const d = await doc(p.id);
    const id = d.body.data.id as string;
    assert.equal((await t.api("post", `/files/${id}/remove`, rec.token).send({})).status, 400);
    assert.equal((await t.api("post", `/files/${id}/remove`, rec.token).send({ reason: "no" })).status, 400);
    assert.equal((await t.api("post", `/files/${id}/remove`, rec.token).send({ reason: "Uploaded to the wrong patient" })).status, 200);
    assert.equal((await t.api("post", `/files/${id}/remove`, rec.token).send({ reason: "Uploaded to the wrong patient" })).status, 409, "already removed");
    assert.equal((await t.api("get", `/files/${id}/content`, rec.token)).status, 404);
    assert.equal((await t.api("get", `/patients/${p.id}/files`, rec.token)).body.data.length, 0);
    const events = await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "PATIENT_FILE_REMOVED", entityId: id } });
    assert.equal(events, 1);
    // the database itself refuses to alter or delete stored-file records
    await assert.rejects(() => t.prisma.patientFile.update({ where: { id }, data: { sha256: "tampered" } }), /cannot be modified/);
    await assert.rejects(() => t.prisma.patientFile.update({ where: { id }, data: { status: "ACTIVE", removedAt: null, removedById: null, removeReason: null } }), /cannot be changed|Invalid file status/);
    await assert.rejects(() => t.prisma.patientFile.delete({ where: { id } }), /append-only|cannot be deleted|not allowed|immutable|forbid/i);
  });

  it("is isolated by tenant and gated by permission and authentication", async () => {
    const p = await registerPatient(t, rec.token);
    const d = await doc(p.id);
    const id = d.body.data.id as string;
    const bUser = await makeUserWithPermissions(t, b, ["PATIENT_READ", "PATIENT_UPDATE"]);
    assert.equal((await t.api("get", `/patients/${p.id}/files`, bUser.token)).status, 404);
    assert.equal((await up(p.id, bUser.token, PDF, "application/pdf", { kind: "DOCUMENT", filename: "a.pdf", title: "Cross tenant" })).status, 404);
    assert.equal((await t.api("get", `/files/${id}/content`, bUser.token)).status, 404);
    assert.equal((await t.api("post", `/files/${id}/remove`, bUser.token).send({ reason: "Cross tenant attempt" })).status, 404);
    assert.equal((await t.api("get", `/files/${randomUUID()}/content`, rec.token)).status, 404);
    assert.equal((await t.api("get", `/files/not-a-uuid/content`, rec.token)).status, 404);
    assert.equal((await up(p.id, readOnly.token, PDF, "application/pdf", { kind: "DOCUMENT", filename: "a.pdf", title: "No rights" })).status, 403, "read-only users cannot upload");
    assert.equal((await t.api("post", `/files/${id}/remove`, readOnly.token).send({ reason: "Not allowed to do this" })).status, 403);
    assert.equal((await t.api("get", `/files/${id}/content`)).status, 401);
    assert.equal((await t.http().post(`/api/v1/patients/${p.id}/files?kind=PHOTO&filename=a.png`).set("Content-Type", "image/png").send(PNG)).status, 401, "anonymous uploads are refused");
  });
});
