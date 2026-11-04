import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { MESSAGE_PROVIDER, type MessageProvider, type OutgoingMessage } from "../prescriptions/message.provider";
import { joinWindow, roomUrl } from "./telemedicine.domain";

type User = { id: string; token: string };
let seq = 0;
const mobileNo = () => `8${String(Date.now()).slice(-6)}${String(++seq).padStart(3, "0")}`;
const VIDEO = "https://video.example.test/{room}";

describe("telemedicine: the join window and the room link", () => {
  it("opens 15 minutes before and closes 90 minutes after the appointment", () => {
    const at = new Date("2026-11-10T10:00:00Z");
    const min = (m: number) => new Date(at.getTime() + m * 60_000);
    assert.equal(joinWindow(at, min(-16)).open, false);
    assert.equal(joinWindow(at, min(-15)).open, true);
    assert.equal(joinWindow(at, min(0)).open, true);
    assert.equal(joinWindow(at, min(90)).open, true);
    assert.equal(joinWindow(at, min(91)).open, false);
    assert.equal(joinWindow(at, min(0)).opensAt.toISOString(), "2026-11-10T09:45:00.000Z");
  });
  it("puts the room name into the hospital's template", () => {
    assert.equal(roomUrl("https://v.example.org/{room}", "abc"), "https://v.example.org/medos-abc");
    assert.equal(roomUrl("https://v.example.org/r?name={room}&x=1", "abc"), "https://v.example.org/r?name=medos-abc&x=1");
  });
});

describe("telemedicine: making an appointment a video consultation, joining it, and the patient's consent", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: User; let nurse: User; let bRec: User;
  let doc: TestDoctor; let doc2: TestDoctor;
  const sent: OutgoingMessage[] = [];

  const setting = (value: string, tenant = a) => t.api("put", "/settings/TELECONSULT_VIDEO_URL", tenant.admin.token).send({ value });
  const minutes = (n: number) => new Date(Date.now() + n * 60_000);
  /** A patient with a mobile number and a booked appointment with the doctor, starting in `inMinutes`. */
  const appointment = async (inMinutes: number, o: { doctor?: TestDoctor; status?: "BOOKED" | "CANCELLED"; mobile?: string; tenant?: TestTenant; rec?: User } = {}) => {
    const tenant = o.tenant ?? a;
    const patient = await registerPatient(t, (o.rec ?? rec).token);
    const mobile = o.mobile ?? mobileNo();
    await t.prisma.patient.update({ where: { id: patient.id }, data: { mobile } });
    const d = o.doctor ?? doc;
    const start = minutes(inMinutes);
    const ap = await t.prisma.appointment.create({ data: { tenantId: tenant.tenantId, facilityId: tenant.facilityId, patientId: patient.id, practitionerId: d.practitionerId, startAt: start, endAt: new Date(start.getTime() + 900_000), status: o.status ?? "BOOKED", overbooked: true, overbookReason: "Test booking", cancelReason: o.status === "CANCELLED" ? "Test cancel" : null, createdById: d.userId } });
    return { patient, mobile, appointmentId: ap.id };
  };
  const make = (appointmentId: string, tok = rec.token) => t.api("post", "/teleconsults", tok).send({ appointmentId });
  const video = async (inMinutes = 5, o: Parameters<typeof appointment>[1] = {}) => { const ap = await appointment(inMinutes, o); const r = await make(ap.appointmentId); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...ap, id: r.body.data.id as string }; };
  const joinDoc = (id: string, tok = doc.token) => t.api("post", `/teleconsults/${id}/join`, tok);
  const codeFor = (mobile: string) => /^(\d{6}) is your/.exec([...sent].reverse().find((m) => m.to === mobile)?.text ?? "")?.[1] ?? "";
  const signIn = async (mobile: string) => {
    await t.api("post", "/patient-portal/auth/code").send({ hospitalCode: a.code, mobile });
    const r = await t.api("post", "/patient-portal/auth/verify").send({ hospitalCode: a.code, mobile, code: codeFor(mobile) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data.token as string;
  };
  const patientJoin = (token: string, id: string, body: Record<string, unknown> = {}) => t.api("post", `/patient-portal/teleconsults/${id}/join`).set("Authorization", `Bearer ${token}`).send(body);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("tele-a"); b = await t.makeTenant("tele-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]); nurse = await t.makeUser(a, ["NURSE"]); bRec = await t.makeUser(b, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a); doc2 = await makeDoctor(t, a);
    const provider = t.app.get<MessageProvider>(MESSAGE_PROVIDER);
    (provider as { send: MessageProvider["send"] }).send = async (m) => { sent.push(m); return { providerMessageId: `test:${m.reference}` }; };
    assert.equal((await t.api("put", "/settings/PATIENT_PORTAL_ENABLED", a.admin.token).send({ value: true })).status, 200);
  });
  after(async () => { await t.close(); });

  it("the video service must be set up first; only a secure address with a place for the room name is accepted", async () => {
    const ap = await appointment(5);
    const none = await make(ap.appointmentId);
    assert.equal(none.status, 409);
    assert.match(none.body.error.message, /video service/);
    for (const bad of ["http://video.example.test/{room}", "https://video.example.test/room", "ftp://x/{room}", 5]) assert.equal((await setting(bad as string)).status, 400, String(bad));
    assert.equal((await setting(VIDEO)).status, 200);
    assert.equal((await setting(VIDEO, b)).status, 200);
    assert.equal((await make(ap.appointmentId)).status, 201);
  });

  it("making a video consultation: reception does it; it needs a live appointment of the same hospital; once per appointment", async () => {
    const ap = await appointment(30);
    assert.equal((await make(ap.appointmentId, doc.token)).status, 403, "the doctor joins; the front desk makes them");
    assert.equal((await make(ap.appointmentId, nurse.token)).status, 403);
    assert.equal((await make(ap.appointmentId, bRec.token)).status, 404, "another hospital's appointment");
    assert.equal((await make(randomUUID())).status, 404);
    assert.equal((await t.api("post", "/teleconsults", rec.token).send({ appointmentId: ap.appointmentId, extra: 1 })).status, 400);
    assert.equal((await t.api("post", "/teleconsults").send({ appointmentId: ap.appointmentId })).status, 401);
    const ok = await make(ap.appointmentId);
    assert.deepEqual([ok.status, ok.body.data.status], [201, "SCHEDULED"]);
    assert.equal((await make(ap.appointmentId)).status, 409, "already a video consultation");
    assert.equal((await make((await appointment(30, { status: "CANCELLED" })).appointmentId)).status, 409, "a cancelled appointment");
    assert.equal((await make((await appointment(-180)).appointmentId)).status, 409, "an appointment that was hours ago");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "TELECONSULT_CREATED", entityId: ok.body.data.id } }));
  });

  it("two at once for the same appointment make one", async () => {
    const ap = await appointment(45);
    const rs = await Promise.all([make(ap.appointmentId), make(ap.appointmentId)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], JSON.stringify(rs.map((r) => r.body)));
  });

  it("the list shows each doctor only their own; the room link is never in it; only the right doctor in the time window can join", async () => {
    const mine = await video(5);
    const other = await video(5, { doctor: doc2 });
    const later = await video(180);
    const docList = (await t.api("get", "/teleconsults?pageSize=100", doc.token)).body.data.items as { id: string; canJoin: boolean; patient: string }[];
    const ids = docList.map((x) => x.id);
    assert.ok(ids.includes(mine.id) && ids.includes(later.id) && !ids.includes(other.id), "a doctor sees only their own");
    assert.deepEqual([docList.find((x) => x.id === mine.id)?.canJoin, docList.find((x) => x.id === later.id)?.canJoin], [true, false]);
    const all = (await t.api("get", "/teleconsults?pageSize=100", rec.token)).body.data.items as { id: string; canJoin: boolean }[];
    assert.ok([mine.id, other.id, later.id].every((i) => all.some((x) => x.id === i)), "the front desk sees all");
    assert.ok(all.every((x) => !x.canJoin), "the front desk never joins");
    const raw = JSON.stringify((await t.api("get", "/teleconsults?pageSize=100", rec.token)).body);
    const row = await t.prisma.teleconsult.findFirstOrThrow({ where: { id: mine.id } });
    assert.ok(!raw.includes(row.roomToken), "the room name is not in lists");
    assert.equal((await t.api("get", "/teleconsults", nurse.token)).status, 403);
    assert.equal(((await t.api("get", "/teleconsults?pageSize=100", bRec.token)).body.data.items as { id: string }[]).some((x) => x.id === mine.id), false);
    assert.equal((await t.api("get", "/teleconsults?status=NOPE", rec.token)).status, 400);
    assert.equal((await joinDoc(other.id)).status, 404, "another doctor's consultation");
    assert.equal((await joinDoc(mine.id, rec.token)).status, 403);
    assert.equal((await joinDoc(mine.id, nurse.token)).status, 403);
    assert.equal((await joinDoc(mine.id, a.admin.token)).status, 403, "or 404: not a doctor of this appointment");
    assert.equal((await joinDoc(randomUUID())).status, 404);
    const early = await joinDoc(later.id);
    assert.equal(early.status, 409, "too early");
    assert.match(early.body.error.message, /15 minutes before/);
  });

  it("the doctor joins and the call starts; the same link on every join; ending it completes it; nothing after", async () => {
    const v = await video(5);
    const j = await joinDoc(v.id);
    assert.equal(j.status, 200, JSON.stringify(j.body));
    const row = await t.prisma.teleconsult.findFirstOrThrow({ where: { id: v.id } });
    assert.equal(j.body.data.url, `https://video.example.test/medos-${row.roomToken}`);
    assert.deepEqual([row.status, !!row.doctorJoinedAt, j.body.data.patientJoined], ["IN_PROGRESS", true, false]);
    assert.equal((await joinDoc(v.id)).body.data.url, j.body.data.url, "the same room every time");
    assert.equal((await t.api("post", `/teleconsults/${v.id}/cancel`, rec.token).send({ reason: "Cancelling during the call" })).status, 409, "a call in progress cannot be cancelled");
    assert.equal((await t.api("post", `/teleconsults/${v.id}/end`, doc2.token)).status, 404);
    assert.equal((await t.api("post", `/teleconsults/${v.id}/end`, doc.token)).status, 200);
    assert.equal((await t.api("post", `/teleconsults/${v.id}/end`, doc.token)).status, 409);
    assert.equal((await joinDoc(v.id)).status, 409, "the consultation is over");
    for (const action of ["TELECONSULT_DOCTOR_JOINED", "TELECONSULT_ENDED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action, entityId: v.id } }), action);
    const notStarted = await video(5);
    assert.equal((await t.api("post", `/teleconsults/${notStarted.id}/end`, doc.token)).status, 409, "a call that never started cannot be ended");
  });

  it("cancelling needs a reason and frees the appointment for a new video consultation", async () => {
    const v = await video(60);
    assert.equal((await t.api("post", `/teleconsults/${v.id}/cancel`, rec.token).send({ reason: "no" })).status, 400);
    assert.equal((await t.api("post", `/teleconsults/${v.id}/cancel`, doc.token).send({ reason: "Doctor on leave" })).status, 403);
    assert.equal((await t.api("post", `/teleconsults/${v.id}/cancel`, bRec.token).send({ reason: "Not our appointment" })).status, 404);
    assert.equal((await t.api("post", `/teleconsults/${v.id}/cancel`, rec.token).send({ reason: "Patient wants to come in" })).status, 200);
    assert.equal((await t.api("post", `/teleconsults/${v.id}/cancel`, rec.token).send({ reason: "Again, for the record" })).status, 409);
    assert.equal((await joinDoc(v.id)).status, 409);
    assert.equal((await make(v.appointmentId)).status, 201, "the appointment can be made a video consultation again");
  });

  it("the patient sees the video consultation in the app, must agree before joining, and gets the same room as the doctor", async () => {
    const v = await video(5);
    const later = await video(240, { mobile: v.mobile, doctor: doc });
    const token = await signIn(v.mobile);
    const appts = (await t.api("get", `/patient-portal/appointments?patientId=${v.patient.id}`).set("Authorization", `Bearer ${token}`)).body.data as { upcoming: { id: string; video: { id: string; canJoin: boolean; consented: boolean } | null }[] };
    assert.deepEqual(appts.upcoming.map((x) => [x.id, x.video?.id, x.video?.canJoin, x.video?.consented]), [[v.appointmentId, v.id, true, false]]);
    const noConsent = await patientJoin(token, v.id);
    assert.equal(noConsent.status, 409);
    assert.match(noConsent.body.error.message, /agree to a video consultation/);
    assert.equal((await patientJoin(token, v.id, { consent: false })).status, 409);
    assert.equal((await patientJoin(token, v.id, { consent: "yes" })).status, 400);
    const ok = await patientJoin(token, v.id, { consent: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const doctor = await joinDoc(v.id);
    assert.equal(ok.body.data.url, doctor.body.data.url, "doctor and patient meet in the same room");
    assert.equal(doctor.body.data.patientJoined, true);
    const row = await t.prisma.teleconsult.findFirstOrThrow({ where: { id: v.id } });
    assert.ok(row.consentAt && row.patientJoinedAt, "the consent is recorded with its time");
    assert.equal((await patientJoin(token, v.id)).status, 200, "no need to agree again");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "TELECONSULT_PATIENT_JOINED", entityId: v.id } }));
    const tooEarly = await patientJoin(token, later.id, { consent: true });
    assert.equal(tooEarly.status, 409);
    assert.match(tooEarly.body.error.message, /15 minutes before/);
    assert.equal((await t.api("post", `/patient-portal/teleconsults/${v.id}/join`).send({ consent: true })).status, 401);
    assert.equal((await t.api("post", `/patient-portal/teleconsults/${v.id}/join`).set("Authorization", `Bearer ${rec.token}`).send({ consent: true })).status, 401, "a staff token is not a patient session");
  });

  it("another family's patient, another hospital's patient, a cancelled appointment or an ended call get nothing", async () => {
    const v = await video(5);
    const stranger = await appointment(5);
    const strangerToken = await signIn(stranger.mobile);
    assert.equal((await patientJoin(strangerToken, v.id, { consent: true })).status, 404, "not their consultation");
    assert.equal((await patientJoin(strangerToken, randomUUID(), { consent: true })).status, 404);
    const token = await signIn(v.mobile);
    await t.prisma.appointment.update({ where: { id: v.appointmentId }, data: { status: "CANCELLED", cancelReason: "Cancelled for the check" } });
    assert.equal((await patientJoin(token, v.id, { consent: true })).status, 409, "the appointment was cancelled");
    assert.equal((await joinDoc(v.id)).status, 409);
    const w = await video(5);
    const wToken = await signIn(w.mobile);
    await joinDoc(w.id);
    assert.equal((await t.api("post", `/teleconsults/${w.id}/end`, doc.token)).status, 200);
    assert.equal((await patientJoin(wToken, w.id, { consent: true })).status, 409, "the call is over");
  });

  it("DATABASE: a video consultation matches its appointment, is never deleted, keeps the patient's consent, and cannot be completed unless it started", async () => {
    const v = await video(5);
    const token = await signIn(v.mobile);
    await patientJoin(token, v.id, { consent: true });
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "Teleconsult" WHERE id = '${v.id}'::uuid`), /cannot be deleted/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Teleconsult" SET "consentAt" = NULL, "patientJoinedAt" = NULL WHERE id = '${v.id}'::uuid`), /consent cannot be changed/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Teleconsult" SET "scheduledAt" = now() + interval '1 day' WHERE id = '${v.id}'::uuid`), /cannot be moved/);
    const fresh = await video(5);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Teleconsult" SET status = 'COMPLETED', "endedAt" = now() WHERE id = '${fresh.id}'::uuid`), /never started/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Teleconsult" SET "patientJoinedAt" = now() WHERE id = '${fresh.id}'::uuid`), /teleconsult_values|check constraint/i);
    const ap = await appointment(10);
    const other = await appointment(10);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "Teleconsult" ("tenantId", "facilityId", "patientId", "appointmentId", "practitionerId", "scheduledAt", "roomToken", "createdById") SELECT '${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${other.patient.id}'::uuid, '${ap.appointmentId}'::uuid, a."practitionerId", a."startAt", 'x'||repeat('y', 30), '${rec.id}'::uuid FROM "Appointment" a WHERE a.id = '${ap.appointmentId}'::uuid`), /must match the appointment/);
  });

  it("the video link can be turned off again, which stops new joins", async () => {
    const v = await video(5);
    assert.equal((await setting("")).status, 200);
    assert.equal((await joinDoc(v.id)).status, 409, "no video service is set");
    assert.equal((await setting(VIDEO)).status, 200);
    assert.equal((await joinDoc(v.id)).status, 200);
  });
});
