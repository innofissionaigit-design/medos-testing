import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startApp, type TestApp, type TestTenant } from "../test/harness";

describe("platform behaviour: errors, headers, audit integrity", () => {
  let t: TestApp;
  let tenant: TestTenant;

  before(async () => {
    t = await startApp();
    tenant = await t.makeTenant("plat");
  });
  after(async () => { await t.close(); });

  it("exposes public liveness and readiness endpoints", async () => {
    assert.equal((await t.api("get", "/health")).status, 200);
    const ready = await t.api("get", "/health/ready");
    assert.equal(ready.status, 200);
    assert.equal(ready.body.data.status, "ready");
  });

  it("returns the stable error envelope without stack traces for unknown routes and malformed bodies", async () => {
    const nf = await t.api("get", "/nope", tenant.admin.token);
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, "NOT_FOUND");
    const bad = await t.http().post("/api/v1/auth/login").set("Content-Type", "application/json").send("{not json");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "VALIDATION_FAILED");
    for (const r of [nf, bad]) {
      const text = JSON.stringify(r.body);
      assert.ok(!/at \w+.*\(.*:\d+:\d+\)/.test(text), `no stack frames: ${text}`);
      assert.ok(!text.includes("node_modules") && !text.includes("prisma"), `no internals: ${text}`);
      assert.ok(r.body.error.requestId, `requestId present: ${JSON.stringify(r.body)}`);
    }
  });

  it("rejects oversized request bodies", async () => {
    const r = await t.http().post("/api/v1/auth/login").send({ tenantCode: "x".repeat(400_000), identifier: "a", password: "b" });
    assert.equal(r.status, 413);
    assert.equal(r.body.error.code, "PAYLOAD_TOO_LARGE");
  });

  it("sets security headers, hides the framework, and echoes a safe request id", async () => {
    const r = await t.api("get", "/health").set("x-request-id", "req-12345678");
    assert.equal(r.headers["x-request-id"], "req-12345678");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["x-powered-by"], undefined);
    const evil = await t.api("get", "/health").set("x-request-id", "bad id\"<script>");
    assert.match(String(evil.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
  });

  it("does not leak database errors: unique violations become CONFLICT, never SQL", async () => {
    const r = await t.api("post", "/roles", tenant.admin.token).send({ name: "ADMINISTRATOR", permissions: ["PATIENT_READ"] });
    assert.equal(r.status, 409);
    assert.ok(!JSON.stringify(r.body).toLowerCase().includes("unique constraint"));
  });

  it("audit events are append-only at the database level (UPDATE, DELETE and TRUNCATE all fail)", async () => {
    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: tenant.tenantId } });
    await assert.rejects(() => t.prisma.auditEvent.update({ where: { id: evt.id }, data: { action: "TAMPERED" } }), /append-only/);
    await assert.rejects(() => t.prisma.auditEvent.delete({ where: { id: evt.id } }), /append-only/);
    await assert.rejects(() => t.prisma.$executeRawUnsafe(`TRUNCATE "AuditEvent"`), /append-only/);
    const again = await t.prisma.auditEvent.findFirstOrThrow({ where: { id: evt.id } });
    assert.equal(again.action, evt.action);
  });

  it("audit events carry tenant, facility, actor and request id", async () => {
    const r = await t.api("post", "/roles", tenant.admin.token).set("x-request-id", "audit-req-0001").send({ name: "Trace Role", permissions: ["PATIENT_READ"] });
    assert.equal(r.status, 201);
    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: tenant.tenantId, action: "ROLE_CREATED", entityId: r.body.data.id } });
    assert.equal(evt.actorUserId, tenant.admin.id);
    assert.equal(evt.facilityId, tenant.facilityId);
    assert.equal(evt.requestId, "audit-req-0001");
  });

  it("audit listing requires AUDIT_READ, is paginated, filterable and read-only", async () => {
    const list = await t.api("get", "/audit-events", tenant.admin.token).query({ action: "ROLE_CREATED" });
    assert.equal(list.status, 200);
    assert.ok(list.body.data.every((e: { action: string }) => e.action === "ROLE_CREATED"));
    for (const m of ["post", "put", "patch", "delete"] as const) {
      const r = await t.api(m, "/audit-events", tenant.admin.token).send({});
      assert.ok([404, 405].includes(r.status), `${m} must not exist`);
    }
    assert.equal((await t.api("get", "/audit-events", tenant.admin.token).query({ pageSize: 500 })).status, 400);
  });
});
