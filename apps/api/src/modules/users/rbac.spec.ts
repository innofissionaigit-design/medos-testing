import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PERMISSIONS, SYSTEM_ROLES } from "@medos/shared";
import { CONTROLLERS } from "../../app.module";
import { ANY_AUTHENTICATED, IS_PUBLIC, REQUIRED_ANY_PERMISSIONS, REQUIRED_PERMISSIONS } from "../../common/http";
import { PASSWORD, startApp, type TestApp, type TestTenant } from "../../test/harness";

describe("route access policy", () => {
  it("every route explicitly declares public, any-authenticated or required permissions", () => {
    const undeclared: string[] = [];
    let routes = 0;
    for (const C of CONTROLLERS) {
      const proto = C.prototype as unknown as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === "constructor" || typeof handler !== "function") continue;
        if (Reflect.getMetadata("method", handler) === undefined) continue; // not a route
        routes++;
        const declared =
          Reflect.getMetadata(IS_PUBLIC, handler) === true ||
          Reflect.getMetadata(ANY_AUTHENTICATED, handler) === true ||
          (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as unknown[] | undefined)?.length ||
          (Reflect.getMetadata(REQUIRED_ANY_PERMISSIONS, handler) as unknown[] | undefined)?.length;
        if (!declared) undeclared.push(`${C.name}.${name}`);
      }
    }
    assert.ok(routes > 15, "route scan must actually find routes");
    assert.deepEqual(undeclared, []);
  });

  it("system roles only reference known permissions", () => {
    const known = new Set<string>(PERMISSIONS);
    for (const [role, perms] of Object.entries(SYSTEM_ROLES)) {
      for (const p of perms) assert.ok(known.has(p), `${role} -> ${p}`);
    }
  });
});

describe("RBAC enforcement", () => {
  let t: TestApp;
  let tenant: TestTenant;

  before(async () => {
    t = await startApp();
    tenant = await t.makeTenant("rbac");
  });
  after(async () => { await t.close(); });

  it("denies admin-only endpoints to non-admin roles with FORBIDDEN, and unauthenticated callers with 401", async () => {
    const rec = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const doc = await t.makeUser(tenant, ["DOCTOR"]);
    const adminOnly: [("get" | "post" | "put" | "patch"), string][] = [
      ["get", "/users"], ["post", "/users"], ["get", "/roles"], ["post", "/roles"],
      ["get", "/audit-events"], ["get", "/number-sequences"], ["post", "/facilities"],
      ["patch", "/tenants/current"],
    ];
    for (const [m, p] of adminOnly) {
      for (const u of [rec, doc]) {
        const r = await t.api(m, p, u.token).send({});
        assert.equal(r.status, 403, `${m} ${p}`);
        assert.equal(r.body.error.code, "FORBIDDEN");
      }
      assert.equal((await t.api(m, p).send({})).status, 401, `${m} ${p} unauthenticated`);
    }
  });

  it("applies a role permission change to already-issued tokens immediately", async () => {
    const role = await t.api("post", "/roles", tenant.admin.token).send({ name: "Audit Viewer", permissions: ["AUDIT_READ"] });
    assert.equal(role.status, 201);
    const u = await t.makeUser(tenant, []);
    const grant = await t.api("put", `/users/${u.id}/roles`, tenant.admin.token).send({ roleIds: [role.body.data.id] });
    assert.equal(grant.status, 200);
    assert.equal((await t.api("get", "/audit-events", u.token)).status, 200);
    const revoke = await t.api("put", `/roles/${role.body.data.id}/permissions`, tenant.admin.token).send({ permissions: ["REPORT_READ"] });
    assert.equal(revoke.status, 200);
    assert.equal((await t.api("get", "/audit-events", u.token)).status, 403);
  });

  it("rejects unknown permissions and protects system roles from modification", async () => {
    assert.equal((await t.api("post", "/roles", tenant.admin.token).send({ name: "Bogus", permissions: ["GOD_MODE"] })).status, 400);
    const sys = await t.api("put", `/roles/${tenant.roleIds["RECEPTIONIST"]}/permissions`, tenant.admin.token).send({ permissions: ["ADMIN_USERS"] });
    assert.equal(sys.status, 409);
    const dup = await t.api("post", "/roles", tenant.admin.token).send({ name: "RECEPTIONIST", permissions: ["PATIENT_READ"] });
    assert.equal(dup.status, 409);
  });

  it("prevents privilege self-escalation: administrators cannot change their own roles, facilities, status or password via admin routes", async () => {
    const ownId = tenant.admin.id;
    const tok = tenant.admin.token;
    assert.equal((await t.api("put", `/users/${ownId}/roles`, tok).send({ roleIds: [tenant.roleIds["DOCTOR"]] })).status, 409);
    assert.equal((await t.api("put", `/users/${ownId}/facilities`, tok).send({ facilityIds: [tenant.facilityId] })).status, 409);
    assert.equal((await t.api("patch", `/users/${ownId}`, tok).send({ status: "INACTIVE" })).status, 409);
    assert.equal((await t.api("post", `/users/${ownId}/reset-password`, tok).send({ password: "Another-Passw0rd-1" })).status, 409);
  });

  it("blocks mass assignment: protected fields cannot be set through user/role/facility endpoints", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    for (const evil of [{ passwordHash: "x" }, { tenantId: "x" }, { id: "x" }, { failedLoginCount: 0 }, { isSystem: true }]) {
      const r = await t.api("patch", `/users/${u.id}`, tenant.admin.token).send({ fullName: "Ok Name", ...evil });
      assert.equal(r.status, 400, JSON.stringify(evil));
    }
    const role = await t.api("post", "/roles", tenant.admin.token).send({ name: "Mass Assign", permissions: ["PATIENT_READ"], isSystem: true });
    assert.equal(role.status, 400);
  });

  it("creates users with roles and facilities, enforces the password policy, and the new user can log in", async () => {
    const weak = await t.api("post", "/users", tenant.admin.token).send({ username: "weak1", fullName: "Weak One", password: "short", roleIds: [tenant.roleIds["NURSE"]], facilityIds: [tenant.facilityId] });
    assert.equal(weak.status, 400);
    const noDigits = await t.api("post", "/users", tenant.admin.token).send({ username: "weak2", fullName: "Weak Two", password: "onlyletterslong", roleIds: [tenant.roleIds["NURSE"]], facilityIds: [tenant.facilityId] });
    assert.equal(noDigits.status, 400);
    const ok = await t.api("post", "/users", tenant.admin.token).send({
      username: "nurse.priya", fullName: "Priya Das", email: "Priya@Example.test", password: PASSWORD, roleIds: [tenant.roleIds["NURSE"]], facilityIds: [tenant.facilityId],
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.email, "priya@example.test");
    assert.equal(ok.body.data.passwordHash, undefined, "password hash must never be returned");
    const login = await t.login(tenant.code, "nurse.priya", PASSWORD);
    assert.equal(login.status, 200);
    const dup = await t.api("post", "/users", tenant.admin.token).send({ username: "nurse.priya", fullName: "Dup", password: PASSWORD, roleIds: [tenant.roleIds["NURSE"]], facilityIds: [tenant.facilityId] });
    assert.equal(dup.status, 409);
  });

  it("audits permission changes with the acting user and before/after state", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    await t.api("put", `/users/${u.id}/roles`, tenant.admin.token).send({ roleIds: [tenant.roleIds["CASHIER"]] });
    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: tenant.tenantId, action: "USER_ROLES_CHANGED", entityId: u.id } });
    assert.equal(evt.actorUserId, tenant.admin.id);
    const meta = evt.metadata as { before: string[]; after: string[] };
    assert.deepEqual(meta.before, [tenant.roleIds["RECEPTIONIST"]]);
    assert.deepEqual(meta.after, [tenant.roleIds["CASHIER"]]);
  });

  it("deactivating a user revokes their refresh tokens; password reset revokes sessions and unlocks", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const l = await t.login(tenant.code, u.username);
    const rt = l.body.data.tokens.refreshToken as string;
    await t.api("post", `/users/${u.id}/reset-password`, tenant.admin.token).send({ password: "Reset-Passw0rd-77" });
    assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt })).status, 401);
    assert.equal((await t.login(tenant.code, u.username, "Reset-Passw0rd-77")).status, 200);
    const l2 = await t.login(tenant.code, u.username, "Reset-Passw0rd-77");
    await t.api("patch", `/users/${u.id}`, tenant.admin.token).send({ status: "INACTIVE" });
    assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: l2.body.data.tokens.refreshToken })).status, 401);
  });

  it("paginates and filters the user list within bounds", async () => {
    const r = await t.api("get", "/users", tenant.admin.token).query({ page: 1, pageSize: 2 });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.length <= 2);
    assert.ok(r.body.meta.total >= r.body.data.length);
    assert.equal((await t.api("get", "/users", tenant.admin.token).query({ pageSize: 1000 })).status, 400);
    const s = await t.api("get", "/users", tenant.admin.token).query({ q: "Synthetic Admin" });
    assert.ok(s.body.data.some((u: { username: string }) => u.username === "admin"));
  });
});

describe("permission list for the role editor", () => {
  let t: TestApp;
  let tenant: TestTenant;
  before(async () => { t = await startApp(); tenant = await t.makeTenant("perm-list"); });
  after(async () => { await t.close(); });

  it("administrators get every permission name; others and anonymous callers are refused", async () => {
    const r = await t.api("get", "/permissions", tenant.admin.token);
    assert.equal(r.status, 200);
    assert.deepEqual([...r.body.data].sort(), [...PERMISSIONS].sort());
    const rec = await t.makeUser(tenant, ["RECEPTIONIST"]);
    assert.equal((await t.api("get", "/permissions", rec.token)).status, 403);
    assert.equal((await t.api("get", "/permissions")).status, 401);
  });
});