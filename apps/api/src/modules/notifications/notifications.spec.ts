import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { streamTuning } from "./notifications.service";
import { makeDoctor, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

interface Row { id: string; type: string; entityType: string; entityId: string | null; createdAt: string; readAt: string | null }

describe("notifications", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let pharmacist: { id: string; token: string };
  let cashier: { id: string; token: string };
  let d1: TestDoctor;
  let d2: TestDoctor;
  let bPharmacist: { id: string; token: string };

  const mine = async (token: string, query: Record<string, string> = {}) => {
    const r = await t.api("get", "/notifications", token).query(query);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { items: r.body.data as Row[], unread: r.body.meta.unread as number, total: r.body.meta.total as number };
  };
  const ofType = (rows: Row[], type: string) => rows.filter((r) => r.type === type);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("notif-a");
    b = await t.makeTenant("notif-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    pharmacist = await t.makeUser(a, ["PHARMACIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    bPharmacist = await t.makeUser(b, ["PHARMACIST"]);
    d1 = await makeDoctor(t, a);
    d2 = await makeDoctor(t, a);
  });
  after(async () => { await t.close(); });

  it("a doctor is told when a patient joins their queue, and nobody else is", async () => {
    const p = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, d1, p.id);
    const doc = await mine(d1.token);
    const joined = ofType(doc.items, "QUEUE_PATIENT_ADDED");
    assert.equal(joined.length, 1);
    assert.equal(joined[0]!.entityType, "QueueEntry");
    assert.equal(joined[0]!.entityId, v.queueId);
    assert.equal(joined[0]!.readAt, null);
    assert.equal(doc.unread, 1);
    assert.equal(ofType((await mine(d2.token)).items, "QUEUE_PATIENT_ADDED").length, 0, "another doctor");
    assert.equal(ofType((await mine(rec.token)).items, "QUEUE_PATIENT_ADDED").length, 0, "the receptionist who did it");
    assert.equal(ofType((await mine(cashier.token)).items, "QUEUE_PATIENT_ADDED").length, 0);
  });

  it("a notification is a pointer: no patient name, number or clinical text", async () => {
    const p = await registerPatient(t, rec.token, { firstName: "Zzqnotifyname", lastName: "Zzqnotifysurname" });
    await startVisit(t, rec.token, d2, p.id);
    const r = await t.api("get", "/notifications", d2.token);
    const text = JSON.stringify(r.body);
    assert.ok(!/zzqnotify/i.test(text), "no patient name");
    assert.ok(!text.includes(p.mrn ?? "no-mrn"), "no patient number");
    for (const row of r.body.data as Record<string, unknown>[]) assert.deepEqual(Object.keys(row).sort(), ["createdAt", "entityId", "entityType", "id", "readAt", "type"]);
  });

  it("a signed prescription tells the pharmacist, once, and not the doctor or the cashier", async () => {
    const patient = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, d1, patient.id);
    const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, d1.token).send({ content: { chiefComplaint: "Fever" } });
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, d1.token).send({ text: "Viral fever", type: "PROVISIONAL" });
    const rx = await t.api("put", `/encounters/${v.encounterId}/prescription`, d1.token).send({ items: [{ genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3 }] });
    assert.equal(rx.status, 200, JSON.stringify(rx.body));
    const before = ofType((await mine(pharmacist.token)).items, "PRESCRIPTION_AT_PHARMACY").length;
    const s = await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, d1.token).send({ version: c.body.data.version, acknowledgeAllergyWarnings: true });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const after = ofType((await mine(pharmacist.token)).items, "PRESCRIPTION_AT_PHARMACY");
    assert.equal(after.length, before + 1);
    assert.equal(after[0]!.entityType, "MedicationOrder");
    assert.equal(ofType((await mine(d1.token)).items, "PRESCRIPTION_AT_PHARMACY").length, 0, "the doctor who signed it");
    assert.equal(ofType((await mine(cashier.token)).items, "PRESCRIPTION_AT_PHARMACY").length, 0);
    assert.equal(ofType((await mine(bPharmacist.token)).items, "PRESCRIPTION_AT_PHARMACY").length, 0, "another hospital's pharmacist");
  });

  it("people read only their own: marking another person's or another hospital's notification is 'not found'", async () => {
    const p = await registerPatient(t, rec.token);
    await startVisit(t, rec.token, d1, p.id);
    const theirs = (await mine(d1.token)).items[0]!;
    // Another person in the same hospital, another hospital, no sign-in, a made-up and a malformed id
    assert.equal((await t.api("post", `/notifications/${theirs.id}/read`, d2.token)).status, 404);
    assert.equal((await t.api("post", `/notifications/${theirs.id}/read`, bPharmacist.token)).status, 404);
    assert.equal((await t.api("post", `/notifications/${theirs.id}/read`)).status, 401);
    assert.equal((await t.api("post", "/notifications/00000000-0000-4000-8000-000000000000/read", d1.token)).status, 404);
    assert.equal((await t.api("post", "/notifications/not-a-uuid/read", d1.token)).status, 404, "a malformed id is \"not found\", like everywhere else");
    assert.equal((await t.api("get", "/notifications")).status, 401);
    assert.equal((await t.api("get", "/notifications/unread-count")).status, 401);
    assert.equal((await mine(d1.token)).items.find((r) => r.id === theirs.id)!.readAt, null, "still unread after the refused attempts");
    // The person themselves
    const before = (await mine(d1.token)).unread;
    const done = await t.api("post", `/notifications/${theirs.id}/read`, d1.token);
    assert.equal(done.status, 200);
    assert.equal(done.body.data.unread, before - 1);
    assert.equal((await t.api("post", `/notifications/${theirs.id}/read`, d1.token)).status, 200, "reading again is harmless");
    const unread = await mine(d1.token, { unread: "true" });
    assert.ok(unread.items.every((r) => r.readAt === null));
    const all = await t.api("post", "/notifications/read-all", d1.token).send({});
    assert.equal(all.status, 200);
    assert.equal(all.body.data.unread, 0);
    assert.equal((await t.api("get", "/notifications/unread-count", d1.token)).body.data.unread, 0);
    assert.ok((await mine(d2.token)).unread >= 1, "marking everything read for one person leaves another's alone");
    assert.equal((await t.api("get", "/notifications", d1.token).query({ pageSize: "500" })).status, 400, "paging is bounded");
  });

  it("an inactive person is not notified", async () => {
    const gone = await t.makeUser(a, ["PHARMACIST"]);
    await t.prisma.user.update({ where: { id: gone.id }, data: { status: "INACTIVE" } });
    const patient = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, d1, patient.id);
    const c = await t.api("put", `/encounters/${v.encounterId}/consultation`, d1.token).send({ content: { chiefComplaint: "Cough" } });
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, d1.token).send({ text: "Cough", type: "PROVISIONAL" });
    await t.api("put", `/encounters/${v.encounterId}/prescription`, d1.token).send({ items: [{ genericName: "Cetirizine", strength: "10 mg", dosage: "1 tablet", route: "ORAL", frequency: "OD", durationDays: 3 }] });
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, d1.token).send({ version: c.body.data.version, acknowledgeAllergyWarnings: true })).status, 200);
    assert.equal(await t.prisma.notification.count({ where: { tenantId: a.tenantId, recipientUserId: gone.id } }), 0);
  });

  it("the same event does not notify the same person twice", async () => {
    const dedupeKey = `TEST:${Date.now()}`;
    const make = () => t.prisma.notification.createMany({ data: [{ tenantId: a.tenantId, facilityId: a.facilityId, recipientUserId: pharmacist.id, type: "BOOKING_FROM_OUTSIDE", entityType: "Appointment", dedupeKey }], skipDuplicates: true });
    assert.equal((await make()).count, 1);
    assert.equal((await make()).count, 0, "the database refuses the repeat");
    await assert.rejects(() => t.prisma.notification.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, recipientUserId: pharmacist.id, type: "BOOKING_FROM_OUTSIDE", entityType: "Appointment", dedupeKey } }), /Unique|unique/);
  });

  it("the live stream says at once when something new arrives, and stays on the caller's own notifications", async () => {
    // The periodic check is made far too slow to help: only the push at commit can deliver within the time asserted below.
    const normalPoll = streamTuning.pollMs;
    streamTuning.pollMs = 60_000;
    const server = t.app.getHttpServer() as Server;
    if (!server.listening) await new Promise<void>((ok) => server.listen(0, ok));
    const port = (server.address() as AddressInfo).port;
    const events: { type: string; data: { unread?: number; latestId?: string | null } }[] = [];
    let buffer = "";
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/v1/notifications/stream", headers: { authorization: `Bearer ${d2.token}`, accept: "text/event-stream" } });
    const seen = (n: number, ms: number) => new Promise<void>((ok, fail) => { const t0 = Date.now(); const timer = setInterval(() => { if (events.length >= n) { clearInterval(timer); ok(); } else if (Date.now() - t0 > ms) { clearInterval(timer); fail(new Error(`only ${events.length} stream events after ${ms} ms`)); } }, 100); });
    const opened = new Promise<number>((ok) => { req.on("response", (res) => { res.setEncoding("utf8"); res.on("data", (chunk: string) => { buffer += chunk; for (;;) { const end = buffer.indexOf("\n\n"); if (end < 0) break; const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); const type = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1]; if (type && data) events.push({ type, data: JSON.parse(data) as { unread?: number } }); } }); ok(res.statusCode ?? 0); }); });
    req.end();
    try {
      assert.equal(await opened, 200);
      await seen(1, 6_000);
      assert.equal(events[0]!.type, "notify");
      const first = events[0]!.data.unread ?? -1;
      assert.equal(first, (await mine(d2.token)).unread, "the first message is the current count");
      // A new patient joins this doctor's queue: the stream says so within a few seconds
      await startVisit(t, rec.token, d2, (await registerPatient(t, rec.token)).id);
      const committed = Date.now();
      await seen(2, 1_500);
      assert.ok(Date.now() - committed < 1_500, "the stream announced it right after the commit");
      assert.equal(events[1]!.data.unread, first + 1);
      // Someone else's notifications do not move this person's stream
      const count = events.length;
      await startVisit(t, rec.token, d1, (await registerPatient(t, rec.token)).id);
      await new Promise((r) => setTimeout(r, 4_500));
      assert.equal(events.filter((e) => e.type === "notify").length, count, "no message for another doctor's patient");
    } finally {
      req.destroy();
      streamTuning.pollMs = normalPoll;
    }
    // Without a sign-in there is no stream
    const anon = await new Promise<number>((ok) => { const r = httpRequest({ host: "127.0.0.1", port, path: "/api/v1/notifications/stream" }, (res) => { ok(res.statusCode ?? 0); res.destroy(); }); r.end(); });
    assert.equal(anon, 401);
  });
});
