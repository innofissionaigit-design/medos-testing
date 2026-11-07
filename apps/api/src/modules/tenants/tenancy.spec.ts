import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PASSWORD, startApp, type TestApp, type TestTenant } from "../../test/harness";

describe("tenant and facility isolation", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("iso-a");
    b = await t.makeTenant("iso-b");
  });
  after(async () => { await t.close(); });

  it("cross-tenant facility reads look exactly like non-existent ids (no existence oracle)", async () => {
    const cross = await t.api("get", `/facilities/${b.facilityId}`, a.admin.token);
    const missing = await t.api("get", `/facilities/${randomUUID()}`, a.admin.token);
    const malformed = await t.api("get", "/facilities/not-a-uuid", a.admin.token);
    for (const r of [cross, missing]) {
      assert.equal(r.status, 404);
      assert.equal(r.body.error.code, "FACILITY_NOT_FOUND");
    }
    assert.equal(cross.body.error.message, missing.body.error.message);
    assert.equal(malformed.status, 404);
  });

  it("cross-tenant facility update is rejected and leaves the foreign record untouched", async () => {
    const r = await t.api("patch", `/facilities/${b.facilityId}`, a.admin.token).send({ name: "Hijacked" });
    assert.equal(r.status, 404);
    const f = await t.prisma.facility.findFirstOrThrow({ where: { id: b.facilityId } });
    assert.notEqual(f.name, "Hijacked");
  });

  it("cross-tenant user access (read, update, roles, facilities, password reset) is not found", async () => {
    const victim = await t.makeUser(b, ["RECEPTIONIST"]);
    const tok = a.admin.token;
    assert.equal((await t.api("get", `/users/${victim.id}`, tok)).status, 404);
    assert.equal((await t.api("patch", `/users/${victim.id}`, tok).send({ status: "INACTIVE" })).status, 404);
    assert.equal((await t.api("put", `/users/${victim.id}/roles`, tok).send({ roleIds: [a.roleIds["DOCTOR"]] })).status, 404);
    assert.equal((await t.api("put", `/users/${victim.id}/facilities`, tok).send({ facilityIds: [a.facilityId] })).status, 404);
    assert.equal((await t.api("post", `/users/${victim.id}/reset-password`, tok).send({ password: "Taken-Over-123" })).status, 404);
    const still = await t.prisma.user.findFirstOrThrow({ where: { id: victim.id } });
    assert.equal(still.status, "ACTIVE");
  });

  it("cannot attach another tenant's roles or facilities when creating or editing users", async () => {
    const withForeignRole = await t.api("post", "/users", a.admin.token).send({
      username: "evil1", fullName: "Evil One", password: "Valid-Passw0rd-1", roleIds: [b.roleIds["ADMINISTRATOR"]], facilityIds: [a.facilityId],
    });
    assert.equal(withForeignRole.status, 400);
    const withForeignFacility = await t.api("post", "/users", a.admin.token).send({
      username: "evil2", fullName: "Evil Two", password: "Valid-Passw0rd-1", roleIds: [a.roleIds["RECEPTIONIST"]], facilityIds: [b.facilityId],
    });
    assert.equal(withForeignFacility.status, 400);
    assert.equal(await t.prisma.user.count({ where: { username: { in: ["evil1", "evil2"] } } }), 0);
  });

  it("the database itself rejects cross-tenant relations (composite foreign keys)", async () => {
    const victim = await t.makeUser(b, ["RECEPTIONIST"]);
    await assert.rejects(() => t.prisma.userRole.create({ data: { tenantId: a.tenantId, userId: victim.id, roleId: a.roleIds["DOCTOR"] as string } }));
    await assert.rejects(() => t.prisma.userFacility.create({ data: { tenantId: a.tenantId, userId: a.admin.id, facilityId: b.facilityId } }));
  });

  it("ignores client-supplied tenant/facility identifiers (strict bodies, headers and query)", async () => {
    const body = await t.api("post", "/facilities", a.admin.token).send({ name: "Sneaky", code: "SNK1", tenantId: b.tenantId });
    assert.equal(body.status, 400);
    assert.equal(body.body.error.code, "VALIDATION_FAILED");
    const hdr = await t.api("get", "/facilities", a.admin.token).set("X-Tenant-Id", b.tenantId).set("X-Facility-Id", b.facilityId).query({ tenantId: b.tenantId });
    assert.equal(hdr.status, 200);
    assert.ok(hdr.body.data.every((f: { id: string }) => f.id !== b.facilityId), "foreign tenant/facility hints are ignored");
  });

  it("lists only the caller's tenant data (facilities, users, audit events, roles)", async () => {
    const facilities = await t.api("get", "/facilities", a.admin.token);
    assert.ok(facilities.body.data.every((f: { id: string }) => [a.facilityId, a.facility2Id].includes(f.id)));
    const users = await t.api("get", "/users", a.admin.token);
    assert.ok(users.body.data.length >= 1);
    const ids = new Set((await t.prisma.user.findMany({ where: { tenantId: a.tenantId } })).map((u) => u.id));
    assert.ok(users.body.data.every((u: { id: string }) => ids.has(u.id)));
    const audit = await t.api("get", "/audit-events", a.admin.token).query({ pageSize: 100 });
    assert.ok(audit.body.data.length > 0);
    const foreign = await t.prisma.auditEvent.findMany({ where: { tenantId: b.tenantId }, select: { id: true } });
    const foreignIds = new Set(foreign.map((e) => e.id));
    assert.ok(audit.body.data.every((e: { id: string }) => !foreignIds.has(e.id)));
    const roles = await t.api("get", "/roles", a.admin.token);
    const foreignRoles = new Set(Object.values(b.roleIds));
    assert.ok(roles.body.data.every((r: { id: string }) => !foreignRoles.has(r.id)));
  });

  it("enforces facility access: users only see and switch into their own facilities", async () => {
    const rec = await t.makeUser(a, ["RECEPTIONIST"], { facilityIds: [a.facilityId] });
    const list = await t.api("get", "/facilities", rec.token);
    assert.deepEqual(list.body.data.map((f: { id: string }) => f.id), [a.facilityId]);
    assert.equal((await t.api("get", `/facilities/${a.facility2Id}`, rec.token)).status, 404);
    assert.equal((await t.api("patch", `/facilities/${a.facilityId}`, rec.token).send({ name: "x1" })).status, 403);
  });

  it("revoking facility access takes effect on already-issued tokens", async () => {
    const u = await t.makeUser(a, ["RECEPTIONIST"], { facilityIds: [a.facilityId, a.facility2Id] });
    assert.equal((await t.api("get", "/auth/me", u.token)).status, 200);
    const other = await t.login(a.code, u.username, PASSWORD, a.facility2Id);
    assert.equal(other.status, 200, JSON.stringify(other.body));
    const r = await t.api("put", `/users/${u.id}/facilities`, a.admin.token).send({ facilityIds: [a.facility2Id] });
    assert.equal(r.status, 200);
    // The session at the facility they lost ends at once (its refresh token is revoked with the access), so the old token is refused outright.
    const after = await t.api("get", "/auth/me", u.token);
    assert.equal(after.status, 401);
    assert.equal(after.body.error.code, "UNAUTHENTICATED");
    assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: "x".repeat(43) })).status, 401);
    // Their session at the facility they still have is untouched.
    assert.equal((await t.api("get", "/auth/me", other.body.data.tokens.accessToken)).status, 200);
  });

  it("validates facility input, keeps codes unique per tenant, and allows same code in another tenant", async () => {
    const bad = await t.api("post", "/facilities", a.admin.token).send({ name: "X", code: "lower case" });
    assert.equal(bad.status, 400);
    const badGst = await t.api("post", "/facilities", a.admin.token).send({ name: "Gst Test", code: "GST1", gstin: "NOTAGSTIN" });
    assert.equal(badGst.status, 400);
    const ok = await t.api("post", "/facilities", a.admin.token).send({ name: "Branch One", code: "BR1", gstin: "19ABCDE1234F1Z5", postalCode: "700001", phone: "+91 98300 00000" });
    assert.equal(ok.status, 201);
    const dup = await t.api("post", "/facilities", a.admin.token).send({ name: "Branch Dup", code: "BR1" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, "CONFLICT");
    const otherTenant = await t.api("post", "/facilities", b.admin.token).send({ name: "Branch One B", code: "BR1" });
    assert.equal(otherTenant.status, 201);
  });

  it("refuses to deactivate the facility the caller is working in, and audits facility changes", async () => {
    const self = await t.api("patch", `/facilities/${a.facilityId}`, a.admin.token).send({ status: "INACTIVE" });
    assert.equal(self.status, 409);
    const ok = await t.api("patch", `/facilities/${a.facility2Id}`, a.admin.token).send({ status: "INACTIVE" });
    assert.equal(ok.status, 200);
    const evt = await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "FACILITY_STATUS_CHANGED", entityId: a.facility2Id } });
    assert.ok(evt && evt.actorUserId === a.admin.id);
  });

  it("tenant settings: only the administrator can update; timezone validated; audited", async () => {
    const rec = await t.makeUser(a, ["RECEPTIONIST"]);
    assert.equal((await t.api("patch", "/tenants/current", rec.token).send({ name: "Nope Hospital" })).status, 403);
    assert.equal((await t.api("patch", "/tenants/current", a.admin.token).send({ timezone: "Mars/Olympus" })).status, 400);
    assert.equal((await t.api("patch", "/tenants/current", a.admin.token).send({ code: "newcode" })).status, 400, "code is immutable");
    const ok = await t.api("patch", "/tenants/current", a.admin.token).send({ name: "Renamed Hospital" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.name, "Renamed Hospital");
    const bUntouched = await t.api("get", "/tenants/current", b.admin.token);
    assert.notEqual(bUntouched.body.data.name, "Renamed Hospital");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "TENANT_UPDATED" } }));
  });

  it("provisioning is atomic: a duplicate tenant code leaves no partial data", async () => {
    const before = await t.prisma.user.count();
    const { TenantsService } = await import("./tenants.service");
    const svc = t.app.get(TenantsService);
    await assert.rejects(() => svc.provision({
      tenant: { name: "Dup Hospital", code: a.code, timezone: "Asia/Kolkata" },
      facility: { name: "Dup", code: "DUP1" },
      admin: { username: "dupadmin", fullName: "Dup Admin", password: "Valid-Passw0rd-1" },
    }));
    assert.equal(await t.prisma.user.count(), before);
  });
});
