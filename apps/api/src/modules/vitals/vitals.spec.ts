import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Decimal } from "@medos/shared";
import { makeDoctor, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { bmi, fahrenheitToCelsius, inRange } from "./vitals.domain";

describe("vitals domain maths", () => {
  it("computes BMI half-up to one decimal and refuses nonsense inputs", () => {
    assert.equal(bmi(70, 175)?.toString(), "22.9");
    assert.equal(bmi("85.5", "162")?.toString(), "32.6");
    assert.equal(bmi(0, 170), null);
    assert.equal(bmi(70, 0), null);
    assert.equal(bmi(400, 20), null, "result outside the physiological range is dropped");
  });
  it("converts Fahrenheit exactly with decimal arithmetic", () => {
    assert.equal(fahrenheitToCelsius(98.6).toString(), "37");
    assert.equal(fahrenheitToCelsius(100.4).toString(), "38");
    assert.equal(fahrenheitToCelsius("102.2").toString(), "39");
    assert.equal(fahrenheitToCelsius(99.1).toString(), "37.28");
  });
  it("range checks are inclusive at the boundaries", () => {
    assert.ok(inRange("PULSE", 20) && inRange("PULSE", 250));
    assert.ok(!inRange("PULSE", 19.99) && !inRange("PULSE", 250.01));
    assert.ok(inRange("SPO2", new Decimal(100)) && !inRange("SPO2", 101));
  });
});

describe("vitals recording", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let doc: TestDoctor;
  let nurse: { id: string; token: string };

  const record = (token: string, encounterId: string, observations: unknown) => t.api("post", `/encounters/${encounterId}/observations`, token).send({ observations });
  const fresh = async () => {
    const p = await registerPatient(t, rec.token);
    const d = await makeDoctor(t, a);
    return { p, d, v: await startVisit(t, rec.token, d, p.id) };
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("vit-a");
    b = await t.makeTenant("vit-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
    nurse = await t.makeUser(a, ["NURSE"]);
  });
  after(async () => { await t.close(); });

  it("records a full set of vitals with canonical units, author and timestamp", async () => {
    const { v } = await fresh();
    const r = await record(nurse.token, v.encounterId, [
      { type: "SYSTOLIC_BP", value: 128 }, { type: "DIASTOLIC_BP", value: 82 }, { type: "PULSE", value: 76 },
      { type: "RESPIRATORY_RATE", value: 16 }, { type: "TEMPERATURE", value: 37.2 }, { type: "SPO2", value: 98 }, { type: "BLOOD_GLUCOSE", value: 104.5 },
    ]);
    assert.equal(r.status, 201);
    const latest = r.body.data.latest;
    assert.equal(latest.SYSTOLIC_BP.value, "128");
    assert.equal(latest.SYSTOLIC_BP.unit, "mmHg");
    assert.equal(latest.TEMPERATURE.unit, "°C");
    assert.equal(latest.BLOOD_GLUCOSE.value, "104.5");
    assert.equal(latest.PULSE.recordedById, nurse.id);
    assert.ok(latest.PULSE.recordedByName.startsWith("Synthetic"));
    assert.equal(r.body.data.items.length, 7);
    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "VITALS_RECORDED", entityId: v.encounterId } });
    assert.equal(evt.actorUserId, nurse.id);
    assert.ok(!JSON.stringify(evt.metadata).includes("128"), "audit holds measurement types, not clinical values");
  });

  it("converts Fahrenheit to Celsius and derives BMI from weight and height", async () => {
    const { v } = await fresh();
    const r = await record(doc.token, v.encounterId, [{ type: "TEMPERATURE", value: 101.3, unit: "F" }, { type: "WEIGHT", value: 70 }, { type: "HEIGHT", value: 175 }]);
    assert.equal(r.status, 201);
    assert.equal(r.body.data.latest.TEMPERATURE.value, "38.5");
    assert.equal(r.body.data.latest.BMI.value, "22.9");
    assert.equal(r.body.data.latest.BMI.derived, true);
  });

  it("uses the patient's most recent height for BMI on later visits, and skips BMI when height is unknown", async () => {
    const p = await registerPatient(t, rec.token);
    const d = await makeDoctor(t, a);
    const v1 = await startVisit(t, rec.token, d, p.id);
    const noHeight = await record(nurse.token, v1.encounterId, [{ type: "WEIGHT", value: 60 }]);
    assert.equal(noHeight.body.data.latest.BMI, undefined);
    await record(nurse.token, v1.encounterId, [{ type: "HEIGHT", value: 160 }]);
    await t.api("post", `/queue/${v1.queueId}/start`, d.token);
    await t.api("post", `/queue/${v1.queueId}/complete`, d.token);
    const v2 = await startVisit(t, rec.token, d, p.id);
    const r = await record(nurse.token, v2.encounterId, [{ type: "WEIGHT", value: 64 }]);
    assert.equal(r.body.data.latest.BMI.value, "25", "64 / 1.6^2 using the earlier visit's height");
  });

  it("rejects impossible values, bad combinations and malformed entries", async () => {
    const { v } = await fresh();
    const cases: [string, unknown][] = [
      ["pulse too high", [{ type: "PULSE", value: 251 }]],
      ["pulse too low", [{ type: "PULSE", value: 19 }]],
      ["negative weight", [{ type: "WEIGHT", value: -5 }]],
      ["SpO2 over 100", [{ type: "SPO2", value: 100.5 }]],
      ["temperature 98 treated as Celsius", [{ type: "TEMPERATURE", value: 98.6 }]],
      ["DBP >= SBP", [{ type: "SYSTOLIC_BP", value: 120 }, { type: "DIASTOLIC_BP", value: 120 }]],
      ["duplicate type", [{ type: "PULSE", value: 70 }, { type: "PULSE", value: 71 }]],
      ["unit on non-temperature", [{ type: "PULSE", value: 70, unit: "C" }]],
      ["derived type written directly", [{ type: "BMI", value: 20 }]],
      ["unknown type", [{ type: "MOOD", value: 5 }]],
      ["string value", [{ type: "PULSE", value: "70" }]],
      ["NaN-ish value", [{ type: "PULSE", value: null }]],
      ["unknown field", [{ type: "PULSE", value: 70, recordedById: randomUUID() }]],
      ["empty list", []],
      ["future time", [{ type: "PULSE", value: 70, recordedAt: new Date(Date.now() + 3600_000).toISOString() }]],
      ["before visit", [{ type: "PULSE", value: 70, recordedAt: new Date(Date.now() - 86_400_000).toISOString() }]],
      ["too many", Array.from({ length: 13 }, () => ({ type: "PULSE", value: 70 }))],
    ];
    for (const [label, body] of cases) {
      const r = await record(nurse.token, v.encounterId, body);
      assert.equal(r.status, 400, label);
      assert.equal(r.body.error.code, "VALIDATION_FAILED", label);
    }
    assert.equal((await t.api("get", `/encounters/${v.encounterId}/observations`, nurse.token)).body.data.items.length, 0, "no partial writes");
    const boundary = await record(nurse.token, v.encounterId, [{ type: "PULSE", value: 20 }, { type: "SPO2", value: 100 }, { type: "TEMPERATURE", value: 45 }]);
    assert.equal(boundary.status, 201, "inclusive boundaries accepted");
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/observations`, nurse.token).send({ observations: [{ type: "PULSE", value: 70 }], encounterId: v.encounterId })).status, 400);
  });

  it("an all-or-nothing batch: one invalid reading rejects the whole entry", async () => {
    const { v } = await fresh();
    const r = await record(nurse.token, v.encounterId, [{ type: "PULSE", value: 70 }, { type: "SPO2", value: 140 }]);
    assert.equal(r.status, 400);
    assert.equal(await t.prisma.observation.count({ where: { encounterId: v.encounterId } }), 0);
  });

  it("only clinical roles can record or read; reception, cashier and pharmacy cannot", async () => {
    const { v } = await fresh();
    const cashier = await t.makeUser(a, ["CASHIER"]);
    const pharmacist = await t.makeUser(a, ["PHARMACIST"]);
    for (const u of [rec, cashier, pharmacist]) {
      assert.equal((await record(u.token, v.encounterId, [{ type: "PULSE", value: 70 }])).status, 403);
      assert.equal((await t.api("get", `/encounters/${v.encounterId}/observations`, u.token)).status, 403);
    }
    assert.equal((await record(doc.token, v.encounterId, [{ type: "PULSE", value: 70 }])).status, 201, "doctors may record where needed");
    assert.equal((await t.api("get", `/encounters/${v.encounterId}/observations`)).status, 401);
  });

  it("never overwrites: each recording is a new timestamped entry, newest wins in `latest`", async () => {
    const { v } = await fresh();
    await record(nurse.token, v.encounterId, [{ type: "PULSE", value: 70 }]);
    await record(nurse.token, v.encounterId, [{ type: "PULSE", value: 90 }]);
    const r = await t.api("get", `/encounters/${v.encounterId}/observations`, nurse.token);
    assert.equal(r.body.data.items.length, 2);
    assert.equal(r.body.data.latest.PULSE.value, "90");
    const times = r.body.data.items.map((i: { recordedAt: string }) => i.recordedAt);
    assert.deepEqual([...times].sort().reverse(), times, "newest first");
  });

  it("the database makes readings immutable and undeletable, and rejects impossible values even via raw SQL", async () => {
    const { v, p } = await fresh();
    await record(nurse.token, v.encounterId, [{ type: "PULSE", value: 70 }]);
    const row = await t.prisma.observation.findFirstOrThrow({ where: { encounterId: v.encounterId } });
    await assert.rejects(() => t.prisma.observation.update({ where: { id: row.id }, data: { value: 71 } }), /cannot be modified/);
    await assert.rejects(() => t.prisma.observation.update({ where: { id: row.id }, data: { status: "ENTERED_IN_ERROR" } }), /requires reason/);
    await assert.rejects(() => t.prisma.observation.delete({ where: { id: row.id } }), /append-only/);
    await assert.rejects(() => t.prisma.observation.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: p.id, encounterId: v.encounterId, type: "PULSE", value: 999, unit: "bpm", recordedById: nurse.id } }), /observation_value_range|check/i);
    await assert.rejects(() => t.prisma.observation.create({ data: { tenantId: a.tenantId, facilityId: a.facility2Id, patientId: p.id, encounterId: v.encounterId, type: "PULSE", value: 70, unit: "bpm", recordedById: nurse.id } }), /foreign key/i);
  });

  it("marks a wrong reading as entered-in-error with a reason: it stays in history and out of `latest`", async () => {
    const { v } = await fresh();
    const rec1 = await record(nurse.token, v.encounterId, [{ type: "PULSE", value: 170 }, { type: "WEIGHT", value: 70 }, { type: "HEIGHT", value: 170 }]);
    const pulse = rec1.body.data.items.find((i: { type: string }) => i.type === "PULSE");
    const weight = rec1.body.data.items.find((i: { type: string }) => i.type === "WEIGHT");
    assert.equal((await t.api("post", `/observations/${pulse.id}/enter-in-error`, nurse.token).send({})).status, 400);
    const ok = await t.api("post", `/observations/${pulse.id}/enter-in-error`, nurse.token).send({ reason: "Typed 170 instead of 70" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.status, "ENTERED_IN_ERROR");
    assert.equal(ok.body.data.value, "170", "original value preserved");
    const visible = await t.api("get", `/encounters/${v.encounterId}/observations`, nurse.token);
    assert.equal(visible.body.data.latest.PULSE, undefined);
    assert.ok(!visible.body.data.items.some((i: { id: string }) => i.id === pulse.id));
    const all = await t.api("get", `/encounters/${v.encounterId}/observations`, nurse.token).query({ includeErrors: "true" });
    assert.ok(all.body.data.items.some((i: { id: string; errorReason: string }) => i.id === pulse.id && i.errorReason === "Typed 170 instead of 70"));
    assert.equal((await t.api("post", `/observations/${pulse.id}/enter-in-error`, nurse.token).send({ reason: "Again" })).status, 409);

    const bmiRow = rec1.body.data.items.find((i: { type: string }) => i.type === "BMI");
    assert.equal((await t.api("post", `/observations/${bmiRow.id}/enter-in-error`, nurse.token).send({ reason: "Derived value" })).status, 409);
    await t.api("post", `/observations/${weight.id}/enter-in-error`, nurse.token).send({ reason: "Wrong scale reading" });
    assert.equal((await t.api("get", `/encounters/${v.encounterId}/observations`, nurse.token)).body.data.latest.BMI, undefined, "derived BMI follows its source");
    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "VITALS_ENTERED_IN_ERROR", entityId: pulse.id } });
    assert.equal(evt.actorUserId, nurse.id);
  });

  it("refuses recording on closed visits", async () => {
    const { v, d } = await fresh();
    await t.api("post", `/queue/${v.queueId}/start`, d.token);
    await t.api("post", `/queue/${v.queueId}/complete`, d.token);
    const r = await record(nurse.token, v.encounterId, [{ type: "PULSE", value: 70 }]);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "INVALID_STATE");
  });

  it("isolates vitals by tenant, facility and observation id (IDOR)", async () => {
    const { v, p } = await fresh();
    const rr = await record(nurse.token, v.encounterId, [{ type: "PULSE", value: 70 }]);
    const obsId = rr.body.data.items[0].id as string;
    const bNurse = await t.makeUser(b, ["NURSE"]);
    assert.equal((await record(bNurse.token, v.encounterId, [{ type: "PULSE", value: 55 }])).status, 404);
    assert.equal((await t.api("get", `/encounters/${v.encounterId}/observations`, bNurse.token)).status, 404);
    assert.equal((await t.api("get", `/patients/${p.id}/observations`, bNurse.token)).status, 404);
    assert.equal((await t.api("post", `/observations/${obsId}/enter-in-error`, bNurse.token).send({ reason: "Hijack attempt" })).status, 404);
    const f2Nurse = await t.makeUser(a, ["NURSE"], { facilityIds: [a.facility2Id] });
    assert.equal((await record(f2Nurse.token, v.encounterId, [{ type: "PULSE", value: 55 }])).status, 404);
    assert.equal((await t.api("get", `/encounters/${v.encounterId}/observations`, f2Nurse.token)).status, 404);
    assert.equal((await t.api("post", `/observations/${obsId}/enter-in-error`, f2Nurse.token).send({ reason: "Cross facility" })).status, 404);
    assert.equal((await t.api("post", `/observations/${randomUUID()}/enter-in-error`, nurse.token).send({ reason: "Missing id" })).status, 404);
    assert.equal(await t.prisma.observation.count({ where: { encounterId: v.encounterId } }), 1);
  });

  it("shows a patient's longitudinal vitals across visits with filtering and pagination", async () => {
    const p = await registerPatient(t, rec.token);
    const d = await makeDoctor(t, a);
    const v1 = await startVisit(t, rec.token, d, p.id);
    await record(nurse.token, v1.encounterId, [{ type: "PULSE", value: 70 }, { type: "SPO2", value: 97 }]);
    await t.api("post", `/queue/${v1.queueId}/start`, d.token);
    await t.api("post", `/queue/${v1.queueId}/complete`, d.token);
    const v2 = await startVisit(t, rec.token, d, p.id);
    await record(nurse.token, v2.encounterId, [{ type: "PULSE", value: 82 }]);
    const all = await t.api("get", `/patients/${p.id}/observations`, d.token);
    assert.equal(all.body.meta.total, 3);
    const pulse = await t.api("get", `/patients/${p.id}/observations`, d.token).query({ type: "PULSE", pageSize: 1 });
    assert.equal(pulse.body.data.length, 1);
    assert.equal(pulse.body.data[0].value, "82");
    assert.equal(pulse.body.meta.total, 2);
    assert.equal((await t.api("get", `/patients/${p.id}/observations`, doc.token).query({ type: "MOOD" })).status, 400);
  });
});
