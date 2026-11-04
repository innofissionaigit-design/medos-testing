import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localParts, zonedToUtc } from "../../common/time";
import { makeDoctor, makeUserWithPermissions, registerPatient, startApp, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const IST = "Asia/Kolkata";
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
/** A local calendar date `days` ahead in the facility timezone. */
const dayAhead = (days: number) => localParts(new Date(Date.now() + days * 86_400_000), IST).dateStr;

describe("appointments", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let doc: TestDoctor;

  const book = (token: string, body: Record<string, unknown>) => t.api("post", "/appointments", token).send(body);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("apt-a");
    b = await t.makeTenant("apt-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
  });
  after(async () => { await t.close(); });

  it("books an appointment with server-derived tenant, facility and department", async () => {
    const p = await registerPatient(t, rec.token);
    const r = await book(rec.token, { patientId: p.id, practitionerId: doc.practitionerId, startAt: inMinutes(24 * 60 * 3), durationMinutes: 20, notes: "Fever" });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.status, "BOOKED");
    assert.equal(r.body.data.departmentId, doc.departmentId);
    assert.equal(r.body.data.mrn, p.mrn);
    const row = await t.prisma.appointment.findFirstOrThrow({ where: { id: r.body.data.id } });
    assert.equal(row.tenantId, a.tenantId);
    assert.equal(row.facilityId, a.facilityId);
    assert.equal(row.endAt.getTime() - row.startAt.getTime(), 20 * 60_000);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "APPOINTMENT_CREATED", entityId: r.body.data.id } }));
  });

  it("validates input: ids, times, durations, unknown fields, past dates", async () => {
    const p = await registerPatient(t, rec.token);
    const base = { patientId: p.id, practitionerId: doc.practitionerId, startAt: inMinutes(5000) };
    const bad: [string, Record<string, unknown>][] = [
      ["missing patient", { ...base, patientId: undefined }],
      ["non-uuid practitioner", { ...base, practitionerId: "x" }],
      ["no timezone", { ...base, startAt: "2030-01-01T10:00:00" }],
      ["garbage time", { ...base, startAt: "tomorrow" }],
      ["zero duration", { ...base, durationMinutes: 0 }],
      ["huge duration", { ...base, durationMinutes: 10_000 }],
      ["fractional duration", { ...base, durationMinutes: 12.5 }],
      ["bad type", { ...base, type: "SURGERY" }],
      ["unknown field", { ...base, status: "COMPLETED" }],
      ["tenant injection", { ...base, tenantId: b.tenantId }],
      ["facility injection", { ...base, facilityId: b.facilityId }],
      ["long notes", { ...base, notes: "x".repeat(501) }],
      ["in the past", { ...base, startAt: inMinutes(-120) }],
    ];
    for (const [label, body] of bad) assert.equal((await book(rec.token, body)).status, 400, label);
    assert.equal((await book(rec.token, { ...base, patientId: randomUUID() })).status, 404);
  });

  it("rejects practitioners and patients from other tenants or facilities without leaking existence", async () => {
    const p = await registerPatient(t, rec.token);
    const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
    const bDoc = await makeDoctor(t, b);
    const bPatient = await registerPatient(t, bRec.token);
    const start = inMinutes(24 * 60 * 4);
    assert.equal((await book(rec.token, { patientId: p.id, practitionerId: bDoc.practitionerId, startAt: start })).status, 400);
    const crossPatient = await book(rec.token, { patientId: bPatient.id, practitionerId: doc.practitionerId, startAt: start });
    const missing = await book(rec.token, { patientId: randomUUID(), practitionerId: doc.practitionerId, startAt: start });
    assert.equal(crossPatient.status, 404);
    assert.equal(crossPatient.body.error.message, missing.body.error.message);
    const otherFacilityDoc = await makeDoctor(t, a, { facilityId: a.facility2Id });
    assert.equal((await book(rec.token, { patientId: p.id, practitionerId: otherFacilityDoc.practitionerId, startAt: start })).status, 400, "practitioner of another facility");
    const inactive = await makeDoctor(t, a);
    await t.prisma.practitioner.update({ where: { id: inactive.practitionerId }, data: { status: "INACTIVE" } });
    assert.equal((await book(rec.token, { patientId: p.id, practitionerId: inactive.practitionerId, startAt: start })).status, 400);
  });

  it("enforces role permissions on every appointment endpoint", async () => {
    const nurse = await t.makeUser(a, ["NURSE"]);
    const cashier = await t.makeUser(a, ["CASHIER"]);
    const p = await registerPatient(t, rec.token);
    const made = await book(rec.token, { patientId: p.id, practitionerId: doc.practitionerId, startAt: inMinutes(24 * 60 * 5) });
    const id = made.body.data.id as string;
    for (const u of [nurse, cashier]) {
      assert.equal((await book(u.token, { patientId: p.id, practitionerId: doc.practitionerId, startAt: inMinutes(9000) })).status, 403);
      assert.equal((await t.api("patch", `/appointments/${id}`, u.token).send({ version: 1, durationMinutes: 30 })).status, 403);
      assert.equal((await t.api("post", `/appointments/${id}/cancel`, u.token).send({ reason: "no reason" })).status, 403);
      assert.equal((await t.api("post", `/appointments/${id}/check-in`, u.token).send({})).status, 403);
      assert.equal((await t.api("post", "/appointments/walk-in", u.token).send({ patientId: p.id, practitionerId: doc.practitionerId })).status, 403);
    }
    assert.equal((await t.api("get", "/appointments").send()).status, 401);
    assert.equal((await t.api("put", `/practitioners/${doc.practitionerId}/schedule`, rec.token).send({ windows: [] })).status, 403, "schedules are an admin master");
  });

  it("prevents double-booking a practitioner: overlap rejected, adjacent slots allowed, other doctors unaffected", async () => {
    const d = await makeDoctor(t, a);
    const d2 = await makeDoctor(t, a);
    const [p1, p2, p3, p4] = await Promise.all([1, 2, 3, 4].map(() => registerPatient(t, rec.token)));
    const start = Date.now() + 86_400_000 * 6;
    const at = (offMin: number) => new Date(start + offMin * 60_000).toISOString();
    assert.equal((await book(rec.token, { patientId: p1!.id, practitionerId: d.practitionerId, startAt: at(0), durationMinutes: 30 })).status, 201);
    const clash = await book(rec.token, { patientId: p2!.id, practitionerId: d.practitionerId, startAt: at(15), durationMinutes: 30 });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, "SLOT_UNAVAILABLE");
    assert.equal((await book(rec.token, { patientId: p2!.id, practitionerId: d.practitionerId, startAt: at(30), durationMinutes: 30 })).status, 201, "back-to-back is fine");
    assert.equal((await book(rec.token, { patientId: p3!.id, practitionerId: d.practitionerId, startAt: at(-15), durationMinutes: 15 })).status, 201, "ends exactly when the first starts");
    assert.equal((await book(rec.token, { patientId: p4!.id, practitionerId: d2.practitionerId, startAt: at(0), durationMinutes: 30 })).status, 201, "another doctor, same time");
  });

  it("never lets one patient hold two live appointments at the same time, even for different doctors", async () => {
    const d1 = await makeDoctor(t, a);
    const d2 = await makeDoctor(t, a);
    const p = await registerPatient(t, rec.token);
    const start = inMinutes(24 * 60 * 7);
    assert.equal((await book(rec.token, { patientId: p.id, practitionerId: d1.practitionerId, startAt: start })).status, 201);
    const r = await book(rec.token, { patientId: p.id, practitionerId: d2.practitionerId, startAt: start });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /patient already has/i);
  });

  it("lets exactly one of 12 simultaneous requests win the same slot", async () => {
    const d = await makeDoctor(t, a);
    const patients = await Promise.all(Array.from({ length: 12 }, () => registerPatient(t, rec.token)));
    const start = inMinutes(24 * 60 * 8);
    const rs = await Promise.all(patients.map((p) => book(rec.token, { patientId: p.id, practitionerId: d.practitionerId, startAt: start, durationMinutes: 15 })));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.error.code === "SLOT_UNAVAILABLE"));
    assert.equal(await t.prisma.appointment.count({ where: { practitionerId: d.practitionerId } }), 1);
  });

  it("the database refuses overlapping bookings even if the service were bypassed", async () => {
    const d = await makeDoctor(t, a);
    const [p1, p2] = await Promise.all([registerPatient(t, rec.token), registerPatient(t, rec.token)]);
    const startAt = new Date(Date.now() + 86_400_000 * 9);
    const mk = (patientId: string, off: number) => t.prisma.appointment.create({
      data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId, practitionerId: d.practitionerId, startAt: new Date(startAt.getTime() + off), endAt: new Date(startAt.getTime() + off + 900_000), createdById: rec.id },
    });
    await mk(p1.id, 0);
    await assert.rejects(() => mk(p2.id, 60_000), /appointment_no_practitioner_overlap|exclusion/);
  });

  it("allows deliberate overbooking only with APPOINTMENT_OVERBOOK, requires a reason, and audits it", async () => {
    const d = await makeDoctor(t, a);
    const [p1, p2, p3] = await Promise.all([1, 2, 3].map(() => registerPatient(t, rec.token)));
    const start = inMinutes(24 * 60 * 10);
    assert.equal((await book(rec.token, { patientId: p1!.id, practitionerId: d.practitionerId, startAt: start })).status, 201);
    const denied = await book(rec.token, { patientId: p2!.id, practitionerId: d.practitionerId, startAt: start, overbook: { reason: "VIP patient" } });
    assert.equal(denied.status, 403, "receptionist lacks the override permission");
    const lead = await makeUserWithPermissions(t, a, ["APPOINTMENT_READ", "APPOINTMENT_CREATE", "APPOINTMENT_OVERBOOK"]);
    assert.equal((await book(lead.token, { patientId: p2!.id, practitionerId: d.practitionerId, startAt: start, overbook: { reason: "x" } })).status, 400, "reason must be meaningful");
    const ok = await book(lead.token, { patientId: p2!.id, practitionerId: d.practitionerId, startAt: start, overbook: { reason: "Urgent referral from ICU" } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.overbooked, true);
    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "APPOINTMENT_OVERBOOKED", entityId: ok.body.data.id } });
    assert.equal(evt.actorUserId, lead.id);
    assert.deepEqual(evt.metadata, { reason: "Urgent referral from ICU" });
    const stillBlocked = await book(rec.token, { patientId: p3!.id, practitionerId: d.practitionerId, startAt: start });
    assert.equal(stillBlocked.status, 409, "the regular slot stays protected");
  });

  describe("practitioner schedules and availability", () => {
    const date = dayAhead(14);
    const weekday = localParts(zonedToUtc(date, 720, IST), IST).weekday;
    let d: TestDoctor;

    before(async () => {
      d = await makeDoctor(t, a);
      const r = await t.api("put", `/practitioners/${d.practitionerId}/schedule`, a.admin.token).send({ windows: [{ dayOfWeek: weekday, start: "09:00", end: "12:00", slotMinutes: 30 }] });
      assert.equal(r.status, 200);
    });

    it("validates schedule windows", async () => {
      const put = (windows: unknown) => t.api("put", `/practitioners/${d.practitionerId}/schedule`, a.admin.token).send({ windows });
      assert.equal((await put([{ dayOfWeek: 7, start: "09:00", end: "10:00" }])).status, 400);
      assert.equal((await put([{ dayOfWeek: 1, start: "10:00", end: "09:00" }])).status, 400);
      assert.equal((await put([{ dayOfWeek: 1, start: "9am", end: "10:00" }])).status, 400);
      assert.equal((await put([{ dayOfWeek: 1, start: "09:00", end: "11:00" }, { dayOfWeek: 1, start: "10:30", end: "12:00" }])).status, 400, "overlap");
      assert.equal((await put([{ dayOfWeek: 1, start: "09:00", end: "10:00", slotMinutes: 2 }])).status, 400);
      const read = await t.api("get", `/practitioners/${d.practitionerId}/schedule`, rec.token);
      assert.deepEqual(read.body.data, [{ dayOfWeek: weekday, start: "09:00", end: "12:00", slotMinutes: 30 }], "failed updates changed nothing");
    });

    it("lists free slots and marks booked ones unavailable", async () => {
      const p = await registerPatient(t, rec.token);
      const slotStart = zonedToUtc(date, 9 * 60 + 30, IST);
      assert.equal((await book(rec.token, { patientId: p.id, practitionerId: d.practitionerId, startAt: slotStart.toISOString(), durationMinutes: 30 })).status, 201);
      const r = await t.api("get", `/practitioners/${d.practitionerId}/availability`, rec.token).query({ date });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.length, 6);
      const taken = r.body.data.find((s: { startAt: string }) => s.startAt === slotStart.toISOString());
      assert.equal(taken.available, false);
      assert.equal(r.body.data.filter((s: { available: boolean }) => s.available).length, 5);
      assert.equal((await t.api("get", `/practitioners/${d.practitionerId}/availability`, rec.token).query({ date: "2026-13-45" })).status, 400);
    });

    it("rejects bookings outside the working window but allows them inside", async () => {
      const p = await registerPatient(t, rec.token);
      const outside = zonedToUtc(date, 13 * 60, IST).toISOString();
      const straddle = zonedToUtc(date, 11 * 60 + 45, IST).toISOString();
      const inside = zonedToUtc(date, 10 * 60, IST).toISOString();
      assert.equal((await book(rec.token, { patientId: p.id, practitionerId: d.practitionerId, startAt: outside })).status, 409);
      assert.equal((await book(rec.token, { patientId: p.id, practitionerId: d.practitionerId, startAt: straddle, durationMinutes: 30 })).status, 409);
      assert.equal((await book(rec.token, { patientId: p.id, practitionerId: d.practitionerId, startAt: inside })).status, 201);
      const otherDay = zonedToUtc(dayAhead(15), 10 * 60, IST).toISOString();
      assert.equal((await book(rec.token, { patientId: p.id, practitionerId: d.practitionerId, startAt: otherDay })).status, 409, "no schedule on that weekday");
    });

    it("cannot configure schedules for another tenant's practitioner", async () => {
      const bDoc = await makeDoctor(t, b);
      const r = await t.api("put", `/practitioners/${bDoc.practitionerId}/schedule`, a.admin.token).send({ windows: [] });
      assert.equal(r.status, 400);
      assert.equal((await t.api("get", `/practitioners/${bDoc.practitionerId}/schedule`, a.admin.token)).status, 400);
    });
  });

  describe("rescheduling, cancelling, no-show", () => {
    it("reschedules a booked appointment with optimistic locking and conflict checks", async () => {
      const d = await makeDoctor(t, a);
      const [p1, p2] = await Promise.all([registerPatient(t, rec.token), registerPatient(t, rec.token)]);
      const s1 = inMinutes(24 * 60 * 11);
      const first = await book(rec.token, { patientId: p1.id, practitionerId: d.practitionerId, startAt: s1 });
      const second = await book(rec.token, { patientId: p2.id, practitionerId: d.practitionerId, startAt: inMinutes(24 * 60 * 11 + 60) });
      const moved = await t.api("patch", `/appointments/${first.body.data.id}`, rec.token).send({ version: 1, startAt: inMinutes(24 * 60 * 12) });
      assert.equal(moved.status, 200);
      assert.equal(moved.body.data.version, 2);
      assert.equal((await t.api("patch", `/appointments/${first.body.data.id}`, rec.token).send({ version: 1, durationMinutes: 45 })).body.error.code, "STALE_VERSION");
      const clash = await t.api("patch", `/appointments/${second.body.data.id}`, rec.token).send({ version: 1, startAt: inMinutes(24 * 60 * 12) });
      assert.equal(clash.status, 409);
      assert.equal(clash.body.error.code, "SLOT_UNAVAILABLE");
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "APPOINTMENT_RESCHEDULED", entityId: first.body.data.id } });
      assert.equal(evt.actorUserId, rec.id);
      assert.equal((await t.api("patch", `/appointments/${first.body.data.id}`, rec.token).send({ version: 2 })).status, 400);
    });

    it("cancels with a mandatory reason; terminal states cannot be reopened or cancelled twice", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const apt = await book(rec.token, { patientId: p.id, practitionerId: d.practitionerId, startAt: inMinutes(24 * 60 * 13) });
      const id = apt.body.data.id as string;
      assert.equal((await t.api("post", `/appointments/${id}/cancel`, rec.token).send({})).status, 400);
      assert.equal((await t.api("post", `/appointments/${id}/cancel`, rec.token).send({ reason: "ok" })).status, 400, "too short");
      const ok = await t.api("post", `/appointments/${id}/cancel`, rec.token).send({ reason: "Patient requested" });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.status, "CANCELLED");
      assert.equal(ok.body.data.cancelReason, "Patient requested");
      const again = await t.api("post", `/appointments/${id}/cancel`, rec.token).send({ reason: "Again" });
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, "APPOINTMENT_INVALID_STATE");
      assert.equal((await t.api("patch", `/appointments/${id}`, rec.token).send({ version: 2, durationMinutes: 30 })).status, 409, "cannot reschedule a cancelled appointment");
      assert.equal((await t.api("post", `/appointments/${id}/check-in`, rec.token).send({})).status, 409);
      await assert.rejects(() => t.prisma.appointment.update({ where: { id }, data: { status: "BOOKED" } }), /Invalid appointment status transition/);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "APPOINTMENT_CANCELLED", entityId: id } }));
    });

    it("frees the slot after cancellation", async () => {
      const d = await makeDoctor(t, a);
      const [p1, p2] = await Promise.all([registerPatient(t, rec.token), registerPatient(t, rec.token)]);
      const s = inMinutes(24 * 60 * 14);
      const apt = await book(rec.token, { patientId: p1.id, practitionerId: d.practitionerId, startAt: s });
      await t.api("post", `/appointments/${apt.body.data.id}/cancel`, rec.token).send({ reason: "Changed plans" });
      assert.equal((await book(rec.token, { patientId: p2.id, practitionerId: d.practitionerId, startAt: s })).status, 201);
    });

    it("marks no-show only once the appointment time has arrived", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const future = await book(rec.token, { patientId: p.id, practitionerId: d.practitionerId, startAt: inMinutes(24 * 60 * 15) });
      assert.equal((await t.api("post", `/appointments/${future.body.data.id}/no-show`, rec.token)).status, 409);
      const p2 = await registerPatient(t, rec.token); // another patient: the same patient twice with one doctor is a duplicate booking
      const past = await book(rec.token, { patientId: p2.id, practitionerId: d.practitionerId, startAt: inMinutes(-10), durationMinutes: 5 });
      assert.equal(past.status, 201, "up to 15 minutes late is accepted");
      const ns = await t.api("post", `/appointments/${past.body.data.id}/no-show`, rec.token);
      assert.equal(ns.status, 200);
      assert.equal(ns.body.data.status, "NO_SHOW");
      assert.equal((await t.api("post", `/appointments/${past.body.data.id}/no-show`, rec.token)).status, 409);
    });

    it("isolates appointments by tenant and by facility (IDOR)", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const apt = await book(rec.token, { patientId: p.id, practitionerId: d.practitionerId, startAt: inMinutes(24 * 60 * 16) });
      const id = apt.body.data.id as string;
      const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
      for (const tok of [bRec.token]) {
        const cross = await t.api("get", `/appointments/${id}`, tok);
        const missing = await t.api("get", `/appointments/${randomUUID()}`, tok);
        assert.equal(cross.status, 404);
        assert.equal(cross.body.error.message, missing.body.error.message);
        assert.equal((await t.api("patch", `/appointments/${id}`, tok).send({ version: 1, durationMinutes: 40 })).status, 404);
        assert.equal((await t.api("post", `/appointments/${id}/cancel`, tok).send({ reason: "Hijack attempt" })).status, 404);
        assert.equal((await t.api("post", `/appointments/${id}/check-in`, tok).send({})).status, 404);
      }
      const facility2Rec = await t.makeUser(a, ["RECEPTIONIST"], { facilityIds: [a.facility2Id] });
      assert.equal((await t.api("get", `/appointments/${id}`, facility2Rec.token)).status, 404, "other facility of the same tenant");
      assert.equal((await t.api("post", `/appointments/${id}/cancel`, facility2Rec.token).send({ reason: "Cross facility" })).status, 404);
      assert.equal((await t.prisma.appointment.findFirstOrThrow({ where: { id } })).status, "BOOKED");
    });

    it("lists appointments for a facility-local day, filtered and paginated", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const date = dayAhead(20);
      const slot = zonedToUtc(date, 10 * 60, IST).toISOString();
      await book(rec.token, { patientId: p.id, practitionerId: d.practitionerId, startAt: slot });
      const r = await t.api("get", "/appointments", rec.token).query({ date, practitionerId: d.practitionerId });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.length, 1);
      assert.equal(r.body.meta.total, 1);
      assert.equal((await t.api("get", "/appointments", rec.token).query({ date: dayAhead(21), practitionerId: d.practitionerId })).body.data.length, 0);
      assert.equal((await t.api("get", "/appointments", rec.token).query({ date, status: "NOPE" })).status, 400);
      assert.equal((await t.api("get", "/appointments", rec.token).query({ pageSize: 1000 })).status, 400);
    });
  });
});
