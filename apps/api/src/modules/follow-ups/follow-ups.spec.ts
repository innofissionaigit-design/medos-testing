import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import type { ReminderMessage, ReminderProvider } from "./reminder.provider";
import { RemindersService } from "./reminders.service";

const MIN = 60_000;
/** A whole-minute instant `mins` from now, as ISO. */
const at = (mins: number) => new Date(Math.ceil((Date.now() + mins * MIN) / MIN) * MIN).toISOString();
const DAY = 24 * 60;
const istDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const plus = (d: Date, mins: number) => new Date(d.getTime() + mins * MIN);

class FakeProvider implements ReminderProvider {
  readonly name = "fake";
  sent: ReminderMessage[] = [];
  fail = false;
  async send(m: ReminderMessage) {
    if (this.fail) throw new Error("gateway down");
    this.sent.push(m);
    return { providerMessageId: `fake-${m.reminderId}` };
  }
}

describe("follow-up management", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let nurse: { id: string; token: string };
  let d1: TestDoctor;
  let d2: TestDoctor;
  let reminders: RemindersService;

  /** A completed-or-active OPD consultation by d1 (walk-in, checked in), as the follow-up's origin. */
  const consult = async (o: Record<string, unknown> = {}, doctor?: TestDoctor) => {
    const p = await registerPatient(t, rec.token, o);
    const v = await startVisit(t, rec.token, doctor ?? d1, p.id);
    return { patientId: p.id, ...v };
  };
  const follow = (encounterId: string, body: Record<string, unknown>, tok = d1.token) => t.api("post", `/encounters/${encounterId}/follow-ups`, tok).send(body);
  const created = async (encounterId: string, body: Record<string, unknown>) => {
    const r = await follow(encounterId, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string; version: number; startAt: string; status: string };
  };
  const rems = (appointmentId: string) => t.prisma.appointmentReminder.findMany({ where: { tenantId: a.tenantId, appointmentId }, orderBy: [{ createdAt: "asc" }, { sendAt: "asc" }] });
  const setting = async (key: string, value: unknown) => {
    const r = await t.api("put", `/settings/${key}`, a.admin.token).send({ value });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const runAt = (now: Date, provider: ReminderProvider) => reminders.runDue(now, provider, 100_000);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("fu-a");
    b = await t.makeTenant("fu-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    nurse = await t.makeUser(a, ["NURSE"]);
    d1 = await makeDoctor(t, a);
    d2 = await makeDoctor(t, a);
    reminders = t.app.get(RemindersService);
  });
  after(async () => { await t.close(); });

  it("a doctor schedules a follow-up from their consultation: linked, audited, in the doctor's schedule and the patient's history", async () => {
    const v = await consult();
    const start = at(3 * DAY);
    const r = await follow(v.encounterId, { startAt: start, notes: "Review blood pressure" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const f = r.body.data;
    assert.deepEqual([f.type, f.status, f.followUpOfEncounterId, f.patientId, f.practitionerId], ["FOLLOW_UP", "BOOKED", v.encounterId, v.patientId, d1.practitionerId]);
    assert.ok(f.followUpOfVisit.encounterNumber, "carries the ordering visit's number");

    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "FOLLOW_UP_SCHEDULED", entityId: f.id } });
    assert.equal((evt.metadata as { encounterId: string }).encounterId, v.encounterId);
    assert.equal(evt.actorUserId, d1.userId);

    const schedule = await t.api("get", "/appointments", d1.token).query({ date: istDay(start), practitionerId: d1.practitionerId, type: "FOLLOW_UP" });
    assert.equal(schedule.status, 200);
    assert.ok(schedule.body.data.some((x: { id: string }) => x.id === f.id), "in the assigned doctor's schedule");

    const hist = await t.api("get", `/patients/${v.patientId}/appointments`, rec.token);
    assert.equal(hist.status, 200);
    const types = hist.body.data.map((x: { id: string; type: string }) => [x.id === f.id, x.type]);
    assert.ok(types.some(([mine, ty]: [boolean, string]) => mine && ty === "FOLLOW_UP"), "the follow-up is in the patient's history");
    assert.ok(types.some(([, ty]: [boolean, string]) => ty === "CONSULTATION"), "next to the visit that ordered it");
    assert.equal(hist.body.data[0].id, f.id, "newest first");

    const fromVisit = await t.api("get", `/encounters/${v.encounterId}/follow-ups`, d1.token);
    assert.deepEqual(fromVisit.body.data.map((x: { id: string }) => x.id), [f.id]);

    const planned = await rems(f.id);
    assert.equal(planned.length, 1);
    assert.deepEqual([planned[0]!.status, planned[0]!.offsetMinutes, planned[0]!.sendAt.getTime()], ["PENDING", 1440, new Date(start).getTime() - DAY * MIN]);
  });

  it("only the treating doctor schedules; receptionists manage; nurses, other doctors and other tenants are refused", async () => {
    const v = await consult();
    const body = { startAt: at(5 * DAY) };
    for (const [who, tok] of [["receptionist", rec.token], ["nurse", nurse.token]] as const) {
      const r = await follow(v.encounterId, body, tok);
      assert.equal(r.status, 403, who);
    }
    const other = await follow(v.encounterId, body, d2.token);
    assert.equal(other.status, 403);
    assert.equal(other.body.error.code, "FORBIDDEN", "a different doctor cannot order this consultation's follow-up");
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/follow-ups`).send(body)).status, 401);
    const foreign = await makeDoctor(t, b);
    assert.equal((await follow(v.encounterId, body, foreign.token)).status, 404, "another tenant cannot even see the consultation");

    const f = await created(v.encounterId, body);
    assert.equal((await t.api("post", `/appointments/${f.id}/cancel`, d1.token).send({ reason: "Doctor changed mind" })).status, 403, "doctors do not manage appointments");
    const moved = await t.api("patch", `/appointments/${f.id}`, rec.token).send({ version: f.version, startAt: at(6 * DAY) });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal((await t.api("post", `/appointments/${f.id}/cancel`, rec.token).send({ reason: "Patient requested" })).status, 200);

    assert.equal((await t.api("get", `/encounters/${v.encounterId}/follow-ups`, nurse.token)).status, 403);
    assert.equal((await t.api("get", `/encounters/${v.encounterId}/follow-ups`, foreign.token)).status, 404);
    assert.equal((await t.api("get", `/appointments/${f.id}/reminders`, b.admin.token)).status, 404);
    assert.equal((await t.api("get", `/patients/${v.patientId}/appointments`, nurse.token)).status, 403);
  });

  it("validates input; the patient always comes from the consultation", async () => {
    const v = await consult();
    const stranger = await registerPatient(t, rec.token);
    assert.equal((await follow(v.encounterId, {})).status, 400);
    assert.equal((await follow(v.encounterId, { startAt: at(DAY), patientId: stranger.id })).status, 400, "no patient field is accepted");
    assert.equal((await follow(v.encounterId, { startAt: at(-DAY) })).status, 400, "not in the past");
    assert.equal((await follow(v.encounterId, { startAt: "next tuesday" })).status, 400);
    assert.equal((await follow(v.encounterId, { startAt: at(DAY), durationMinutes: 1 })).status, 400);
    assert.equal((await follow(randomUUID(), { startAt: at(DAY) })).status, 404);
    assert.equal((await follow("not-a-uuid", { startAt: at(DAY) })).status, 404);

    const c = await consult();
    assert.equal((await t.api("post", `/appointments/${c.appointmentId}/cancel`, rec.token).send({ reason: "Left before being seen" })).status, 200);
    const r = await follow(c.encounterId, { startAt: at(2 * DAY) });
    assert.equal(r.status, 409, "a cancelled visit cannot order a follow-up");
  });

  it("detects conflicts with the existing rules: booked slot, patient double-booking, working hours", async () => {
    const v1 = await consult();
    const v2 = await consult();
    const s = at(8 * DAY);
    await created(v1.encounterId, { startAt: s });
    const busy = await follow(v2.encounterId, { startAt: s });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, "SLOT_UNAVAILABLE");
    const twice = await follow(v1.encounterId, { startAt: s, practitionerId: d2.practitionerId });
    assert.equal(twice.status, 409, "the patient cannot be in two appointments at once");
    assert.match(twice.body.error.message, /patient already has an appointment/);

    const d3 = await makeDoctor(t, a);
    const sched = await t.api("put", `/practitioners/${d3.practitionerId}/schedule`, a.admin.token).send({ windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: "09:00", end: "10:00", slotMinutes: 15 })) });
    assert.equal(sched.status, 200, JSON.stringify(sched.body));
    const v3 = await consult();
    const day = istDay(at(9 * DAY));
    const late = await follow(v3.encounterId, { startAt: `${day}T23:00:00+05:30`, practitionerId: d3.practitionerId });
    assert.equal(late.status, 409);
    assert.match(late.body.error.message, /not available/);
    await created(v3.encounterId, { startAt: `${day}T09:15:00+05:30`, practitionerId: d3.practitionerId });
  });

  it("concurrent bookings of one slot: exactly one succeeds", async () => {
    const visits = [];
    for (let i = 0; i < 10; i++) visits.push(await consult());
    const s = at(10 * DAY + 7);
    const results = await Promise.all(visits.map((v) => follow(v.encounterId, { startAt: s })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, ...Array(9).fill(409)], statuses.join());
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "SLOT_UNAVAILABLE"));
    const live = await t.prisma.appointment.count({ where: { tenantId: a.tenantId, practitionerId: d1.practitionerId, startAt: new Date(s), status: "BOOKED" } });
    assert.equal(live, 1);
  });

  it("rescheduling replaces the pending reminders and is guarded by the version", async () => {
    const v = await consult();
    const s1 = at(4 * DAY);
    const f = await created(v.encounterId, { startAt: s1 });
    const [r1] = await rems(f.id);
    assert.equal((await t.api("patch", `/appointments/${f.id}`, rec.token).send({ version: f.version + 5, startAt: at(4 * DAY + 60) })).body.error.code, "STALE_VERSION");
    const s2 = at(4 * DAY + 180);
    const moved = await t.api("patch", `/appointments/${f.id}`, rec.token).send({ version: f.version, startAt: s2 });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const after = await rems(f.id);
    assert.deepEqual(after.map((x) => x.status), ["CANCELLED", "PENDING"]);
    const r2 = after[1]!;
    assert.equal(r2.appointmentStartAt.getTime(), new Date(s2).getTime());
    assert.equal(r2.sendAt.getTime(), new Date(s2).getTime() - DAY * MIN);

    const fake = new FakeProvider();
    await runAt(plus(r1!.sendAt, 1), fake);
    assert.ok(!fake.sent.some((m) => m.appointmentId === f.id), "the obsolete reminder never goes out");
    await runAt(plus(r2.sendAt, 1), fake);
    const msg = fake.sent.filter((m) => m.appointmentId === f.id);
    assert.equal(msg.length, 1);
    const doc = await t.prisma.practitioner.findFirstOrThrow({ where: { id: d1.practitionerId } });
    const pt = await t.prisma.patient.findFirstOrThrow({ where: { id: v.patientId } });
    assert.equal(msg[0]!.to, pt.mobile);
    assert.ok(msg[0]!.text.includes(doc.displayName), msg[0]!.text);
    assert.ok(!msg[0]!.text.includes(pt.firstName), "no patient name in the SMS");
    const sent = await t.prisma.appointmentReminder.findFirstOrThrow({ where: { id: r2.id } });
    assert.deepEqual([sent.status, sent.attempts, sent.providerMessageId], ["SENT", 1, `fake-${r2.id}`]);
  });

  it("cancellation needs a reason, stops pending reminders and is final", async () => {
    const v = await consult();
    const f = await created(v.encounterId, { startAt: at(5 * DAY) });
    const [r] = await rems(f.id);
    assert.equal((await t.api("post", `/appointments/${f.id}/cancel`, rec.token).send({})).status, 400);
    assert.equal((await t.api("post", `/appointments/${f.id}/cancel`, rec.token).send({ reason: "x" })).status, 400);
    const c = await t.api("post", `/appointments/${f.id}/cancel`, rec.token).send({ reason: "Patient travelling" });
    assert.equal(c.status, 200);
    assert.deepEqual([c.body.data.status, c.body.data.cancelReason], ["CANCELLED", "Patient travelling"]);
    assert.deepEqual((await rems(f.id)).map((x) => x.status), ["CANCELLED"]);
    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "APPOINTMENT_CANCELLED", entityId: f.id } });
    assert.equal((evt.metadata as { remindersCancelled: number }).remindersCancelled, 1);

    const fake = new FakeProvider();
    await runAt(plus(r!.sendAt, 1), fake);
    assert.ok(!fake.sent.some((m) => m.appointmentId === f.id));
    assert.equal((await t.api("patch", `/appointments/${f.id}`, rec.token).send({ version: c.body.data.version, startAt: at(6 * DAY) })).status, 409);
    assert.equal((await t.api("post", `/appointments/${f.id}/cancel`, rec.token).send({ reason: "Again please" })).status, 409);
    assert.equal((await t.api("post", `/appointments/${f.id}/no-show`, rec.token)).status, 409);
  });

  it("status transitions: no-show only once due and final; check-in and completion run through the OPD flow", async () => {
    const early = await consult();
    const fe = await created(early.encounterId, { startAt: at(2 * DAY) });
    const ns = await t.api("post", `/appointments/${fe.id}/no-show`, rec.token);
    assert.equal(ns.status, 409);
    assert.match(ns.body.error.message, /not arrived/);

    // Due: started 10 minutes ago (within the booking grace), ending before the patient's own walk-in visit began.
    const due = await consult();
    const fd = await created(due.encounterId, { startAt: at(-10), durationMinutes: 5 });
    const marked = await t.api("post", `/appointments/${fd.id}/no-show`, rec.token);
    assert.equal(marked.status, 200, JSON.stringify(marked.body));
    assert.equal(marked.body.data.status, "NO_SHOW");
    assert.equal((await t.api("post", `/appointments/${fd.id}/cancel`, rec.token).send({ reason: "Too late now" })).status, 409);
    await assert.rejects(t.prisma.appointment.update({ where: { id: fd.id }, data: { status: "BOOKED" } }), /Invalid appointment status transition/, "the database refuses it too");

    // Check-in today cancels the reminder; the visit then completes like any OPD visit.
    await setting("FOLLOWUP_REMINDER_OFFSETS_MINUTES", [15]);
    try {
      const v = await consult();
      const f = await created(v.encounterId, { startAt: at(20) });
      assert.deepEqual((await rems(f.id)).map((x) => x.status), ["PENDING"]);
      const ci = await t.api("post", `/appointments/${f.id}/check-in`, rec.token).send({});
      assert.equal(ci.status, 200, JSON.stringify(ci.body));
      assert.equal(ci.body.data.appointment.status, "WAITING");
      assert.deepEqual((await rems(f.id)).map((x) => x.status), ["CANCELLED"], "the patient is here: no reminder");
      const q = ci.body.data.queueEntry.id as string;
      const enc = ci.body.data.encounter.id as string;
      assert.equal((await t.api("post", `/queue/${q}/call`, d1.token)).status, 200);
      assert.equal((await t.api("post", `/queue/${q}/start`, d1.token)).status, 200);
      const note = await t.api("put", `/encounters/${enc}/consultation`, d1.token).send({ content: { chiefComplaint: "Follow-up review" } });
      assert.equal(note.status, 200, JSON.stringify(note.body));
      assert.equal((await t.api("post", `/encounters/${enc}/diagnoses`, d1.token).send({ text: "Hypertension, controlled", type: "FINAL" })).status, 201, "signing needs a diagnosis");
      const signed = await t.api("post", `/encounters/${enc}/consultation/sign`, d1.token).send({ version: note.body.data.version });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal((await t.api("post", `/queue/${q}/complete`, d1.token)).status, 200);
      const done = await t.api("get", `/appointments/${f.id}`, rec.token);
      assert.equal(done.body.data.status, "COMPLETED");
      assert.equal((await t.api("post", `/appointments/${f.id}/cancel`, rec.token).send({ reason: "Cannot cancel" })).status, 409);
    } finally {
      await setting("FOLLOWUP_REMINDER_OFFSETS_MINUTES", [1440]);
    }
  });

  it("reminders follow the facility settings: offsets, switching off, and times already passed", async () => {
    await setting("FOLLOWUP_REMINDER_OFFSETS_MINUTES", [1440, 120]);
    try {
      const v = await consult();
      // Each test books d1 on its own days: a follow-up holds its 15-minute slot, so reused offsets would collide.
      const f = await created(v.encounterId, { startAt: at(12 * DAY) });
      assert.deepEqual((await rems(f.id)).map((x) => x.offsetMinutes).sort((x, y) => x - y), [120, 1440]);
      const soon = await consult();
      const fs = await created(soon.encounterId, { startAt: at(90) });
      assert.equal((await rems(fs.id)).length, 0, "both reminder times have already passed");

      await setting("FOLLOWUP_REMINDERS_ENABLED", false);
      const off = await consult();
      const fo = await created(off.encounterId, { startAt: at(13 * DAY) });
      assert.equal((await rems(fo.id)).length, 0, "switched off for the facility");
    } finally {
      await setting("FOLLOWUP_REMINDERS_ENABLED", true);
      await setting("FOLLOWUP_REMINDER_OFFSETS_MINUTES", [1440]);
    }
    for (const bad of [[5], [60, 60], [], [20_000], [1, 2, 3, 4, 5, 6]]) {
      assert.equal((await t.api("put", "/settings/FOLLOWUP_REMINDER_OFFSETS_MINUTES", a.admin.token).send({ value: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await t.api("put", "/settings/FOLLOWUP_REMINDERS_ENABLED", rec.token).send({ value: false })).status, 403);
  });

  it("the worker sends each due reminder once, skips obsolete ones, retries failures and never double-sends", async () => {
    const fake = new FakeProvider();
    const v1 = await consult();
    const f1 = await created(v1.encounterId, { startAt: at(14 * DAY) });
    const [r1] = await rems(f1.id);
    await runAt(plus(r1!.sendAt, 1), fake);
    await runAt(plus(r1!.sendAt, 2), fake);
    assert.equal(fake.sent.filter((m) => m.reminderId === r1!.id).length, 1, "sent exactly once");

    const v2 = await consult();
    const f2 = await created(v2.encounterId, { startAt: at(14 * DAY + 60) });
    const [r2] = await rems(f2.id);
    const moved = plus(new Date(f2.startAt), 30);
    await t.prisma.appointment.update({ where: { id: f2.id }, data: { startAt: moved, endAt: plus(moved, 15) } }); // changed behind the service's back
    await runAt(plus(r2!.sendAt, 1), fake);
    const s2 = await t.prisma.appointmentReminder.findFirstOrThrow({ where: { id: r2!.id } });
    assert.equal(s2.status, "SKIPPED");
    assert.match(s2.lastError ?? "", /changed/);

    const v3 = await consult({ mobile: undefined });
    const f3 = await created(v3.encounterId, { startAt: at(14 * DAY + 120) });
    const [r3] = await rems(f3.id);
    await runAt(plus(r3!.sendAt, 1), fake);
    const s3 = await t.prisma.appointmentReminder.findFirstOrThrow({ where: { id: r3!.id } });
    assert.deepEqual([s3.status, s3.lastError], ["SKIPPED", "The patient has no mobile number"]);

    const v4 = await consult();
    const f4 = await created(v4.encounterId, { startAt: at(14 * DAY + 180) });
    const [r4] = await rems(f4.id);
    const failing = new FakeProvider();
    failing.fail = true;
    const n1 = plus(r4!.sendAt, 1);
    await runAt(n1, failing);
    let s4 = await t.prisma.appointmentReminder.findFirstOrThrow({ where: { id: r4!.id } });
    assert.deepEqual([s4.status, s4.attempts, s4.sendAt.getTime()], ["PENDING", 1, plus(n1, 5).getTime()], "retried in 5 minutes");
    const n2 = plus(n1, 6);
    await runAt(n2, failing);
    s4 = await t.prisma.appointmentReminder.findFirstOrThrow({ where: { id: r4!.id } });
    assert.deepEqual([s4.status, s4.attempts], ["PENDING", 2]);
    await runAt(plus(n2, 11), failing);
    s4 = await t.prisma.appointmentReminder.findFirstOrThrow({ where: { id: r4!.id } });
    assert.deepEqual([s4.status, s4.attempts, s4.lastError], ["FAILED", 3, "gateway down"]);

    const v5 = await consult();
    const f5 = await created(v5.encounterId, { startAt: at(14 * DAY + 240) });
    const [r5] = await rems(f5.id);
    const twin = new FakeProvider();
    await Promise.all([runAt(plus(r5!.sendAt, 1), twin), runAt(plus(r5!.sendAt, 1), twin)]);
    assert.equal(twin.sent.filter((m) => m.reminderId === r5!.id).length, 1, "two workers at once still send it once");

    await assert.rejects(t.prisma.appointmentReminder.update({ where: { id: r1!.id }, data: { status: "PENDING" } }), /already SENT/, "settled reminders are history");
    await assert.rejects(t.prisma.appointmentReminder.delete({ where: { id: r1!.id } }));

    const list = await t.api("get", `/appointments/${f1.id}/reminders`, rec.token);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((x: { status: string; logOnly: boolean }) => [x.status, x.logOnly]), [["SENT", false]]);
  });

  it("the database itself guards the link: follow-up type, same patient, never re-pointed", async () => {
    const v = await consult();
    const other = await consult();
    const base = { tenantId: a.tenantId, facilityId: a.facilityId, practitionerId: d2.practitionerId, createdById: a.admin.id, startAt: new Date(at(30 * DAY)), endAt: new Date(at(30 * DAY + 15)) };
    await assert.rejects(t.prisma.appointment.create({ data: { ...base, patientId: v.patientId, type: "CONSULTATION", followUpOfEncounterId: v.encounterId } }), /appointment_follow_up_type/);
    await assert.rejects(t.prisma.appointment.create({ data: { ...base, patientId: other.patientId, type: "FOLLOW_UP", followUpOfEncounterId: v.encounterId } }), /same patient/);
    const f = await created(v.encounterId, { startAt: at(31 * DAY) });
    await assert.rejects(t.prisma.appointment.update({ where: { id: f.id }, data: { followUpOfEncounterId: other.encounterId } }), /stays linked/);
  });
});
