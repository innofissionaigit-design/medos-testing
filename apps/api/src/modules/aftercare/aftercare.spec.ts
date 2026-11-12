import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import type { ReminderMessage, ReminderProvider } from "../follow-ups/reminder.provider";
import { AftercareJobsService } from "./aftercare-jobs.service";

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

let seq = 0;
const code = (p: string) => `${p}${(++seq).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`.slice(0, 14);
const COURSE = { hospitalCourse: "Admitted with fever and cough. Treated with IV antibiotics. Recovered well.", finalDiagnoses: [{ text: "Community-acquired pneumonia", code: "J18.9" }], followUp: { afterDays: 10, notes: "Review chest X-ray and bring all reports" } };
const MIN = 60_000;
const at = (minutes: number) => new Date(Date.now() + minutes * MIN).toISOString();
const dayStr = (d: Date) => d.toISOString().slice(0, 10);

interface World { tenant: TestTenant; rec: { id: string; token: string }; nurse: { id: string; token: string }; cashier: { id: string; token: string }; pharm: { id: string; token: string }; doc: TestDoctor; coord: { id: string; token: string }; relations: { id: string; token: string } }

describe("post-discharge journey: review calls, booking, feedback and complaints", () => {
  let t: TestApp;
  let w: World;
  let other: World;

  const world = async (label: string): Promise<World> => {
    const tenant = await t.makeTenant(label);
    return {
      tenant, rec: await t.makeUser(tenant, ["RECEPTIONIST"]), nurse: await t.makeUser(tenant, ["NURSE"]), cashier: await t.makeUser(tenant, ["CASHIER"]),
      pharm: await t.makeUser(tenant, ["PHARMACIST"]), doc: await makeDoctor(t, tenant), coord: await t.makeUser(tenant, ["CARE_COORDINATOR"]), relations: await t.makeUser(tenant, ["PATIENT_RELATIONS"]),
    };
  };
  /** Admits a patient and takes them through the whole discharge, so the review task is made by the real discharge. */
  const discharge = async (x: World, content: Record<string, unknown> = COURSE) => {
    const ward = (await t.api("post", "/wards", x.tenant.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    const room = (await t.api("post", "/rooms", x.tenant.admin.token).send({ wardId: ward.id, name: "Room", code: code("R") })).body.data;
    const bed = (await t.api("post", "/beds", x.tenant.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: "1000" })).body.data;
    const patient = await registerPatient(t, x.rec.token);
    const a = await t.api("post", "/admissions", x.rec.token).send({ patientId: patient.id, consultantId: x.doc.practitionerId, bedId: bed.id, reason: "Pneumonia needing IV antibiotics" });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const adm = a.body.data as { id: string; encounterId: string };
    const clear = (step: string, tok: string) => t.api("post", `/admissions/${adm.id}/discharge/clear`, tok).send({ step });
    assert.equal((await clear("MEDICALLY_FIT", x.doc.token)).status, 200);
    assert.equal((await clear("NURSING", x.nurse.token)).status, 200);
    assert.equal((await clear("CHARGES_REVIEWED", x.cashier.token)).status, 200);
    assert.equal((await clear("PHARMACY", x.pharm.token)).status, 200);
    const d = await t.api("put", `/admissions/${adm.id}/discharge-summary`, x.doc.token).send({ content });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-summary/sign`, x.doc.token).send({ version: d.body.data.version })).status, 200);
    const fb = await t.api("post", `/admissions/${adm.id}/discharge/final-invoice`, x.cashier.token);
    assert.equal(fb.status, 200, JSON.stringify(fb.body));
    const inv = (await t.api("get", `/invoices/${fb.body.data.invoice.id}`, x.cashier.token)).body.data;
    const pay = await t.api("post", `/invoices/${inv.id}/payments`, x.cashier.token).set("Idempotency-Key", `k-${uniqueWord(12)}`).send({ payments: [{ method: "UPI", amount: inv.total, reference: "UPI-AFTER-01" }] });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    const done = await t.api("post", `/admissions/${adm.id}/discharge/complete`, x.doc.token).send({ type: "ROUTINE" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    return { adm, patient };
  };
  const taskOf = async (admissionId: string) => t.prisma.aftercareTask.findFirstOrThrow({ where: { admissionId } });
  const list = (x: World, q = "", tok = x.coord.token) => t.api("get", `/aftercare/tasks${q}`, tok);

  before(async () => {
    t = await startApp();
    w = await world("aft-a");
    other = await world("aft-b");
  });
  after(async () => { await t.close(); });

  it("completing a discharge makes the review task: the date comes from the signed summary, or the hospital's default", async () => {
    const { adm, patient } = await discharge(w);
    const task = await taskOf(adm.id);
    assert.equal(task.patientId, patient.id);
    assert.equal(task.status, "PENDING");
    assert.equal(task.adviceNote, "Review chest X-ray and bring all reports");
    const days = Math.round((task.dueDate.getTime() - Date.now()) / 86_400_000);
    assert.ok(days >= 9 && days <= 11, `due in ${days} days`);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: w.tenant.tenantId, action: "AFTERCARE_TASK_CREATED", entityId: task.id } }));

    const plain = await discharge(w, { hospitalCourse: COURSE.hospitalCourse, finalDiagnoses: COURSE.finalDiagnoses });
    const t2 = await taskOf(plain.adm.id);
    const d2 = Math.round((t2.dueDate.getTime() - Date.now()) / 86_400_000);
    assert.ok(d2 >= 6 && d2 <= 8, `a summary with no advice uses the hospital's default of 7 days (${d2})`);
    assert.equal(t2.adviceNote, null);
    assert.equal(await t.prisma.aftercareTask.count({ where: { admissionId: adm.id } }), 1, "one task per stay");
    await assert.rejects(() => t.prisma.aftercareTask.create({ data: { tenantId: w.tenant.tenantId, facilityId: w.tenant.facilityId, patientId: patient.id, admissionId: adm.id, dueDate: new Date() } }), "a stay never has two");
    await assert.rejects(() => t.prisma.aftercareTask.delete({ where: { id: task.id } }), "a task is never deleted");
  });

  it("the call list: who is due, the calls made, booking the review as a follow-up, and what happens when the visit is missed or kept", async () => {
    const { adm, patient } = await discharge(w);
    const task = await taskOf(adm.id);
    // Due in ~10 days: not on today's call list (the lead is 3 days), but on the list of all pending reviews.
    assert.equal((await list(w)).body.data.items.some((r: { id: string }) => r.id === task.id), false);
    const pending = (await list(w, "?show=PENDING")).body.data.items.find((r: { id: string }) => r.id === task.id);
    assert.ok(pending);
    assert.equal(pending.patientId, patient.id);
    assert.equal(pending.status, "PENDING");

    // The coordinator brings the date forward; the patient now appears, and the person who touches it takes it.
    const today = dayStr(new Date());
    assert.equal((await t.api("patch", `/aftercare/tasks/${task.id}`, w.coord.token).send({ dueDate: today })).status, 200);
    const due = (await list(w)).body.data.items.find((r: { id: string }) => r.id === task.id);
    assert.ok(due, "now due");
    assert.equal(due.attempts, 0);

    // Calls: the validation of each outcome.
    const call = (body: Record<string, unknown>, tok = w.coord.token) => t.api("post", `/aftercare/tasks/${task.id}/contacts`, tok).send(body);
    assert.equal((await call({ outcome: "CALL_AGAIN" })).status, 400, "a call-back needs a time");
    assert.equal((await call({ outcome: "DECLINED" })).status, 400, "declining needs a reason");
    assert.equal((await call({ outcome: "BOOKED" })).status, 400, "booking has its own step");
    assert.equal((await call({ outcome: "CALL_AGAIN", nextCallAt: at(-600) })).status, 400, "not in the past");
    assert.equal((await call({ outcome: "NO_ANSWER", note: "Phone rang out" })).status, 200);
    assert.equal((await call({ outcome: "CALL_AGAIN", nextCallAt: at(120), note: "Asked to call after 5 pm" })).status, 200);
    const detail = (await t.api("get", `/aftercare/tasks/${task.id}`, w.coord.token)).body.data;
    assert.equal(detail.attempts, 2);
    assert.equal(detail.assignedToId, w.coord.id);
    assert.deepEqual(detail.contacts.map((c: { outcome: string }) => c.outcome), ["NO_ANSWER", "CALL_AGAIN"]);
    assert.ok(detail.nextCallAt);
    assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: w.tenant.tenantId, action: "AFTERCARE_CONTACTED", entityId: task.id } }), 2);
    await assert.rejects(() => t.prisma.contactAttempt.updateMany({ where: { taskId: task.id }, data: { note: "changed" } }), "calls are never edited");

    // Booking: an ordinary follow-up appointment, linked to the stay's encounter, for the patient on the task.
    const bad = await t.api("post", `/aftercare/tasks/${task.id}/book`, w.coord.token).send({ practitionerId: w.doc.practitionerId, startAt: at(-120) });
    assert.ok([400, 409].includes(bad.status), "not in the past");
    const slot = at(20 * 24 * 60);
    const booked = await t.api("post", `/aftercare/tasks/${task.id}/book`, w.coord.token).send({ practitionerId: w.doc.practitionerId, startAt: slot, notes: "Review after pneumonia" });
    assert.equal(booked.status, 200, JSON.stringify(booked.body));
    assert.equal(booked.body.data.status, "BOOKED");
    const appt = await t.prisma.appointment.findFirstOrThrow({ where: { id: booked.body.data.appointment.id } });
    assert.equal(appt.type, "FOLLOW_UP");
    assert.equal(appt.patientId, patient.id);
    assert.equal(appt.followUpOfEncounterId, adm.encounterId, "linked to the stay");
    assert.equal((await t.api("post", `/aftercare/tasks/${task.id}/book`, w.coord.token).send({ practitionerId: w.doc.practitionerId, startAt: at(21 * 24 * 60) })).status, 409, "already booked");
    assert.equal((await call({ outcome: "NO_ANSWER" })).status, 409, "no more calls once booked");
    assert.equal((await t.api("post", `/aftercare/tasks/${task.id}/close`, w.coord.token).send({ reason: "Not needed any more" })).status, 409, "a booked review is closed by cancelling the visit");
    assert.ok((await list(w, "?show=BOOKED")).body.data.items.some((r: { id: string }) => r.id === task.id));

    // The visit is cancelled: the patient is due a call again, straight away.
    assert.equal((await t.api("post", `/appointments/${appt.id}/cancel`, w.rec.token).send({ reason: "Patient travelling" })).status, 200);
    const back = await taskOf(adm.id);
    assert.equal(back.status, "PENDING");
    assert.equal(back.appointmentId, null);
    assert.ok(back.nextCallAt && back.nextCallAt.getTime() <= Date.now() + 5000);
    assert.ok((await list(w)).body.data.items.some((r: { id: string }) => r.id === task.id), "back on the call list");

    // Booked again, and this time the patient comes and is seen: the review is completed by the visit itself.
    const again = await t.api("post", `/aftercare/tasks/${task.id}/book`, w.coord.token).send({ practitionerId: w.doc.practitionerId, startAt: at(20) });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const apptId = again.body.data.appointment.id as string;
    const ci = await t.api("post", `/appointments/${apptId}/check-in`, w.rec.token).send({});
    assert.equal(ci.status, 200, JSON.stringify(ci.body));
    const q = ci.body.data.queueEntry.id as string, enc = ci.body.data.encounter.id as string;
    assert.equal((await t.api("post", `/queue/${q}/call`, w.doc.token)).status, 200);
    assert.equal((await t.api("post", `/queue/${q}/start`, w.doc.token)).status, 200);
    const note = await t.api("put", `/encounters/${enc}/consultation`, w.doc.token).send({ content: { chiefComplaint: "Review after discharge" } });
    assert.equal(note.status, 200, JSON.stringify(note.body));
    assert.equal((await t.api("post", `/encounters/${enc}/diagnoses`, w.doc.token).send({ text: "Pneumonia, resolving", type: "FINAL" })).status, 201);
    assert.equal((await t.api("post", `/encounters/${enc}/consultation/sign`, w.doc.token).send({ version: note.body.data.version })).status, 200);
    assert.equal((await t.api("post", `/queue/${q}/complete`, w.doc.token)).status, 200);
    const finished = await taskOf(adm.id);
    assert.equal(finished.status, "COMPLETED");
    assert.ok(finished.completedAt);
    assert.equal((await t.api("post", `/aftercare/tasks/${task.id}/close`, w.coord.token).send({ reason: "Whatever else" })).status, 409, "a finished review is final");
    await assert.rejects(() => t.prisma.aftercareTask.update({ where: { id: task.id }, data: { status: "PENDING" } }), "the database holds it too");
    assert.ok((await list(w, "?show=DONE")).body.data.items.some((r: { id: string }) => r.id === task.id));
  });

  it("a patient who declines is closed with the reason; a review can also be closed by staff; people and permissions are checked", async () => {
    const a1 = await taskOf((await discharge(w)).adm.id);
    const declined = await t.api("post", `/aftercare/tasks/${a1.id}/contacts`, w.coord.token).send({ outcome: "DECLINED", note: "Feels fine and lives far away" });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal(declined.body.data.status, "CLOSED");
    assert.match(declined.body.data.closeReason, /Patient declined: Feels fine/);
    assert.equal((await t.api("patch", `/aftercare/tasks/${a1.id}`, w.coord.token).send({ dueDate: dayStr(new Date()) })).status, 409, "closed is final");
    assert.ok((await list(w, "?show=CLOSED")).body.data.items.some((r: { id: string }) => r.id === a1.id));

    const a2 = await taskOf((await discharge(w)).adm.id);
    assert.equal((await t.api("post", `/aftercare/tasks/${a2.id}/close`, w.coord.token).send({ reason: "x" })).status, 400, "a reason is needed");
    assert.equal((await t.api("post", `/aftercare/tasks/${a2.id}/close`, w.coord.token).send({ reason: "Moved to another city" })).status, 200);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: w.tenant.tenantId, action: "AFTERCARE_CLOSED", entityId: a2.id } }));

    const a3 = await taskOf((await discharge(w)).adm.id);
    assert.equal((await t.api("patch", `/aftercare/tasks/${a3.id}`, w.coord.token).send({ assignedToId: w.rec.id })).status, 200, "handed to a colleague");
    assert.equal((await list(w, "?show=PENDING&mine=1")).body.data.items.some((r: { id: string }) => r.id === a3.id), false);
    assert.equal((await list(w, "?show=PENDING&mine=1", w.rec.token)).status, 403, "reception has no call list");
    assert.equal((await t.api("patch", `/aftercare/tasks/${a3.id}`, w.coord.token).send({ assignedToId: other.coord.id })).status, 400, "only people of this hospital");
    assert.equal((await t.api("patch", `/aftercare/tasks/${a3.id}`, w.coord.token).send({})).status, 400);
    assert.equal((await t.api("patch", `/aftercare/tasks/${a3.id}`, w.coord.token).send({ dueDate: "tomorrow" })).status, 400);
    assert.equal((await t.api("patch", `/aftercare/tasks/${a3.id}`, w.coord.token).send({ patientId: other.rec.id })).status, 400, "no unknown fields");
    for (const tok of [w.rec.token, w.doc.token, w.nurse.token, w.relations.token]) {
      assert.equal((await t.api("get", `/aftercare/tasks/${a3.id}`, tok)).status, 403);
      assert.equal((await t.api("post", `/aftercare/tasks/${a3.id}/contacts`, tok).send({ outcome: "NO_ANSWER" })).status, 403);
    }
    assert.equal((await t.api("get", "/aftercare/tasks")).status, 401);
  });

  it("is isolated by hospital: another hospital's staff cannot read, call, book or close a review", async () => {
    const a = await taskOf((await discharge(w)).adm.id);
    for (const [m, p, body] of [
      ["get", `/aftercare/tasks/${a.id}`, undefined], ["post", `/aftercare/tasks/${a.id}/contacts`, { outcome: "NO_ANSWER" }],
      ["post", `/aftercare/tasks/${a.id}/book`, { practitionerId: other.doc.practitionerId, startAt: at(60 * 24 * 3) }], ["post", `/aftercare/tasks/${a.id}/close`, { reason: "Not theirs" }],
      ["patch", `/aftercare/tasks/${a.id}`, { dueDate: dayStr(new Date()) }],
    ] as const) {
      const r = await t.api(m, p, other.coord.token).send(body as object);
      assert.equal(r.status, 404, `${m} ${p}`);
    }
    assert.equal((await list(other, "?show=ALL")).body.data.items.some((r: { id: string }) => r.id === a.id), false);
    assert.equal((await t.api("post", `/aftercare/tasks/not-a-uuid/contacts`, w.coord.token).send({ outcome: "NO_ANSWER" })).status, 404);
    assert.equal((await t.api("post", `/aftercare/tasks/${a.id}/book`, w.coord.token).send({ practitionerId: other.doc.practitionerId, startAt: at(60 * 24 * 3) })).status >= 400, true, "another hospital's doctor cannot be used");
    assert.equal((await taskOf(a.admissionId)).status, "PENDING", "nothing changed");
  });

  it("feedback: a rating and a comment from a call or at the desk; the patient and stay come from the review; never edited", async () => {
    const { adm, patient } = await discharge(w);
    const task = await taskOf(adm.id);
    const post = (body: Record<string, unknown>, tok = w.coord.token) => t.api("post", "/aftercare/feedback", tok).send(body);
    assert.equal((await post({ taskId: task.id, rating: 6 })).status, 400);
    assert.equal((await post({ taskId: task.id, rating: 0 })).status, 400);
    assert.equal((await post({ rating: 4 })).status, 400, "whose feedback?");
    assert.equal((await post({ taskId: task.id, rating: 4, comment: "x".repeat(1001) })).status, 400);
    const ok = await post({ taskId: task.id, rating: 2, comment: "Waited long for the bill", channel: "PHONE" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const row = await t.prisma.patientFeedback.findFirstOrThrow({ where: { id: ok.body.data.id } });
    assert.equal(row.patientId, patient.id);
    assert.equal(row.admissionId, adm.id);
    assert.equal((await post({ admissionId: adm.id, rating: 5, channel: "IN_PERSON" }, w.rec.token)).status, 201, "reception can take it at the desk");
    assert.equal((await post({ patientId: patient.id, rating: 4, channel: "FORM" }, w.nurse.token)).status, 201);
    assert.equal((await post({ taskId: task.id, rating: 3 }, other.coord.token)).status, 404, "another hospital's review");
    assert.equal((await post({ patientId: patient.id, rating: 3 }, other.rec.token)).status, 404, "another hospital's patient");
    assert.equal((await post({ taskId: task.id, rating: 3 }, w.doc.token)).status, 403);
    await assert.rejects(() => t.prisma.patientFeedback.update({ where: { id: row.id }, data: { rating: 5 } }), "feedback is never edited");
    await assert.rejects(() => t.prisma.patientFeedback.delete({ where: { id: row.id } }));
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "PatientFeedback" SET rating = 9 WHERE id = ${row.id}::uuid`);

    const low = (await t.api("get", "/aftercare/feedback?maxRating=2", w.relations.token)).body.data;
    assert.ok(low.items.some((f: { id: string }) => f.id === row.id));
    assert.ok(low.items.every((f: { rating: number }) => f.rating <= 2));
    assert.equal((await t.api("get", "/aftercare/feedback", w.rec.token)).status, 403, "reading feedback is for coordinators and patient relations");
    assert.equal((await t.api("get", "/aftercare/feedback", other.coord.token)).body.data.items.some((f: { id: string }) => f.id === row.id), false);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: w.tenant.tenantId, action: "FEEDBACK_RECORDED", entityId: row.id } }));
  });

  it("complaints: raised from a call or feedback, owned, noted, resolved with a written outcome, closed or reopened; history is never edited", async () => {
    const { adm, patient } = await discharge(w);
    const task = await taskOf(adm.id);
    const fb = (await t.api("post", "/aftercare/feedback", w.coord.token).send({ taskId: task.id, rating: 1, comment: "Billing error and rude desk staff" })).body.data;
    const raise = (body: Record<string, unknown>, tok = w.coord.token) => t.api("post", "/complaints", tok).send(body);
    assert.equal((await raise({ category: "Billing", description: "short" })).status, 400);
    assert.equal((await raise({ category: "B", description: "A long enough description of the problem" })).status, 400);
    assert.equal((await raise({ category: "Billing", description: "A long enough description of the problem", severity: "URGENT" })).status, 400);
    const c = await raise({ taskId: task.id, feedbackId: fb.id, category: "Billing", severity: "HIGH", description: "Charged twice for the same bed day and the desk staff were rude about it" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const id = c.body.data.id as string;
    assert.match(c.body.data.complaintNumber, /^CMP-\d{4}-\d{6}$/);
    assert.equal(c.body.data.patientId, patient.id, "the patient comes from the review");
    assert.equal(c.body.data.status, "OPEN");
    assert.equal((await raise({ patientId: patient.id, category: "Waiting time", description: "Waited three hours for the discharge medicines" }, w.rec.token)).status, 201, "reception can log one too");

    const act = (p: string, body: Record<string, unknown> = {}, tok = w.relations.token) => t.api("post", `/complaints/${id}/${p}`, tok).send(body);
    assert.equal((await t.api("get", `/complaints/${id}`, w.coord.token)).status, 403, "the call centre logs a complaint but does not work it");
    assert.equal((await act("start", {}, w.coord.token)).status, 403);
    assert.equal((await act("resolve", { resolution: "Refunded the double charge" })).status, 200, "an open complaint can be resolved directly");
    // Reopen to continue the full path.
    assert.equal((await act("reopen", { reason: "Patient says the refund has not arrived" })).status, 200);
    assert.equal((await act("reopen", { reason: "again again" })).status, 409, "only a resolved complaint is reopened");
    assert.equal((await act("start")).status, 409, "already in progress");
    assert.equal((await act("assign", { ownerId: other.relations.id })).status, 400, "only people of this hospital");
    const mgr = await t.makeUser(w.tenant, ["MANAGER"]);
    assert.equal((await act("assign", { ownerId: mgr.id })).body.data.owner !== null, true);
    assert.equal((await act("notes", { note: "Called the patient and promised a refund in 3 days" })).status, 200);
    assert.equal((await act("notes", { note: "x" })).status, 400);
    assert.equal((await act("resolve", { resolution: "short" })).status, 400, "the outcome has to be written");
    assert.equal((await act("close")).status, 409, "resolve before closing");
    const res = await act("resolve", { resolution: "Refund of the double charge was paid by UPI and the patient was told" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, "RESOLVED");
    assert.ok(res.body.data.resolvedBy);
    assert.equal((await act("close", { note: "Patient satisfied" })).status, 200);
    const closed = (await t.api("get", `/complaints/${id}`, mgr.token)).body.data;
    assert.equal(closed.status, "CLOSED");
    assert.equal(closed.notes[0].kind, "RAISED");
    assert.ok(closed.notes.length >= 7, "every step is in the history");
    for (const [p, body] of [["start", {}], ["resolve", { resolution: "A long enough resolution text" }], ["close", {}], ["reopen", { reason: "reopening it now" }], ["notes", { note: "more notes" }], ["assign", { ownerId: mgr.id }]] as const) {
      assert.equal((await act(p, body)).status, 409, `${p} on a closed complaint`);
    }
    await assert.rejects(() => t.prisma.complaint.update({ where: { id }, data: { description: "Rewritten history is not allowed" } }), "closed is final");
    await assert.rejects(() => t.prisma.complaint.delete({ where: { id } }));
    await assert.rejects(() => t.prisma.complaintNote.updateMany({ where: { complaintId: id }, data: { note: "edited" } }), "history is never edited");
    for (const action of ["COMPLAINT_RAISED", "COMPLAINT_ASSIGNED", "COMPLAINT_RESOLVED", "COMPLAINT_CLOSED", "COMPLAINT_REOPENED"]) {
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: w.tenant.tenantId, action } }), `${action} is audited`);
    }

    // A second complaint through the straight path, and what the register shows.
    const c2 = (await raise({ category: "Cleanliness", description: "The room was not cleaned for two days during the stay" }, w.rec.token)).body.data.id as string;
    assert.equal((await t.api("post", `/complaints/${c2}/start`, w.relations.token)).body.data.status, "IN_PROGRESS");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: w.tenant.tenantId, action: "COMPLAINT_STARTED", entityId: c2 } }), "taking it up is audited");
    const active = (await t.api("get", "/complaints", mgr.token)).body.data;
    assert.ok(active.items.some((x: { id: string }) => x.id === c2));
    assert.ok(active.items.every((x: { status: string }) => x.status === "OPEN" || x.status === "IN_PROGRESS"), "the default view is the open ones");
    assert.ok((await t.api("get", "/complaints?status=CLOSED", mgr.token)).body.data.items.some((x: { id: string }) => x.id === id));
    assert.equal((await t.api("get", "/complaints?status=BOGUS", mgr.token)).status, 400);
    assert.equal((await t.api("get", "/complaints", w.rec.token)).status, 403);
    assert.equal((await t.api("get", "/complaints", w.doc.token)).status, 403);

    // Hospital isolation.
    for (const [m, p, body] of [["get", `/complaints/${id}`, undefined], ["post", `/complaints/${c2}/notes`, { note: "Not yours to touch" }], ["post", `/complaints/${c2}/resolve`, { resolution: "Not theirs to resolve this one" }]] as const) {
      assert.equal((await t.api(m, p, other.relations.token).send(body as object)).status, 404, `${m} ${p}`);
    }
    assert.equal((await t.api("get", "/complaints?status=ALL", other.relations.token)).body.data.items.length, 0);
    assert.equal((await raise({ taskId: task.id, category: "Billing", description: "Using another hospital's review" }, other.relations.token)).status, 404);
  });

  it("the journey summary counts reviews, calls, ratings and complaints for a period, for coordinators and managers only", async () => {
    const ahead = dayStr(new Date(Date.now() + 40 * 86_400_000));
    const s = await t.api("get", `/aftercare/summary?from=${dayStr(new Date())}&to=${ahead}`, w.coord.token);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const d = s.body.data;
    assert.ok(d.reviews.due >= 5);
    assert.ok(d.reviews.completed >= 1 && d.reviews.closed >= 2);
    assert.ok(d.reviews.reached >= 1);
    assert.ok(d.feedback.count >= 3 && d.feedback.average !== null);
    assert.equal(d.feedback.byRating.length, 5);
    assert.ok(d.complaints.total >= 2 && d.complaints.resolved >= 1);
    assert.equal((await t.api("get", "/aftercare/summary?from=2026-12-01&to=2026-01-01", w.coord.token)).status, 400);
    assert.equal((await t.api("get", "/aftercare/summary?from=2020-01-01&to=2026-01-01", w.coord.token)).status, 400, "at most a year");
    assert.equal((await t.api("get", "/aftercare/summary", w.rec.token)).status, 403);
    const o = (await t.api("get", "/aftercare/summary", other.coord.token)).body.data;
    assert.equal(o.reviews.due, 0, "another hospital counts only its own");
    assert.equal(o.complaints.total, 0);
  });
  it("telephone calls: the length of each call, from the call timer, is kept with the outcome", async () => {
    const task = await taskOf((await discharge(w)).adm.id);
    const call = (body: Record<string, unknown>) => t.api("post", `/aftercare/tasks/${task.id}/contacts`, w.coord.token).send(body);
    assert.equal((await call({ outcome: "NO_ANSWER", durationSeconds: -1 })).status, 400);
    assert.equal((await call({ outcome: "NO_ANSWER", durationSeconds: 20000 })).status, 400);
    assert.equal((await call({ outcome: "NO_ANSWER", durationSeconds: 1.5 })).status, 400);
    assert.equal((await call({ outcome: "NO_ANSWER", note: "Rang out", durationSeconds: 125 })).status, 200);
    const detail = (await t.api("get", `/aftercare/tasks/${task.id}`, w.coord.token)).body.data;
    assert.equal(detail.contacts[0].durationSeconds, 125);
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "ContactAttempt" SET "durationSeconds" = 5 WHERE "taskId" = ${task.id}::uuid`, "a logged call is never edited");
  });

  it("the automatic text: sent once when the review is due and not booked, retried when the gateway fails, never for a booked review", async () => {
    const jobs = t.app.get(AftercareJobsService);
    const fake = new FakeProvider();
    const sentFor = (id: string) => fake.sent.filter((m) => m.reminderId === id);
    const url = "https://hospital.example";
    const far = await taskOf((await discharge(w)).adm.id);
    const now = new Date();
    await jobs.runDue(now, fake, url);
    assert.equal(sentFor(far.id).length, 0, "ten days away: not yet");

    const later = new Date(now.getTime() + 8 * 86_400_000);
    const r1 = await jobs.runDue(later, fake, url);
    assert.ok(r1.reminders.sent >= 1);
    assert.equal(sentFor(far.id).length, 1);
    assert.match(sentFor(far.id)[0]!.text, /review visit.*due around/);
    assert.doesNotMatch(sentFor(far.id)[0]!.text, /pneumonia|diagnos/i, "no clinical detail in the message");
    assert.ok((await taskOf(far.admissionId)).reminderSentAt);
    await jobs.runDue(later, fake, url);
    assert.equal(sentFor(far.id).length, 1, "only once");

    // A gateway failure is tried again later, up to three times.
    const flaky = await taskOf((await discharge(w)).adm.id);
    assert.equal((await t.api("patch", `/aftercare/tasks/${flaky.id}`, w.coord.token).send({ dueDate: dayStr(new Date()) })).status, 200);
    fake.fail = true;
    await jobs.runDue(now, fake, url);
    let f = await taskOf(flaky.admissionId);
    assert.equal(f.reminderAttempts, 1);
    assert.equal(f.reminderSentAt, null);
    assert.ok(f.reminderNextAt && f.reminderNextAt > now);
    await jobs.runDue(now, fake, url);
    assert.equal((await taskOf(flaky.admissionId)).reminderAttempts, 1, "not again before its time");
    fake.fail = false;
    await jobs.runDue(new Date(now.getTime() + 20 * 60_000), fake, url);
    f = await taskOf(flaky.admissionId);
    assert.ok(f.reminderSentAt);
    assert.equal(f.reminderAttempts, 2);
    assert.equal(sentFor(flaky.id).length, 1);

    // A booked review needs no text, and the hospital can switch the texts off.
    const booked = await taskOf((await discharge(w)).adm.id);
    assert.equal((await t.api("patch", `/aftercare/tasks/${booked.id}`, w.coord.token).send({ dueDate: dayStr(new Date()) })).status, 200);
    assert.equal((await t.api("post", `/aftercare/tasks/${booked.id}/book`, w.coord.token).send({ practitionerId: w.doc.practitionerId, startAt: at(30 * 24 * 60) })).status, 200);
    const off = await taskOf((await discharge(w)).adm.id);
    assert.equal((await t.api("patch", `/aftercare/tasks/${off.id}`, w.coord.token).send({ dueDate: dayStr(new Date()) })).status, 200);
    assert.equal((await t.api("put", "/settings/AFTERCARE_REMINDER_ENABLED", w.tenant.admin.token).send({ value: false })).status, 200);
    try { await jobs.runDue(now, fake, url); } finally { await t.api("put", "/settings/AFTERCARE_REMINDER_ENABLED", w.tenant.admin.token).send({ value: true }); }
    assert.equal(sentFor(booked.id).length, 0, "booked");
    assert.equal(sentFor(off.id).length, 0, "switched off");
  });

  it("the patient's own feedback form: a secret link used once, a rating and an optional complaint, no sign-in; staff can make it; the worker sends it after a review visit", async () => {
    const jobs = t.app.get(AftercareJobsService);
    const { adm, patient } = await discharge(w);
    const task = await taskOf(adm.id);
    assert.equal((await t.api("post", `/aftercare/tasks/${task.id}/feedback-link`, w.rec.token).send({})).status, 403);
    assert.equal((await t.api("post", `/aftercare/tasks/${task.id}/feedback-link`, other.coord.token).send({})).status, 404);
    const made = await t.api("post", `/aftercare/tasks/${task.id}/feedback-link`, w.coord.token).send({ send: true });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.match(made.body.data.path, /^\/feedback\/[A-Za-z0-9_-]{40,}$/);
    assert.equal(made.body.data.sent, false, "no web address is set in tests, so nothing is texted");
    assert.ok(made.body.data.notSentBecause);
    const token = made.body.data.path.split("/").pop() as string;
    const stored = await t.prisma.feedbackRequest.findFirstOrThrow({ where: { taskId: task.id } });
    assert.notEqual(stored.tokenHash, token, "only a hash is kept");

    assert.equal((await t.api("get", "/public/feedback/short")).status, 404);
    assert.equal((await t.api("get", `/public/feedback/${"a".repeat(43)}`)).status, 404, "a wrong link looks like an expired one");
    const info = await t.api("get", `/public/feedback/${token}`);
    assert.equal(info.status, 200, JSON.stringify(info.body));
    assert.ok(info.body.data.hospital);
    assert.equal(JSON.stringify(info.body).includes(patient.id), false, "nothing about the patient is shown");
    const post = (tok: string, body: Record<string, unknown>) => t.api("post", `/public/feedback/${tok}`).send(body);
    assert.equal((await post(token, { rating: 6 })).status, 400);
    assert.equal((await post(token, { rating: 4, patientId: other.rec.id })).status, 400, "no field the patient could use to name someone else");
    assert.equal((await post(token, { rating: 2, complaint: { category: "Billing", description: "short" } })).status, 400);
    const ok = await post(token, { rating: 2, comment: "Long wait at the pharmacy", complaint: { category: "Pharmacy", description: "Waited more than an hour for the medicines after discharge" } });
    assert.ok([200, 201].includes(ok.status), JSON.stringify(ok.body));
    assert.match(ok.body.data.complaintNumber, /^CMP-/);
    const fb = await t.prisma.patientFeedback.findFirstOrThrow({ where: { taskId: task.id, viaLink: true } });
    assert.equal(fb.patientId, patient.id);
    assert.equal(fb.channel, "FORM");
    assert.equal(fb.rating, 2);
    const cmp = await t.prisma.complaint.findFirstOrThrow({ where: { feedbackId: fb.id } });
    assert.equal(cmp.patientId, patient.id);
    assert.equal(cmp.status, "OPEN");
    assert.equal((await post(token, { rating: 5 })).status, 404, "a link works once");
    assert.equal((await t.api("get", `/public/feedback/${token}`)).status, 404);
    await assert.rejects(() => t.prisma.feedbackRequest.update({ where: { id: stored.id }, data: { sentAt: new Date() } }), "a used link never changes");
    await assert.rejects(() => t.prisma.feedbackRequest.delete({ where: { id: stored.id } }));
    assert.ok((await t.api("get", "/aftercare/feedback", w.relations.token)).body.data.items.some((f: { id: string }) => f.id === fb.id));

    // After a review visit the worker makes the link and texts it, once.
    const v = await discharge(w);
    const vt = await taskOf(v.adm.id);
    const booked = await t.api("post", `/aftercare/tasks/${vt.id}/book`, w.coord.token).send({ practitionerId: w.doc.practitionerId, startAt: at(25) });
    assert.equal(booked.status, 200, JSON.stringify(booked.body));
    const apptId = booked.body.data.appointment.id as string;
    for (const status of ["CHECKED_IN", "WAITING", "IN_CONSULTATION", "COMPLETED"] as const) await t.prisma.appointment.update({ where: { id: apptId }, data: { status } });
    assert.equal((await taskOf(v.adm.id)).status, "COMPLETED");
    const fake = new FakeProvider();
    await jobs.runDue(new Date(), fake, "https://hospital.example");
    const req = await t.prisma.feedbackRequest.findMany({ where: { taskId: vt.id } });
    assert.equal(req.length, 1, "one link for the review");
    assert.ok(req[0]!.sentAt);
    assert.ok(fake.sent.some((m) => m.reminderId === req[0]!.id && m.text.includes("https://hospital.example/feedback/")));
    await jobs.runDue(new Date(), fake, "https://hospital.example");
    assert.equal(await t.prisma.feedbackRequest.count({ where: { taskId: vt.id } }), 1, "never a second one");
  });

  it("complaint deadlines and escalation: the deadline follows the severity, an overdue complaint goes up to a manager on its own, and any complaint can be sent up by hand", async () => {
    const jobs = t.app.get(AftercareJobsService);
    const mgr = await t.makeUser(w.tenant, ["MANAGER"]);
    const raise = async (severity: string) => (await t.api("post", "/complaints", w.relations.token).send({ category: "Service", severity, description: `A ${severity} severity complaint about the service during the stay` })).body.data as { id: string; dueAt: string; createdAt: string; overdue: boolean };
    const hours = (c: { dueAt: string; createdAt: string }) => Math.round((Date.parse(c.dueAt) - Date.parse(c.createdAt)) / 3_600_000);
    const high = await raise("HIGH"), med = await raise("MEDIUM"), low = await raise("LOW");
    assert.equal(hours(high), 24);
    assert.equal(hours(med), 72);
    assert.equal(hours(low), 168);
    assert.equal(high.overdue, false);
    assert.equal((await t.api("get", "/complaints?overdue=1", w.relations.token)).body.data.items.some((c: { id: string }) => c.id === high.id), false);

    // Past the deadline the worker sends it up, once, with a note and an audit record; the others are not yet due.
    const fake = new FakeProvider();
    const r = await jobs.runDue(new Date(Date.now() + 25 * 3_600_000), fake, "https://hospital.example");
    assert.ok(r.escalated >= 1);
    const h = (await t.api("get", `/complaints/${high.id}`, w.relations.token)).body.data;
    assert.ok(h.escalatedAt);
    assert.ok(h.escalatedTo);
    assert.match(h.escalationReason, /deadline/);
    assert.ok(h.notes.some((n: { kind: string }) => n.kind === "ESCALATED"));
    assert.equal((await t.api("get", `/complaints/${med.id}`, w.relations.token)).body.data.escalatedAt, null);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: w.tenant.tenantId, action: "COMPLAINT_ESCALATED", entityId: high.id } }));
    await jobs.runDue(new Date(Date.now() + 25 * 3_600_000), fake, "https://hospital.example");
    assert.equal(await t.prisma.complaintNote.count({ where: { complaintId: high.id, kind: "ESCALATED" } }), 1, "sent up once");

    // By hand: with a reason, once, only while it is open, to someone of this hospital.
    const by = (id: string, body: Record<string, unknown>, tok = w.relations.token) => t.api("post", `/complaints/${id}/escalate`, tok).send(body);
    assert.equal((await by(med.id, { reason: "x" })).status, 400);
    assert.equal((await by(med.id, { reason: "Patient is threatening to go to the press", toUserId: other.relations.id })).status, 400);
    assert.equal((await by(med.id, { reason: "Patient is threatening to go to the press" }, w.coord.token)).status, 403);
    const up = await by(med.id, { reason: "Patient is threatening to go to the press", toUserId: mgr.id });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.data.escalatedTo !== null, true);
    assert.equal((await by(med.id, { reason: "Trying to escalate it again" })).status, 409);
    assert.equal((await t.api("get", "/complaints?mine=1", mgr.token)).body.data.items.some((c: { id: string }) => c.id === med.id), true, "it is on the manager's list");
    assert.equal((await t.api("post", `/complaints/${low.id}/resolve`, w.relations.token).send({ resolution: "Explained to the patient and apologised for the delay" })).status, 200);
    assert.equal((await by(low.id, { reason: "It is resolved already" })).status, 409, "only an open complaint");
    assert.equal((await t.api("post", `/complaints/${high.id}/escalate`, other.relations.token).send({ reason: "Not my hospital's complaint" })).status, 404);
  });
  it("the call queue: take the next patient (most overdue first), nobody else is given the same one, release or time out hands it back, a logged call or a booking ends the claim", async () => {
    const x = await world("aft-queue");
    const coord2 = await t.makeUser(x.tenant, ["CARE_COORDINATOR"]);
    const coord3 = await t.makeUser(x.tenant, ["CARE_COORDINATOR"]);
    const next = (tok = x.coord.token) => t.api("post", "/aftercare/queue/next", tok).send({});
    assert.equal((await next()).body.data, null, "an empty queue gives nobody");

    const mk = async () => taskOf((await discharge(x)).adm.id);
    const oldest = await mk(), middle = await mk(), newest = await mk(), notYet = await mk();
    const due = async (id: string, daysAgo: number) => assert.equal((await t.api("patch", `/aftercare/tasks/${id}`, x.coord.token).send({ dueDate: dayStr(new Date(Date.now() - daysAgo * 86_400_000)) })).status, 200);
    await due(oldest.id, 5); await due(middle.id, 2); await due(newest.id, 0);
    // notYet is due in about ten days: not in the queue.

    const a1 = await next();
    assert.equal(a1.status, 200, JSON.stringify(a1.body));
    assert.equal(a1.body.data.id, oldest.id, "the most overdue first");
    assert.equal(a1.body.data.assignedToId, x.coord.id);
    assert.equal((await next()).body.data.id, oldest.id, "asking again gives the same patient, not a second one");
    const b1 = await next(coord2.token);
    assert.equal(b1.body.data.id, middle.id, "the other person is given the next one");
    // Two at once get two different patients.
    const [c1, c2] = await Promise.all([next(), next(coord2.token)]);
    assert.ok(c1.body.data && c2.body.data);
    assert.notEqual(c1.body.data.id, c2.body.data.id);
    const listed = (await list(x, "?show=PENDING")).body.data.items as { id: string; claimedUntil: string | null }[];
    assert.ok(listed.find((r) => r.id === oldest.id)!.claimedUntil, "the list shows who is holding whom");
    assert.equal(listed.find((r) => r.id === notYet.id)!.claimedUntil, null);

    // Release hands it back; only the holder can release.
    assert.equal((await t.api("post", `/aftercare/tasks/${oldest.id}/release`, coord2.token).send({})).status, 409, "not theirs to release");
    assert.equal((await t.api("post", `/aftercare/tasks/${oldest.id}/release`, x.coord.token).send({})).status, 200);
    assert.equal((await t.api("post", `/aftercare/tasks/${oldest.id}/release`, x.coord.token).send({})).status, 409, "already released");
    assert.equal((await next(coord3.token)).body.data.id, oldest.id, "back in the queue for the next person");

    // A logged call ends the claim and, with a call-back time, keeps the patient out of the queue until then.
    assert.equal((await t.api("post", `/aftercare/tasks/${oldest.id}/contacts`, coord3.token).send({ outcome: "CALL_AGAIN", nextCallAt: at(180), note: "After 6 pm" })).status, 200);
    assert.equal((await taskOf(oldest.admissionId)).claimedUntil, null, "the claim ends with the call");
    const after = await next(x.coord.token);
    assert.notEqual(after.body.data?.id, oldest.id, "not offered again before the call-back time");

    // An expired claim is given to someone else.
    await t.prisma.aftercareTask.update({ where: { id: newest.id }, data: { claimedUntil: new Date(Date.now() - 60_000), assignedToId: coord2.id } });
    await t.prisma.aftercareTask.update({ where: { id: middle.id }, data: { claimedUntil: null, assignedToId: null, status: "CLOSED", closedById: x.coord.id, closedAt: new Date(), closeReason: "Closed for the test" } });
    const reclaimed = await next(x.coord.token);
    assert.equal(reclaimed.body.data?.id, newest.id, "the timed-out claim goes to the next person");

    // Permissions, booking ends the claim, and hospital isolation.
    assert.equal((await next(x.rec.token)).status, 403);
    assert.equal((await next(x.doc.token)).status, 403);
    assert.equal((await t.api("post", "/aftercare/queue/next").send({})).status, 401);
    assert.equal((await t.api("post", `/aftercare/tasks/${newest.id}/release`, other.coord.token).send({})).status, 404);
    assert.equal((await next(other.coord.token)).body.data?.id === newest.id, false, "another hospital is never given this hospital's patient");
    const book = await t.api("post", `/aftercare/tasks/${newest.id}/book`, x.coord.token).send({ practitionerId: x.doc.practitionerId, startAt: at(14 * 24 * 60) });
    assert.equal(book.status, 200, JSON.stringify(book.body));
    assert.equal((await taskOf(newest.admissionId)).claimedUntil, null, "booking ends the claim");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action: "AFTERCARE_CLAIMED" } }));
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action: "AFTERCARE_RELEASED", entityId: oldest.id } }));
  });
  it("call scripts: built-in wording with the patient, doctor, due date and hospital filled in; a hospital can write its own (managers only) and go back to the built-in; unknown fields are refused", async () => {
    const x = await world("aft-scripts");
    const mgr = await t.makeUser(x.tenant, ["MANAGER"]);
    const task = await taskOf((await discharge(x)).adm.id);
    const script = (q = "", tok = x.coord.token) => t.api("get", `/aftercare/tasks/${task.id}/script${q}`, tok);

    const list = (await t.api("get", "/aftercare/scripts", x.coord.token)).body.data as { kind: string; isDefault: boolean; body: string; title: string }[];
    assert.deepEqual(list.map((s) => s.kind), ["FIRST_CALL", "CALL_BACK", "BOOKING", "DECLINED", "FEEDBACK"]);
    assert.ok(list.every((s) => s.isDefault && s.body.length > 20 && s.title));

    const first = await script();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.kind, "FIRST_CALL");
    assert.equal(first.body.data.isDefault, true);
    assert.doesNotMatch(first.body.data.text, /\{|\}/, "every placeholder is filled in");
    const patient = await t.prisma.patient.findFirstOrThrow({ where: { id: task.patientId } });
    assert.ok(first.body.data.text.includes(patient.firstName), "the patient's first name");
    assert.match(first.body.data.text, /review visit with .+ is due around \d{1,2} [A-Z][a-z]+/);
    assert.equal(first.body.data.kinds.length, 5);

    // After a call the script is the call-back one; any kind can be asked for.
    assert.equal((await t.api("post", `/aftercare/tasks/${task.id}/contacts`, x.coord.token).send({ outcome: "NO_ANSWER" })).status, 200);
    assert.equal((await script()).body.data.kind, "CALL_BACK");
    assert.equal((await script("?kind=BOOKING")).body.data.kind, "BOOKING");
    assert.equal((await script("?kind=BOGUS")).status, 400);
    assert.equal((await script("?extra=1")).status, 400);

    // Only people who configure the call centre can change the wording.
    const put = (kind: string, body: Record<string, unknown>, tok = mgr.token) => t.api("put", `/aftercare/scripts/${kind}`, tok).send(body);
    assert.equal((await put("FIRST_CALL", { body: "Namaste {patient}, this is {hospital} about your visit with {doctor} around {due}." }, x.coord.token)).status, 403);
    assert.equal((await put("FIRST_CALL", { body: "Namaste {patient}, this is {hospital} about your visit with {doctor} around {due}." }, x.rec.token)).status, 403);
    assert.equal((await put("FIRST_CALL", { body: "short" })).status, 400);
    assert.equal((await put("FIRST_CALL", { body: "Hello {patient}, your password is {password} please." })).status, 400, "only the known placeholders");
    assert.equal((await put("FIRST_CALL", { body: "Hello {patient}, how are you feeling today?", extra: 1 })).status, 400);
    assert.equal((await put("FIRST_CALL", { body: "x".repeat(1501) })).status, 400);
    assert.equal((await put("NOT_A_KIND", { body: "Hello {patient}, how are you feeling today?" })).status, 404);
    const saved = await put("FIRST_CALL", { body: "Namaste {patient}, this is {hospital}. Your visit with {doctor} is due around {due}." });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.isDefault, false);
    const fresh = await taskOf((await discharge(x)).adm.id);
    const custom = await t.api("get", `/aftercare/tasks/${fresh.id}/script`, x.coord.token);
    assert.match(custom.body.data.text, /^Namaste /);
    assert.equal(custom.body.data.isDefault, false);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: x.tenant.tenantId, action: "AFTERCARE_SCRIPT_SAVED" } }));
    assert.equal((await t.api("post", "/aftercare/scripts/FIRST_CALL/reset", x.coord.token).send({})).status, 403);
    const reset = await t.api("post", "/aftercare/scripts/FIRST_CALL/reset", mgr.token).send({});
    assert.equal(reset.status, 200);
    assert.equal(reset.body.data.isDefault, true);
    assert.match((await t.api("get", `/aftercare/tasks/${fresh.id}/script`, x.coord.token)).body.data.text, /^Hello, may I speak with/);

    // Hospital isolation: another hospital's scripts and tasks are its own.
    assert.equal((await t.api("get", `/aftercare/tasks/${task.id}/script`, other.coord.token)).status, 404);
    assert.ok((await t.api("get", "/aftercare/scripts", other.coord.token)).body.data.every((s: { isDefault: boolean }) => s.isDefault));
    assert.equal((await t.api("get", "/aftercare/scripts", x.rec.token)).status, 403);
  });

  it("daily targets: each caller sees today's calls, answered calls and bookings against the targets; managers see everyone; nobody sees another hospital", async () => {
    const x = await world("aft-targets");
    const mgr = await t.makeUser(x.tenant, ["MANAGER"]);
    const coord2 = await t.makeUser(x.tenant, ["CARE_COORDINATOR"]);
    assert.equal((await t.api("put", "/settings/AFTERCARE_DAILY_CALL_TARGET", x.tenant.admin.token).send({ value: 3 })).status, 200);
    assert.equal((await t.api("put", "/settings/AFTERCARE_DAILY_BOOKING_TARGET", x.tenant.admin.token).send({ value: 5 })).status, 200);
    assert.equal((await t.api("put", "/settings/AFTERCARE_DAILY_CALL_TARGET", x.tenant.admin.token).send({ value: 501 })).status, 400);
    const zero = (await t.api("get", "/aftercare/targets", x.coord.token)).body.data;
    assert.deepEqual([zero.callTarget, zero.bookingTarget, zero.mine.calls, zero.mine.bookings], [3, 5, 0, 0]);
    assert.equal(zero.team, null, "a caller does not see the team");

    const a1 = await taskOf((await discharge(x)).adm.id), a2 = await taskOf((await discharge(x)).adm.id), a3 = await taskOf((await discharge(x)).adm.id);
    const call = (id: string, body: Record<string, unknown>, tok = x.coord.token) => t.api("post", `/aftercare/tasks/${id}/contacts`, tok).send(body);
    assert.equal((await call(a1.id, { outcome: "NO_ANSWER" })).status, 200);
    assert.equal((await call(a2.id, { outcome: "WRONG_NUMBER", note: "Number not in use" })).status, 200);
    assert.equal((await call(a3.id, { outcome: "CALL_AGAIN", nextCallAt: at(240) })).status, 200);
    assert.equal((await t.api("post", `/aftercare/tasks/${a1.id}/book`, x.coord.token).send({ practitionerId: x.doc.practitionerId, startAt: at(30 * 24 * 60) })).status, 200);
    assert.equal((await call(a2.id, { outcome: "NO_ANSWER" }, coord2.token)).status, 200, "a colleague's call counts for the colleague");

    const mine = (await t.api("get", "/aftercare/targets", x.coord.token)).body.data;
    assert.deepEqual([mine.mine.calls, mine.mine.reached, mine.mine.bookings], [4, 2, 1], "3 calls and a booking; the call-back and the booking were answered");
    assert.equal(mine.mine.callsPercent, 100, "capped at 100");
    assert.equal(mine.mine.bookingsPercent, 20);
    const theirs = (await t.api("get", "/aftercare/targets", coord2.token)).body.data;
    assert.deepEqual([theirs.mine.calls, theirs.mine.bookings], [1, 0]);
    const boss = await t.api("get", "/aftercare/targets", mgr.token);
    assert.equal(boss.status, 200, JSON.stringify(boss.body));
    const team = boss.body.data.team as { userId: string; name: string | null; calls: number; bookings: number }[];
    assert.deepEqual(team.map((r) => [r.userId, r.calls, r.bookings]), [[x.coord.id, 4, 1], [coord2.id, 1, 0]], "the manager sees everyone, busiest first");
    assert.ok(team.every((r) => r.name));
    assert.equal((await t.api("get", "/aftercare/targets", other.coord.token)).body.data.mine.calls, 0, "another hospital counts only its own");
    assert.equal((await t.api("get", "/aftercare/targets", x.rec.token)).status, 403);
  });
});
