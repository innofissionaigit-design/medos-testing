import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localParts, zonedToUtc } from "../../common/time";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const IST = "Asia/Kolkata";
let seq = 0;
const code = (p: string) => `${p}${(++seq).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`.slice(0, 14);

describe("nursing: notes, tasks, MAR, intake/output, worklist", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let nurse: { id: string; token: string };
  let nurse2: { id: string; token: string };
  let doc: TestDoctor;

  const mkBed = async () => {
    const w = (await t.api("post", "/wards", a.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    const r = (await t.api("post", "/rooms", a.admin.token).send({ wardId: w.id, name: "Room", code: code("R") })).body.data;
    return (await t.api("post", "/beds", a.admin.token).send({ roomId: r.id, code: code("B"), dailyRate: "800" })).body.data as { id: string; code: string; wardId: string };
  };
  /** An admitted patient (own bed) with the given consultant. */
  const admitted = async (consultant: TestDoctor = doc) => {
    const bed = await mkBed();
    const patient = await registerPatient(t, rec.token);
    const r = await t.api("post", "/admissions", rec.token).send({ patientId: patient.id, consultantId: consultant.practitionerId, bedId: bed.id, reason: "Acute illness needing inpatient care" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient, bed, adm: r.body.data as { id: string; encounterId: string; admissionNumber: string } };
  };
  const item = (generic: string, frequency: string, o: Record<string, unknown> = {}) =>
    ({ genericName: generic, strength: "500 mg", dosage: "1 unit", route: "ORAL", frequency, ...(frequency === "OTHER" ? { frequencyText: "Every 36 hours" } : {}), ...o });
  /** A signed inpatient prescription with the given lines. */
  const signedOrder = async (encounterId: string, items: Record<string, unknown>[], doctor: TestDoctor = doc) => {
    const save = await t.api("put", `/encounters/${encounterId}/prescription`, doctor.token).send({ items });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    const sign = await t.api("post", `/encounters/${encounterId}/prescription/sign`, doctor.token).send({});
    assert.equal(sign.status, 200, JSON.stringify(sign.body));
    return sign.body.data as { id: string; items: { id: string; genericName: string; frequency: string }[] };
  };
  const generate = (admId: string, hours = 48, tok = nurse.token) => t.api("post", `/admissions/${admId}/mar/generate`, tok).send({ hours });
  const slots = async (admId: string) => t.prisma.medicationAdministration.findMany({ where: { admissionId: admId }, orderBy: { scheduledAt: "asc" } });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("nur-a");
    b = await t.makeTenant("nur-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    nurse = await t.makeUser(a, ["NURSE"]);
    nurse2 = await t.makeUser(a, ["NURSE"]);
    doc = await makeDoctor(t, a);
  });
  after(async () => { await t.close(); });

  // ───────────────────────── notes ─────────────────────────
  describe("nursing notes", () => {
    it("adds attributable, timestamped notes shown chronologically with addenda beneath the original", async () => {
      const { adm } = await admitted();
      const n1 = await t.api("post", `/admissions/${adm.id}/notes`, nurse.token).send({ note: "Patient comfortable. Pain score 3/10." });
      assert.equal(n1.status, 201);
      assert.equal(n1.body.data.authorId, nurse.id);
      assert.ok(n1.body.data.authorName);
      await t.api("post", `/admissions/${adm.id}/notes`, nurse2.token).send({ note: "Ambulated with assistance." });
      const add = await t.api("post", `/nursing-notes/${n1.body.data.id}/addendum`, nurse2.token).send({ note: "Correction: pain score was 4/10 at 14:00." });
      assert.equal(add.status, 201);
      assert.equal(add.body.data.addendumOfId, n1.body.data.id);
      const list = (await t.api("get", `/admissions/${adm.id}/notes`, doc.token)).body.data;
      assert.equal(list.length, 2, "addenda are grouped under their original");
      assert.equal(list[0].note, "Patient comfortable. Pain score 3/10.", "the original text is unchanged");
      assert.equal(list[0].addenda[0].note, "Correction: pain score was 4/10 at 14:00.");
      assert.ok(new Date(list[0].createdAt) <= new Date(list[1].createdAt));
      assert.equal((await t.api("post", `/nursing-notes/${add.body.data.id}/addendum`, nurse.token).send({ note: "Addendum of addendum" })).status, 409);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "NURSING_NOTE_ADDENDUM", actorUserId: nurse2.id } }));
    });

    it("notes are append-only: no edit route, and the database refuses edits and deletes", async () => {
      const { adm } = await admitted();
      const n = (await t.api("post", `/admissions/${adm.id}/notes`, nurse.token).send({ note: "Vitals stable overnight." })).body.data;
      for (const m of ["put", "patch", "delete"] as const) assert.equal((await t.api(m, `/nursing-notes/${n.id}`, nurse.token).send({ note: "Tampered" })).status, 404);
      await assert.rejects(() => t.prisma.nursingNote.update({ where: { id: n.id }, data: { note: "Tampered" } }), /cannot be edited/);
      await assert.rejects(() => t.prisma.nursingNote.update({ where: { id: n.id }, data: { authorId: rec.id } }), /cannot be edited/);
      await assert.rejects(() => t.prisma.nursingNote.delete({ where: { id: n.id } }), /append-only/);
      await assert.rejects(() => t.prisma.nursingNote.update({ where: { id: n.id }, data: { status: "ENTERED_IN_ERROR" } }), /Invalid nursing note status change/);
    });

    it("entered-in-error keeps the note visible only on request, needs a reason and the author or a doctor", async () => {
      const { adm } = await admitted();
      const n = (await t.api("post", `/admissions/${adm.id}/notes`, nurse.token).send({ note: "Wrong patient charted here." })).body.data;
      assert.equal((await t.api("post", `/nursing-notes/${n.id}/enter-in-error`, nurse.token).send({})).status, 400);
      assert.equal((await t.api("post", `/nursing-notes/${n.id}/enter-in-error`, nurse2.token).send({ reason: "Charted on wrong patient" })).status, 403, "another nurse cannot");
      const ok = await t.api("post", `/nursing-notes/${n.id}/enter-in-error`, nurse.token).send({ reason: "Charted on wrong patient" });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.status, "ENTERED_IN_ERROR");
      assert.equal((await t.api("get", `/admissions/${adm.id}/notes`, nurse.token)).body.data.length, 0);
      const all = (await t.api("get", `/admissions/${adm.id}/notes`, nurse.token).query({ includeErrors: "true" })).body.data;
      assert.equal(all[0].note, "Wrong patient charted here.", "history preserved");
      assert.equal((await t.api("post", `/nursing-notes/${n.id}/enter-in-error`, nurse.token).send({ reason: "Once more please" })).status, 409);
    });

    it("permissions, validation and isolation", async () => {
      const { adm } = await admitted();
      const body = { note: "Routine round completed." };
      assert.equal((await t.api("post", `/admissions/${adm.id}/notes`, doc.token).send(body)).status, 403, "doctors read nursing notes; they do not author them");
      assert.equal((await t.api("post", `/admissions/${adm.id}/notes`, rec.token).send(body)).status, 403);
      assert.equal((await t.api("get", `/admissions/${adm.id}/notes`, doc.token)).status, 200);
      assert.equal((await t.api("get", `/admissions/${adm.id}/notes`, rec.token)).status, 403);
      for (const bad of [{ note: "x" }, { note: "x".repeat(4001) }, { ...body, authorId: rec.id }, { ...body, status: "ACTIVE" }, {}]) assert.equal((await t.api("post", `/admissions/${adm.id}/notes`, nurse.token).send(bad)).status, 400);
      const bNurse = await t.makeUser(b, ["NURSE"]);
      assert.equal((await t.api("post", `/admissions/${adm.id}/notes`, bNurse.token).send(body)).status, 404);
      assert.equal((await t.api("get", `/admissions/${adm.id}/notes`, bNurse.token)).status, 404);
      const f2 = await t.makeUser(a, ["NURSE"], { facilityIds: [a.facility2Id] });
      assert.equal((await t.api("get", `/admissions/${adm.id}/notes`, f2.token)).status, 404);
      await t.api("post", `/admissions/${adm.id}/cancel`, rec.token).send({ reason: "Admitted by mistake" });
      assert.equal((await t.api("post", `/admissions/${adm.id}/notes`, nurse.token).send(body)).status, 409, "no new notes once the admission is closed");
      assert.equal((await t.api("get", `/admissions/${adm.id}/notes`, nurse.token)).status, 200, "history stays readable");
    });
  });

  // ───────────────────────── tasks ─────────────────────────
  describe("nursing tasks", () => {
    it("creates, completes and cancels tasks once; closed tasks are frozen", async () => {
      const { adm } = await admitted();
      const due = new Date(Date.now() + 3600_000).toISOString();
      const t1 = await t.api("post", `/admissions/${adm.id}/tasks`, nurse.token).send({ type: "VITALS", title: "Check BP and pulse", dueAt: due, assignedToId: nurse2.id });
      assert.equal(t1.status, 201);
      assert.equal(t1.body.data.status, "PENDING");
      const done = await t.api("post", `/tasks/${t1.body.data.id}/complete`, nurse2.token).send({ note: "BP 120/80" });
      assert.equal(done.body.data.status, "DONE");
      assert.equal(done.body.data.completedById, nurse2.id);
      assert.equal((await t.api("post", `/tasks/${t1.body.data.id}/complete`, nurse2.token).send({})).status, 409);
      assert.equal((await t.api("post", `/tasks/${t1.body.data.id}/cancel`, nurse2.token).send({ reason: "Late cancel" })).status, 409);
      const t2 = (await t.api("post", `/admissions/${adm.id}/tasks`, nurse.token).send({ title: "Change dressing", dueAt: due })).body.data;
      assert.equal((await t.api("post", `/tasks/${t2.id}/cancel`, nurse.token).send({})).status, 400);
      assert.equal((await t.api("post", `/tasks/${t2.id}/cancel`, nurse.token).send({ reason: "Done by surgical team" })).body.data.status, "CANCELLED");
      await assert.rejects(() => t.prisma.nursingTask.update({ where: { id: t1.body.data.id }, data: { status: "PENDING" } }), /closed task cannot be changed/);
      await assert.rejects(() => t.prisma.nursingTask.delete({ where: { id: t2.id } }), /append-only/);
      const t3 = (await t.api("post", `/admissions/${adm.id}/tasks`, nurse.token).send({ title: "Fluid chart review", dueAt: due })).body.data;
      await assert.rejects(() => t.prisma.nursingTask.update({ where: { id: t3.id }, data: { title: "Different task" } }), /Task details cannot be changed/);
      assert.equal((await t.api("get", `/admissions/${adm.id}/tasks`, doc.token)).body.data.length, 3);
    });

    it("validates assignees, titles and dates; enforces permissions and isolation", async () => {
      const { adm } = await admitted();
      const due = new Date(Date.now() + 3600_000).toISOString();
      const bNurse = await t.makeUser(b, ["NURSE"]);
      for (const bad of [{ title: "x", dueAt: due }, { title: "Valid title", dueAt: "tomorrow" }, { title: "Valid title" }, { title: "Valid title", dueAt: due, assignedToId: bNurse.id }, { title: "Valid title", dueAt: due, assignedToId: randomUUID() }, { title: "Valid title", dueAt: due, status: "DONE" }, { title: "Valid title", dueAt: due, type: "SURGERY" }]) {
        assert.equal((await t.api("post", `/admissions/${adm.id}/tasks`, nurse.token).send(bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await t.api("post", `/admissions/${adm.id}/tasks`, rec.token).send({ title: "Valid title", dueAt: due })).status, 403);
      const tk = (await t.api("post", `/admissions/${adm.id}/tasks`, nurse.token).send({ title: "Valid title", dueAt: due })).body.data;
      assert.equal((await t.api("post", `/tasks/${tk.id}/complete`, bNurse.token).send({})).status, 404);
      assert.equal((await t.api("get", `/admissions/${adm.id}/tasks`, bNurse.token)).status, 404);
    });
  });

  // ───────────────────────── MAR ─────────────────────────
  describe("medication administration record", () => {
    it("the doctor's order and the nurse's administration are distinct: ordering creates no administration", async () => {
      const { adm } = await admitted();
      const order = await signedOrder(adm.encounterId, [item("Ceftriaxone", "BD")]);
      assert.equal(order.items.length, 1);
      assert.equal(await t.prisma.medicationAdministration.count({ where: { admissionId: adm.id } }), 0, "a prescription is not an administration");
      const mar = await t.api("get", `/admissions/${adm.id}/mar`, nurse.token);
      assert.deepEqual(mar.body.data, []);
      const g = await generate(adm.id);
      assert.equal(g.status, 200);
      const rows = await slots(adm.id);
      assert.ok(rows.every((r) => r.status === "DUE" && r.administeredAt === null && r.administeredById === null));
    });

    it("generates slots from the frequency: OD, BD, TDS, QID, HS, STAT; none for SOS/OTHER; stopped items excluded", async () => {
      const { adm } = await admitted();
      const order = await signedOrder(adm.encounterId, [item("DrugOD", "OD"), item("DrugBD", "BD"), item("DrugTDS", "TDS"), item("DrugQID", "QID"), item("DrugHS", "HS"), item("DrugSTAT", "STAT"), item("DrugSOS", "SOS"), item("DrugOTH", "OTHER"), item("DrugStopped", "BD")]);
      const stopped = order.items.find((i) => i.genericName === "DrugStopped")!;
      assert.equal((await t.api("post", `/medication-order-items/${stopped.id}/stop`, doc.token).send({ reason: "Not needed" })).status, 200);
      const g = await generate(adm.id, 48);
      const rows = await slots(adm.id);
      const count = (name: string) => rows.filter((r) => order.items.find((i) => i.id === r.medicationOrderItemId)?.genericName === name).length;
      assert.deepEqual(["DrugOD", "DrugBD", "DrugTDS", "DrugQID", "DrugHS", "DrugSTAT", "DrugSOS", "DrugOTH", "DrugStopped"].map(count), [2, 4, 6, 8, 2, 1, 0, 0, 0]);
      assert.equal(g.body.data.created, 23);
      const bd = rows.filter((r) => order.items.find((i) => i.id === r.medicationOrderItemId)?.genericName === "DrugBD");
      const hhmm = bd.map((r) => { const p = localParts(r.scheduledAt, IST); return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; });
      assert.deepEqual([...new Set(hhmm)].sort(), ["09:00", "21:00"], "BD = 09:00 and 21:00 facility time");
      assert.equal((await generate(adm.id, 48)).body.data.created, 0, "idempotent");
    });

    it("concurrent schedule generation never duplicates a dose", async () => {
      const { adm } = await admitted();
      await signedOrder(adm.encounterId, [item("Metronidazole", "TDS")]);
      const rs = await Promise.all(Array.from({ length: 6 }, () => generate(adm.id, 48)));
      assert.ok(rs.every((r) => r.status === 200));
      assert.equal((await slots(adm.id)).length, 6);
      const times = (await slots(adm.id)).map((r) => r.scheduledAt.getTime());
      assert.equal(new Set(times).size, times.length);
    });

    it("respects the prescribed duration and never schedules before the order was signed", async () => {
      const { adm } = await admitted();
      await signedOrder(adm.encounterId, [item("Cefixime", "BD", { durationDays: 1 })]);
      await generate(adm.id, 72);
      const rows = await slots(adm.id);
      assert.equal(rows.length, 2, "1 day of BD = 2 doses");
      const order = await t.prisma.medicationOrder.findFirstOrThrow({ where: { encounterId: adm.encounterId } });
      assert.ok(rows.every((r) => r.scheduledAt >= order.signedAt! && r.scheduledAt.getTime() <= order.signedAt!.getTime() + 86_400_000));
      assert.equal((await t.api("post", `/admissions/${adm.id}/mar/generate`, nurse.token).send({ hours: 0 })).status, 400);
      assert.equal((await t.api("post", `/admissions/${adm.id}/mar/generate`, nurse.token).send({ hours: 100 })).status, 400);
    });

    it("records GIVEN with who and when; the dose cannot be recorded twice", async () => {
      const { adm } = await admitted();
      await signedOrder(adm.encounterId, [item("Pantoprazole", "STAT")]);
      await generate(adm.id);
      const [slot] = await slots(adm.id);
      const r = await t.api("post", `/mar/${slot!.id}/administer`, nurse.token).send({ status: "GIVEN" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.status, "GIVEN");
      assert.equal(r.body.data.administeredById, nurse.id);
      assert.ok(r.body.data.administeredAt);
      assert.equal(r.body.data.administeredByName, (await t.prisma.user.findFirstOrThrow({ where: { id: nurse.id } })).fullName);
      const again = await t.api("post", `/mar/${slot!.id}/administer`, nurse2.token).send({ status: "REFUSED", remarks: "Patient refused" });
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, "INVALID_STATE");
      assert.equal((await t.prisma.medicationAdministration.findFirstOrThrow({ where: { id: slot!.id } })).administeredById, nurse.id, "the first record stands");
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "MEDICATION_GIVEN", entityId: slot!.id } });
      assert.equal(evt.actorUserId, nurse.id);
      assert.equal(evt.facilityId, a.facilityId);
    });

    it("six nurses recording the same dose at once: exactly one wins", async () => {
      const { adm } = await admitted();
      await signedOrder(adm.encounterId, [item("Enoxaparin", "STAT")]);
      await generate(adm.id);
      const [slot] = await slots(adm.id);
      const nurses = await Promise.all(Array.from({ length: 5 }, () => t.makeUser(a, ["NURSE"])));
      const rs = await Promise.all([nurse, ...nurses].map((n) => t.api("post", `/mar/${slot!.id}/administer`, n.token).send({ status: "GIVEN" })));
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, entityId: slot!.id, action: { startsWith: "MEDICATION_" } } }), 1);
    });

    it("missed, held and refused doses need a reason; a dose that is not yet due cannot be missed or given far too early", async () => {
      const { adm } = await admitted();
      await signedOrder(adm.encounterId, [item("Vancomycin", "BD")]);
      await generate(adm.id);
      const future = (await slots(adm.id)).find((s) => s.scheduledAt.getTime() > Date.now() + 3 * 3_600_000)!;
      assert.equal((await t.api("post", `/mar/${future.id}/administer`, nurse.token).send({ status: "MISSED", remarks: "Patient asleep" })).status, 409, "not yet due");
      assert.equal((await t.api("post", `/mar/${future.id}/administer`, nurse.token).send({ status: "GIVEN" })).status, 400, "more than 2 hours early");
      assert.equal((await t.api("post", `/mar/${future.id}/administer`, nurse.token).send({ status: "HELD" })).status, 400, "reason required");
      assert.equal((await t.api("post", `/mar/${future.id}/administer`, nurse.token).send({ status: "REFUSED", remarks: "no" })).status, 400);
      const held = await t.api("post", `/mar/${future.id}/administer`, nurse.token).send({ status: "HELD", remarks: "BP low, doctor informed" });
      assert.equal(held.status, 200);
      assert.equal(held.body.data.status, "HELD");
      assert.equal(held.body.data.administeredAt, null);
      assert.equal(held.body.data.remarks, "BP low, doctor informed");
      assert.equal((await t.api("post", `/mar/${future.id}/administer`, nurse.token).send({ status: "GIVEN", administeredAt: new Date(Date.now() + 3_600_000).toISOString() })).status, 409);
      const past = await t.prisma.medicationAdministration.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: (await t.prisma.admission.findFirstOrThrow({ where: { id: adm.id } })).patientId, admissionId: adm.id, encounterId: adm.encounterId, medicationOrderItemId: future.medicationOrderItemId, scheduledAt: new Date(Date.now() - 3 * 3_600_000) } });
      const missed = await t.api("post", `/mar/${past.id}/administer`, nurse.token).send({ status: "MISSED", remarks: "Patient was in theatre" });
      assert.equal(missed.status, 200);
      assert.equal(missed.body.data.status, "MISSED");
      const bad = await t.api("post", `/mar/${future.id}/administer`, nurse.token).send({ status: "DUE" });
      assert.equal(bad.status, 400);
      assert.equal((await t.api("post", `/mar/${future.id}/administer`, nurse.token).send({ status: "GIVEN", dose: "double" })).status, 400);
    });

    it("a medicine the doctor has stopped cannot be given, but the nurse can record why it was held", async () => {
      const { adm } = await admitted();
      const order = await signedOrder(adm.encounterId, [item("Gentamicin", "STAT")]);
      await generate(adm.id);
      const [slot] = await slots(adm.id);
      await t.api("post", `/medication-order-items/${order.items[0]!.id}/stop`, doc.token).send({ reason: "Renal function worsening" });
      const g = await t.api("post", `/mar/${slot!.id}/administer`, nurse.token).send({ status: "GIVEN" });
      assert.equal(g.status, 409);
      assert.match(g.body.error.message, /stopped by the doctor/);
      assert.equal((await t.prisma.medicationAdministration.findFirstOrThrow({ where: { id: slot!.id } })).status, "DUE");
      assert.equal((await t.api("post", `/mar/${slot!.id}/administer`, nurse.token).send({ status: "HELD", remarks: "Order stopped by doctor" })).status, 200);
    });

    it("only nurses administer: doctors and reception cannot; other tenants and facilities cannot see the slot", async () => {
      const { adm } = await admitted();
      await signedOrder(adm.encounterId, [item("Ondansetron", "STAT")]);
      await generate(adm.id);
      const [slot] = await slots(adm.id);
      for (const u of [doc, rec]) assert.equal((await t.api("post", `/mar/${slot!.id}/administer`, u.token).send({ status: "GIVEN" })).status, 403);
      assert.equal((await generate(adm.id, 24, doc.token)).status, 403, "scheduling is a nursing action");
      assert.equal((await t.api("get", `/admissions/${adm.id}/mar`, doc.token)).status, 200, "doctors can review the MAR");
      const bNurse = await t.makeUser(b, ["NURSE"]);
      assert.equal((await t.api("post", `/mar/${slot!.id}/administer`, bNurse.token).send({ status: "GIVEN" })).status, 404);
      assert.equal((await t.api("get", `/admissions/${adm.id}/mar`, bNurse.token)).status, 404);
      assert.equal((await generate(adm.id, 24, bNurse.token)).status, 404);
      const f2 = await t.makeUser(a, ["NURSE"], { facilityIds: [a.facility2Id] });
      assert.equal((await t.api("post", `/mar/${slot!.id}/administer`, f2.token).send({ status: "GIVEN" })).status, 404);
      assert.equal((await t.api("post", `/mar/${randomUUID()}/administer`, nurse.token).send({ status: "GIVEN" })).status, 404);
    });

    it("DATABASE: a recorded administration can never be changed or deleted; slot fields are immutable", async () => {
      const { adm } = await admitted();
      await signedOrder(adm.encounterId, [item("Tramadol", "STAT")]);
      await generate(adm.id);
      const [slot] = await slots(adm.id);
      await assert.rejects(() => t.prisma.medicationAdministration.update({ where: { id: slot!.id }, data: { scheduledAt: new Date(0) } }), /Schedule fields are immutable/);
      await assert.rejects(() => t.prisma.medicationAdministration.update({ where: { id: slot!.id }, data: { status: "GIVEN" } }), /mar_status_complete|check/i);
      await t.api("post", `/mar/${slot!.id}/administer`, nurse.token).send({ status: "GIVEN" });
      await assert.rejects(() => t.prisma.medicationAdministration.update({ where: { id: slot!.id }, data: { administeredById: nurse2.id } }), /cannot be changed/);
      await assert.rejects(() => t.prisma.medicationAdministration.update({ where: { id: slot!.id }, data: { status: "DUE", administeredAt: null, administeredById: null } }), /cannot be changed/);
      await assert.rejects(() => t.prisma.medicationAdministration.delete({ where: { id: slot!.id } }), /cannot be deleted/);
      const admRow = await t.prisma.admission.findFirstOrThrow({ where: { id: adm.id } });
      await assert.rejects(() => t.prisma.medicationAdministration.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: admRow.patientId, admissionId: adm.id, encounterId: adm.encounterId, medicationOrderItemId: slot!.medicationOrderItemId, scheduledAt: slot!.scheduledAt } }), /Unique|unique/);
    });

    it("PRN: as-needed (SOS) medicines are given outside the schedule and recorded as such; scheduled drugs are refused", async () => {
      const { adm } = await admitted();
      const order = await signedOrder(adm.encounterId, [item("Paracetamol", "SOS"), item("Amlodipine", "OD")]);
      const sos = order.items.find((i) => i.genericName === "Paracetamol")!;
      const od = order.items.find((i) => i.genericName === "Amlodipine")!;
      const r = await t.api("post", `/admissions/${adm.id}/mar/unscheduled`, nurse.token).send({ medicationOrderItemId: sos.id, remarks: "Fever 38.9 C" });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.status, "GIVEN");
      assert.equal(r.body.data.unscheduled, true);
      assert.equal((await t.api("post", `/admissions/${adm.id}/mar/unscheduled`, nurse.token).send({ medicationOrderItemId: od.id })).status, 409);
      assert.equal((await t.api("post", `/admissions/${adm.id}/mar/unscheduled`, nurse.token).send({ medicationOrderItemId: randomUUID() })).status, 404);
      assert.equal((await t.api("post", `/admissions/${adm.id}/mar/unscheduled`, nurse.token).send({ medicationOrderItemId: sos.id, administeredAt: new Date(Date.now() + 3_600_000).toISOString() })).status, 400);
      assert.equal((await t.api("post", `/admissions/${adm.id}/mar/unscheduled`, doc.token).send({ medicationOrderItemId: sos.id })).status, 403);
      await t.api("post", `/medication-order-items/${sos.id}/stop`, doc.token).send({ reason: "Switched to scheduled dosing" });
      assert.equal((await t.api("post", `/admissions/${adm.id}/mar/unscheduled`, nurse.token).send({ medicationOrderItemId: sos.id })).status, 409);
    });

    it("the due list shows overdue doses first with patient and bed, filterable by ward", async () => {
      const x = await admitted();
      const y = await admitted();
      const oX = await signedOrder(x.adm.encounterId, [item("Heparin", "OTHER")]);
      const oY = await signedOrder(y.adm.encounterId, [item("Insulin", "OTHER")]);
      const mk = (adm: { id: string; encounterId: string }, patientId: string, itemId: string, minutes: number) =>
        t.prisma.medicationAdministration.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId, admissionId: adm.id, encounterId: adm.encounterId, medicationOrderItemId: itemId, scheduledAt: new Date(Date.now() + minutes * 60_000) } });
      await mk(x.adm, x.patient.id, oX.items[0]!.id, -90);
      await mk(y.adm, y.patient.id, oY.items[0]!.id, 20);
      await mk(y.adm, y.patient.id, oY.items[0]!.id, 300);
      const due = (await t.api("get", "/mar/due", nurse.token).query({ withinMinutes: 60 })).body.data as { admissionId: string; overdue: boolean; bed: string; patientName: string; mrn: string }[];
      const mine = due.filter((d) => [x.adm.id, y.adm.id].includes(d.admissionId));
      assert.equal(mine.length, 2, "the dose 5 hours away is not due yet");
      assert.equal(mine[0]!.admissionId, x.adm.id);
      assert.equal(mine[0]!.overdue, true);
      assert.equal(mine[1]!.overdue, false);
      assert.equal(mine[0]!.bed, x.bed.code);
      assert.equal(mine[0]!.mrn, x.patient.mrn);
      const ward = (await t.api("get", "/mar/due", nurse.token).query({ withinMinutes: 60, wardId: y.bed.wardId })).body.data as { admissionId: string }[];
      assert.ok(ward.every((d) => d.admissionId === y.adm.id) && ward.length === 1);
      assert.equal((await t.api("get", "/mar/due", rec.token)).status, 403);
      assert.equal((await t.api("get", "/mar/due", nurse.token).query({ withinMinutes: 5000 })).status, 400);
      const bNurse = await t.makeUser(b, ["NURSE"]);
      assert.equal((await t.api("get", "/mar/due", bNurse.token)).body.data.length, 0);
    });
  });

  // ───────────────────────── intake / output ─────────────────────────
  describe("intake and output", () => {
    it("records intake and output with type, amount, time and user; invalid combinations are rejected", async () => {
      const { adm } = await admitted();
      const post = (body: Record<string, unknown>, tok = nurse.token) => t.api("post", `/admissions/${adm.id}/intake-output`, tok).send(body);
      const r = await post({ direction: "INTAKE", category: "IV", amount: 500 });
      assert.equal(r.status, 201);
      assert.equal(r.body.data.amount, "500.0");
      assert.equal(r.body.data.recordedById, nurse.id);
      assert.equal((await post({ direction: "OUTPUT", category: "URINE", amount: 250.5 })).body.data.amount, "250.5");
      for (const [label, bad] of [
        ["intake with output category", { direction: "INTAKE", category: "URINE", amount: 100 }], ["output with intake category", { direction: "OUTPUT", category: "ORAL", amount: 100 }],
        ["zero", { direction: "INTAKE", category: "ORAL", amount: 0 }], ["negative", { direction: "INTAKE", category: "ORAL", amount: -5 }], ["too large", { direction: "INTAKE", category: "IV", amount: 20_001 }],
        ["two decimals", { direction: "INTAKE", category: "ORAL", amount: 10.25 }], ["text", { direction: "INTAKE", category: "ORAL", amount: "100" }], ["unknown category", { direction: "INTAKE", category: "ENEMA", amount: 5 }],
        ["future", { direction: "INTAKE", category: "ORAL", amount: 5, recordedAt: new Date(Date.now() + 3_600_000).toISOString() }],
        ["before admission", { direction: "INTAKE", category: "ORAL", amount: 5, recordedAt: new Date(Date.now() - 86_400_000).toISOString() }],
        ["unit injection", { direction: "INTAKE", category: "ORAL", amount: 5, unit: "litres" }],
      ] as [string, Record<string, unknown>][]) assert.equal((await post(bad)).status, 400, label);
      assert.equal((await post({ direction: "INTAKE", category: "ORAL", amount: 100 }, doc.token)).status, 403);
      assert.equal((await post({ direction: "INTAKE", category: "ORAL", amount: 100 }, rec.token)).status, 403);
      assert.equal((await t.api("get", `/admissions/${adm.id}/intake-output`, doc.token)).body.data.length, 2);
    });

    it("computes exact daily (06:00-06:00) and per-shift totals with a decimal-safe balance", async () => {
      const { adm, patient } = await admitted();
      const yesterday = localParts(new Date(Date.now() - 86_400_000), IST).dateStr;
      const nextDay = localParts(new Date(Date.now()), IST).dateStr;
      const at = (date: string, h: number, m = 0) => zonedToUtc(date, h * 60 + m, IST);
      const seed = (direction: "INTAKE" | "OUTPUT", category: string, amount: string, when: Date) =>
        t.prisma.intakeOutput.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: patient.id, admissionId: adm.id, direction, category: category as "ORAL", amount, recordedAt: when, recordedById: nurse.id } });
      await seed("INTAKE", "ORAL", "200.1", at(yesterday, 7));
      await seed("INTAKE", "IV", "500.2", at(yesterday, 9));
      await seed("OUTPUT", "URINE", "300.3", at(yesterday, 12));
      await seed("INTAKE", "IV", "1000", at(yesterday, 15));
      await seed("OUTPUT", "DRAIN", "50.5", at(yesterday, 18));
      await seed("INTAKE", "ORAL", "250", at(yesterday, 23));
      await seed("OUTPUT", "URINE", "400", at(nextDay, 2));
      await seed("INTAKE", "ORAL", "999", at(yesterday, 5, 59));
      await seed("INTAKE", "ORAL", "888", at(nextDay, 6));
      const err = await seed("INTAKE", "ORAL", "777", at(yesterday, 10));
      await t.prisma.intakeOutput.update({ where: { id: err.id }, data: { status: "ENTERED_IN_ERROR", errorReason: "Wrong patient", errorById: nurse.id, errorAt: new Date() } });
      const r = (await t.api("get", `/admissions/${adm.id}/intake-output/totals`, doc.token).query({ date: yesterday })).body.data;
      assert.equal(r.daily.intake, "1950.3");
      assert.equal(r.daily.output, "750.8");
      assert.equal(r.daily.balance, "1199.5");
      assert.equal(r.daily.byCategory.IV, "1500.2");
      const by = Object.fromEntries(r.shifts.map((s: { shift: string }) => [s.shift, s]));
      assert.deepEqual([by.MORNING.intake, by.MORNING.output, by.MORNING.balance], ["700.3", "300.3", "400.0"]);
      assert.deepEqual([by.EVENING.intake, by.EVENING.output, by.EVENING.balance], ["1000.0", "50.5", "949.5"]);
      assert.deepEqual([by.NIGHT.intake, by.NIGHT.output, by.NIGHT.balance], ["250.0", "400.0", "-150.0"], "night shift spans midnight into the next calendar day");
      assert.equal(by.MORNING.label, "06:00-14:00");
      assert.equal(r.window.from, at(yesterday, 6).toISOString());
      assert.equal((await t.api("get", `/admissions/${adm.id}/intake-output/totals`, doc.token).query({ date: "2026-02-30" })).status, 400);
      assert.equal((await t.api("get", `/admissions/${adm.id}/intake-output/totals`, rec.token).query({ date: yesterday })).status, 403);
    });

    it("entered-in-error entries leave the totals but stay on record; the database makes entries immutable", async () => {
      const { adm } = await admitted();
      const e = (await t.api("post", `/admissions/${adm.id}/intake-output`, nurse.token).send({ direction: "INTAKE", category: "ORAL", amount: 300 })).body.data;
      const today = localParts(new Date(), IST).dateStr;
      const before = (await t.api("get", `/admissions/${adm.id}/intake-output/totals`, nurse.token).query({ date: today })).body.data;
      assert.ok(before.daily.intake === "300.0" || before.daily.intake === "0.0", "falls in today's or yesterday's I/O day depending on the clock");
      assert.equal((await t.api("post", `/intake-output/${e.id}/enter-in-error`, nurse.token).send({})).status, 400);
      const ok = await t.api("post", `/intake-output/${e.id}/enter-in-error`, nurse.token).send({ reason: "Charted on wrong patient" });
      assert.equal(ok.body.data.status, "ENTERED_IN_ERROR");
      assert.equal((await t.api("post", `/intake-output/${e.id}/enter-in-error`, nurse.token).send({ reason: "Once more please" })).status, 409);
      assert.equal((await t.api("get", `/admissions/${adm.id}/intake-output`, nurse.token)).body.data.length, 1, "kept on record");
      await assert.rejects(() => t.prisma.intakeOutput.update({ where: { id: e.id }, data: { amount: 5 } }), /cannot be modified/);
      await assert.rejects(() => t.prisma.intakeOutput.delete({ where: { id: e.id } }), /append-only/);
      const admRow2 = await t.prisma.admission.findFirstOrThrow({ where: { id: adm.id } });
      await assert.rejects(() => t.prisma.intakeOutput.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: admRow2.patientId, admissionId: adm.id, direction: "INTAKE", category: "URINE", amount: 5, recordedById: nurse.id } }), /io_category_matches_direction|check/i);
      const bNurse = await t.makeUser(b, ["NURSE"]);
      assert.equal((await t.api("post", `/intake-output/${e.id}/enter-in-error`, bNurse.token).send({ reason: "Cross tenant attempt" })).status, 404);
      assert.equal((await t.api("get", `/admissions/${adm.id}/intake-output/totals`, bNurse.token).query({ date: today })).status, 404);
    });
  });

  // ───────────────────────── worklist ─────────────────────────
  describe("nurse worklist", () => {
    it("shows each current patient with bed, doctor, tasks, medication due, allergies and vitals due on one screen", async () => {
      const x = await admitted();
      const y = await admitted();
      const oX = await signedOrder(x.adm.encounterId, [item("Aztreonam", "OTHER")]);
      await t.prisma.medicationAdministration.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: x.patient.id, admissionId: x.adm.id, encounterId: x.adm.encounterId, medicationOrderItemId: oX.items[0]!.id, scheduledAt: new Date(Date.now() - 2 * 3_600_000) } });
      await t.api("post", `/admissions/${x.adm.id}/tasks`, nurse.token).send({ title: "Review drain output", dueAt: new Date(Date.now() - 600_000).toISOString() });
      await t.api("post", `/admissions/${x.adm.id}/tasks`, nurse.token).send({ title: "Mobilise patient", dueAt: new Date(Date.now() + 7_200_000).toISOString() });
      await t.api("post", `/patients/${x.patient.id}/allergies`, nurse.token).send({ allergen: "Latex", type: "OTHER", severity: "MODERATE" });
      await t.api("post", `/encounters/${y.adm.encounterId}/observations`, nurse.token).send({ observations: [{ type: "PULSE", value: 80 }] });
      const wl = (await t.api("get", "/nursing/worklist", nurse.token)).body.data as Record<string, unknown>[];
      const rx = wl.find((r) => r["admissionId"] === x.adm.id)!;
      const ry = wl.find((r) => r["admissionId"] === y.adm.id)!;
      assert.equal(rx["bed"], x.bed.code);
      assert.equal(rx["mrn"], x.patient.mrn);
      assert.equal(rx["doctor"], (await t.prisma.practitioner.findFirstOrThrow({ where: { id: doc.practitionerId } })).displayName);
      assert.equal(rx["pendingTasks"], 2);
      assert.equal(rx["overdueTasks"], 1);
      assert.equal(rx["medicationDue"], 1);
      assert.equal(rx["medicationOverdue"], 1);
      assert.equal(rx["hasAllergies"], true);
      assert.equal(rx["vitalsDue"], true, "no vitals recorded yet");
      assert.equal(ry["vitalsDue"], false, "vitals taken just now");
      assert.equal(ry["hasAllergies"], false);
      assert.ok(wl.indexOf(rx) < wl.indexOf(ry), "patients with overdue medication come first");
      const ward = (await t.api("get", "/nursing/worklist", nurse.token).query({ wardId: y.bed.wardId })).body.data as { admissionId: string }[];
      assert.deepEqual(ward.map((r) => r.admissionId), [y.adm.id]);
      assert.equal((await t.api("get", "/nursing/worklist", doc.token)).status, 200);
      assert.equal((await t.api("get", "/nursing/worklist", rec.token)).status, 403);
      assert.equal((await t.api("get", "/nursing/worklist")).status, 401);
    });

    it("only current admissions of this tenant and facility appear", async () => {
      const x = await admitted();
      await t.api("post", `/admissions/${x.adm.id}/cancel`, rec.token).send({ reason: "Admitted by mistake" });
      const bNurse = await t.makeUser(b, ["NURSE"]);
      assert.ok(!(await t.api("get", "/nursing/worklist", nurse.token)).body.data.some((r: { admissionId: string }) => r.admissionId === x.adm.id));
      const live = await admitted();
      assert.equal((await t.api("get", "/nursing/worklist", bNurse.token)).body.data.length, 0);
      const f2 = await t.makeUser(a, ["NURSE"], { facilityIds: [a.facility2Id] });
      assert.ok(!(await t.api("get", "/nursing/worklist", f2.token)).body.data.some((r: { admissionId: string }) => r.admissionId === live.adm.id));
    });
  });

  it("IPD vitals, notes, MAR and I/O all hang off the same admission encounter and are audited", async () => {
    const { adm } = await admitted();
    const v = await t.api("post", `/encounters/${adm.encounterId}/observations`, nurse.token).send({ observations: [{ type: "SYSTOLIC_BP", value: 118 }, { type: "DIASTOLIC_BP", value: 76 }] });
    assert.equal(v.status, 201);
    await t.api("post", `/admissions/${adm.id}/notes`, nurse.token).send({ note: "Shift handover done." });
    const evts = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, actorUserId: nurse.id, action: { in: ["VITALS_RECORDED", "NURSING_NOTE_ADDED"] }, facilityId: a.facilityId } });
    assert.ok(evts.length >= 2 && evts.every((e) => e.requestId));
    assert.equal(await t.prisma.observation.count({ where: { encounterId: adm.encounterId } }), 2);
  });
});
