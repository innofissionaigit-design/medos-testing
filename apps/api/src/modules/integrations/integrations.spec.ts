import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hashApiKey } from "../../common/auth.guard";
import { makeDoctor, patientBody, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

describe("integration API: keys for outside systems and bots, booking through the API", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let doc: TestDoctor;
  let bDoc: TestDoctor;
  let day = 0;

  type Client = { id: string; name: string; keyPrefix: string; status: string };
  const makeClient = async (abilities = ["FIND_PATIENTS", "REGISTER_PATIENTS", "BOOK_APPOINTMENTS"], tenant = a, extra: Record<string, unknown> = {}) => {
    const r = await t.api("post", "/integrations/clients", tenant.admin.token).send({ name: `Bot ${uniqueWord(6)}`, abilities, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { client: Client; apiKey: string };
  };
  const at = (daysAhead: number, hour = 10) => {
    const d = new Date(Date.now() + daysAhead * 86_400_000);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 5, 30)).toISOString();
  };
  const nextDay = () => 30 + 10 * day++;
  const idem = () => `bot-${randomUUID().slice(0, 16)}`;
  const mobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("int-a");
    b = await t.makeTenant("int-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
    bDoc = await makeDoctor(t, b);
    for (const [tenant, d] of [[a, doc], [b, bDoc]] as const) {
      await t.prisma.practitionerSchedule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ tenantId: tenant.tenantId, facilityId: tenant.facilityId, practitionerId: d.practitionerId, dayOfWeek, startMinute: 0, endMinute: 1439, slotMinutes: 15 })) });
    }
  });
  after(async () => { await t.close(); });

  describe("creating and revoking keys", () => {
    it("only people with ADMIN_INTEGRATIONS manage keys; the key is shown once and only its hash is stored", async () => {
      const body = { name: `Voice bot ${uniqueWord(4)}`, abilities: ["BOOK_APPOINTMENTS"] };
      assert.equal((await t.api("post", "/integrations/clients", rec.token).send(body)).status, 403);
      assert.equal((await t.api("post", "/integrations/clients", doc.token).send(body)).status, 403);
      assert.equal((await t.api("post", "/integrations/clients").send(body)).status, 401);
      const r = await t.api("post", "/integrations/clients", a.admin.token).send(body);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const { client, apiKey } = r.body.data as { client: Client; apiKey: string };
      assert.match(apiKey, /^mdk_[A-Za-z0-9_-]{43}$/);
      assert.equal(client.keyPrefix, apiKey.slice(0, 12));
      const row = await t.prisma.apiClient.findFirstOrThrow({ where: { id: client.id } });
      assert.equal(row.keyHash, hashApiKey(apiKey));
      assert.notEqual(row.keyHash, apiKey);
      const list = await t.api("get", "/integrations/clients", a.admin.token);
      assert.ok(!JSON.stringify(list.body).includes(apiKey), "the key is never listed again");
      assert.ok(!JSON.stringify(list.body).includes(row.keyHash), "nor its hash");
      assert.equal((await t.api("get", "/integrations/clients", rec.token)).status, 403);
      const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "API_CLIENT_CREATED", entityId: client.id } });
      assert.ok(!JSON.stringify(ev.metadata).includes(apiKey));
    });
    it("validates the request: a real name, known abilities only, no duplicates, no arbitrary permissions", async () => {
      const send = (body: Record<string, unknown>) => t.api("post", "/integrations/clients", a.admin.token).send(body);
      assert.equal((await send({ name: "x", abilities: ["BOOK_APPOINTMENTS"] })).status, 400);
      assert.equal((await send({ name: "Valid name", abilities: [] })).status, 400);
      assert.equal((await send({ name: "Valid name", abilities: ["ADMIN_USERS"] })).status, 400, "nothing outside the menu can be granted");
      assert.equal((await send({ name: "Valid name", abilities: ["BOOK_APPOINTMENTS"], permissions: ["PAYMENT_REFUND"] })).status, 400, "extra fields are refused");
      assert.equal((await send({ name: "Valid name", abilities: ["BOOK_APPOINTMENTS", "BOOK_APPOINTMENTS"] })).status, 400);
      const one = await send({ name: `Same name ${uniqueWord(4)}`, abilities: ["BOOK_APPOINTMENTS"] });
      assert.equal(one.status, 201);
      assert.equal((await send({ name: one.body.data.client.name, abilities: ["BOOK_APPOINTMENTS"] })).status, 409);
    });
    it("revoking stops the key at once, needs a reason, and cannot be undone", async () => {
      const { client, apiKey } = await makeClient();
      assert.equal((await t.api("get", "/booking/doctors", apiKey)).status, 200);
      assert.equal((await t.api("post", `/integrations/clients/${client.id}/revoke`, a.admin.token).send({ reason: "no" })).status, 400);
      const r = await t.api("post", `/integrations/clients/${client.id}/revoke`, a.admin.token).send({ reason: "Vendor contract ended" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.status, "REVOKED");
      assert.equal((await t.api("get", "/booking/doctors", apiKey)).status, 401, "revoked: refused immediately");
      assert.equal((await t.api("post", `/integrations/clients/${client.id}/revoke`, a.admin.token).send({ reason: "Again for the record" })).status, 409);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "ApiClient" SET status = 'ACTIVE', "revokedAt" = NULL WHERE id = '${client.id}'::uuid`), /cannot be reactivated/);
      assert.equal((await t.api("post", `/integrations/clients/${client.id}/revoke`, b.admin.token).send({ reason: "Not my hospital" })).status, 404);
    });
    it("an expired key stops working; a wrong key, a malformed key and a person's token are not mixed up", async () => {
      const { client, apiKey } = await makeClient(["BOOK_APPOINTMENTS"], a, { expiresInDays: 1 });
      assert.equal((await t.api("get", "/booking/doctors", apiKey)).status, 200);
      await t.prisma.apiClient.update({ where: { id: client.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await t.api("get", "/booking/doctors", apiKey)).status, 401);
      assert.equal((await t.api("get", "/booking/doctors", `mdk_${"x".repeat(43)}`)).status, 401);
      assert.equal((await t.api("get", "/booking/doctors", "mdk_")).status, 401);
      assert.equal((await t.api("get", "/booking/doctors")).status, 401);
    });
    it("the hidden user cannot sign in and is not listed among staff", async () => {
      const { client } = await makeClient();
      const u = await t.prisma.user.findFirstOrThrow({ where: { apiClient: { id: client.id } } });
      assert.ok(u.isService);
      const login = await t.http().post("/api/v1/auth/login").send({ tenantCode: a.code, identifier: u.username, password: "anything-at-all-123" });
      assert.equal(login.status, 401);
      const staff = (await t.api("get", "/users?pageSize=100", a.admin.token)).body.data as { username: string }[];
      assert.ok(!staff.some((s) => s.username === u.username));
    });
  });

  describe("what a key can reach", () => {
    it("only the booking calls: no patient records, billing, users, settings or integrations", async () => {
      const { apiKey } = await makeClient();
      const p = await registerPatient(t, rec.token);
      for (const [m, path] of [["get", `/patients/${p.id}`], ["get", "/patients?q=ab"], ["get", `/patients/${p.id}/files`], ["get", `/patients/${p.id}/ledger`], ["get", "/invoices"], ["get", "/users"], ["get", "/settings"],
        ["get", "/integrations/clients"], ["get", "/queue"], ["get", "/reports/collections"], ["get", "/audit-events"], ["get", `/patients/${p.id}/allergies`]] as const) {
        const r = await t.api(m, path, apiKey);
        assert.ok([403, 404].includes(r.status), `${path} -> ${r.status}`);
      }
      assert.equal((await t.api("post", "/integrations/clients", apiKey).send({ name: "Sneaky", abilities: ["BOOK_APPOINTMENTS"] })).status, 403);
    });
    it("a key holds only the abilities it was given", async () => {
      const findOnly = (await makeClient(["FIND_PATIENTS"])).apiKey;
      const bookOnly = (await makeClient(["BOOK_APPOINTMENTS"])).apiKey;
      const m = mobile();
      assert.equal((await t.api("get", `/booking/patients?mobile=${m}`, findOnly)).status, 200);
      assert.equal((await t.api("get", `/booking/patients?mobile=${m}`, bookOnly)).status, 403);
      assert.equal((await t.api("post", "/booking/patients", findOnly).send({ firstName: "Asha", gender: "FEMALE", mobile: m, estimatedAgeYears: 30 })).status, 403);
      const p = await registerPatient(t, rec.token);
      assert.equal((await t.api("post", "/appointments", findOnly).send({ patientId: p.id, practitionerId: doc.practitionerId, startAt: at(nextDay()) })).status, 403);
      assert.equal((await t.api("post", "/appointments", bookOnly).send({ patientId: p.id, practitionerId: doc.practitionerId, startAt: at(nextDay()) })).status, 201);
    });
  });

  describe("booking end to end with a key", () => {
    it("doctors with free times, find a patient by mobile (minimal details), register, book, look up, move and cancel", async () => {
      const { client, apiKey } = await makeClient();
      const date = new Date(Date.now() + 5.5 * 3600_000 + 40 * 86_400_000).toISOString().slice(0, 10);
      const docs = await t.api("get", `/booking/doctors?date=${date}&slots=3`, apiKey);
      assert.equal(docs.status, 200, JSON.stringify(docs.body));
      const mine = docs.body.data.doctors.find((d: { id: string }) => d.id === doc.practitionerId);
      assert.equal(mine.nextFreeTimes.length, 3);
      assert.ok(!docs.body.data.doctors.some((d: { id: string }) => d.id === bDoc.practitionerId), "another hospital's doctors never appear");
      assert.ok(mine.department.name);

      const body = patientBody({ mobile: mobile() });
      const found0 = await t.api("get", `/booking/patients?mobile=${body["mobile"]}`, apiKey);
      assert.deepEqual(found0.body.data, []);
      const reg = await t.api("post", "/booking/patients", apiKey).set("Idempotency-Key", idem()).send({ firstName: body["firstName"], lastName: body["lastName"], gender: "FEMALE", mobile: body["mobile"], dateOfBirth: "1990-04-02" });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
      assert.deepEqual(Object.keys(reg.body.data).sort(), ["ageYears", "firstName", "gender", "id", "lastInitial", "mrn"]);
      const found = await t.api("get", `/booking/patients?mobile=${body["mobile"]}`, apiKey);
      assert.equal(found.body.data.length, 1);
      assert.deepEqual(Object.keys(found.body.data[0]).sort(), ["ageYears", "firstName", "gender", "id", "lastInitial", "mrn"], "no address, date of birth or mobile in the answer");
      assert.equal(found.body.data[0].lastInitial, `${String(body["lastName"]).charAt(0).toUpperCase()}.`);

      const k = idem();
      const startAt = mine.nextFreeTimes[0].startAt as string;
      const booked = await t.api("post", "/appointments", apiKey).set("Idempotency-Key", k).send({ patientId: reg.body.data.id, practitionerId: doc.practitionerId, startAt });
      assert.equal(booked.status, 201, JSON.stringify(booked.body));
      const replay = await t.api("post", "/appointments", apiKey).set("Idempotency-Key", k).send({ patientId: reg.body.data.id, practitionerId: doc.practitionerId, startAt });
      assert.equal(replay.status, 200);
      assert.equal(replay.headers["idempotent-replayed"], "true");
      assert.equal(replay.body.data.id, booked.body.data.id);
      assert.equal(await t.prisma.appointment.count({ where: { tenantId: a.tenantId, patientId: reg.body.data.id } }), 1, "a retry never books twice");
      const differs = await t.api("post", "/appointments", apiKey).set("Idempotency-Key", k).send({ patientId: reg.body.data.id, practitionerId: doc.practitionerId, startAt: mine.nextFreeTimes[1].startAt });
      assert.equal(differs.status, 422, "the same key for a different request is refused");
      assert.equal(differs.body.error.code, "IDEMPOTENCY_KEY_REUSED");

      const id = booked.body.data.id as string;
      const got = await t.api("get", `/appointments/${id}`, apiKey);
      assert.equal(got.status, 200);
      const moved = await t.api("patch", `/appointments/${id}`, apiKey).send({ version: got.body.data.version, startAt: mine.nextFreeTimes[2].startAt });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal((await t.api("post", `/appointments/${id}/cancel`, apiKey).send({ reason: "Caller asked to cancel" })).status, 200);

      const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "APPOINTMENT_CREATED", entityId: id } });
      const hidden = await t.prisma.apiClient.findFirstOrThrow({ where: { id: client.id } });
      assert.equal(ev.actorUserId, hidden.userId, "the audit trail names the integration");
      assert.ok((await t.prisma.apiClient.findFirstOrThrow({ where: { id: client.id } })).lastUsedAt, "last used is recorded");
    });
    it("registering a patient who already exists is refused with minimal matches and cannot be overridden", async () => {
      const { apiKey } = await makeClient();
      const body = patientBody({ mobile: mobile() });
      const send = (extra: Record<string, unknown> = {}) => t.api("post", "/booking/patients", apiKey).send({ firstName: body["firstName"], lastName: body["lastName"], gender: "FEMALE", mobile: body["mobile"], dateOfBirth: "1990-04-02", ...extra });
      assert.equal((await send()).status, 201);
      const dup = await send();
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, "DUPLICATE_PATIENT_SUSPECTED");
      const m = dup.body.error.details.matches[0];
      assert.deepEqual(Object.keys(m).sort(), ["ageYears", "firstName", "gender", "id", "lastInitial", "mrn"]);
      assert.equal(JSON.stringify(dup.body).includes(String(body["mobile"])), false, "no mobile number in the error");
      assert.equal((await send({ duplicateOverride: { confirmedDistinct: true } })).status, 400, "no override from a bot");
      assert.equal((await send({ addressLine: "12 Some Street" })).status, 400, "only the booking fields are accepted");
      assert.equal((await t.api("get", "/booking/patients?mobile=abc", apiKey)).status, 400);
    });
    it("the duplicate-booking rules apply to bots too, and a bot cannot override them", async () => {
      const { apiKey } = await makeClient();
      const p = await registerPatient(t, rec.token);
      const d0 = nextDay();
      assert.equal((await t.api("post", "/appointments", apiKey).send({ patientId: p.id, practitionerId: doc.practitionerId, startAt: at(d0) })).status, 201);
      const again = await t.api("post", "/appointments", apiKey).send({ patientId: p.id, practitionerId: doc.practitionerId, startAt: at(d0 + 2) });
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, "DUPLICATE_BOOKING_SUSPECTED");
      const forced = await t.api("post", "/appointments", apiKey).send({ patientId: p.id, practitionerId: doc.practitionerId, startAt: at(d0 + 2), duplicateOverride: { reason: "Bot insists on a second slot" } });
      assert.equal(forced.status, 403);
    });
  });

  describe("isolation", () => {
    it("a key sees and changes only the appointments it made; staff bookings and other keys' bookings are not found", async () => {
      const one = await makeClient();
      const two = await makeClient();
      const p1 = await registerPatient(t, rec.token);
      const p2 = await registerPatient(t, rec.token);
      const p3 = await registerPatient(t, rec.token);
      const staffBooked = await t.api("post", "/appointments", rec.token).send({ patientId: p1.id, practitionerId: doc.practitionerId, startAt: at(nextDay()) });
      const mineOne = await t.api("post", "/appointments", one.apiKey).send({ patientId: p2.id, practitionerId: doc.practitionerId, startAt: at(nextDay()) });
      const mineTwo = await t.api("post", "/appointments", two.apiKey).send({ patientId: p3.id, practitionerId: doc.practitionerId, startAt: at(nextDay()) });
      assert.equal(staffBooked.status, 201); assert.equal(mineOne.status, 201); assert.equal(mineTwo.status, 201);
      for (const other of [staffBooked.body.data, mineTwo.body.data]) {
        assert.equal((await t.api("get", `/appointments/${other.id}`, one.apiKey)).status, 404);
        assert.equal((await t.api("patch", `/appointments/${other.id}`, one.apiKey).send({ version: other.version, startAt: at(nextDay()) })).status, 404);
        assert.equal((await t.api("post", `/appointments/${other.id}/cancel`, one.apiKey).send({ reason: "Not mine to cancel" })).status, 404);
        assert.equal((await t.api("post", `/appointments/${other.id}/no-show`, one.apiKey)).status, 404);
      }
      assert.equal((await t.api("get", `/appointments/${mineOne.body.data.id}`, one.apiKey)).status, 200);
      assert.equal((await t.api("get", `/appointments/${mineOne.body.data.id}`, rec.token)).status, 200, "staff still see everything");
      const history = async (id: string) => ((await t.api("get", `/patients/${id}/appointments`, one.apiKey)).body.data as unknown[]).length;
      assert.deepEqual([await history(p1.id), await history(p2.id), await history(p3.id)], [0, 1, 0], "a patient's history shows only this key's bookings");
    });
    it("a key never crosses into another hospital", async () => {
      const { apiKey } = await makeClient();
      const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
      const bPatient = await registerPatient(t, bRec.token);
      assert.ok([400, 404].includes((await t.api("get", `/practitioners/${bDoc.practitionerId}/availability?date=2030-01-01`, apiKey)).status), "another hospital's doctor is not found");
      const r = await t.api("post", "/appointments", apiKey).send({ patientId: bPatient.id, practitionerId: bDoc.practitionerId, startAt: at(nextDay()) });
      assert.ok([404, 400].includes(r.status), String(r.status));
      assert.equal(await t.prisma.appointment.count({ where: { tenantId: b.tenantId, patientId: bPatient.id } }), 0);
      assert.equal((await t.api("get", `/booking/patients?mobile=${(await t.prisma.patient.findFirstOrThrow({ where: { id: bPatient.id } })).mobile}`, apiKey)).body.data.length, 0);
      const bKey = (await makeClient(["BOOK_APPOINTMENTS"], b)).apiKey;
      const aPatient = await registerPatient(t, rec.token);
      const cross = await t.api("post", "/appointments", bKey).send({ patientId: aPatient.id, practitionerId: doc.practitionerId, startAt: at(nextDay()) });
      assert.ok([404, 400].includes(cross.status), "a hospital B key cannot book hospital A's doctor");
      assert.equal(await t.prisma.appointment.count({ where: { tenantId: a.tenantId, patientId: aPatient.id } }), 0);
    });
  });

  describe("the database", () => {
    it("a key's hash, owner and hospital cannot be changed and a client cannot be deleted", async () => {
      const { client } = await makeClient();
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "ApiClient" SET "keyHash" = 'x' WHERE id = '${client.id}'::uuid`), /cannot be changed/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "ApiClient" WHERE id = '${client.id}'::uuid`), /append-only|cannot/);
    });
  });
});

describe("integration API: rate limit per key", () => {
  let t: TestApp;
  let a: TestTenant;
  before(async () => {
    process.env["API_CLIENT_RATE_LIMIT_PER_MINUTE"] = "12";
    t = await startApp({ rateLimit: true });
    a = await t.makeTenant("int-rl");
  });
  after(async () => { await t.close(); delete process.env["API_CLIENT_RATE_LIMIT_PER_MINUTE"]; });

  it("one key is limited per minute, and another key is not affected", async () => {
    const mk = async () => (await t.api("post", "/integrations/clients", a.admin.token).send({ name: `Limited ${uniqueWord(5)}`, abilities: ["BOOK_APPOINTMENTS"] })).body.data.apiKey as string;
    const k1 = await mk();
    const k2 = await mk();
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await t.api("get", "/booking/doctors", k1)).status);
    assert.equal(codes.filter((c) => c === 200).length, 12, codes.join());
    assert.deepEqual(codes.slice(12), [429, 429]);
    assert.equal((await t.api("get", "/booking/doctors", k2)).status, 200);
    assert.equal((await t.api("get", "/booking/doctors", a.admin.token)).status, 200, "people are not limited by this");
  });
});
