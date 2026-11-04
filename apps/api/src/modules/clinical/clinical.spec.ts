import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeClinicianWith, makeDoctor, registerPatient, startApp, startVisit, type TestApp, type TestTenant } from "../../test/harness";

const COMPLAINT = { chiefComplaint: "Fever and cough for 3 days", examination: "Chest clear. Throat congested." };
const AMOX = { genericName: "Amoxicillin", strength: "500 mg", dosage: "1 capsule", route: "ORAL", frequency: "TDS", durationDays: 5, quantity: 15 };
const PARA = { genericName: "Paracetamol", brandName: "Dolo", strength: "650 mg", dosage: "1 tablet", route: "ORAL", frequency: "SOS", instructions: "After food", quantity: 10 };

describe("clinical core: allergies, diagnoses, consultation, prescription, signing, amendment", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let nurse: { id: string; token: string };

  /** Registers a patient and a live OPD visit with a fresh treating doctor. */
  const visit = async () => {
    const patient = await registerPatient(t, rec.token);
    const doctor = await makeDoctor(t, a);
    const v = await startVisit(t, rec.token, doctor, patient.id);
    return { patient, doctor, ...v };
  };
  const save = (tok: string, enc: string, content: unknown, version?: number) => t.api("put", `/encounters/${enc}/consultation`, tok).send({ content, ...(version ? { version } : {}) });
  const dx = (tok: string, enc: string, text = "Acute bronchitis", type = "PROVISIONAL") => t.api("post", `/encounters/${enc}/diagnoses`, tok).send({ text, type, code: "J20.9" });
  const rx = (tok: string, enc: string, items: unknown) => t.api("put", `/encounters/${enc}/prescription`, tok).send({ items });
  const sign = (tok: string, enc: string, version: number, extra: Record<string, unknown> = {}) => t.api("post", `/encounters/${enc}/consultation/sign`, tok).send({ version, ...extra });
  /** A fully documented, ready-to-sign visit. */
  const readyVisit = async (withRx = true) => {
    const v = await visit();
    const s = await save(v.doctor.token, v.encounterId, COMPLAINT);
    assert.equal(s.status, 200);
    assert.equal((await dx(v.doctor.token, v.encounterId)).status, 201);
    if (withRx) assert.equal((await rx(v.doctor.token, v.encounterId, [PARA])).status, 200);
    return { ...v, version: s.body.data.version as number };
  };
  const signed = async (withRx = true) => {
    const v = await readyVisit(withRx);
    const r = await sign(v.doctor.token, v.encounterId, v.version);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return v;
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("cln-a");
    b = await t.makeTenant("cln-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    nurse = await t.makeUser(a, ["NURSE"]);
  });
  after(async () => { await t.close(); });

  // ───────────────────────── allergies ─────────────────────────
  describe("allergies", () => {
    it("records patient-level allergies, lists active ones, and shows them in every later visit", async () => {
      const p = await registerPatient(t, rec.token);
      const d = await makeDoctor(t, a);
      const r = await t.api("post", `/patients/${p.id}/allergies`, nurse.token).send({ allergen: "Penicillin", type: "DRUG", reaction: "Rash, swelling", severity: "SEVERE" });
      assert.equal(r.status, 201);
      assert.equal(r.body.data.recordedById, nurse.id);
      const list = await t.api("get", `/patients/${p.id}/allergies`, rec.token);
      assert.equal(list.status, 200, "reception can see allergies (PATIENT_READ)");
      assert.equal(list.body.data.length, 1);
      const v = await startVisit(t, rec.token, d, p.id);
      const ws = await t.api("get", `/encounters/${v.encounterId}/workspace`, d.token);
      assert.equal(ws.body.data.allergies[0].allergen, "Penicillin");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "ALLERGY_RECORDED", entityId: r.body.data.id, actorUserId: nurse.id } }));
    });

    it("rejects duplicates, invalid input and unauthorised writers; reads need PATIENT_READ", async () => {
      const p = await registerPatient(t, rec.token);
      const body = { allergen: "  Sulfa  Drugs ", type: "DRUG", severity: "MODERATE" };
      assert.equal((await t.api("post", `/patients/${p.id}/allergies`, nurse.token).send(body)).status, 201);
      assert.equal((await t.api("post", `/patients/${p.id}/allergies`, nurse.token).send({ ...body, allergen: "sulfa drugs" })).status, 409);
      for (const bad of [{ ...body, allergen: "x" }, { ...body, type: "MOOD" }, { ...body, severity: "HUGE" }, { ...body, status: "RESOLVED" }, { ...body, patientId: p.id }]) {
        assert.equal((await t.api("post", `/patients/${p.id}/allergies`, nurse.token).send(bad)).status, 400);
      }
      const cashier = await t.makeUser(a, ["CASHIER"]);
      assert.equal((await t.api("post", `/patients/${p.id}/allergies`, rec.token).send({ allergen: "Dust", type: "ENVIRONMENT", severity: "MILD" })).status, 403);
      assert.equal((await t.api("post", `/patients/${p.id}/allergies`, cashier.token).send({ allergen: "Dust", type: "ENVIRONMENT", severity: "MILD" })).status, 403);
      assert.equal((await t.api("get", `/patients/${p.id}/allergies`)).status, 401);
    });

    it("corrections preserve history: status changes need a reason, details are immutable, nothing is deleted", async () => {
      const p = await registerPatient(t, rec.token);
      const al = (await t.api("post", `/patients/${p.id}/allergies`, nurse.token).send({ allergen: "Latex", type: "OTHER", severity: "MILD" })).body.data;
      assert.equal((await t.api("post", `/allergies/${al.id}/status`, nurse.token).send({ status: "ENTERED_IN_ERROR" })).status, 400);
      const wrong = await t.api("post", `/allergies/${al.id}/status`, nurse.token).send({ status: "ENTERED_IN_ERROR", reason: "Recorded on wrong patient" });
      assert.equal(wrong.status, 200);
      assert.equal((await t.api("get", `/patients/${p.id}/allergies`, nurse.token)).body.data.length, 0);
      const all = await t.api("get", `/patients/${p.id}/allergies`, nurse.token).query({ all: "true" });
      assert.equal(all.body.data[0].statusReason, "Recorded on wrong patient");
      assert.equal((await t.api("post", `/allergies/${al.id}/status`, nurse.token).send({ status: "ACTIVE", reason: "Reopen" })).status, 409, "entered-in-error is terminal");
      await assert.rejects(() => t.prisma.allergy.update({ where: { id: al.id }, data: { allergen: "Changed" } }), /immutable/);
      await assert.rejects(() => t.prisma.allergy.delete({ where: { id: al.id } }), /append-only/);
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "ALLERGY_STATUS_CHANGED", entityId: al.id } });
      assert.deepEqual(evt.metadata, { patientId: p.id, from: "ACTIVE", to: "ENTERED_IN_ERROR", reason: "Recorded on wrong patient" });
    });

    it("an allergy can be resolved and later reactivated, but never duplicated while active", async () => {
      const p = await registerPatient(t, rec.token);
      const al = (await t.api("post", `/patients/${p.id}/allergies`, nurse.token).send({ allergen: "Peanut", type: "FOOD", severity: "LIFE_THREATENING" })).body.data;
      assert.equal((await t.api("post", `/allergies/${al.id}/status`, nurse.token).send({ status: "RESOLVED", reason: "Outgrown, tested negative" })).status, 200);
      const again = (await t.api("post", `/patients/${p.id}/allergies`, nurse.token).send({ allergen: "Peanut", type: "FOOD", severity: "SEVERE" }));
      assert.equal(again.status, 201, "a new active record is allowed once the old one is resolved");
      assert.equal((await t.api("post", `/allergies/${al.id}/status`, nurse.token).send({ status: "ACTIVE", reason: "Recurred" })).status, 409, "would create two active records");
    });

    it("isolates allergies by tenant", async () => {
      const p = await registerPatient(t, rec.token);
      const al = (await t.api("post", `/patients/${p.id}/allergies`, nurse.token).send({ allergen: "Iodine", type: "DRUG", severity: "MILD" })).body.data;
      const bNurse = await t.makeUser(b, ["NURSE"]);
      assert.equal((await t.api("get", `/patients/${p.id}/allergies`, bNurse.token)).status, 404);
      assert.equal((await t.api("post", `/patients/${p.id}/allergies`, bNurse.token).send({ allergen: "Iodine2", type: "DRUG", severity: "MILD" })).status, 404);
      assert.equal((await t.api("post", `/allergies/${al.id}/status`, bNurse.token).send({ status: "RESOLVED", reason: "Hijack attempt" })).status, 404);
      assert.equal((await t.prisma.allergy.findFirstOrThrow({ where: { id: al.id } })).status, "ACTIVE");
    });
  });

  // ───────────────────────── consultation draft ─────────────────────────
  describe("consultation draft and diagnoses", () => {
    it("saves a draft with optimistic locking and only for the author", async () => {
      const v = await visit();
      const s1 = await save(v.doctor.token, v.encounterId, COMPLAINT);
      assert.equal(s1.status, 200);
      assert.equal(s1.body.data.version, 1);
      const s2 = await save(v.doctor.token, v.encounterId, { ...COMPLAINT, advice: "Rest, fluids" }, 1);
      assert.equal(s2.body.data.version, 2);
      const stale = await save(v.doctor.token, v.encounterId, COMPLAINT, 1);
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, "STALE_VERSION");
      assert.equal((await save(v.doctor.token, v.encounterId, COMPLAINT)).status, 409, "version is mandatory once a draft exists");
      const other = await makeDoctor(t, a);
      const hijack = await save(other.token, v.encounterId, { chiefComplaint: "Overwrite" }, 2);
      assert.equal(hijack.status, 403, "another doctor cannot take over the draft");
      const got = await t.api("get", `/encounters/${v.encounterId}/consultation`, v.doctor.token);
      assert.equal(got.body.data.document.content.advice, "Rest, fluids");
      assert.equal(got.body.data.document.status, "DRAFT");
    });

    it("validates content and rejects unknown or oversized fields", async () => {
      const v = await visit();
      for (const bad of [{ chiefComplaint: "x".repeat(4001) }, { chiefComplaint: 5 }, { status: "SIGNED" }, { followUp: { afterDays: 0 } }, { followUp: { afterDays: 400 } }, { followUp: { date: "tomorrow" } }]) {
        assert.equal((await save(v.doctor.token, v.encounterId, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
      }
      assert.equal((await t.api("put", `/encounters/${v.encounterId}/consultation`, v.doctor.token).send({ content: {}, signedAt: "2020-01-01" })).status, 400);
      assert.equal((await save(v.doctor.token, v.encounterId, { followUp: { afterDays: 7, notes: "Review with reports" } })).status, 200);
    });

    it("only registered practitioners can document; permission alone is not enough", async () => {
      const v = await visit();
      const noProfile = await t.makeUser(a, ["DOCTOR"]); // has CONSULTATION_CREATE but no practitioner record
      for (const call of [
        () => save(noProfile.token, v.encounterId, COMPLAINT),
        () => dx(noProfile.token, v.encounterId),
        () => rx(noProfile.token, v.encounterId, [PARA]),
      ]) {
        const r = await call();
        assert.equal(r.status, 403);
        assert.match(r.body.error.message, /registered practitioner/);
      }
      for (const u of [nurse, rec]) {
        assert.equal((await save(u.token, v.encounterId, COMPLAINT)).status, 403);
        assert.equal((await dx(u.token, v.encounterId)).status, 403);
        assert.equal((await rx(u.token, v.encounterId, [PARA])).status, 403);
      }
      assert.equal(await t.prisma.clinicalDocument.count({ where: { encounterId: v.encounterId } }), 0);
      const inactive = await makeDoctor(t, a);
      await t.prisma.practitioner.update({ where: { id: inactive.practitionerId }, data: { status: "INACTIVE" } });
      assert.equal((await save(inactive.token, v.encounterId, COMPLAINT)).status, 403, "inactive practitioner");
    });

    it("adds and removes diagnoses while drafting; history keeps removed ones; duplicates and limits enforced", async () => {
      const v = await visit();
      await save(v.doctor.token, v.encounterId, COMPLAINT);
      const d1 = await dx(v.doctor.token, v.encounterId, "Acute bronchitis", "PROVISIONAL");
      assert.equal(d1.status, 201);
      assert.equal((await dx(v.doctor.token, v.encounterId, "ACUTE BRONCHITIS", "PROVISIONAL")).status, 409);
      assert.equal((await dx(v.doctor.token, v.encounterId, "Acute bronchitis", "FINAL")).status, 201, "same text, different type is a different statement");
      for (const bad of [{ text: "x", type: "FINAL" }, { text: "Valid text", type: "MAYBE" }, { text: "Valid text", type: "FINAL", code: "bad code!" }, { text: "Valid text", type: "FINAL", status: "REMOVED" }]) {
        assert.equal((await t.api("post", `/encounters/${v.encounterId}/diagnoses`, v.doctor.token).send(bad)).status, 400);
      }
      assert.equal((await t.api("post", `/diagnoses/${d1.body.data.id}/remove`, v.doctor.token).send({})).status, 400);
      const rm = await t.api("post", `/diagnoses/${d1.body.data.id}/remove`, v.doctor.token).send({ reason: "Entered by mistake" });
      assert.equal(rm.body.data.status, "REMOVED");
      assert.equal((await t.api("post", `/diagnoses/${d1.body.data.id}/remove`, v.doctor.token).send({ reason: "Again" })).status, 409);
      const active = await t.api("get", `/encounters/${v.encounterId}/diagnoses`, v.doctor.token);
      assert.equal(active.body.data.length, 1);
      const withRemoved = await t.api("get", `/encounters/${v.encounterId}/diagnoses`, v.doctor.token).query({ includeRemoved: "true" });
      assert.equal(withRemoved.body.data.length, 2);
      await assert.rejects(() => t.prisma.diagnosis.update({ where: { id: d1.body.data.id }, data: { text: "Edited" } }), /immutable/);
      await assert.rejects(() => t.prisma.diagnosis.delete({ where: { id: d1.body.data.id } }), /append-only/);
      for (let i = 0; i < 19; i++) await dx(v.doctor.token, v.encounterId, `Condition number ${i}`, "SECONDARY");
      assert.equal((await dx(v.doctor.token, v.encounterId, "One too many", "SECONDARY")).status, 400);
    });

    it("builds longitudinal diagnosis history across visits", async () => {
      const s = await signed(false);
      const history = await t.api("get", `/patients/${s.patient.id}/diagnoses`, s.doctor.token);
      assert.equal(history.status, 200);
      assert.equal(history.body.data[0].text, "Acute bronchitis");
      assert.match(history.body.data[0].encounterNumber, /^OPD-/);
    });

    it("cannot document on a completed or cancelled visit, nor use another tenant's visit", async () => {
      const v = await visit();
      await save(v.doctor.token, v.encounterId, COMPLAINT);
      await t.api("post", `/queue/${v.queueId}/cancel`, rec.token).send({ reason: "Patient left" });
      assert.equal((await dx(v.doctor.token, v.encounterId)).status, 409);
      assert.equal((await save(v.doctor.token, v.encounterId, COMPLAINT, 1)).status, 409);
      const live = await visit();
      const bDoc = await makeDoctor(t, b);
      assert.equal((await save(bDoc.token, live.encounterId, COMPLAINT)).status, 404);
      assert.equal((await dx(bDoc.token, live.encounterId)).status, 404);
      assert.equal((await rx(bDoc.token, live.encounterId, [PARA])).status, 404);
      assert.equal((await t.api("get", `/encounters/${live.encounterId}/workspace`, bDoc.token)).status, 404);
      const f2 = await makeDoctor(t, a, { facilityId: a.facility2Id });
      assert.equal((await save(f2.token, live.encounterId, COMPLAINT)).status, 404, "another facility of the same tenant");
    });
  });

  // ───────────────────────── prescription ─────────────────────────
  describe("prescription (medication orders)", () => {
    it("saves a structured draft with no number and no pharmacy visibility", async () => {
      const v = await visit();
      const r = await rx(v.doctor.token, v.encounterId, [AMOX, PARA]);
      assert.equal(r.status, 200);
      const o = r.body.data.order;
      assert.equal(o.status, "DRAFT");
      assert.equal(o.orderNumber, null);
      assert.deepEqual(o.items.map((i: { lineNo: number }) => i.lineNo), [1, 2]);
      assert.equal(o.items[1].brandName, "Dolo");
      const replace = await rx(v.doctor.token, v.encounterId, [PARA]);
      assert.equal(replace.body.data.order.id, o.id, "the same draft is updated");
      assert.equal(replace.body.data.order.items.length, 1);
      assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: v.encounterId } }), 1);
    });

    it("validates every medicine line", async () => {
      const v = await visit();
      const bad: [string, unknown][] = [
        ["no items", []],
        ["too many", Array.from({ length: 31 }, () => PARA)],
        ["missing generic", [{ ...PARA, genericName: undefined }]],
        ["bad route", [{ ...PARA, route: "RECTAL" }]],
        ["bad frequency", [{ ...PARA, frequency: "WEEKLY" }]],
        ["OTHER frequency without text", [{ ...PARA, frequency: "OTHER" }]],
        ["zero duration", [{ ...PARA, durationDays: 0 }]],
        ["huge duration", [{ ...PARA, durationDays: 400 }]],
        ["negative quantity", [{ ...PARA, quantity: -1 }]],
        ["fractional quantity", [{ ...PARA, quantity: 1.5 }]],
        ["unknown field", [{ ...PARA, price: 5 }]],
        ["status injection", [{ ...PARA, status: "STOPPED" }]],
        ["long instructions", [{ ...PARA, instructions: "x".repeat(201) }]],
      ];
      for (const [label, items] of bad) assert.equal((await rx(v.doctor.token, v.encounterId, items)).status, 400, label);
      const ok = await rx(v.doctor.token, v.encounterId, [{ ...PARA, frequency: "OTHER", frequencyText: "Every 36 hours" }]);
      assert.equal(ok.status, 200);
      assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: v.encounterId } }), 1, "invalid saves created nothing");
    });

    it("another doctor cannot overwrite someone else's draft", async () => {
      const v = await visit();
      await rx(v.doctor.token, v.encounterId, [PARA]);
      const other = await makeDoctor(t, a);
      assert.equal((await rx(other.token, v.encounterId, [AMOX])).status, 403);
    });

    it("checks the patient's recorded allergies: warns on the draft, blocks signing until acknowledged, audits the override", async () => {
      const v = await visit();
      await t.api("post", `/patients/${v.patient.id}/allergies`, nurse.token).send({ allergen: "Amoxicillin", type: "DRUG", reaction: "Anaphylaxis", severity: "LIFE_THREATENING" });
      const s = await save(v.doctor.token, v.encounterId, COMPLAINT);
      await dx(v.doctor.token, v.encounterId);
      const draft = await rx(v.doctor.token, v.encounterId, [AMOX, PARA]);
      assert.equal(draft.body.data.allergyWarnings.length, 1);
      assert.equal(draft.body.data.allergyWarnings[0].allergen, "Amoxicillin");
      assert.equal(draft.body.data.allergyWarnings[0].severity, "LIFE_THREATENING");
      const blocked = await sign(v.doctor.token, v.encounterId, s.body.data.version);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, "ALLERGY_CONFLICT");
      assert.equal(blocked.body.error.details.allergyWarnings[0].matchedItem, "Amoxicillin");
      assert.equal((await t.prisma.clinicalDocument.findFirstOrThrow({ where: { encounterId: v.encounterId } })).status, "DRAFT", "nothing was signed");
      assert.equal((await t.prisma.medicationOrder.findFirstOrThrow({ where: { encounterId: v.encounterId } })).orderNumber, null, "and no prescription number was consumed");
      const ok = await sign(v.doctor.token, v.encounterId, s.body.data.version, { acknowledgeAllergyWarnings: true });
      assert.equal(ok.status, 200);
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PRESCRIPTION_ALLERGY_ACKNOWLEDGED", actorUserId: v.doctor.userId } });
      assert.deepEqual((evt.metadata as { allergies: string[] }).allergies, ["Amoxicillin"]);
    });

    it("resolved or erroneous allergies no longer trigger warnings", async () => {
      const v = await visit();
      const al = (await t.api("post", `/patients/${v.patient.id}/allergies`, nurse.token).send({ allergen: "Paracetamol", type: "DRUG", severity: "MILD" })).body.data;
      assert.equal((await rx(v.doctor.token, v.encounterId, [PARA])).body.data.allergyWarnings.length, 1);
      await t.api("post", `/allergies/${al.id}/status`, nurse.token).send({ status: "RESOLVED", reason: "Tolerated rechallenge" });
      assert.equal((await rx(v.doctor.token, v.encounterId, [PARA])).body.data.allergyWarnings.length, 0);
    });

    it("OPD prescriptions can only be signed with the consultation, not on their own", async () => {
      const v = await readyVisit();
      const r = await t.api("post", `/encounters/${v.encounterId}/prescription/sign`, v.doctor.token).send({});
      assert.equal(r.status, 409);
      assert.match(r.body.error.message, /together with the consultation/);
    });

    it("only users with PRESCRIPTION_CREATE can draft and PRESCRIPTION_READ can view; reception cannot", async () => {
      const v = await readyVisit();
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/prescription`, v.doctor.token)).status, 200);
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/prescription`, nurse.token)).status, 200);
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/prescription`, rec.token)).status, 403);
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/prescription`)).status, 401);
    });
  });

  // ───────────────────────── signing ─────────────────────────
  describe("signing", () => {
    it("signs: freezes the record as version 1, signs the prescription with a number, audits who signed", async () => {
      const v = await readyVisit();
      const r = await sign(v.doctor.token, v.encounterId, v.version);
      assert.equal(r.status, 200);
      assert.equal(r.body.data.status, "SIGNED");
      assert.equal(r.body.data.currentVersion, 1);
      const got = await t.api("get", `/encounters/${v.encounterId}/consultation`, v.doctor.token);
      const d = got.body.data.document;
      assert.equal(d.status, "SIGNED");
      assert.equal(d.signedByName, (await t.prisma.user.findFirstOrThrow({ where: { id: v.doctor.userId } })).fullName);
      assert.deepEqual(d.versions.map((x: { version: number; kind: string }) => [x.version, x.kind]), [[1, "SIGNED"]]);
      const order = got.body.data.prescription.orders.find((o: { status: string }) => o.status === "SIGNED");
      assert.match(order.orderNumber, /^RX-\d{4}-\d{6}$/);
      assert.equal(order.items[0].genericName, "Paracetamol");
      const snap = (await t.api("get", `/encounters/${v.encounterId}/consultation/versions/1`, v.doctor.token)).body.data.snapshot;
      assert.equal(snap.diagnoses[0].text, "Acute bronchitis");
      assert.equal(snap.prescriptions[0].orderNumber, order.orderNumber);
      for (const action of ["CONSULTATION_SIGNED", "PRESCRIPTION_SIGNED"]) {
        const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action, actorUserId: v.doctor.userId, facilityId: a.facilityId } });
        assert.ok(evt.requestId);
      }
    });

    it("requires a chief complaint and a diagnosis before signing", async () => {
      const v = await visit();
      const s = await save(v.doctor.token, v.encounterId, { examination: "Normal" });
      assert.equal((await sign(v.doctor.token, v.encounterId, s.body.data.version)).status, 400, "no chief complaint");
      await save(v.doctor.token, v.encounterId, COMPLAINT, 1);
      const noDx = await sign(v.doctor.token, v.encounterId, 2);
      assert.equal(noDx.status, 400);
      assert.equal(noDx.body.error.details[0].path, "diagnoses");
      assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, v.doctor.token).send({})).status, 400, "version is mandatory");
    });

    it("only the treating doctor can sign: not a colleague, not a user without a practitioner record", async () => {
      const v = await readyVisit();
      const colleague = await makeDoctor(t, a);
      const noProfile = await t.makeUser(a, ["DOCTOR"]);
      for (const u of [colleague, noProfile, nurse, rec]) assert.equal((await sign(u.token, v.encounterId, v.version)).status, 403);
      assert.equal((await t.prisma.clinicalDocument.findFirstOrThrow({ where: { encounterId: v.encounterId } })).status, "DRAFT");
      const notAllowed = await makeClinicianWith(t, a, ["CONSULTATION_READ", "CONSULTATION_CREATE"]);
      assert.equal((await sign(notAllowed.token, v.encounterId, v.version)).status, 403, "lacks CONSULTATION_SIGN");
    });

    it("rejects signing a stale version (the doctor must review what changed)", async () => {
      const v = await readyVisit();
      await save(v.doctor.token, v.encounterId, { ...COMPLAINT, advice: "Added after review" }, v.version);
      const stale = await sign(v.doctor.token, v.encounterId, v.version);
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, "STALE_VERSION");
    });

    it("signing is single-shot: a concurrent burst signs exactly once and consumes exactly one prescription number", async () => {
      const v = await readyVisit();
      const before = await t.prisma.numberSequence.findFirst({ where: { tenantId: a.tenantId, facilityId: a.facilityId, type: "PRESCRIPTION" } });
      const rs = await Promise.all(Array.from({ length: 6 }, () => sign(v.doctor.token, v.encounterId, v.version)));
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
      assert.equal(await t.prisma.clinicalDocumentVersion.count({ where: { documentId: (await t.prisma.clinicalDocument.findFirstOrThrow({ where: { encounterId: v.encounterId } })).id } }), 1);
      assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: v.encounterId, status: "SIGNED" } }), 1);
      const after2 = await t.prisma.numberSequence.findFirst({ where: { tenantId: a.tenantId, facilityId: a.facilityId, type: "PRESCRIPTION" } });
      assert.equal(Number(after2?.lastValue ?? 0) - Number(before?.lastValue ?? 0), 1);
    });

    it("assigns unique prescription numbers when many visits are signed in parallel", async () => {
      const visits = await Promise.all(Array.from({ length: 8 }, () => readyVisit()));
      const rs = await Promise.all(visits.map((v) => sign(v.doctor.token, v.encounterId, v.version)));
      assert.ok(rs.every((r) => r.status === 200));
      const numbers = (await t.prisma.medicationOrder.findMany({ where: { encounterId: { in: visits.map((v) => v.encounterId) } } })).map((o) => o.orderNumber as string);
      assert.equal(new Set(numbers).size, 8);
    });

    it("signing without a prescription is allowed and creates no order", async () => {
      const v = await readyVisit(false);
      assert.equal((await sign(v.doctor.token, v.encounterId, v.version)).status, 200);
      assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: v.encounterId } }), 0);
    });

    it("a signer without PRESCRIPTION_SIGN cannot sign a consultation that has a draft prescription (atomic: nothing signed)", async () => {
      const limited = await makeClinicianWith(t, a, ["PATIENT_READ", "CONSULTATION_READ", "CONSULTATION_CREATE", "CONSULTATION_SIGN", "PRESCRIPTION_CREATE", "PRESCRIPTION_READ", "QUEUE_READ", "QUEUE_MANAGE"]);
      const patient = await registerPatient(t, rec.token);
      const vv = await startVisit(t, rec.token, limited, patient.id);
      const s = await save(limited.token, vv.encounterId, COMPLAINT);
      await dx(limited.token, vv.encounterId);
      await rx(limited.token, vv.encounterId, [PARA]);
      const r = await sign(limited.token, vv.encounterId, s.body.data.version);
      assert.equal(r.status, 403);
      assert.equal((await t.prisma.clinicalDocument.findFirstOrThrow({ where: { encounterId: vv.encounterId } })).status, "DRAFT");
      assert.equal(await t.prisma.clinicalDocumentVersion.count({ where: { tenantId: a.tenantId, document: { encounterId: vv.encounterId } } }), 0);
    });
  });

  // ───────────────────────── signed-record immutability ─────────────────────────
  describe("signed records cannot be silently changed", () => {
    it("API: every edit path is closed after signing (draft, diagnoses, prescription, stop)", async () => {
      const v = await signed();
      const e = v.encounterId;
      const tok = v.doctor.token;
      const r1 = await save(tok, e, { chiefComplaint: "Tampered" }, 1);
      assert.equal(r1.status, 409);
      assert.equal(r1.body.error.code, "CONSULTATION_SIGNED");
      assert.equal((await dx(tok, e, "Sneaky new diagnosis")).body.error.code, "CONSULTATION_SIGNED");
      const existing = (await t.api("get", `/encounters/${e}/diagnoses`, tok)).body.data[0];
      assert.equal((await t.api("post", `/diagnoses/${existing.id}/remove`, tok).send({ reason: "Remove it quietly" })).body.error.code, "CONSULTATION_SIGNED");
      assert.equal((await rx(tok, e, [AMOX])).body.error.code, "CONSULTATION_SIGNED");
      const item = (await t.api("get", `/encounters/${e}/prescription`, tok)).body.data.orders[0].items[0];
      assert.equal((await t.api("post", `/medication-order-items/${item.id}/stop`, tok).send({ reason: "Quiet stop" })).body.error.code, "CONSULTATION_SIGNED");
      assert.equal((await sign(tok, e, 1)).body.error.code, "CONSULTATION_SIGNED");
      const content = (await t.api("get", `/encounters/${e}/consultation`, tok)).body.data.document.content;
      assert.equal(content.chiefComplaint, COMPLAINT.chiefComplaint, "content untouched");
    });

    it("database: signed documents, versions, orders and items reject updates and deletes even via raw SQL", async () => {
      const v = await signed();
      const doc = await t.prisma.clinicalDocument.findFirstOrThrow({ where: { encounterId: v.encounterId } });
      await assert.rejects(() => t.prisma.clinicalDocument.update({ where: { id: doc.id }, data: { draft: { chiefComplaint: "Tampered" } } }), /cannot be edited/);
      await assert.rejects(() => t.prisma.clinicalDocument.update({ where: { id: doc.id }, data: { status: "DRAFT" } }), /Invalid clinical document transition/);
      await assert.rejects(() => t.prisma.clinicalDocument.update({ where: { id: doc.id }, data: { signedById: randomUUID() } }), /cannot be edited/);
      await assert.rejects(() => t.prisma.clinicalDocument.update({ where: { id: doc.id }, data: { currentVersion: 5 } }), /only move forward/);
      await assert.rejects(() => t.prisma.clinicalDocument.delete({ where: { id: doc.id } }), /append-only/);
      const ver = await t.prisma.clinicalDocumentVersion.findFirstOrThrow({ where: { documentId: doc.id } });
      await assert.rejects(() => t.prisma.clinicalDocumentVersion.update({ where: { id: ver.id }, data: { content: { chiefComplaint: "Tampered" } } }), /append-only/);
      await assert.rejects(() => t.prisma.clinicalDocumentVersion.delete({ where: { id: ver.id } }), /append-only/);
      await assert.rejects(() => t.prisma.$executeRawUnsafe(`TRUNCATE "ClinicalDocumentVersion"`), /append-only/);
      const order = await t.prisma.medicationOrder.findFirstOrThrow({ where: { encounterId: v.encounterId, status: "SIGNED" }, include: { items: true } });
      await assert.rejects(() => t.prisma.medicationOrder.update({ where: { id: order.id }, data: { orderNumber: "RX-HACK-1" } }), /cannot be edited/);
      await assert.rejects(() => t.prisma.medicationOrder.update({ where: { id: order.id }, data: { status: "DRAFT" } }), /Invalid medication order transition/);
      await assert.rejects(() => t.prisma.medicationOrder.delete({ where: { id: order.id } }), /append-only/);
      const item = order.items[0]!;
      await assert.rejects(() => t.prisma.medicationOrderItem.update({ where: { id: item.id }, data: { genericName: "Morphine" } }), /cannot be edited/);
      await assert.rejects(() => t.prisma.medicationOrderItem.update({ where: { id: item.id }, data: { quantity: 9999 } }), /cannot be edited/);
      await assert.rejects(() => t.prisma.medicationOrderItem.delete({ where: { id: item.id } }), /cannot be deleted/);
      await assert.rejects(() => t.prisma.medicationOrderItem.create({ data: { tenantId: a.tenantId, orderId: order.id, lineNo: 9, genericName: "Added", dosage: "1", route: "ORAL", frequency: "OD" } }), /cannot be added/);
      await assert.rejects(() => t.prisma.medicationOrderItem.update({ where: { id: item.id }, data: { dispensedQuantity: 11 } }), /order_item_dispensed_valid|check/i);
    });

    it("database: dispensed quantity can only grow, and stopping an item requires a reason and is permanent", async () => {
      const v = await signed();
      const item = await t.prisma.medicationOrderItem.findFirstOrThrow({ where: { order: { encounterId: v.encounterId } } });
      await t.prisma.medicationOrderItem.update({ where: { id: item.id }, data: { dispensedQuantity: 4 } });
      await assert.rejects(() => t.prisma.medicationOrderItem.update({ where: { id: item.id }, data: { dispensedQuantity: 2 } }), /can only increase/);
      await assert.rejects(() => t.prisma.medicationOrderItem.update({ where: { id: item.id }, data: { status: "STOPPED" } }), /order_item_stop_has_reason|check/i);
      await t.prisma.medicationOrderItem.update({ where: { id: item.id }, data: { status: "STOPPED", stoppedAt: new Date(), stoppedById: v.doctor.userId, stopReason: "Adverse reaction" } });
      await assert.rejects(() => t.prisma.medicationOrderItem.update({ where: { id: item.id }, data: { status: "ACTIVE" } }), /cannot be restarted|order_item_stop_has_reason|check/i);
    });

    it("database: draft orders must have no number; signed orders must have one; one draft per visit", async () => {
      const v = await visit();
      await assert.rejects(() => t.prisma.medicationOrder.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: v.patient.id, encounterId: v.encounterId, orderedById: v.doctor.userId, orderNumber: "RX-FAKE" } }), /medication_order_signed_has_number|check/i);
      await t.prisma.medicationOrder.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: v.patient.id, encounterId: v.encounterId, orderedById: v.doctor.userId } });
      await assert.rejects(() => t.prisma.medicationOrder.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: v.patient.id, encounterId: v.encounterId, orderedById: v.doctor.userId } }), /Unique|unique/);
      const draftOrder = await t.prisma.medicationOrder.findFirstOrThrow({ where: { encounterId: v.encounterId } });
      await assert.rejects(() => t.prisma.medicationOrderItem.create({ data: { tenantId: a.tenantId, orderId: draftOrder.id, lineNo: 1, genericName: "X-drug", dosage: "1", route: "ORAL", frequency: "OTHER" } }), /order_item_other_needs_text|check/i);
    });
  });

  // ───────────────────────── amendment ─────────────────────────
  describe("amendment", () => {
    const amend = (tok: string, enc: string, body: Record<string, unknown>) => t.api("post", `/encounters/${enc}/consultation/amend`, tok).send(body);
    const base = { content: { ...COMPLAINT, advice: "Corrected advice: complete antibiotic course" }, expectedVersion: 1, reason: "Advice section omitted the antibiotic course" };

    it("creates version 2 with reason, author and time; the signed original stays recoverable byte-for-byte", async () => {
      const v = await signed();
      const original = (await t.api("get", `/encounters/${v.encounterId}/consultation/versions/1`, v.doctor.token)).body.data;
      const r = await amend(v.doctor.token, v.encounterId, base);
      assert.equal(r.status, 200);
      assert.equal(r.body.data.status, "AMENDED");
      assert.equal(r.body.data.currentVersion, 2);
      const got = (await t.api("get", `/encounters/${v.encounterId}/consultation`, v.doctor.token)).body.data.document;
      assert.equal(got.status, "AMENDED");
      assert.equal(got.content.advice, "Corrected advice: complete antibiotic course");
      assert.deepEqual(got.versions.map((x: { version: number; kind: string; reason: string | null }) => [x.version, x.kind, x.reason]), [[1, "SIGNED", null], [2, "AMENDED", base.reason]]);
      assert.ok(got.versions[1].authorName);
      const again = (await t.api("get", `/encounters/${v.encounterId}/consultation/versions/1`, v.doctor.token)).body.data;
      assert.deepEqual(again.content, original.content);
      assert.deepEqual(again.snapshot, original.snapshot);
      assert.equal(again.content.advice, undefined, "version 1 never saw the amendment");
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "CONSULTATION_AMENDED", actorUserId: v.doctor.userId } });
      assert.deepEqual({ ...(evt.metadata as object) }, { encounterId: v.encounterId, fromVersion: 1, toVersion: 2, reason: base.reason, diagnosesReplaced: false, prescriptionReplaced: false });
    });

    it("amends diagnoses and prescription together, superseding (never editing) the old ones", async () => {
      const v = await signed();
      const oldOrder = await t.prisma.medicationOrder.findFirstOrThrow({ where: { encounterId: v.encounterId, status: "SIGNED" } });
      const r = await amend(v.doctor.token, v.encounterId, {
        ...base, diagnoses: [{ text: "Community-acquired pneumonia", type: "FINAL", code: "J18.9" }], prescription: { items: [AMOX, PARA] },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const diag = await t.prisma.diagnosis.findMany({ where: { encounterId: v.encounterId }, orderBy: { recordedAt: "asc" } });
      assert.equal(diag.length, 2);
      assert.equal(diag[0]?.status, "REMOVED");
      assert.equal(diag[0]?.supersededAtVersion, 2);
      assert.match(diag[0]?.removeReason ?? "", /amendment v2/);
      assert.equal(diag[1]?.status, "ACTIVE");
      assert.equal(diag[1]?.text, "Community-acquired pneumonia");
      const orders = await t.prisma.medicationOrder.findMany({ where: { encounterId: v.encounterId }, orderBy: { createdAt: "asc" }, include: { items: true } });
      assert.equal(orders[0]?.id, oldOrder.id);
      assert.equal(orders[0]?.status, "SUPERSEDED");
      assert.equal(orders[0]?.supersededAtVersion, 2);
      assert.equal(orders[0]?.items.length, 1, "the old prescription is preserved intact");
      assert.equal(orders[1]?.status, "SIGNED");
      assert.equal(orders[1]?.items.length, 2);
      assert.notEqual(orders[1]?.orderNumber, orders[0]?.orderNumber);
      const v1 = (await t.api("get", `/encounters/${v.encounterId}/consultation/versions/1`, v.doctor.token)).body.data.snapshot;
      assert.equal(v1.diagnoses[0].text, "Acute bronchitis", "the original snapshot still shows what was originally signed");
      const v2 = (await t.api("get", `/encounters/${v.encounterId}/consultation/versions/2`, v.doctor.token)).body.data.snapshot;
      assert.equal(v2.diagnoses[0].text, "Community-acquired pneumonia");
      assert.equal(v2.prescriptions.length, 1);
      assert.equal(v2.prescriptions[0].items.length, 2);
    });

    it("refuses to replace a prescription once any medicine has been dispensed", async () => {
      const v = await signed();
      const item = await t.prisma.medicationOrderItem.findFirstOrThrow({ where: { order: { encounterId: v.encounterId } } });
      await t.prisma.medicationOrderItem.update({ where: { id: item.id }, data: { dispensedQuantity: 2 } });
      const r = await amend(v.doctor.token, v.encounterId, { ...base, prescription: { items: [AMOX] } });
      assert.equal(r.status, 409);
      assert.match(r.body.error.message, /already dispensed/);
      const doc = await t.prisma.clinicalDocument.findFirstOrThrow({ where: { encounterId: v.encounterId } });
      assert.equal(doc.currentVersion, 1, "the failed amendment left no partial version");
      assert.equal(await t.prisma.clinicalDocumentVersion.count({ where: { documentId: doc.id } }), 1);
      assert.equal((await amend(v.doctor.token, v.encounterId, base)).status, 200, "text-only amendments remain possible");
    });

    it("requires a meaningful reason, a non-empty complaint, and the latest version number", async () => {
      const v = await signed();
      const tok = v.doctor.token;
      assert.equal((await amend(tok, v.encounterId, { ...base, reason: "too short" })).status, 400);
      assert.equal((await amend(tok, v.encounterId, { ...base, reason: undefined })).status, 400);
      assert.equal((await amend(tok, v.encounterId, { ...base, content: { advice: "no complaint" } })).status, 400);
      assert.equal((await amend(tok, v.encounterId, { ...base, expectedVersion: 5 })).body.error.code, "STALE_VERSION");
      assert.equal((await amend(tok, v.encounterId, { ...base, diagnoses: [] })).status, 400);
      assert.equal((await amend(tok, v.encounterId, { ...base, status: "DRAFT" })).status, 400);
      assert.equal((await amend(tok, v.encounterId, base)).status, 200);
      assert.equal((await amend(tok, v.encounterId, base)).body.error.code, "STALE_VERSION", "the same expected version cannot be amended twice");
      assert.equal((await amend(tok, v.encounterId, { ...base, expectedVersion: 2, reason: "Second correction to the examination findings", content: { ...COMPLAINT, examination: "Chest: crepitations right base" } })).body.data.currentVersion, 3);
    });

    it("only authorised clinicians can amend: not nurses, reception, doctors without CONSULTATION_AMEND, or non-practitioners", async () => {
      const v = await signed();
      const noAmend = await makeClinicianWith(t, a, ["CONSULTATION_READ", "CONSULTATION_CREATE", "CONSULTATION_SIGN"]);
      const noProfile = await t.makeUser(a, ["DOCTOR"]);
      for (const u of [nurse, rec, noAmend, noProfile]) assert.equal((await amend(u.token, v.encounterId, base)).status, 403);
      assert.equal((await amend(v.doctor.token, v.encounterId, base)).status, 200, "the treating doctor can");
      const covering = await makeDoctor(t, a);
      const v2 = await signed();
      assert.equal((await amend(covering.token, v2.encounterId, base)).status, 200, "another registered practitioner holding CONSULTATION_AMEND can (covering doctor); the audit trail names them");
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "CONSULTATION_AMENDED", entityType: "ClinicalDocument", actorUserId: covering.userId } });
      assert.ok(evt, "amender is attributable and distinct from the signer");
      assert.notEqual(evt.actorUserId, v2.doctor.userId);
    });

    it("cannot amend a draft or a non-existent consultation", async () => {
      const v = await readyVisit();
      assert.equal((await amend(v.doctor.token, v.encounterId, base)).status, 409);
      const empty = await visit();
      assert.equal((await amend(empty.doctor.token, empty.encounterId, base)).status, 404);
    });

    it("a concurrent amendment race produces exactly one new version", async () => {
      const v = await signed();
      const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => amend(v.doctor.token, v.encounterId, { ...base, reason: `Concurrent correction number ${i} to advice`, content: { ...COMPLAINT, advice: `Variant ${i}` } })));
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
      const doc = await t.prisma.clinicalDocument.findFirstOrThrow({ where: { encounterId: v.encounterId } });
      assert.equal(doc.currentVersion, 2);
      assert.equal(await t.prisma.clinicalDocumentVersion.count({ where: { documentId: doc.id } }), 2);
    });

    it("blocks amendments that would add a medicine the patient is allergic to unless acknowledged", async () => {
      const v = await signed();
      await t.api("post", `/patients/${v.patient.id}/allergies`, nurse.token).send({ allergen: "Amoxicillin", type: "DRUG", severity: "SEVERE" });
      const r = await amend(v.doctor.token, v.encounterId, { ...base, prescription: { items: [AMOX] } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "ALLERGY_CONFLICT");
      assert.equal(await t.prisma.clinicalDocumentVersion.count({ where: { document: { encounterId: v.encounterId } } }), 1);
      assert.equal((await amend(v.doctor.token, v.encounterId, { ...base, prescription: { items: [AMOX] }, acknowledgeAllergyWarnings: true })).status, 200);
    });

    it("isolates amendments and versions by tenant and facility", async () => {
      const v = await signed();
      const bDoc = await makeDoctor(t, b);
      assert.equal((await amend(bDoc.token, v.encounterId, base)).status, 404);
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/consultation`, bDoc.token)).status, 404);
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/consultation/versions/1`, bDoc.token)).status, 404);
      const f2 = await makeDoctor(t, a, { facilityId: a.facility2Id });
      assert.equal((await amend(f2.token, v.encounterId, base)).status, 404);
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/consultation/versions/9`, v.doctor.token)).status, 404);
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/consultation/versions/abc`, v.doctor.token)).status, 404);
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/consultation/versions/0`, v.doctor.token)).status, 404);
    });
  });

  // ───────────────────────── queue + workspace ─────────────────────────
  describe("visit workflow", () => {
    it("a visit cannot be completed while its consultation is an unsigned draft", async () => {
      const v = await readyVisit();
      await t.api("post", `/queue/${v.queueId}/start`, v.doctor.token);
      const blocked = await t.api("post", `/queue/${v.queueId}/complete`, v.doctor.token);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /Sign the consultation/);
      assert.equal((await sign(v.doctor.token, v.encounterId, v.version)).status, 200);
      assert.equal((await t.api("post", `/queue/${v.queueId}/complete`, v.doctor.token)).status, 200);
    });

    it("a visit cannot be completed while its prescription is an unsigned draft, even with no consultation note", async () => {
      const v = await visit();
      assert.equal((await rx(v.doctor.token, v.encounterId, [AMOX])).status, 200);
      await t.api("post", `/queue/${v.queueId}/start`, v.doctor.token);
      const blocked = await t.api("post", `/queue/${v.queueId}/complete`, v.doctor.token);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /prescription/);
      assert.equal((await t.prisma.encounter.findFirstOrThrow({ where: { id: v.encounterId } })).status, "ACTIVE", "the visit stays open so the doctor can still sign");
    });

    it("a visit with no consultation can still be completed (e.g. nurse-only review)", async () => {
      const v = await visit();
      await t.api("post", `/queue/${v.queueId}/start`, v.doctor.token);
      assert.equal((await t.api("post", `/queue/${v.queueId}/complete`, v.doctor.token)).status, 200);
    });

    it("the workspace gives the doctor header, allergies, vitals, previous visits and the consultation on one call", async () => {
      const first = await signed();
      await t.api("post", `/patients/${first.patient.id}/allergies`, nurse.token).send({ allergen: "Aspirin", type: "DRUG", severity: "MODERATE" });
      await t.api("post", `/queue/${first.queueId}/start`, first.doctor.token);
      await t.api("post", `/queue/${first.queueId}/complete`, first.doctor.token);
      const second = await startVisit(t, rec.token, first.doctor, first.patient.id);
      await t.api("post", `/encounters/${second.encounterId}/observations`, nurse.token).send({ observations: [{ type: "PULSE", value: 88 }, { type: "SPO2", value: 97 }] });
      const ws = (await t.api("get", `/encounters/${second.encounterId}/workspace`, first.doctor.token)).body.data;
      assert.equal(ws.header.mrn, first.patient.mrn);
      assert.equal(ws.header.gender, "FEMALE");
      assert.equal(ws.header.age.years >= 30, true);
      assert.equal(ws.header.visitStatus, "ACTIVE");
      assert.match(ws.header.encounterNumber, /^OPD-/);
      assert.equal(ws.allergies[0].allergen, "Aspirin");
      assert.equal(ws.latestVitals.PULSE.value, "88");
      assert.equal(ws.previousVisits.length, 1);
      assert.equal(ws.previousVisits[0].chiefComplaint, COMPLAINT.chiefComplaint);
      assert.deepEqual(ws.previousVisits[0].diagnoses, ["Acute bronchitis"]);
      assert.equal(ws.consultation.document, null);
      assert.equal((await t.api("get", `/encounters/${second.encounterId}/workspace`, rec.token)).status, 403, "reception has no clinical access");
      assert.equal((await t.api("get", `/encounters/${second.encounterId}/workspace`, nurse.token)).status, 403, "nurses do not hold CONSULTATION_READ");
    });
  });

  // ───────────────────────── audit trail ─────────────────────────
  it("the audit trail attributes every clinical step to the right user and facility without storing clinical text", async () => {
    const v = await signed();
    await t.api("post", `/consultations/none`, v.doctor.token).send({});
    const events = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, actorUserId: v.doctor.userId, entityType: { in: ["ClinicalDocument", "Diagnosis", "MedicationOrder"] } }, orderBy: { createdAt: "asc" } });
    const actions = events.map((e) => e.action);
    for (const expected of ["CONSULTATION_STARTED", "DIAGNOSIS_RECORDED", "PRESCRIPTION_DRAFT_SAVED", "PRESCRIPTION_SIGNED", "CONSULTATION_SIGNED"]) assert.ok(actions.includes(expected), expected);
    assert.ok(events.every((e) => e.facilityId === a.facilityId && e.requestId));
    const blob = JSON.stringify(events.map((e) => e.metadata));
    assert.ok(!blob.includes("bronchitis") && !blob.includes("Fever") && !blob.includes("Paracetamol"), "no clinical content in audit metadata");
  });
});
