// This spec always runs the application under full enforcement, whatever mode the rest of the suite uses: the app's queries
// carry the tenant and run as the restricted role (docs/rls.md). Each spec file is its own process, so this does not leak.
process.env["DB_TENANT_CONTEXT"] = "on";
process.env["DB_SESSION_ROLE"] = "medos_app";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config";
import { PrismaService, TenantContextMissingError } from "./prisma.service";
import { tenantScope } from "./tenant-scope";
import { TenantsService } from "../modules/tenants/tenants.service";
import { RemindersService } from "../modules/follow-ups/reminders.service";
import { registerPatient, startApp, type TestApp, type TestTenant } from "../test/harness";

describe("row-level security: tenant context, and the explicit paths that have none", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let app: PrismaService;
  let patientA: string;
  let patientB: string;
  let tokens: { a: string; b: string };

  before(async () => {
    t = await startApp();
    app = t.app.get(PrismaService);
    a = await t.makeTenant("rlsp-a");
    b = await t.makeTenant("rlsp-b");
    const recA = await t.makeUser(a, ["RECEPTIONIST"]);
    const recB = await t.makeUser(b, ["RECEPTIONIST"]);
    patientA = (await registerPatient(t, recA.token)).id;
    patientB = (await registerPatient(t, recB.token)).id;
    tokens = { a: recA.token, b: recB.token };
  });
  after(async () => { await t.close(); });

  // ───────────────────────── configuration ─────────────────────────
  it("the session-role emulation cannot be enabled by accident or in production", () => {
    const base = { DATABASE_URL: "postgresql://x@localhost/x", JWT_ACCESS_SECRET: "x".repeat(40) };
    assert.throws(() => loadConfig({ ...base, DB_SESSION_ROLE: "medos_app" }), /DB_SESSION_ROLE/, "needs the tenant context on");
    assert.throws(() => loadConfig({ ...base, DB_SESSION_ROLE: "medos_app", DB_TENANT_CONTEXT: "on", NODE_ENV: "production" }), /DB_SESSION_ROLE/, "never in production");
    assert.throws(() => loadConfig({ ...base, DB_TENANT_CONTEXT: "on", DB_SESSION_ROLE: "medos_app; DROP TABLE x" }), /DB_SESSION_ROLE/, "a role name, nothing else");
    assert.equal(loadConfig({ ...base }).DB_TENANT_CONTEXT, "off", "off by default until phase 3");
    assert.equal(loadConfig({ ...base, DB_TENANT_CONTEXT: "on", DB_SESSION_ROLE: "medos_app" }).DB_SESSION_ROLE, "medos_app");
  });

  // ───────────────────────── fail closed ─────────────────────────
  it("a query with no scope is refused before it reaches the database, for every way of querying", async () => {
    await assert.rejects(() => app.patient.findMany(), TenantContextMissingError);
    await assert.rejects(() => app.patient.count(), TenantContextMissingError);
    await assert.rejects(() => app.$queryRaw`SELECT 1`, TenantContextMissingError);
    await assert.rejects(() => app.$executeRawUnsafe("SELECT 1"), TenantContextMissingError);
    await assert.rejects(() => app.$transaction(async (tx) => tx.patient.findMany()), TenantContextMissingError);
  });

  it("a scope reads only its own hospital, in transactions, single queries and raw SQL alike", async () => {
    const own = await tenantScope.run(a.tenantId, async () => ({
      single: (await app.patient.findMany()).map((p) => p.id),
      raw: (await app.$queryRaw<{ id: string }[]>`SELECT id FROM "Patient"`).map((p) => p.id),
      tx: await app.$transaction(async (tx) => (await tx.patient.findMany()).map((p) => p.id)),
      foreign: await app.patient.findUnique({ where: { id: patientB } }),
    }));
    assert.deepEqual(own.single, [patientA]);
    assert.deepEqual(own.raw, [patientA]);
    assert.deepEqual(own.tx, [patientA]);
    assert.equal(own.foreign, null, "another hospital's record is not found even by exact id");
    assert.deepEqual(await tenantScope.run(b.tenantId, async () => (await app.patient.findMany()).map((p) => p.id)), [patientB]);
  });

  it("the explicit tenant-less scope grants nothing: it can call the narrow functions but cannot read tables", async () => {
    const seen = await tenantScope.system("test", async () => ({
      patients: await app.patient.findMany(),
      tenants: await app.tenant.findMany(),
      users: await app.user.findMany(),
    }));
    assert.deepEqual([seen.patients.length, seen.tenants.length, seen.users.length], [0, 0, 0]);
    const found = await tenantScope.system("test", () => app.$queryRaw<{ id: string; status: string }[]>`SELECT id::text AS id, status FROM medos_resolve_tenant(${a.code})`);
    assert.deepEqual(found, [{ id: a.tenantId, status: "ACTIVE" }], "the code resolves to an id and a status, nothing more");
    assert.deepEqual(await tenantScope.system("test", () => app.$queryRaw<unknown[]>`SELECT * FROM medos_resolve_tenant(${"no-such-hospital"})`), []);
    const token = await tenantScope.system("test", () => app.$queryRaw<{ t: string | null }[]>`SELECT medos_resolve_refresh_token(${"0".repeat(64)})::text AS t`);
    assert.equal(token[0]!.t, null, "an unknown token resolves to nothing");
  });

  it("provisioning and other owner work are not available to a hospital's scope or to the tenant-less scope", async () => {
    const tenants = t.app.get(TenantsService);
    const input = (code: string) => ({ tenant: { name: "Nope", code, timezone: "Asia/Kolkata" }, facility: { name: "Main", code: "NOPE", city: "K", state: "WB" }, admin: { username: "admin", fullName: "Nobody", password: "Synthetic-Pass-123" } });
    await assert.rejects(() => tenantScope.run(a.tenantId, () => tenants.provision(input(`blocked-${Date.now()}`))), /row-level security|violates|permission/i);
    await assert.rejects(() => tenantScope.system("test", () => tenants.provision(input(`blocked2-${Date.now()}`))), /row-level security|violates|permission/i);
    assert.equal(await t.prisma.tenant.count({ where: { code: { startsWith: "blocked" } } }), 0, "nothing was created");
  });

  // ───────────────────────── requests ─────────────────────────
  it("requests run under the tenant of the verified session, never one a caller names", async () => {
    const mine = await t.api("get", `/patients/${patientA}`, tokens.a);
    assert.equal(mine.status, 200);
    assert.equal((await t.api("get", `/patients/${patientB}`, tokens.a)).status, 404, "another hospital's patient is not found");
    // A token that names hospital B but belongs to a user of hospital A: signed validly, so only the tenant scope stops it.
    const secret = process.env["JWT_ACCESS_SECRET"]!;
    const forged = jwt.sign({ sub: a.admin.id, tid: b.tenantId, fid: a.facilityId, sid: randomUUID(), typ: "access" }, secret, { algorithm: "HS256", expiresIn: 300 });
    assert.equal((await t.api("get", `/patients/${patientB}`, forged)).status, 401, "the user is not found under the claimed hospital");
    assert.equal((await t.api("get", `/patients/${patientA}`, forged)).status, 401);
    const noTenant = jwt.sign({ sub: a.admin.id, fid: a.facilityId, sid: randomUUID(), typ: "access" }, secret, { algorithm: "HS256", expiresIn: 300 });
    assert.equal((await t.api("get", `/patients/${patientA}`, noTenant)).status, 401, "a token without a hospital is refused");
  });

  it("many simultaneous requests from two hospitals never see each other's data", async () => {
    const ids = {
      a: new Set((await t.prisma.user.findMany({ where: { tenantId: a.tenantId }, select: { id: true } })).map((u) => u.id)),
      b: new Set((await t.prisma.user.findMany({ where: { tenantId: b.tenantId }, select: { id: true } })).map((u) => u.id)),
    };
    const calls = Array.from({ length: 40 }, (_, i) => ({ who: i % 2 === 0 ? "a" : "b", r: t.api("get", "/users", i % 2 === 0 ? a.admin.token : b.admin.token) }));
    const results = await Promise.all(calls.map(async (c) => ({ who: c.who as "a" | "b", res: await c.r })));
    for (const { who, res } of results) {
      assert.equal(res.status, 200, `${who}: ${JSON.stringify(res.body?.error ?? null)}`);
      const got = (res.body.data as { id: string }[]).map((u) => u.id);
      assert.ok(got.length > 0 && got.every((id) => ids[who].has(id)), `a ${who} request returned only ${who} users`);
    }
  });

  // ───────────────────────── login, refresh, logout ─────────────────────────
  it("login finds the hospital through the narrow function and runs under it; unknown and inactive hospitals are refused alike", async () => {
    const ok = await t.login(a.code, "admin", undefined, a.facilityId);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.status, "AUTHENTICATED");
    const bad = await t.login("no-such-hospital", "admin");
    assert.equal(bad.status, 401);
    const wrongPw = await t.login(a.code, "admin", "Wrong-Password-1", a.facilityId);
    assert.equal(wrongPw.status, 401);
    assert.deepEqual(bad.body.error.code, wrongPw.body.error.code, "an unknown hospital looks the same as a wrong password");
    await t.prisma.tenant.update({ where: { id: a.tenantId }, data: { status: "INACTIVE" } });
    try { assert.equal((await t.login(a.code, "admin", undefined, a.facilityId)).status, 401, "an inactive hospital cannot sign in"); }
    finally { await t.prisma.tenant.update({ where: { id: a.tenantId }, data: { status: "ACTIVE" } }); }
    // The audit event for a failed login is written under the right hospital.
    const evt = await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LOGIN_FAILED" }, orderBy: { createdAt: "desc" } });
    assert.ok(evt, "LOGIN_FAILED is recorded for hospital A");
  });

  it("token refresh and logout find the hospital from the token alone; reuse is detected; logout is quiet about unknown tokens", async () => {
    const first = await t.login(b.code, "admin", undefined, b.facilityId);
    const rt1 = first.body.data.tokens.refreshToken as string;
    const refreshed = await t.api("post", "/auth/refresh").send({ refreshToken: rt1 });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    const rt2 = refreshed.body.data.refreshToken as string;
    assert.notEqual(rt2, rt1);
    const reuse = await t.api("post", "/auth/refresh").send({ refreshToken: rt1 });
    assert.equal(reuse.status, 401, "a rotated token cannot be used again");
    assert.equal((await t.api("post", "/auth/refresh").send({ refreshToken: rt2 })).status, 401, "and the whole family is revoked");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: b.tenantId, action: "REFRESH_TOKEN_REUSE_DETECTED" } }), "the theft signal is audited under its hospital");
    assert.equal((await t.api("post", "/auth/refresh").send({ refreshToken: "x".repeat(64) })).status, 401);
    const second = await t.login(b.code, "admin", undefined, b.facilityId);
    const out = await t.api("post", "/auth/logout").send({ refreshToken: second.body.data.tokens.refreshToken });
    assert.ok([200, 204].includes(out.status));
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: b.tenantId, action: "LOGOUT" } }));
    const unknown = await t.api("post", "/auth/logout").send({ refreshToken: "y".repeat(64) });
    assert.ok([200, 204].includes(unknown.status), "an unknown token gets the same answer");
  });

  // ───────────────────────── reminder worker ─────────────────────────
  it("the reminder worker lists hospitals through the narrow function and serves each under its own scope", async () => {
    const worker = t.app.get(RemindersService);
    // The test database is shared by every suite and is never wiped between runs, so reminders that other suites or earlier runs left
    // pending can have become due by now. This test is about enforcement, not about what else is in the database: clear those first.
    await t.prisma.appointmentReminder.updateMany({ where: { status: "PENDING", sendAt: { lte: new Date() } }, data: { status: "CANCELLED" } });
    const counts = await worker.runDue();
    assert.deepEqual(counts, { sent: 0, skipped: 0, retried: 0, failed: 0 }, "runs under enforcement with nothing due and no refusal");
    const due = await tenantScope.system("test", () => app.$queryRaw<{ t: string }[]>`SELECT medos_tenants_with_due_reminders(${new Date("2100-01-01")}::timestamptz)::text AS t`);
    assert.ok(Array.isArray(due));
    const tableRead = await tenantScope.system("test", () => app.appointmentReminder.findMany());
    assert.equal(tableRead.length, 0, "the worker's tenant-less step reads no reminder rows itself");
  });
});
