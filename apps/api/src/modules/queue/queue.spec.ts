import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe("check-in, walk-in and OPD queue", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let nurse: { id: string; token: string };

  const book = async (d: TestDoctor, patientId: string, startMin = 2) => {
    const r = await t.api("post", "/appointments", rec.token).send({ patientId, practitionerId: d.practitionerId, startAt: inMinutes(startMin), durationMinutes: 5 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.id as string;
  };
  const walkIn = (d: TestDoctor, patientId: string, extra: Record<string, unknown> = {}, key?: string) => {
    const req = t.api("post", "/appointments/walk-in", rec.token);
    if (key) req.set("Idempotency-Key", key);
    return req.send({ patientId, practitionerId: d.practitionerId, ...extra });
  };
  const queueOf = async (d: TestDoctor) => (await t.api("get", "/queue", rec.token).query({ practitionerId: d.practitionerId })).body.data as { id: string; status: string; tokenNumber: number; priority: string; patientName: string; waitingMinutes: number | null }[];

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("q-a");
    b = await t.makeTenant("q-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    nurse = await t.makeUser(a, ["NURSE"]);
  });
  after(async () => { await t.close(); });

  describe("appointment check-in", () => {
    it("moves BOOKED -> WAITING atomically, opening an OPD encounter and a queue token", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const id = await book(d, p.id);
      const r = await t.api("post", `/appointments/${id}/check-in`, rec.token).send({});
      assert.equal(r.status, 200);
      const { appointment, encounter, queueEntry } = r.body.data;
      assert.equal(appointment.status, "WAITING");
      assert.equal(appointment.encounterId, encounter.id);
      assert.match(encounter.encounterNumber, /^OPD-\d{4}-\d{6}$/);
      assert.equal(encounter.type, "OPD");
      assert.equal(encounter.status, "ACTIVE");
      assert.equal(encounter.practitionerId, d.practitionerId);
      assert.equal(queueEntry.tokenNumber, 1);
      assert.equal(queueEntry.status, "WAITING");
      const q = await queueOf(d);
      assert.equal(q.length, 1);
      assert.equal(q[0]?.status, "WAITING");
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "APPOINTMENT_CHECKED_IN", entityId: id } });
      assert.equal(evt.actorUserId, rec.id);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "ENCOUNTER_OPENED", entityId: encounter.id } }));
    });

    it("cannot be checked in twice; a concurrent burst creates exactly one encounter and one queue entry", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const id = await book(d, p.id);
      const rs = await Promise.all(Array.from({ length: 6 }, () => t.api("post", `/appointments/${id}/check-in`, rec.token).send({})));
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
      assert.equal(await t.prisma.encounter.count({ where: { tenantId: a.tenantId, patientId: p.id } }), 1);
      assert.equal(await t.prisma.queueEntry.count({ where: { tenantId: a.tenantId, patientId: p.id } }), 1);
      assert.equal((await t.api("post", `/appointments/${id}/check-in`, rec.token).send({})).body.error.code, "APPOINTMENT_INVALID_STATE");
    });

    it("rejects check-in for another day and rolls back without consuming numbers", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const future = await t.api("post", "/appointments", rec.token).send({ patientId: p.id, practitionerId: d.practitionerId, startAt: inMinutes(60 * 24 * 3) });
      const r = await t.api("post", `/appointments/${future.body.data.id}/check-in`, rec.token).send({});
      assert.equal(r.status, 409);
      assert.equal(await t.prisma.encounter.count({ where: { tenantId: a.tenantId, patientId: p.id } }), 0);
    });

    it("accepts an optional priority and rejects invalid values", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const id = await book(d, p.id);
      assert.equal((await t.api("post", `/appointments/${id}/check-in`, rec.token).send({ priority: "URGENT" })).status, 400);
      const ok = await t.api("post", `/appointments/${id}/check-in`, rec.token).send({ priority: "PRIORITY" });
      assert.equal(ok.body.data.queueEntry.priority, "PRIORITY");
    });

    it("cancelling a checked-in appointment cancels its queue entry and encounter together", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const id = await book(d, p.id);
      const ci = await t.api("post", `/appointments/${id}/check-in`, rec.token).send({});
      const c = await t.api("post", `/appointments/${id}/cancel`, rec.token).send({ reason: "Patient left" });
      assert.equal(c.status, 200);
      assert.equal((await t.prisma.queueEntry.findFirstOrThrow({ where: { appointmentId: id } })).status, "CANCELLED");
      const enc = await t.prisma.encounter.findFirstOrThrow({ where: { id: ci.body.data.encounter.id } });
      assert.equal(enc.status, "CANCELLED");
      assert.ok(enc.endedAt);
    });
  });

  describe("walk-ins", () => {
    it("creates an immediate appointment, encounter and token in one step", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const r = await walkIn(d, p.id);
      assert.equal(r.status, 201);
      assert.equal(r.body.data.appointment.source, "WALK_IN");
      assert.equal(r.body.data.appointment.status, "WAITING");
      assert.equal(r.body.data.queueEntry.tokenNumber, 1);
      assert.equal(r.body.data.encounter.status, "ACTIVE");
    });

    it("double-click safe: the same Idempotency-Key yields one visit; the same patient cannot be queued twice at once", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const key = `walkin-${randomUUID().slice(0, 12)}`;
      const rs = await Promise.all(Array.from({ length: 5 }, () => walkIn(d, p.id, {}, key)));
      assert.ok(rs.every((r) => [200, 201].includes(r.status)), rs.map((r) => r.status).join());
      assert.equal(rs.filter((r) => r.status === 201).length, 1);
      assert.equal(new Set(rs.map((r) => r.body.data.encounter.id)).size, 1);
      assert.equal(await t.prisma.encounter.count({ where: { tenantId: a.tenantId, patientId: p.id } }), 1);
      const again = await walkIn(d, p.id, {}, `walkin-${randomUUID().slice(0, 12)}`);
      assert.equal(again.status, 409, "a patient already in a live visit cannot be queued again");
      assert.equal(again.body.error.code, "SLOT_UNAVAILABLE");
    });

    it("assigns unique, gap-free daily tokens per practitioner under 10 parallel walk-ins", async () => {
      const d = await makeDoctor(t, a);
      const other = await makeDoctor(t, a);
      const patients = await Promise.all(Array.from({ length: 10 }, () => registerPatient(t, rec.token)));
      const rs = await Promise.all(patients.map((p) => walkIn(d, p.id)));
      assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.status).join());
      const tokens = rs.map((r) => r.body.data.queueEntry.tokenNumber as number).sort((x, y) => x - y);
      assert.deepEqual(tokens, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const solo = await registerPatient(t, rec.token);
      assert.equal((await walkIn(other, solo.id)).body.data.queueEntry.tokenNumber, 1, "each practitioner has their own sequence");
    });

    it("requires queue-manage rights for priority; validates input and references", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      assert.equal((await walkIn(d, p.id, { priority: "EMERGENCY" })).status, 201);
      const p2 = await registerPatient(t, rec.token);
      assert.equal((await walkIn(d, p2.id, { priority: "SUPER" })).status, 400);
      assert.equal((await walkIn(d, randomUUID())).status, 404);
      assert.equal((await walkIn(d, p2.id, { status: "COMPLETED" })).status, 400);
      const bDoc = await makeDoctor(t, b);
      assert.equal((await walkIn(bDoc, p2.id)).status, 400, "practitioner of another tenant");
    });
  });

  describe("queue operations", () => {
    it("reception view shows token, patient, doctor, department, waiting time and status, ordered by priority then arrival", async () => {
      const d = await makeDoctor(t, a);
      const [p1, p2, p3] = await Promise.all([1, 2, 3].map(() => registerPatient(t, rec.token)));
      await walkIn(d, p1!.id);
      await walkIn(d, p2!.id);
      await walkIn(d, p3!.id, { priority: "EMERGENCY" });
      const r = await t.api("get", "/queue", rec.token).query({ practitionerId: d.practitionerId });
      assert.equal(r.status, 200);
      const rows = r.body.data;
      assert.deepEqual(rows.map((x: { tokenNumber: number }) => x.tokenNumber), [3, 1, 2], "emergency first, then arrival order");
      assert.equal(rows[0].priority, "EMERGENCY");
      assert.ok(rows[0].patientName && rows[0].mrn && rows[0].practitionerName && rows[0].departmentName);
      assert.equal(typeof rows[0].waitingMinutes, "number");
    });

    it("doctor works their own queue: call, start, complete; complete closes the encounter and appointment", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const ci = await walkIn(d, p.id);
      const qid = ci.body.data.queueEntry.id as string;
      const view = await t.api("get", "/queue/doctor", d.token);
      assert.equal(view.status, 200);
      assert.equal(view.body.data.next.id, qid);
      assert.equal(view.body.data.current, null);
      assert.equal((await t.api("post", `/queue/${qid}/call`, d.token)).body.data.status, "CALLED");
      const started = await t.api("post", `/queue/${qid}/start`, d.token);
      assert.equal(started.body.data.status, "IN_CONSULTATION");
      assert.equal((await t.api("get", "/queue/doctor", d.token)).body.data.current.id, qid);
      assert.equal((await t.prisma.appointment.findFirstOrThrow({ where: { id: ci.body.data.appointment.id } })).status, "IN_CONSULTATION");
      const done = await t.api("post", `/queue/${qid}/complete`, d.token);
      assert.equal(done.status, 200);
      assert.equal(done.body.data.status, "COMPLETED");
      assert.ok(done.body.data.completedAt);
      assert.equal((await t.prisma.encounter.findFirstOrThrow({ where: { id: ci.body.data.encounter.id } })).status, "COMPLETED");
      assert.equal((await t.prisma.appointment.findFirstOrThrow({ where: { id: ci.body.data.appointment.id } })).status, "COMPLETED");
      const after = await t.api("get", "/queue/doctor", d.token);
      assert.equal(after.body.data.completed.length, 1);
      assert.equal(after.body.data.next, null);
      for (const action of ["QUEUE_CALL", "QUEUE_START", "QUEUE_COMPLETE"]) {
        const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action, entityId: qid } });
        assert.equal(evt.actorUserId, d.userId);
      }
    });

    it("enforces who may act: a doctor only on their own queue, nurses read-only, reception manages", async () => {
      const d1 = await makeDoctor(t, a);
      const d2 = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const qid = (await walkIn(d1, p.id)).body.data.queueEntry.id as string;
      assert.equal((await t.api("post", `/queue/${qid}/call`, d2.token)).status, 403, "another doctor");
      assert.equal((await t.api("post", `/queue/${qid}/start`, nurse.token)).status, 403, "nurse");
      assert.equal((await t.api("get", "/queue", nurse.token)).status, 200, "nurses can read");
      assert.equal((await t.api("get", "/queue/doctor", d2.token).query({ practitionerId: d1.practitionerId })).status, 403, "cannot view another doctor's queue");
      assert.equal((await t.api("post", `/queue/${qid}/skip`, d1.token)).status, 403, "skip is a reception action");
      assert.equal((await t.api("post", `/queue/${qid}/cancel`, d1.token).send({ reason: "Doctor cancel" })).status, 403);
      // Priority: a doctor may change it for their own waiting patients only; nurses and other doctors may not; reception may for anyone.
      assert.equal((await t.api("patch", `/queue/${qid}/priority`, d2.token).send({ priority: "EMERGENCY" })).status, 403, "another doctor's queue");
      assert.equal((await t.api("patch", `/queue/${qid}/priority`, nurse.token).send({ priority: "EMERGENCY" })).status, 403, "nurse");
      const own = await t.api("patch", `/queue/${qid}/priority`, d1.token).send({ priority: "EMERGENCY" });
      assert.deepEqual([own.status, own.body.data.priority], [200, "EMERGENCY"], "a doctor on their own queue");
      assert.equal((await t.api("patch", `/queue/${qid}/priority`, d1.token).send({ priority: "SUPER" })).status, 400);
      assert.equal((await t.api("patch", `/queue/${qid}/priority`, rec.token).send({ priority: "PRIORITY" })).body.data.priority, "PRIORITY", "reception on any queue");
      const evts = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: "QUEUE_PRIORITY_CHANGED", entityId: qid }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(evts.map((e) => [e.actorUserId, (e.metadata as { to: string }).to]), [[d1.userId, "EMERGENCY"], [rec.id, "PRIORITY"]], "each change is audited with who made it");
      assert.equal((await t.api("post", `/queue/${qid}/call`, rec.token)).status, 200, "reception may call");
      assert.equal((await t.api("get", "/queue")).status, 401);
    });

    it("rejects illegal transitions with INVALID_STATE and the database enforces the same table", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const qid = (await walkIn(d, p.id)).body.data.queueEntry.id as string;
      assert.equal((await t.api("post", `/queue/${qid}/complete`, d.token)).status, 409, "cannot complete a patient who never started");
      assert.equal((await t.api("post", `/queue/${qid}/recall`, rec.token)).status, 409);
      assert.equal((await t.api("post", `/queue/${qid}/requeue`, rec.token)).status, 409);
      await t.api("post", `/queue/${qid}/start`, d.token);
      assert.equal((await t.api("post", `/queue/${qid}/start`, d.token)).status, 409, "already started");
      assert.equal((await t.api("post", `/queue/${qid}/skip`, rec.token)).status, 409);
      assert.equal((await t.api("post", `/queue/${qid}/cancel`, rec.token).send({ reason: "Too late" })).status, 409);
      await t.api("post", `/queue/${qid}/complete`, d.token);
      assert.equal((await t.api("post", `/queue/${qid}/call`, rec.token)).status, 409, "completed is terminal");
      await assert.rejects(() => t.prisma.queueEntry.update({ where: { id: qid }, data: { status: "WAITING" } }), /Invalid queue status transition/);
      await assert.rejects(() => t.prisma.queueEntry.update({ where: { id: qid }, data: { tokenNumber: 99 } }), /immutable/);
      const enc = (await t.prisma.queueEntry.findFirstOrThrow({ where: { id: qid } })).encounterId;
      await assert.rejects(() => t.prisma.encounter.update({ where: { id: enc }, data: { status: "ACTIVE", endedAt: null } }), /Invalid encounter status transition/);
      await assert.rejects(() => t.prisma.encounter.update({ where: { id: enc }, data: { type: "IPD" } }), /immutable/);
    });

    it("a doctor can only be in consultation with one patient at a time", async () => {
      const d = await makeDoctor(t, a);
      const [p1, p2] = await Promise.all([registerPatient(t, rec.token), registerPatient(t, rec.token)]);
      const q1 = (await walkIn(d, p1.id)).body.data.queueEntry.id as string;
      const q2 = (await walkIn(d, p2.id)).body.data.queueEntry.id as string;
      assert.equal((await t.api("post", `/queue/${q1}/start`, d.token)).status, 200);
      const second = await t.api("post", `/queue/${q2}/start`, d.token);
      assert.equal(second.status, 409);
      assert.match(second.body.error.message, /already in consultation/);
      assert.equal((await t.prisma.queueEntry.findFirstOrThrow({ where: { id: q2 } })).status, "WAITING", "failed start left no partial state");
    });

    it("skip and requeue keep the original place; cancel closes the visit with a reason", async () => {
      const d = await makeDoctor(t, a);
      const [p1, p2, p3] = await Promise.all([1, 2, 3].map(() => registerPatient(t, rec.token)));
      const q1 = (await walkIn(d, p1!.id)).body.data.queueEntry.id as string;
      const q2 = (await walkIn(d, p2!.id)).body.data.queueEntry.id as string;
      const w3 = await walkIn(d, p3!.id);
      assert.equal((await t.api("post", `/queue/${q1}/skip`, rec.token)).body.data.status, "SKIPPED");
      assert.equal((await t.api("get", "/queue/doctor", d.token)).body.data.next.id, q2);
      assert.equal((await t.api("post", `/queue/${q1}/requeue`, rec.token)).body.data.status, "WAITING");
      assert.equal((await t.api("get", "/queue/doctor", d.token)).body.data.next.id, q1, "back in its original position");
      assert.equal((await t.api("post", `/queue/${w3.body.data.queueEntry.id}/cancel`, rec.token).send({})).status, 400);
      const cancelled = await t.api("post", `/queue/${w3.body.data.queueEntry.id}/cancel`, rec.token).send({ reason: "Left without being seen" });
      assert.equal(cancelled.body.data.status, "CANCELLED");
      assert.equal((await t.prisma.encounter.findFirstOrThrow({ where: { id: w3.body.data.encounter.id } })).status, "CANCELLED");
      assert.equal((await t.prisma.appointment.findFirstOrThrow({ where: { id: w3.body.data.appointment.id } })).status, "CANCELLED");
    });

    it("priority can be raised while waiting and changes the order; not afterwards", async () => {
      const d = await makeDoctor(t, a);
      const [p1, p2] = await Promise.all([registerPatient(t, rec.token), registerPatient(t, rec.token)]);
      const q1 = (await walkIn(d, p1.id)).body.data.queueEntry.id as string;
      const q2 = (await walkIn(d, p2.id)).body.data.queueEntry.id as string;
      assert.equal((await t.api("patch", `/queue/${q2}/priority`, rec.token).send({ priority: "PRIORITY" })).body.data.priority, "PRIORITY");
      assert.equal((await t.api("get", "/queue/doctor", d.token)).body.data.next.id, q2);
      assert.equal((await t.api("patch", `/queue/${q2}/priority`, rec.token).send({ priority: "LOW" })).status, 400);
      await t.api("post", `/queue/${q1}/start`, d.token);
      assert.equal((await t.api("patch", `/queue/${q1}/priority`, rec.token).send({ priority: "EMERGENCY" })).status, 409);
    });

    it("call-next picks by priority then arrival, and parallel calls never pick the same patient", async () => {
      const d = await makeDoctor(t, a);
      const ps = await Promise.all(Array.from({ length: 4 }, () => registerPatient(t, rec.token)));
      const ids: string[] = [];
      for (const p of ps) ids.push((await walkIn(d, p.id)).body.data.queueEntry.id as string);
      await t.api("patch", `/queue/${ids[3]}/priority`, rec.token).send({ priority: "EMERGENCY" });
      const first = await t.api("post", "/queue/call-next", d.token).send({});
      assert.equal(first.body.data.id, ids[3]);
      const rs = await Promise.all([t.api("post", "/queue/call-next", d.token).send({}), t.api("post", "/queue/call-next", d.token).send({}), t.api("post", "/queue/call-next", rec.token).send({ practitionerId: d.practitionerId })]);
      const picked = rs.map((r) => r.body.data?.id as string);
      assert.equal(new Set(picked).size, 3, "no double-calls");
      assert.deepEqual([...picked].sort(), [ids[0], ids[1], ids[2]].sort());
      const none = await t.api("post", "/queue/call-next", d.token).send({});
      assert.equal(none.status, 200);
      assert.equal(none.body.data, null);
    });

    it("isolates queues by tenant, facility and practitioner ownership (IDOR)", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const qid = (await walkIn(d, p.id)).body.data.queueEntry.id as string;
      const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
      const cross = await t.api("post", `/queue/${qid}/skip`, bRec.token);
      const missing = await t.api("post", `/queue/${randomUUID()}/skip`, bRec.token);
      assert.equal(cross.status, 404);
      assert.equal(cross.body.error.message, missing.body.error.message);
      assert.equal((await t.api("get", "/queue", bRec.token)).body.data.length, 0);
      const f2 = await t.makeUser(a, ["RECEPTIONIST"], { facilityIds: [a.facility2Id] });
      assert.equal((await t.api("post", `/queue/${qid}/skip`, f2.token)).status, 404, "another facility of the same tenant");
      assert.equal((await t.api("get", "/queue", f2.token)).body.data.length, 0);
      assert.equal((await t.api("post", `/queue/not-a-uuid/call`, rec.token)).status, 404);
      assert.equal((await t.api("get", "/queue/doctor", rec.token)).status, 404, "reception has no practitioner profile");
    });

    it("encounters are readable per patient, tenant-isolated, and expose no hard-delete path", async () => {
      const d = await makeDoctor(t, a);
      const p = await registerPatient(t, rec.token);
      const w = await walkIn(d, p.id);
      const list = await t.api("get", `/patients/${p.id}/encounters`, rec.token);
      assert.equal(list.status, 200);
      assert.equal(list.body.data.length, 1);
      assert.equal(list.body.data[0].practitionerName, (await t.prisma.practitioner.findFirstOrThrow({ where: { id: d.practitionerId } })).displayName);
      const encId = w.body.data.encounter.id as string;
      assert.equal((await t.api("get", `/encounters/${encId}`, rec.token)).status, 200);
      const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
      assert.equal((await t.api("get", `/encounters/${encId}`, bRec.token)).status, 404);
      assert.equal((await t.api("get", `/patients/${p.id}/encounters`, bRec.token)).status, 404);
      assert.equal((await t.api("get", `/encounters/${encId}`, (await t.makeUser(a, ["CASHIER"])).token)).status, 200, "cashier holds PATIENT_READ");
      assert.equal((await t.api("get", `/encounters/${encId}`, a.admin.token)).status, 200);
      await assert.rejects(() => t.prisma.encounter.delete({ where: { id: encId } }), /append-only/);
      assert.equal((await t.api("delete", `/encounters/${encId}`, rec.token)).status, 404);
    });
  });
});
