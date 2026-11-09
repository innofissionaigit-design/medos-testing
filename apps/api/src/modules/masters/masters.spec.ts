import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startApp, type TestApp, type TestTenant } from "../../test/harness";

describe("hospital masters: departments and practitioners", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("mst-a");
    b = await t.makeTenant("mst-b");
  });
  after(async () => { await t.close(); });

  it("administrator creates departments; codes are normalised and unique per facility", async () => {
    const r = await t.api("post", "/departments", a.admin.token).send({ name: "General Medicine", code: "gm" });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.code, "GM");
    assert.equal((await t.api("post", "/departments", a.admin.token).send({ name: "Dup", code: "GM" })).status, 409);
    assert.equal((await t.api("post", "/departments", b.admin.token).send({ name: "General Medicine", code: "GM" })).status, 201, "same code in another tenant is fine");
    assert.equal((await t.api("post", "/departments", a.admin.token).send({ name: "X", code: "bad code!" })).status, 400);
  });

  it("any authenticated user can read active masters; only ADMIN_MASTERS can write", async () => {
    const rec = await t.makeUser(a, ["RECEPTIONIST"]);
    const list = await t.api("get", "/departments", rec.token);
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some((d: { code: string }) => d.code === "GM"));
    assert.equal((await t.api("post", "/departments", rec.token).send({ name: "Sneaky", code: "SNK" })).status, 403);
    assert.equal((await t.api("post", "/practitioners", rec.token).send({ displayName: "Dr Sneaky" })).status, 403);
    assert.equal((await t.api("get", "/departments")).status, 401);
  });

  it("hides inactive masters from non-admins even if they ask for them", async () => {
    const d = await t.api("post", "/departments", a.admin.token).send({ name: "Old Dept", code: "OLD" });
    await t.api("patch", `/departments/${d.body.data.id}`, a.admin.token).send({ status: "INACTIVE" });
    const rec = await t.makeUser(a, ["RECEPTIONIST"]);
    const asRec = await t.api("get", "/departments", rec.token).query({ includeInactive: "true" });
    assert.ok(!asRec.body.data.some((x: { code: string }) => x.code === "OLD"));
    const asAdmin = await t.api("get", "/departments", a.admin.token).query({ includeInactive: "true" });
    assert.ok(asAdmin.body.data.some((x: { code: string }) => x.code === "OLD"));
  });

  it("is isolated across tenants and across facilities (IDOR on update)", async () => {
    const bDept = await t.api("post", "/departments", b.admin.token).send({ name: "B Cardiology", code: "CARD" });
    const cross = await t.api("patch", `/departments/${bDept.body.data.id}`, a.admin.token).send({ name: "Hijack" });
    const missing = await t.api("patch", `/departments/${randomUUID()}`, a.admin.token).send({ name: "Hijack" });
    assert.equal(cross.status, 404);
    assert.equal(cross.body.error.message, missing.body.error.message);
    const aList = await t.api("get", "/departments", a.admin.token);
    assert.ok(!aList.body.data.some((x: { code: string }) => x.code === "CARD"));

    // facility isolation: masters belong to the facility in the session
    const login2 = await t.login(a.code, "admin", undefined, a.facility2Id);
    const tok2 = login2.body.data.tokens.accessToken as string;
    const f2 = await t.api("get", "/departments", tok2);
    assert.ok(!f2.body.data.some((x: { code: string }) => x.code === "GM"), "facility 2 does not see facility 1 departments");
    const gm = aList.body.data.find((x: { code: string }) => x.code === "GM");
    assert.equal((await t.api("patch", `/departments/${gm.id}`, tok2).send({ name: "Cross Facility" })).status, 404);
  });

  it("creates practitioners linked to a department and a facility user; rejects foreign links", async () => {
    const dept = (await t.api("get", "/departments", a.admin.token)).body.data.find((x: { code: string }) => x.code === "GM");
    const docUser = await t.makeUser(a, ["DOCTOR"]);
    const ok = await t.api("post", "/practitioners", a.admin.token).send({ displayName: "Dr. Anirban Sen", specialty: "Internal Medicine", registrationNo: "WBMC-12345", departmentId: dept.id, userId: docUser.id });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.userId, docUser.id);

    const bUser = await t.makeUser(b, ["DOCTOR"]);
    const bDept = (await t.api("get", "/departments", b.admin.token)).body.data[0];
    assert.equal((await t.api("post", "/practitioners", a.admin.token).send({ displayName: "Dr Foreign User", userId: bUser.id })).status, 400);
    assert.equal((await t.api("post", "/practitioners", a.admin.token).send({ displayName: "Dr Foreign Dept", departmentId: bDept.id })).status, 400);
    assert.equal((await t.api("post", "/practitioners", a.admin.token).send({ displayName: "Dr Dup User", userId: docUser.id })).status, 409);

    const inactiveUser = await t.makeUser(a, ["DOCTOR"]);
    await t.api("patch", `/users/${inactiveUser.id}`, a.admin.token).send({ status: "INACTIVE" });
    assert.equal((await t.api("post", "/practitioners", a.admin.token).send({ displayName: "Dr Inactive", userId: inactiveUser.id })).status, 400);
  });

  it("the database blocks cross-tenant practitioner links even if the service were bypassed", async () => {
    const bUser = await t.makeUser(b, ["DOCTOR"]);
    await assert.rejects(
      () => t.prisma.practitioner.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, displayName: "Raw Insert", userId: bUser.id } }),
      /Invalid reference/,
    );
    const bDept = await t.prisma.department.findFirstOrThrow({ where: { tenantId: b.tenantId } });
    await assert.rejects(
      () => t.prisma.practitioner.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, displayName: "Raw Dept", departmentId: bDept.id } }),
      /Invalid reference/,
    );
  });

  it("audits master changes with the acting administrator", async () => {
    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PRACTITIONER_CREATED" } });
    assert.equal(evt.actorUserId, a.admin.id);
    assert.equal(evt.facilityId, a.facilityId);
  });

  it("rejects mass assignment and empty updates", async () => {
    const dept = (await t.api("get", "/departments", a.admin.token)).body.data.find((x: { code: string }) => x.code === "GM");
    assert.equal((await t.api("patch", `/departments/${dept.id}`, a.admin.token).send({ tenantId: b.tenantId })).status, 400);
    assert.equal((await t.api("patch", `/departments/${dept.id}`, a.admin.token).send({})).status, 400);
    assert.equal((await t.api("post", "/practitioners", a.admin.token).send({ displayName: "Dr X Tenant", tenantId: b.tenantId })).status, 400);
  });
});
