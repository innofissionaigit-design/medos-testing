import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

describe("facility and departments: what an administrator may change, and what is refused", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let token2: string; // admin signed in at the second facility

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("fac-a");
    b = await t.makeTenant("fac-b");
    const r = await t.login(a.code, "admin", undefined, a.facility2Id);
    token2 = r.body.data.tokens.accessToken as string;
  });
  after(async () => { await t.close(); });

  it("adds a facility, edits its details (blank clears), keeps the code, and rejects bad formats", async () => {
    const add = await t.api("post", "/facilities", a.admin.token).send({ code: "north", name: "North Wing" });
    assert.equal(add.status, 400, "the code must be capital letters");
    const ok = await t.api("post", "/facilities", a.admin.token).send({ code: "NORTH", name: "North Wing" });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.status, "ACTIVE");
    assert.equal((await t.api("post", "/facilities", a.admin.token).send({ code: "NORTH", name: "Again" })).status, 409, "codes are unique in the hospital");
    assert.ok((await t.api("get", "/facilities", a.admin.token)).body.data.some((f: { id: string }) => f.id === ok.body.data.id), "the creator can see it");
    const id = ok.body.data.id as string;
    const up = await t.api("patch", `/facilities/${id}`, a.admin.token).send({ name: "North Wing Hospital", city: "Siliguri", postalCode: "734001", phone: "+91 353 000 0000", gstin: "19ABCDE1234F1Z5" });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.deepEqual([up.body.data.city, up.body.data.postalCode, up.body.data.code], ["Siliguri", "734001", "NORTH"]);
    assert.equal((await t.api("patch", `/facilities/${id}`, a.admin.token).send({ city: null })).body.data.city, null, "null clears a detail");
    for (const bad of [{ postalCode: "12" }, { gstin: "123" }, { phone: "abc" }, { email: "nope" }, { name: "x" }, { code: "OTHER" }, {}]) {
      assert.equal((await t.api("patch", `/facilities/${id}`, a.admin.token).send(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await t.api("patch", `/facilities/${id}`, b.admin.token).send({ name: "Hijack" })).status, 404, "another hospital's facility is simply not found");
  });

  it("a facility with admitted patients cannot be switched off; one without can, and can be switched on again", async () => {
    const doc = await makeDoctor(t, a, { facilityId: a.facility2Id });
    const ward = (await t.api("post", "/wards", token2).send({ name: `Ward ${uniqueWord(4)}`, code: "WF2" })).body.data;
    const room = (await t.api("post", "/rooms", token2).send({ wardId: ward.id, name: "Room 1", code: "RF2" })).body.data;
    const bed = (await t.api("post", "/beds", token2).send({ roomId: room.id, code: "BF2", dailyRate: "500" })).body.data;
    const rec2 = await t.makeUser(a, ["RECEPTIONIST"], { facilityIds: [a.facility2Id] });
    const patient = await registerPatient(t, rec2.token);
    const adm = await t.api("post", "/admissions", rec2.token).send({ patientId: patient.id, consultantId: doc.practitionerId, bedId: bed.id, reason: "Observation after surgery" });
    assert.equal(adm.status, 201, JSON.stringify(adm.body));

    const refused = await t.api("patch", `/facilities/${a.facility2Id}`, a.admin.token).send({ status: "INACTIVE" });
    assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details?.admitted], [409, "INVALID_STATE", 1]);
    assert.match(refused.body.error.message, /1 patient is still admitted/);
    assert.equal((await t.prisma.facility.findFirstOrThrow({ where: { id: a.facility2Id } })).status, "ACTIVE", "nothing changed");

    const empty = await t.api("post", "/facilities", a.admin.token).send({ code: "SPARE", name: "Spare" });
    assert.equal((await t.api("patch", `/facilities/${empty.body.data.id}`, a.admin.token).send({ status: "INACTIVE" })).status, 200);
    assert.equal((await t.api("patch", `/facilities/${empty.body.data.id}`, a.admin.token).send({ status: "ACTIVE" })).status, 200);
    const trail = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: empty.body.data.id }, select: { action: true }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(trail.map((e) => e.action), ["FACILITY_CREATED", "FACILITY_STATUS_CHANGED", "FACILITY_STATUS_CHANGED"]);
  });

  it("departments: add, rename, switch off only when no working doctor is in them, and switch back on", async () => {
    const dept = (await t.api("post", "/departments", a.admin.token).send({ name: "Cardiology", code: "cardio" })).body.data;
    assert.equal(dept.code, "CARDIO");
    const rename = await t.api("patch", `/departments/${dept.id}`, a.admin.token).send({ name: "Cardiology and Heart Care" });
    assert.equal(rename.body.data.name, "Cardiology and Heart Care");
    assert.equal((await t.api("patch", `/departments/${dept.id}`, a.admin.token).send({ code: "NEW" })).status, 400, "the code does not change");

    const doc = (await t.api("post", "/practitioners", a.admin.token).send({ displayName: "Dr. Heart", departmentId: dept.id })).body.data;
    const refused = await t.api("patch", `/departments/${dept.id}`, a.admin.token).send({ status: "INACTIVE" });
    assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details?.doctors], [409, "INVALID_STATE", 1]);
    assert.equal((await t.api("get", "/departments", a.admin.token)).body.data.some((d: { id: string }) => d.id === dept.id), true, "still listed");

    // Moving the doctor (or switching them off) lets the department be switched off.
    assert.equal((await t.api("patch", `/practitioners/${doc.id}`, a.admin.token).send({ status: "INACTIVE" })).status, 200);
    assert.equal((await t.api("patch", `/departments/${dept.id}`, a.admin.token).send({ status: "INACTIVE" })).status, 200);
    assert.equal((await t.api("get", "/departments", a.admin.token)).body.data.some((d: { id: string }) => d.id === dept.id), false, "hidden from everyday lists");
    assert.equal((await t.api("get", "/departments?includeInactive=true", a.admin.token)).body.data.find((d: { id: string }) => d.id === dept.id).status, "INACTIVE", "still there for the administrator");
    assert.equal((await t.api("post", "/practitioners", a.admin.token).send({ displayName: "Dr. Late", departmentId: dept.id })).status, 400, "no new doctors in a switched-off department");
    assert.equal((await t.api("patch", `/departments/${dept.id}`, a.admin.token).send({ status: "ACTIVE" })).status, 200);
    assert.equal((await t.api("patch", `/departments/${randomUUID()}`, a.admin.token).send({ status: "ACTIVE" })).status, 404);
    assert.equal((await t.api("patch", `/departments/${dept.id}`, b.admin.token).send({ name: "Hijack" })).status, 404, "another hospital's department is not found");
  });

  it("only administrators can change them", async () => {
    const rec = await t.makeUser(a, ["RECEPTIONIST"]);
    assert.equal((await t.api("post", "/departments", rec.token).send({ name: "Nope", code: "NOPE" })).status, 403);
    assert.equal((await t.api("post", "/facilities", rec.token).send({ code: "NOPE", name: "Nope" })).status, 403);
    assert.equal((await t.api("patch", `/facilities/${a.facilityId}`, rec.token).send({ name: "Nope" })).status, 403);
    assert.equal((await t.api("get", "/departments", rec.token)).status, 200, "everyone can read them");
  });
});
