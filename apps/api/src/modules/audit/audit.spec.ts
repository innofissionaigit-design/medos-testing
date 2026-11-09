import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, PASSWORD, registerPatient, startApp, startVisit, type TestApp, type TestTenant } from "../../test/harness";

interface AuditRow { id: string; action: string; entityType: string; entityId: string | null; actorUserId: string | null; requestId: string | null; metadata: Record<string, unknown>; createdAt: string }

describe("audit trail review", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let cashier: { id: string; token: string };
  let manager: { id: string; token: string };

  const events = async (query: Record<string, string | number> = {}, tok = a.admin.token): Promise<AuditRow[]> => {
    const r = await t.api("get", "/audit-events", tok).query({ pageSize: 100, ...query });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data as AuditRow[];
  };
  const has = async (action: string, entityId?: string) => (await events({ action, ...(entityId ? { entityId } : {}) })).filter((e) => !entityId || e.entityId === entityId);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("aud-a");
    b = await t.makeTenant("aud-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    manager = await t.makeUser(a, ["MANAGER"]);
  });
  after(async () => { await t.close(); });

  it("every clinical, financial, security and administrative step of a day's work leaves an audit event with actor and request id", async () => {
    // security
    assert.equal((await t.login(a.code, "nobody-here", "Wrong-Password-1")).status, 401);
    // patient + visit
    const doctor = await makeDoctor(t, a);
    const p = await registerPatient(t, rec.token);
    assert.equal((await t.api("patch", `/patients/${p.id}`, rec.token).send({ version: p.version, city: "Howrah" })).status, 200);
    const v = await startVisit(t, rec.token, doctor, p.id);
    // consultation + prescription
    const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, doctor.token).send({ content: { chiefComplaint: "Fever and cough for 3 days" } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doctor.token).send({ text: "Acute bronchitis", type: "PROVISIONAL" })).status, 201);
    assert.equal((await t.api("put", `/encounters/${v.encounterId}/prescription`, doctor.token).send({ items: [{ genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3 }] })).status, 200);
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doctor.token).send({ version: c.body.data.version })).status, 200);
    // billing
    const inv = await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, lines: [{ description: "Consultation", unitPrice: "400", taxPercent: 0, quantity: 1 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const invId = inv.body.data.id as string;
    assert.equal((await t.api("post", `/invoices/${invId}/issue`, cashier.token)).status, 200);
    assert.equal((await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "0" })).status, 201);
    const pay = await t.api("post", `/invoices/${invId}/payments`, cashier.token).set("Idempotency-Key", `k-${randomUUID().slice(0, 18)}`).send({ payments: [{ method: "UPI", amount: "400", reference: "UPI-AUD-1" }] });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    // administration
    const staff = await t.makeUser(a, ["RECEPTIONIST"]);
    assert.equal((await t.api("patch", `/users/${staff.id}`, a.admin.token).send({ status: "INACTIVE" })).status, 200);
    assert.equal((await t.api("put", `/users/${staff.id}/roles`, a.admin.token).send({ roleIds: [a.roleIds["CASHIER"]] })).status, 200);

    const expected: Array<[string, string?]> = [
      ["LOGIN_FAILED"], ["PATIENT_CREATED", p.id], ["PATIENT_UPDATED", p.id], ["ENCOUNTER_OPENED", v.encounterId], ["DIAGNOSIS_RECORDED"], ["PRESCRIPTION_SIGNED"],
      ["CONSULTATION_SIGNED"], ["INVOICE_CREATED", invId], ["INVOICE_ISSUED", invId], ["SHIFT_OPENED"], ["PAYMENT_RECEIVED"], ["USER_DEACTIVATED", staff.id], ["USER_ROLES_CHANGED", staff.id],
    ];
    for (const [action, entityId] of expected) {
      const found = await has(action, entityId);
      assert.ok(found.length >= 1, `missing audit event ${action}`);
      if (action !== "LOGIN_FAILED") assert.ok(found.every((e) => e.actorUserId), `${action} has no actor`);
      assert.ok(found.every((e) => e.requestId), `${action} has no request id`);
    }
    const created = (await has("PATIENT_CREATED", p.id))[0]!;
    assert.equal(created.actorUserId, rec.id);
  });

  it("an audited mutation and its audit event commit together: a failed request writes no event", async () => {
    const before = (await events({ action: "INVOICE_ISSUED" })).length;
    const missing = randomUUID();
    assert.equal((await t.api("post", `/invoices/${missing}/issue`, cashier.token)).status, 404);
    assert.equal((await events({ action: "INVOICE_ISSUED" })).length, before);
  });

  it("audit metadata carries targeted change data only: no passwords, tokens, hashes or patient demographics", async () => {
    const all = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId } });
    assert.ok(all.length > 10);
    const FORBIDDEN = /password|"token"|(access|refresh|bearer|jwt)token|secret|hash|firstName|lastName|mobile|dateOfBirth|address|content|draft/i;
    for (const e of all) {
      const keys = JSON.stringify(Object.keys(e.metadata as object));
      assert.ok(!FORBIDDEN.test(keys), `${e.action} metadata keys leak sensitive fields: ${keys}`);
      assert.ok(!JSON.stringify(e.metadata).includes(PASSWORD), `${e.action} metadata contains a password`);
    }
  });

  it("filters by action, entity, actor and time; paginates with a capped page size", async () => {
    const byAction = await events({ action: "PATIENT_CREATED" });
    assert.ok(byAction.length >= 1 && byAction.every((e) => e.action === "PATIENT_CREATED"));
    const one = byAction[0]!;
    assert.ok((await events({ entityType: one.entityType, entityId: one.entityId! })).every((e) => e.entityId === one.entityId));
    assert.ok((await events({ actorUserId: one.actorUserId! })).every((e) => e.actorUserId === one.actorUserId));
    assert.equal((await events({ from: new Date(Date.now() + 3_600_000).toISOString() })).length, 0);
    const page1 = await t.api("get", "/audit-events", a.admin.token).query({ pageSize: 2, page: 1 });
    const page2 = await t.api("get", "/audit-events", a.admin.token).query({ pageSize: 2, page: 2 });
    assert.equal(page1.body.data.length, 2);
    assert.notEqual(page1.body.data[0].id, page2.body.data[0].id);
    assert.ok(page1.body.data[0].createdAt >= page1.body.data[1].createdAt, "newest first");
    assert.equal((await t.api("get", "/audit-events", a.admin.token).query({ pageSize: 500 })).status, 400);
    assert.equal((await t.api("get", "/audit-events", a.admin.token).query({ tenantId: b.tenantId })).status, 400, "no tenant override");
  });

  it("names the actor on each event and lists this tenant's staff for the user filter, gated by AUDIT_READ", async () => {
    const rows = (await t.api("get", "/audit-events", a.admin.token).query({ actorUserId: rec.id })).body.data as { actorUserId: string; actorName: string | null; actorUsername: string | null }[];
    const recUser = await t.prisma.user.findUniqueOrThrow({ where: { id: rec.id } });
    assert.ok(rows.length > 0 && rows.every((r) => r.actorName === recUser.fullName && r.actorUsername === recUser.username));
    const actors = await t.api("get", "/audit-events/actors", manager.token);
    assert.equal(actors.status, 200);
    const ids = new Set((actors.body.data as { id: string }[]).map((u) => u.id));
    assert.ok(ids.has(rec.id) && ids.has(manager.id));
    assert.ok(!ids.has(b.admin.id), "other tenants' staff never appear");
    assert.deepEqual(Object.keys(actors.body.data[0]).sort(), ["fullName", "id", "username"], "names only");
    assert.equal((await t.api("get", "/audit-events/actors", cashier.token)).status, 403);
  });

  it("is tenant-isolated and readable only with AUDIT_READ; the API offers no way to change events", async () => {
    const mine = new Set((await events()).map((e) => e.id));
    const theirs = await events({}, b.admin.token);
    assert.ok(theirs.every((e) => !mine.has(e.id)), "other tenant's events never appear");
    assert.equal((await t.api("get", "/audit-events", rec.token)).status, 403);
    assert.equal((await t.api("get", "/audit-events", cashier.token)).status, 403);
    assert.equal((await t.api("get", "/audit-events", manager.token)).status, 200);
    assert.equal((await t.api("get", "/audit-events")).status, 401);
    const some = (await events())[0]!;
    for (const m of ["post", "put", "patch", "delete"] as const) {
      const r = await t.api(m, `/audit-events/${some.id}`, a.admin.token).send({ action: "TAMPERED" });
      assert.ok([404, 405].includes(r.status), `${m} must not exist (got ${r.status})`);
    }
    await assert.rejects(() => t.prisma.auditEvent.delete({ where: { id: some.id } }), /append-only/);
    await assert.rejects(() => t.prisma.auditEvent.update({ where: { id: some.id }, data: { action: "TAMPERED" } }), /append-only/);
  });
});
