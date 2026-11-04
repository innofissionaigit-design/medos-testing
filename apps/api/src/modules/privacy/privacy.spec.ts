import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDoctor, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import type { ReminderMessage, ReminderProvider } from "../follow-ups/reminder.provider";
import { RemindersService } from "../follow-ups/reminders.service";
import { DATA_REQUEST_TRANSITIONS } from "./privacy.service";
import { remindersAllowed } from "./consent";

const MIN = 60_000;
const DAY = 24 * 60;
const at = (mins: number) => new Date(Math.ceil((Date.now() + mins * MIN) / MIN) * MIN).toISOString();
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

class FakeProvider implements ReminderProvider {
  readonly name = "fake";
  sent: ReminderMessage[] = [];
  async send(m: ReminderMessage) { this.sent.push(m); return { providerMessageId: `fake-${m.reminderId}` }; }
}

/** Records what patients agreed to and asked for. It decides nothing about what the law requires (docs/reviews/pending-decisions.md). */
describe("privacy: consent records, reminder consent and data requests", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let nurse: { id: string; token: string };
  let pharm: { id: string; token: string };
  let doc: TestDoctor;
  let reminders: RemindersService;

  const consent = (patientId: string, body: Record<string, unknown>, tok = rec.token) => t.api("post", `/patients/${patientId}/consents`, tok).send({ method: "VERBAL", ...body });
  const reminderConsent = (patientId: string, status: "GRANTED" | "WITHDRAWN", tok = rec.token) => consent(patientId, { purpose: "APPOINTMENT_REMINDERS", status }, tok);
  const request = (patientId: string, body: Record<string, unknown> = {}, tok = rec.token) =>
    t.api("post", `/patients/${patientId}/data-requests`, tok).send({ type: "ACCESS", details: "The patient asked for a copy of their records", ...body });
  const setting = async (value: boolean) => { assert.equal((await t.api("put", "/settings/REMINDERS_REQUIRE_CONSENT", a.admin.token).send({ value })).status, 200); };
  let slot = 0;
  const visits = new Map<string, string>();
  /** Each follow-up gets its own half-hour slot, so none collides with another for the doctor or the patient. */
  const followUp = async (patientId: string) => {
    // One visit per patient: a second walk-in for the same patient would overlap the first.
    if (!visits.has(patientId)) visits.set(patientId, (await startVisit(t, rec.token, doc, patientId)).encounterId);
    const r = await t.api("post", `/encounters/${visits.get(patientId)}/follow-ups`, doc.token).send({ startAt: at(3 * DAY + 30 * ++slot), notes: "Review" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string };
  };
  const rems = (appointmentId: string) => t.prisma.appointmentReminder.findMany({ where: { tenantId: a.tenantId, appointmentId }, orderBy: { createdAt: "asc" } });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("priv-a");
    b = await t.makeTenant("priv-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    nurse = await t.makeUser(a, ["NURSE"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]);
    doc = await makeDoctor(t, a);
    reminders = t.app.get(RemindersService);
  });
  after(async () => { await t.close(); });

  describe("consent records", () => {
    it("records a decision, keeps the whole history, and the newest record is the current one", async () => {
      const p = await registerPatient(t, rec.token);
      assert.deepEqual((await t.api("get", `/patients/${p.id}/consents`, rec.token)).body.data, { current: [], history: [] }, "nothing is assumed");
      const g = await consent(p.id, { purpose: "PRIVACY_NOTICE_ACKNOWLEDGED", status: "GRANTED", method: "WRITTEN", noticeVersion: "2026-v1", note: "Signed at the desk" });
      assert.equal(g.status, 201, JSON.stringify(g.body));
      assert.deepEqual([g.body.data.purpose, g.body.data.status, g.body.data.method, g.body.data.noticeVersion], ["PRIVACY_NOTICE_ACKNOWLEDGED", "GRANTED", "WRITTEN", "2026-v1"]);
      assert.equal((await reminderConsent(p.id, "GRANTED")).status, 201);
      assert.equal((await reminderConsent(p.id, "WITHDRAWN")).status, 201);
      assert.equal((await reminderConsent(p.id, "GRANTED")).status, 201, "a patient can agree again after withdrawing");
      const view = (await t.api("get", `/patients/${p.id}/consents`, nurse.token)).body.data as { current: { purpose: string; status: string }[]; history: unknown[] };
      assert.equal(view.history.length, 4, "every decision is kept");
      assert.deepEqual(view.current.map((c) => [c.purpose, c.status]).sort(), [["APPOINTMENT_REMINDERS", "GRANTED"], ["PRIVACY_NOTICE_ACKNOWLEDGED", "GRANTED"]]);
    });

    it("refuses a repeat of the current state, bad input and unknown fields", async () => {
      const p = await registerPatient(t, rec.token);
      assert.equal((await reminderConsent(p.id, "WITHDRAWN")).status, 201);
      const again = await reminderConsent(p.id, "WITHDRAWN");
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, "CONSENT_UNCHANGED");
      for (const bad of [{ purpose: "SELLING_DATA", status: "GRANTED" }, { purpose: "APPOINTMENT_REMINDERS", status: "MAYBE" }, { purpose: "APPOINTMENT_REMINDERS", status: "GRANTED", method: "TELEPATHY" }, { purpose: "APPOINTMENT_REMINDERS", status: "GRANTED", recordedById: "x" }, { status: "GRANTED" }, { purpose: "APPOINTMENT_REMINDERS", status: "GRANTED", note: "" }]) {
        assert.equal((await consent(p.id, bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await consent("00000000-0000-4000-8000-000000000000", { purpose: "APPOINTMENT_REMINDERS", status: "GRANTED" })).status, 404);
      assert.equal((await consent("not-a-uuid", { purpose: "APPOINTMENT_REMINDERS", status: "GRANTED" })).status, 404);
    });

    it("two people recording the same decision at once leave exactly one record", async () => {
      const p = await registerPatient(t, rec.token);
      const results = await Promise.all(Array.from({ length: 6 }, () => reminderConsent(p.id, "GRANTED")));
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
      assert.equal(await t.prisma.patientConsent.count({ where: { tenantId: a.tenantId, patientId: p.id } }), 1);
    });

    it("history cannot be edited or deleted, even directly in the database", async () => {
      const p = await registerPatient(t, rec.token);
      const c = (await consent(p.id, { purpose: "APPOINTMENT_REMINDERS", status: "GRANTED" })).body.data;
      await assert.rejects(t.prisma.patientConsent.update({ where: { tenantId_id: { tenantId: a.tenantId, id: c.id } }, data: { status: "WITHDRAWN" } }), /cannot be changed or removed/);
      await assert.rejects(t.prisma.patientConsent.delete({ where: { tenantId_id: { tenantId: a.tenantId, id: c.id } } }), /cannot be changed or removed/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PatientConsent" WHERE id = '${c.id}'::uuid`), /cannot be changed or removed/);
    });

    it("is audited without copying the free-text note, and only roles that can update patients may record", async () => {
      const p = await registerPatient(t, rec.token);
      await consent(p.id, { purpose: "PRIVACY_NOTICE_ACKNOWLEDGED", status: "GRANTED", noticeVersion: "v7", note: "private remark" });
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "CONSENT_GRANTED", entityId: p.id } });
      assert.equal(evt.actorUserId, rec.id);
      assert.deepEqual([(evt.metadata as { purpose: string }).purpose, (evt.metadata as { noticeVersion: string }).noticeVersion], ["PRIVACY_NOTICE_ACKNOWLEDGED", "v7"]);
      assert.ok(!JSON.stringify(evt.metadata).includes("private remark"));
      assert.equal((await reminderConsent(p.id, "WITHDRAWN", nurse.token)).status, 403, "a nurse can read but not record");
      assert.equal((await reminderConsent(p.id, "WITHDRAWN", pharm.token)).status, 403);
      assert.equal((await t.api("post", `/patients/${p.id}/consents`).send({ purpose: "APPOINTMENT_REMINDERS", status: "WITHDRAWN", method: "VERBAL" })).status, 401);
      assert.equal((await t.api("get", `/patients/${p.id}/consents`, pharm.token)).status, 200);
      await consent(p.id, { purpose: "PRIVACY_NOTICE_ACKNOWLEDGED", status: "WITHDRAWN" });
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "CONSENT_WITHDRAWN", entityId: p.id } }));
    });

    it("another hospital can neither see nor change a patient's consent (and cannot guess ids)", async () => {
      const p = await registerPatient(t, rec.token);
      await consent(p.id, { purpose: "APPOINTMENT_REMINDERS", status: "GRANTED" });
      assert.equal((await t.api("get", `/patients/${p.id}/consents`, b.admin.token)).status, 404);
      const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
      assert.equal((await reminderConsent(p.id, "WITHDRAWN", bRec.token)).status, 404);
      assert.equal(await t.prisma.patientConsent.count({ where: { tenantId: b.tenantId } }), 0);
    });
  });

  describe("reminders respect consent", () => {
    it("the rule: withdrawn never; agreed always; no record follows the hospital's setting", () => {
      assert.deepEqual([remindersAllowed("WITHDRAWN", false), remindersAllowed("WITHDRAWN", true), remindersAllowed("GRANTED", false), remindersAllowed("GRANTED", true), remindersAllowed("NONE", false), remindersAllowed("NONE", true)], [false, false, true, true, true, false]);
    });

    it("default (no record on file): reminders are planned; withdrawing cancels the pending ones and stops new ones", async () => {
      await setting(false);
      const p = await registerPatient(t, rec.token);
      const f1 = await followUp(p.id);
      assert.deepEqual((await rems(f1.id)).map((r) => r.status), ["PENDING"]);
      const w = await reminderConsent(p.id, "WITHDRAWN");
      assert.equal(w.status, 201);
      assert.deepEqual((await rems(f1.id)).map((r) => r.status), ["CANCELLED"], "pending reminders are cancelled at once");
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "CONSENT_WITHDRAWN", entityId: p.id } });
      assert.equal((evt.metadata as { remindersCancelled: number }).remindersCancelled, 1);
      const f2 = await followUp(p.id);
      assert.equal((await rems(f2.id)).length, 0, "a later follow-up gets no reminders");
      assert.equal((await reminderConsent(p.id, "GRANTED")).status, 201);
      assert.deepEqual((await rems((await followUp(p.id)).id)).map((r) => r.status), ["PENDING"], "agreeing again restores them");
    });

    it("withdrawal only touches that patient's reminders", async () => {
      await setting(false);
      const p1 = await registerPatient(t, rec.token);
      const p2 = await registerPatient(t, rec.token);
      const f1 = await followUp(p1.id);
      const f2 = await followUp(p2.id);
      await reminderConsent(p1.id, "WITHDRAWN");
      assert.deepEqual([(await rems(f1.id))[0]!.status, (await rems(f2.id))[0]!.status], ["CANCELLED", "PENDING"]);
    });

    it("with 'require consent' on, only patients who agreed get reminders", async () => {
      await setting(true);
      try {
        const noRecord = await registerPatient(t, rec.token);
        const agreed = await registerPatient(t, rec.token);
        await reminderConsent(agreed.id, "GRANTED");
        assert.equal((await rems((await followUp(noRecord.id)).id)).length, 0);
        assert.deepEqual((await rems((await followUp(agreed.id)).id)).map((r) => r.status), ["PENDING"]);
      } finally { await setting(false); }
    });

    it("the worker re-checks at send time: a withdrawal that arrived after planning means the SMS is skipped", async () => {
      await setting(false);
      const p = await registerPatient(t, rec.token);
      const f = await followUp(p.id);
      const [r] = await rems(f.id);
      // The patient withdraws without going through the API (for example, a record imported from elsewhere): the worker must still honour it.
      await t.prisma.patientConsent.create({ data: { tenantId: a.tenantId, patientId: p.id, purpose: "APPOINTMENT_REMINDERS", status: "WITHDRAWN", method: "WRITTEN", recordedById: rec.id } });
      const fake = new FakeProvider();
      const out = await reminders.runDue(new Date(r!.sendAt.getTime() + MIN), fake, 100_000);
      assert.ok(out.skipped >= 1);
      assert.equal(fake.sent.filter((m) => m.reminderId === r!.id).length, 0, "nothing is sent");
      const after = (await rems(f.id))[0]!;
      assert.deepEqual([after.status, after.lastError], ["SKIPPED", "The patient has not agreed to reminders"]);
    });

    it("the setting is validated, audited and limited to administrators", async () => {
      assert.equal((await t.api("put", "/settings/REMINDERS_REQUIRE_CONSENT", a.admin.token).send({ value: "yes" })).status, 400);
      assert.equal((await t.api("put", "/settings/REMINDERS_REQUIRE_CONSENT", rec.token).send({ value: true })).status, 403);
      await setting(true);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "SETTING_CHANGED", entityId: "REMINDERS_REQUIRE_CONSENT" } }));
      await setting(false);
    });
  });

  describe("data requests", () => {
    it("a request is logged by the front desk, worked by a privacy manager, and closed with an outcome", async () => {
      const p = await registerPatient(t, rec.token);
      const c = await request(p.id, { type: "CORRECTION", details: "Wrong date of birth recorded at registration", dueOn: ymd(30) });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      assert.deepEqual([c.body.data.type, c.body.data.status, c.body.data.version, c.body.data.receivedOn, c.body.data.overdue], ["CORRECTION", "OPEN", 1, ymd(0), false]);
      const id = c.body.data.id as string;
      const prog = await t.api("patch", `/privacy/requests/${id}`, a.admin.token).send({ status: "IN_PROGRESS", version: 1 });
      assert.equal(prog.status, 200, JSON.stringify(prog.body));
      assert.deepEqual([prog.body.data.status, prog.body.data.version, prog.body.data.resolution], ["IN_PROGRESS", 2, null]);
      const done = await t.api("patch", `/privacy/requests/${id}`, a.admin.token).send({ status: "COMPLETED", resolution: "Date of birth corrected after checking the ID card", version: 2 });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(done.body.data.status, "COMPLETED");
      assert.ok(done.body.data.closedAt);
      const row = await t.prisma.patientDataRequest.findFirstOrThrow({ where: { id } });
      assert.equal(row.closedById, a.admin.id);
      for (const action of ["DATA_REQUEST_CREATED", "DATA_REQUEST_UPDATED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action, entityId: id } }), action);
      const updates = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: "DATA_REQUEST_UPDATED", entityId: id }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(updates.map((u) => (u.metadata as { to: string }).to), ["IN_PROGRESS", "COMPLETED"]);
      assert.ok(!JSON.stringify(updates.map((u) => u.metadata)).includes("Date of birth"), "request text is not copied into the audit log");
    });

    it("closing needs an outcome; a closed request never reopens; stale versions are refused; only the listed moves are allowed", async () => {
      const p = await registerPatient(t, rec.token);
      const id = (await request(p.id, { type: "ERASURE", details: "Wants all records erased from the hospital" })).body.data.id as string;
      const patch = (body: Record<string, unknown>) => t.api("patch", `/privacy/requests/${id}`, a.admin.token).send(body);
      assert.equal((await patch({ status: "COMPLETED", version: 1 })).status, 400, "no outcome");
      assert.equal((await patch({ status: "REJECTED", resolution: "ok", version: 1 })).status, 400, "outcome too short");
      assert.equal((await patch({ status: "OPEN", version: 1 })).status, 400, "cannot move back to open");
      assert.equal((await patch({ status: "IN_PROGRESS", version: 7 })).status, 409, "stale version");
      const rejected = await patch({ status: "REJECTED", resolution: "Clinical records must be kept; explained to the patient", version: 1 });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      const reopen = await patch({ status: "IN_PROGRESS", version: 2 });
      assert.equal(reopen.status, 409);
      assert.equal(reopen.body.error.code, "INVALID_STATE");
      assert.deepEqual(DATA_REQUEST_TRANSITIONS["COMPLETED"], []);
      // Logging an erasure request never touches the patient's record.
      assert.equal((await t.prisma.patient.findFirstOrThrow({ where: { id: p.id } })).status, "ACTIVE");
    });

    it("rules are enforced by the database as well: no deletes, and a closed request must carry its outcome", async () => {
      const p = await registerPatient(t, rec.token);
      const id = (await request(p.id)).body.data.id as string;
      await assert.rejects(t.prisma.patientDataRequest.delete({ where: { tenantId_id: { tenantId: a.tenantId, id } } }), /cannot be removed/);
      await assert.rejects(t.prisma.patientDataRequest.update({ where: { tenantId_id: { tenantId: a.tenantId, id } }, data: { status: "COMPLETED" } }), /data_request_closed_has_outcome|check/i);
    });

    it("validates input: dates, text length, type, unknown fields, patient", async () => {
      const p = await registerPatient(t, rec.token);
      for (const bad of [{ details: "short" }, { type: "SELL" }, { receivedOn: "2026-13-45" }, { receivedOn: ymd(5) }, { receivedOn: ymd(-3), dueOn: ymd(-10) }, { status: "COMPLETED" }, { dueOn: "tomorrow" }]) {
        assert.equal((await request(p.id, bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await request("00000000-0000-4000-8000-000000000000")).status, 404);
      assert.equal((await request(p.id, { receivedOn: ymd(-3), dueOn: ymd(-3) })).status, 201, "due on the same day is fine");
    });

    it("the list is for privacy managers: filters, oldest first, overdue flag, names, pagination, and nobody else's requests", async () => {
      const p = await registerPatient(t, rec.token);
      const old = (await request(p.id, { receivedOn: ymd(-40), dueOn: ymd(-10), details: "Complaint about how data was shared" , type: "GRIEVANCE" })).body.data;
      const fresh = (await request(p.id, { details: "Wants a copy of discharge papers" })).body.data;
      const list = await t.api("get", "/privacy/requests", a.admin.token).query({ patientId: p.id });
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.deepEqual(list.body.data.map((r: { id: string }) => r.id), [old.id, fresh.id], "oldest first");
      assert.deepEqual([list.body.data[0].overdue, list.body.data[1].overdue], [true, false]);
      assert.ok(list.body.data[0].patientName.length > 0 && list.body.data[0].mrn);
      assert.equal(list.body.meta.total, 2);
      await t.api("patch", `/privacy/requests/${old.id}`, a.admin.token).send({ status: "COMPLETED", resolution: "Explained and apologised", version: 1 });
      const open = await t.api("get", "/privacy/requests", a.admin.token).query({ patientId: p.id, status: "OPEN" });
      assert.deepEqual(open.body.data.map((r: { id: string }) => r.id), [fresh.id]);
      const closed = await t.api("get", "/privacy/requests", a.admin.token).query({ patientId: p.id, status: "COMPLETED" });
      assert.equal(closed.body.data[0].overdue, false, "a closed request is not overdue");
      assert.equal((await t.api("get", "/privacy/requests", a.admin.token).query({ pageSize: 1, patientId: p.id })).body.data.length, 1);
      assert.equal((await t.api("get", "/privacy/requests", a.admin.token).query({ unknown: "x" })).status, 400);
      const other = await t.api("get", "/privacy/requests", b.admin.token);
      assert.equal(other.status, 200);
      assert.ok(!other.body.data.some((r: { id: string }) => r.id === old.id || r.id === fresh.id), "another hospital sees none of them");
    });

    it("access control: the front desk can log but not work requests; nobody outside the hospital can touch them", async () => {
      const p = await registerPatient(t, rec.token);
      const id = (await request(p.id)).body.data.id as string;
      assert.equal((await request(p.id, {}, nurse.token)).status, 403, "a nurse cannot log requests");
      for (const tok of [rec.token, nurse.token, pharm.token]) {
        assert.equal((await t.api("get", "/privacy/requests", tok)).status, 403);
        assert.equal((await t.api("patch", `/privacy/requests/${id}`, tok).send({ status: "IN_PROGRESS", version: 1 })).status, 403);
      }
      assert.equal((await t.api("get", "/privacy/requests")).status, 401);
      assert.equal((await t.api("patch", `/privacy/requests/${id}`, b.admin.token).send({ status: "IN_PROGRESS", version: 1 })).status, 404, "another hospital cannot find it");
      assert.equal((await t.api("patch", "/privacy/requests/not-a-uuid", a.admin.token).send({ status: "IN_PROGRESS", version: 1 })).status, 404);
      const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
      assert.equal((await request(p.id, {}, bRec.token)).status, 404, "nor log one against our patient");
      assert.equal((await t.prisma.patientDataRequest.findFirstOrThrow({ where: { id } })).status, "OPEN");
    });

    it("two managers acting on the same request at once: exactly one wins", async () => {
      const p = await registerPatient(t, rec.token);
      const id = (await request(p.id)).body.data.id as string;
      const results = await Promise.all(Array.from({ length: 5 }, () => t.api("patch", `/privacy/requests/${id}`, a.admin.token).send({ status: "IN_PROGRESS", version: 1 })));
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409]);
      assert.equal((await t.prisma.patientDataRequest.findFirstOrThrow({ where: { id } })).version, 2);
    });
  });
});
