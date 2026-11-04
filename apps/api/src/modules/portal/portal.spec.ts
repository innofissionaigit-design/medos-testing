import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { MESSAGE_PROVIDER, type MessageProvider, type OutgoingMessage } from "../prescriptions/message.provider";

type User = { id: string; token: string };
let seq = 0;
/** A valid Indian mobile number that no other test uses. */
const mobileNo = () => `9${String(Date.now()).slice(-6)}${String(++seq).padStart(3, "0")}`;

describe("patient app: sign-in with a code, what a patient sees, and appointment requests", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: User; let cashier: User; let nurse: User; let bRec: User;
  let doc: TestDoctor;
  const sent: OutgoingMessage[] = [];
  const codeFor = (mobile: string) => /^(\d{6}) is your/.exec([...sent].reverse().find((m) => m.to === mobile)?.text ?? "")?.[1] ?? "";

  const setting = (value: boolean, tenant = a) => t.api("put", "/settings/PATIENT_PORTAL_ENABLED", tenant.admin.token).send({ value });
  const ask = (mobile: string, hospitalCode = a.code) => t.api("post", "/patient-portal/auth/code").send({ hospitalCode, mobile });
  const verify = (mobile: string, code: string, hospitalCode = a.code) => t.api("post", "/patient-portal/auth/verify").send({ hospitalCode, mobile, code });
  const signIn = async (mobile: string, tenant = a) => { await ask(mobile, tenant.code); const r = await verify(mobile, codeFor(mobile), tenant.code); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data.token as string; };
  const get = (path: string, token?: string) => (token ? t.api("get", path).set("Authorization", `Bearer ${token}`) : t.api("get", path));
  const post = (path: string, token: string, body: Record<string, unknown> = {}) => t.api("post", path).set("Authorization", `Bearer ${token}`).send(body);
  /** A patient with this mobile, with a signed consultation and prescription. */
  const visit = async (mobile: string, sign = true, first = "Meera") => {
    const patient = await registerPatient(t, rec.token, { firstName: first });
    await t.prisma.patient.update({ where: { id: patient.id }, data: { mobile } });
    const v = await startVisit(t, rec.token, doc, patient.id);
    await t.api("post", `/queue/${v.queueId}/start`, doc.token);
    await t.api("put", `/encounters/${v.encounterId}/prescription`, doc.token).send({ items: [{ genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3 }] });
    const n = await t.api("put", `/encounters/${v.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Fever for two days", advice: "Drink plenty of fluids" } });
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doc.token).send({ text: "Viral fever", type: "PROVISIONAL" });
    if (sign) assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doc.token).send({ version: n.body.data.version })).status, 200);
    return { patient, encounterId: v.encounterId };
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("portal-a"); b = await t.makeTenant("portal-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]); cashier = await t.makeUser(a, ["CASHIER"]); nurse = await t.makeUser(a, ["NURSE"]); bRec = await t.makeUser(b, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
    const provider = t.app.get<MessageProvider>(MESSAGE_PROVIDER);
    (provider as { send: MessageProvider["send"] }).send = async (m) => { sent.push(m); return { providerMessageId: `test:${m.reference}` }; };
    assert.equal((await setting(true)).status, 200);
    assert.equal((await setting(true, b)).status, 200);
  });
  after(async () => { await t.close(); });

  describe("the code", () => {
    it("is sent only to a registered mobile when the hospital has the app on, and the answer is always the same", async () => {
      const mobile = mobileNo();
      await visit(mobile);
      const before = sent.length;
      const known = await ask(mobile);
      const unknown = await ask(mobileNo());
      const badHospital = await ask(mobile, "no-such-hospital");
      const badNumber = await ask("1234567890");
      for (const r of [known, unknown, badHospital, badNumber]) assert.deepEqual([r.status, r.body.data], [200, { sent: true }]);
      assert.equal(sent.length, before + 1, "only the registered number received a code");
      const m = sent[sent.length - 1]!;
      assert.deepEqual([m.to, m.channel], [mobile, "SMS"]);
      assert.match(m.text, /^\d{6} is your .+ patient app code\. It works for 5 minutes\. Do not share it with anyone\.$/);
      const row = await t.prisma.patientOtp.findFirstOrThrow({ where: { tenantId: a.tenantId, mobile } });
      assert.notEqual(row.codeHash, codeFor(mobile), "only a hash is kept");
      assert.equal((await ask(mobile, b.code)).status, 200);
      assert.equal(sent.length, before + 1, "another hospital has no patient with this number");
      for (const bad of [{}, { hospitalCode: a.code }, { hospitalCode: a.code, mobile, extra: 1 }]) assert.equal((await t.api("post", "/patient-portal/auth/code").send(bad)).status, 400);
    });

    it("sends nothing while the hospital has the app switched off", async () => {
      const mobile = mobileNo();
      await visit(mobile);
      await setting(false);
      const before = sent.length;
      assert.deepEqual((await ask(mobile)).body.data, { sent: true });
      assert.equal(sent.length, before);
      await setting(true);
    });

    it("is limited to three a quarter hour for one number", async () => {
      const mobile = mobileNo();
      await visit(mobile);
      const before = sent.length;
      for (let i = 0; i < 5; i++) assert.equal((await ask(mobile)).status, 200);
      assert.equal(sent.length - before, 3);
    });

    it("works once, only for the right number, and only a few wrong tries are allowed", async () => {
      const mobile = mobileNo();
      await visit(mobile);
      await ask(mobile);
      const code = codeFor(mobile);
      const wrong = code === "000000" ? "111111" : "000000";
      const other = mobileNo();
      await visit(other);
      assert.equal((await verify(other, code)).status, 401, "a code is for one number");
      assert.equal((await verify(mobile, wrong)).status, 401);
      assert.equal((await verify(mobile, wrong, b.code)).status, 401, "another hospital");
      for (const bad of ["12345", "abcdef", "1234567", ""]) assert.equal((await verify(mobile, bad)).status, 400, bad);
      const ok = await verify(mobile, code);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.match(ok.body.data.token, /^mdp_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/);
      assert.equal((await verify(mobile, code)).status, 401, "a used code is dead");
      const row = await t.prisma.patientSession.findFirstOrThrow({ where: { tenantId: a.tenantId, mobile } });
      assert.notEqual(row.tokenHash, ok.body.data.token, "only a hash of the token is kept");
      // Five wrong tries lock the code, even for the right answer.
      const m2 = mobileNo();
      await visit(m2);
      await ask(m2);
      const c2 = codeFor(m2);
      for (let i = 0; i < 5; i++) assert.equal((await verify(m2, c2 === "000000" ? "111111" : "000000")).status, 401);
      assert.equal((await verify(m2, c2)).status, 401, "locked after five wrong tries");
      assert.equal(await t.prisma.patientSession.count({ where: { tenantId: a.tenantId, mobile: m2 } }), 0);
    });

    it("expires, and two people entering the right code at once open one session", async () => {
      const mobile = mobileNo();
      await visit(mobile);
      const old = new Date(Date.now() - 20 * 60_000);
      await t.prisma.patientOtp.create({ data: { tenantId: a.tenantId, mobile, codeHash: "x".repeat(64), createdAt: old, expiresAt: new Date(old.getTime() + 5 * 60_000) } });
      assert.equal((await verify(mobile, "123456")).status, 401, "expired");
      await ask(mobile);
      const code = codeFor(mobile);
      const [x, y] = await Promise.all([verify(mobile, code), verify(mobile, code)]);
      assert.deepEqual([x.status, y.status].sort(), [200, 401], JSON.stringify([x.body, y.body]));
      assert.equal(await t.prisma.patientSession.count({ where: { tenantId: a.tenantId, mobile } }), 1);
    });
  });

  describe("the session and what it can see", () => {
    it("needs a patient's own token: no token, a staff token or a made-up one is refused; a patient token does not open staff routes", async () => {
      const mobile = mobileNo();
      await visit(mobile);
      const token = await signIn(mobile);
      assert.equal((await get("/patient-portal/me")).status, 401);
      assert.equal((await get("/patient-portal/me", rec.token)).status, 401, "a staff token is not a patient session");
      assert.equal((await get("/patient-portal/me", "mdp_bogus.xxxx")).status, 401);
      assert.equal((await get("/patient-portal/me", `mdp_${randomUUID()}.${"a".repeat(43)}`)).status, 401);
      assert.equal((await get("/patients?q=Meera", token)).status, 401, "the patient token opens no staff route");
      assert.equal((await get("/patient-portal/me", token)).status, 200);
      const forged = token.replace(/^mdp_[0-9a-f-]{36}/, `mdp_${b.tenantId}`);
      assert.equal((await get("/patient-portal/me", forged)).status, 401, "a token cannot be moved to another hospital");
    });

    it("lists only the patients registered with the signed-in mobile; a family sharing a phone sees each other", async () => {
      const mobile = mobileNo();
      const one = await visit(mobile, true, "Asha");
      const two = await visit(mobile, true, "Bina");
      const stranger = await visit(mobileNo(), true, "Chitra");
      const token = await signIn(mobile);
      const me = (await get("/patient-portal/me", token)).body.data as { hospital: string; patients: { id: string; name: string; mrn: string }[] };
      assert.deepEqual(me.patients.map((p) => p.id).sort(), [one.patient.id, two.patient.id].sort());
      assert.ok(me.hospital);
      assert.ok(me.patients.every((p) => p.mrn));
      for (const path of ["appointments", "visits", "reports", "bills", "appointment-requests"]) {
        assert.equal((await get(`/patient-portal/${path}?patientId=${stranger.patient.id}`, token)).status, 404, `${path}: another number's patient`);
        assert.equal((await get(`/patient-portal/${path}?patientId=${randomUUID()}`, token)).status, 404, `${path}: unknown patient`);
        assert.equal((await get(`/patient-portal/${path}?patientId=nope`, token)).status, 400, `${path}: not an id`);
        assert.equal((await get(`/patient-portal/${path}`, token)).status, 400, `${path}: a patient is required`);
        assert.equal((await get(`/patient-portal/${path}?patientId=${one.patient.id}`, token)).status, 200, path);
      }
      const bToken = await signIn(mobile, b).catch(() => null);
      assert.equal(bToken, null, "the number is not a patient of the other hospital");
    });

    it("shows signed visits with the diagnosis, advice and prescription; never a draft", async () => {
      const mobile = mobileNo();
      const signed = await visit(mobile, true, "Signed");
      const draft = await visit(mobile, false, "Drafted");
      const token = await signIn(mobile);
      const v = (await get(`/patient-portal/visits?patientId=${signed.patient.id}`, token)).body.data as { diagnoses: string[]; advice: string | null; doctor: string; prescription: { number: string; medicines: { name: string; dose: string; days: number }[] } | null }[];
      assert.equal(v.length, 1);
      assert.deepEqual([v[0]!.diagnoses, v[0]!.advice], [["Viral fever"], "Drink plenty of fluids"]);
      assert.deepEqual(v[0]!.prescription?.medicines.map((m) => [m.name, m.dose, m.days]), [["Paracetamol 500 mg", "1 tablet", 3]]);
      assert.ok(v[0]!.prescription?.number && v[0]!.doctor);
      assert.deepEqual((await get(`/patient-portal/visits?patientId=${draft.patient.id}`, token)).body.data, [], "a note that is not signed is not shown");
    });

    it("shows appointments, upcoming and past", async () => {
      const mobile = mobileNo();
      const p = await visit(mobile);
      const at = (days: number) => new Date(Date.now() + days * 86_400_000);
      await t.prisma.appointment.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: p.patient.id, practitionerId: doc.practitionerId, startAt: at(3), endAt: new Date(at(3).getTime() + 900_000), status: "BOOKED", createdById: rec.id } });
      const token = await signIn(mobile);
      const r = (await get(`/patient-portal/appointments?patientId=${p.patient.id}`, token)).body.data as { upcoming: { status: string; doctor: string }[]; past: unknown[] };
      assert.deepEqual([r.upcoming.length, r.upcoming[0]?.status], [1, "BOOKED"]);
      assert.ok(r.upcoming[0]!.doctor);
      assert.ok(r.past.length >= 1, "the walk-in of the visit is in the past list");
    });

    it("shows verified lab reports and signed radiology reports, and holds back a critical one until the doctor has seen it", async () => {
      const mobile = mobileNo();
      const p = await visit(mobile);
      const invoice = (await t.api("post", "/invoices", cashier.token).send({ patientId: p.patient.id, lines: [{ description: "Tests", unitPrice: "800", taxPercent: 0, quantity: 1 }] })).body.data.id as string;
      const order = async (category: "LABORATORY" | "RADIOLOGY", name: string) => t.prisma.testOrder.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: p.patient.id, encounterId: p.encounterId, category, name, status: "BILLED", invoiceId: invoice, billedAt: new Date(), billedById: cashier.id, orderedById: doc.userId } });
      const lab = async (critical: boolean) => {
        const o = await order("LABORATORY", critical ? "Platelet count" : "Haemoglobin");
        const r = await t.prisma.labResult.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: p.patient.id, encounterId: p.encounterId, testOrderId: o.id, name: o.name, status: "VERIFIED", currentVersion: 1, hasCritical: critical } });
        await t.prisma.labResultVersion.create({ data: { tenantId: a.tenantId, resultId: r.id, version: 1, kind: "VERIFIED", values: [{ name: o.name, unit: "g/dL", value: critical ? "12" : "13.2", flag: critical ? "CRITICAL_LOW" : "NORMAL", rangeText: "12.0 - 15.5" }], hasCritical: critical, verifiedById: doc.userId } });
        return r;
      };
      const normal = await lab(false);
      const held = await lab(true);
      const token = await signIn(mobile);
      let r = (await get(`/patient-portal/reports?patientId=${p.patient.id}`, token)).body.data as { withheld: number; lab: { id: string; values: { name: string; value: string; flag: string }[] }[]; radiology: { id: string; impression: string }[] };
      assert.deepEqual([r.lab.map((x) => x.id), r.withheld], [[normal.id], 1]);
      assert.deepEqual(r.lab[0]!.values.map((v) => [v.name, v.value, v.flag]), [["Haemoglobin", "13.2", "NORMAL"]]);
      await t.prisma.labResult.update({ where: { id: held.id }, data: { criticalAckAt: new Date(), criticalAckById: doc.userId } });
      r = (await get(`/patient-portal/reports?patientId=${p.patient.id}`, token)).body.data;
      assert.deepEqual([r.lab.map((x) => x.id).sort(), r.withheld], [[normal.id, held.id].sort(), 0], "released once the doctor acknowledged it");
      const ro = await order("RADIOLOGY", "Chest X-ray");
      const study = await t.prisma.radStudy.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: p.patient.id, encounterId: p.encounterId, testOrderId: ro.id, accessionNumber: `RAD-T-${seq}`, modality: "XRAY", bodyPart: "Chest PA", status: "REPORTED", currentVersion: 1, hasCritical: true, performedById: doc.userId } });
      await t.prisma.radReportVersion.create({ data: { tenantId: a.tenantId, studyId: study.id, version: 1, kind: "SIGNED", findings: "Large pneumothorax", impression: "Pneumothorax", hasCritical: true, signedById: doc.userId } });
      r = (await get(`/patient-portal/reports?patientId=${p.patient.id}`, token)).body.data;
      assert.deepEqual([r.radiology.length, r.withheld], [0, 1], "a critical radiology report is held too");
      await t.prisma.radStudy.update({ where: { id: study.id }, data: { criticalAckAt: new Date(), criticalAckById: doc.userId } });
      r = (await get(`/patient-portal/reports?patientId=${p.patient.id}`, token)).body.data;
      assert.deepEqual([r.radiology.map((x) => x.impression), r.withheld], [["Pneumothorax"], 0]);
    });

    it("shows issued bills with what is due and the receipts, never a draft", async () => {
      const mobile = mobileNo();
      const p = await visit(mobile);
      const mk = async () => (await t.api("post", "/invoices", cashier.token).send({ patientId: p.patient.id, lines: [{ description: "Procedure", unitPrice: "1000", taxPercent: 0, quantity: 1 }] })).body.data.id as string;
      const issued = await mk();
      await mk();
      assert.equal((await t.api("post", `/invoices/${issued}/issue`, cashier.token)).status, 200);
      assert.equal((await t.api("post", `/invoices/${issued}/payments`, cashier.token).set("Idempotency-Key", `k-${randomUUID().slice(0, 18)}`).send({ payments: [{ method: "UPI", amount: "400", reference: "UPIREF4001" }] })).status, 201);
      const token = await signIn(mobile);
      const bills = (await get(`/patient-portal/bills?patientId=${p.patient.id}`, token)).body.data as { id: string; total: string; paid: string; due: string; status: string; receipts: { amount: string }[] }[];
      assert.equal(bills.length, 1, "the draft is not shown");
      assert.deepEqual([bills[0]!.total, bills[0]!.paid, bills[0]!.due, bills[0]!.status, bills[0]!.receipts.map((r) => r.amount)], ["1000.00", "400.00", "600.00", "PARTIALLY_PAID", ["400.00"]]);
    });

    it("signing out ends the session; switching the app off ends every session", async () => {
      const mobile = mobileNo();
      await visit(mobile);
      const token = await signIn(mobile);
      assert.equal((await post("/patient-portal/logout", token)).status, 200);
      assert.equal((await get("/patient-portal/me", token)).status, 401);
      const again = await signIn(mobile);
      await setting(false);
      assert.equal((await get("/patient-portal/me", again)).status, 401, "the hospital switched the app off");
      await setting(true);
      assert.equal((await get("/patient-portal/me", again)).status, 200);
      for (const action of ["PATIENT_APP_SIGNED_IN", "PATIENT_APP_SIGNED_OUT"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action } }), action);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientSession" SET "revokedAt" = NULL WHERE "tenantId" = '${a.tenantId}'::uuid AND mobile = '${mobile}' AND "revokedAt" IS NOT NULL`), /cannot be revived/);
    });
  });

  describe("appointment requests", () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

    it("a patient asks for an appointment; the front desk answers; the patient sees the answer", async () => {
      const mobile = mobileNo();
      const p = await visit(mobile);
      const token = await signIn(mobile);
      const body = (over: Record<string, unknown> = {}) => ({ patientId: p.patient.id, practitionerId: doc.practitionerId, preferredDate: day(3), timeOfDay: "MORNING", reason: "Follow-up for fever", ...over });
      for (const bad of [{ preferredDate: day(-1) }, { preferredDate: day(90) }, { reason: "x" }, { timeOfDay: "NIGHT" }, { extra: 1 }, { practitionerId: "nope" }]) assert.equal((await post("/patient-portal/appointment-requests", token, body(bad))).status, 400, JSON.stringify(bad));
      assert.equal((await post("/patient-portal/appointment-requests", token, body({ practitionerId: randomUUID() }))).status, 404);
      assert.equal((await post("/patient-portal/appointment-requests", token, body({ patientId: randomUUID() }))).status, 404);
      const r = await post("/patient-portal/appointment-requests", token, body());
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const mine = (await get(`/patient-portal/appointment-requests?patientId=${p.patient.id}`, token)).body.data as { id: string; status: string; doctor: string }[];
      assert.deepEqual([mine[0]?.id, mine[0]?.status, !!mine[0]?.doctor], [r.body.data.id, "PENDING", true]);
      const list = await t.api("get", "/appointment-requests?status=PENDING&pageSize=100", rec.token);
      assert.equal(list.status, 200);
      const row = (list.body.data.items as { id: string; patientId: string; reason: string }[]).find((x) => x.id === r.body.data.id)!;
      assert.deepEqual([row.patientId, row.reason], [p.patient.id, "Follow-up for fever"]);
      assert.equal((await t.api("get", "/appointment-requests", nurse.token)).status, 403);
      assert.equal((await t.api("get", "/appointment-requests", token)).status, 401, "a patient token is not a staff token");
      assert.equal(((await t.api("get", "/appointment-requests?pageSize=100", bRec.token)).body.data.items as { id: string }[]).some((x) => x.id === r.body.data.id), false);
      const answer = (decision: string, extra: Record<string, unknown> = {}, tok = rec.token) => t.api("post", `/appointment-requests/${r.body.data.id}/answer`, tok).send({ decision, ...extra });
      assert.equal((await answer("DECLINED")).status, 400, "a decline needs a note");
      assert.equal((await answer("BOOKED", {}, nurse.token)).status, 403);
      assert.equal((await answer("BOOKED", {}, bRec.token)).status, 404);
      assert.equal((await answer("MAYBE")).status, 400);
      assert.equal((await answer("BOOKED", { note: "Booked for Tuesday 10:30" })).status, 200);
      assert.equal((await answer("DECLINED", { note: "Changed my mind" })).status, 409, "already answered");
      assert.equal((await post(`/patient-portal/appointment-requests/${r.body.data.id}/cancel`, token)).status, 409, "the patient cannot cancel an answered request");
      const after = (await get(`/patient-portal/appointment-requests?patientId=${p.patient.id}`, token)).body.data as { status: string; answer: string }[];
      assert.deepEqual([after[0]?.status, after[0]?.answer], ["BOOKED", "Booked for Tuesday 10:30"]);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "APPOINTMENT_REQUEST_ANSWERED", entityId: r.body.data.id } }));
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "AppointmentRequest" SET status = 'PENDING', "handledAt" = NULL, "handledById" = NULL WHERE id = '${r.body.data.id}'::uuid`), /cannot change/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "AppointmentRequest" WHERE id = '${r.body.data.id}'::uuid`), /cannot be deleted/);
    });

    it("is limited to three waiting requests; a patient can cancel their own, not another family's; a decline shows its reason", async () => {
      const mobile = mobileNo();
      const p = await visit(mobile);
      const other = await visit(mobileNo(), true, "Other");
      const token = await signIn(mobile);
      const otherToken = await signIn(await t.prisma.patient.findFirstOrThrow({ where: { id: other.patient.id } }).then((x) => x.mobile!));
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) { const r = await post("/patient-portal/appointment-requests", token, { patientId: p.patient.id, preferredDate: day(2 + i), reason: `Visit number ${i}` }); assert.equal(r.status, 201); ids.push(r.body.data.id); }
      assert.equal((await post("/patient-portal/appointment-requests", token, { patientId: p.patient.id, preferredDate: day(7), reason: "One too many" })).status, 409);
      assert.equal((await post(`/patient-portal/appointment-requests/${ids[0]}/cancel`, otherToken)).status, 404, "another family's request");
      assert.equal((await post(`/patient-portal/appointment-requests/${randomUUID()}/cancel`, token)).status, 404);
      assert.equal((await post(`/patient-portal/appointment-requests/${ids[0]}/cancel`, token)).status, 200);
      assert.equal((await post(`/patient-portal/appointment-requests/${ids[0]}/cancel`, token)).status, 409, "already cancelled");
      assert.equal((await t.api("post", `/appointment-requests/${ids[1]}/answer`, rec.token).send({ decision: "DECLINED", note: "No slots that day, please call us" })).status, 200);
      const mine = (await get(`/patient-portal/appointment-requests?patientId=${p.patient.id}`, token)).body.data as { id: string; status: string; answer: string | null }[];
      assert.deepEqual(mine.find((x) => x.id === ids[1]), { ...mine.find((x) => x.id === ids[1])!, status: "DECLINED", answer: "No slots that day, please call us" });
      assert.equal((await post("/patient-portal/appointment-requests", token, { patientId: p.patient.id, preferredDate: day(8), reason: "Room again after the cancel" })).status, 201);
    });
  });

  it("DATABASE: codes and sessions cannot be deleted or rewritten", async () => {
    const mobile = mobileNo();
    await visit(mobile);
    await signIn(mobile);
    const otp = await t.prisma.patientOtp.findFirstOrThrow({ where: { tenantId: a.tenantId, mobile } });
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PatientOtp" WHERE id = '${otp.id}'::uuid`), /cannot be deleted/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientOtp" SET "consumedAt" = NULL WHERE id = '${otp.id}'::uuid`), /cannot be used again/);
    const s = await t.prisma.patientSession.findFirstOrThrow({ where: { tenantId: a.tenantId, mobile } });
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PatientSession" WHERE id = '${s.id}'::uuid`), /cannot be deleted/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientSession" SET mobile = '9000000000' WHERE id = '${s.id}'::uuid`), /cannot be changed/);
  });
});
