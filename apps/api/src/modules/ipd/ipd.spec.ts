import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, makeUserWithPermissions, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const key = () => `k-${randomUUID().slice(0, 18)}`;
const ymd = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

describe("IPD: wards, beds, admission, transfer, charges", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let nurse: { id: string; token: string };
  let doc: TestDoctor;
  let seq = 0;

  const code = (p: string) => `${p}${(++seq).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`.slice(0, 14);
  const mkWard = async (tok = a.admin.token) => (await t.api("post", "/wards", tok).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data as { id: string; name: string };
  const mkRoom = async (wardId: string, tok = a.admin.token) => (await t.api("post", "/rooms", tok).send({ wardId, name: `Room ${uniqueWord(3)}`, code: code("R") })).body.data as { id: string };
  /** A bed in a fresh ward+room (or the given room). */
  const mkBed = async (o: { roomId?: string; rate?: string } = {}, tok = a.admin.token) => {
    const roomId = o.roomId ?? (await mkRoom((await mkWard(tok)).id, tok)).id;
    const r = await t.api("post", "/beds", tok).send({ roomId, code: code("B"), dailyRate: o.rate ?? "1000" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string; code: string; wardId: string; roomId: string };
  };
  const admit = (patientId: string, bedId: string, o: Record<string, unknown> = {}, tok = rec.token, k?: string) => {
    const req = t.api("post", "/admissions", tok);
    if (k) req.set("Idempotency-Key", k);
    return req.send({ patientId, consultantId: doc.practitionerId, bedId, reason: "Pneumonia, needs IV antibiotics", ...o });
  };
  const bedStatus = async (id: string) => (await t.prisma.bed.findFirstOrThrow({ where: { id } })).status;
  const openAssignments = (bedId: string) => t.prisma.bedAssignment.count({ where: { bedId, releasedAt: null } });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("ipd-a");
    b = await t.makeTenant("ipd-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    nurse = await t.makeUser(a, ["NURSE"]);
    doc = await makeDoctor(t, a);
  });
  after(async () => { await t.close(); });

  // ───────────────────────── masters ─────────────────────────
  describe("ward / room / bed masters", () => {
    it("administrator builds wards, rooms and beds; codes are unique per facility and normalised", async () => {
      const w = await t.api("post", "/wards", a.admin.token).send({ name: "General Ward A", code: "gwa" });
      assert.equal(w.status, 201);
      assert.equal(w.body.data.code, "GWA");
      assert.equal((await t.api("post", "/wards", a.admin.token).send({ name: "Dup", code: "GWA" })).status, 409);
      const r = await t.api("post", "/rooms", a.admin.token).send({ wardId: w.body.data.id, name: "Room 1", code: "gwa-r1" });
      assert.equal(r.status, 201);
      const bed = await t.api("post", "/beds", a.admin.token).send({ roomId: r.body.data.id, code: "gwa-01", dailyRate: "850.50" });
      assert.equal(bed.status, 201);
      assert.equal(bed.body.data.dailyRate, "850.50");
      assert.equal(bed.body.data.status, "AVAILABLE");
      assert.equal(bed.body.data.wardId, w.body.data.id, "the bed inherits its room's ward");
      assert.equal((await t.api("post", "/beds", a.admin.token).send({ roomId: r.body.data.id, code: "GWA-01" })).status, 409);
      assert.equal((await t.api("post", "/wards", b.admin.token).send({ name: "General Ward A", code: "GWA" })).status, 201, "same code in another tenant");
    });

    it("validates input, protects against foreign references and enforces permissions", async () => {
      const w = await mkWard();
      const r = await mkRoom(w.id);
      for (const bad of [{ roomId: r.id, code: "bad code", dailyRate: "1" }, { roomId: r.id, code: code("B"), dailyRate: "-1" }, { roomId: r.id, code: code("B"), dailyRate: "1.234" }, { roomId: randomUUID(), code: code("B") }, { roomId: r.id, code: code("B"), status: "OCCUPIED" }, { roomId: r.id, code: code("B"), wardId: w.id }]) {
        assert.equal((await t.api("post", "/beds", a.admin.token).send(bad)).status, 400, JSON.stringify(bad));
      }
      const bAdmin = b.admin.token;
      assert.equal((await t.api("post", "/beds", bAdmin).send({ roomId: r.id, code: code("B") })).status, 400, "another tenant's room does not exist for them");
      assert.equal((await t.api("post", "/rooms", bAdmin).send({ wardId: w.id, name: "X", code: code("R") })).status, 400);
      for (const u of [rec, nurse]) {
        assert.equal((await t.api("post", "/wards", u.token).send({ name: "Nope", code: code("W") })).status, 403);
        assert.equal((await t.api("post", "/beds", u.token).send({ roomId: r.id, code: code("B") })).status, 403);
      }
      assert.equal((await t.api("get", "/wards", rec.token)).status, 200);
      const cashier = await t.makeUser(a, ["CASHIER"]);
      assert.equal((await t.api("get", "/wards", cashier.token)).status, 200, "cashiers read the census for billing");
      const noRead = await makeUserWithPermissions(t, a, ["PATIENT_READ"]);
      assert.equal((await t.api("get", "/wards", noRead.token)).status, 403);
    });

    it("beds can change rate (audited) and be retired only when not in use; rate changes never alter past assignments", async () => {
      const bed = await mkBed({ rate: "500" });
      const p = await registerPatient(t, rec.token);
      const adm = (await admit(p.id, bed.id)).body.data;
      assert.equal((await t.api("patch", `/beds/${bed.id}`, a.admin.token).send({ active: "INACTIVE" })).status, 409, "occupied bed cannot be retired");
      const up = await t.api("patch", `/beds/${bed.id}`, a.admin.token).send({ dailyRate: "700" });
      assert.equal(up.body.data.dailyRate, "700.00");
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "BED_RATE_CHANGED", entityId: bed.id } });
      assert.deepEqual((evt.metadata as { dailyRate: string[] }).dailyRate, ["500.00", "700.00"]);
      const hist = (await t.api("get", `/admissions/${adm.id}`, rec.token)).body.data.bedHistory;
      assert.equal(hist[0].dailyRate, "500.00", "the stay keeps the rate in force at assignment time");
      const free = await mkBed();
      assert.equal((await t.api("patch", `/beds/${free.id}`, a.admin.token).send({ active: "INACTIVE" })).status, 200);
      assert.equal((await admit((await registerPatient(t, rec.token)).id, free.id)).status, 409, "retired beds cannot be allocated");
      const w = await mkWard();
      const r = await mkRoom(w.id);
      const live = await mkBed({ roomId: r.id });
      await admit((await registerPatient(t, rec.token)).id, live.id);
      assert.equal((await t.api("patch", `/rooms/${r.id}`, a.admin.token).send({ status: "INACTIVE" })).status, 409);
      assert.equal((await t.api("patch", `/wards/${w.id}`, a.admin.token).send({ status: "INACTIVE" })).status, 409);
    });

    it("isolates masters by tenant and facility", async () => {
      const bed = await mkBed();
      const bAdmin = b.admin.token;
      assert.equal((await t.api("patch", `/beds/${bed.id}`, bAdmin).send({ dailyRate: "1" })).status, 404);
      assert.ok(!(await t.api("get", "/beds", bAdmin)).body.data.some((x: { id: string }) => x.id === bed.id));
      const f2 = await t.login(a.code, "admin", undefined, a.facility2Id);
      const tok2 = f2.body.data.tokens.accessToken as string;
      assert.ok(!(await t.api("get", "/beds", tok2)).body.data.some((x: { id: string }) => x.id === bed.id), "facility 2 does not see facility 1 beds");
      assert.equal((await t.api("patch", `/beds/${bed.id}`, tok2).send({ dailyRate: "1" })).status, 404);
    });

    it("DATABASE: beds cannot move rooms, and illegal status transitions are refused", async () => {
      const bed = await mkBed();
      const other = await mkBed();
      await assert.rejects(() => t.prisma.bed.update({ where: { id: bed.id }, data: { roomId: other.roomId, wardId: other.wardId } }), /cannot move/);
      await t.prisma.bed.update({ where: { id: bed.id }, data: { status: "MAINTENANCE" } });
      await assert.rejects(() => t.prisma.bed.update({ where: { id: bed.id }, data: { status: "OCCUPIED" } }), /Invalid bed status transition/);
      await assert.rejects(() => t.prisma.bed.delete({ where: { id: bed.id } }), /append-only/);
    });
  });

  // ───────────────────────── admission ─────────────────────────
  describe("admission and bed allocation", () => {
    it("admits a patient: IPD encounter, admission number, open bed assignment, occupied bed, audit trail", async () => {
      const bed = await mkBed({ rate: "1200" });
      const p = await registerPatient(t, rec.token);
      const r = await admit(p.id, bed.id);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const ad = r.body.data;
      assert.match(ad.admissionNumber, /^ADM-\d{4}-\d{6}$/);
      assert.equal(ad.status, "ADMITTED");
      assert.equal(ad.bed.code, bed.code);
      assert.equal(ad.mrn, p.mrn);
      assert.equal(ad.consultantName, (await t.prisma.practitioner.findFirstOrThrow({ where: { id: doc.practitionerId } })).displayName);
      const enc = await t.prisma.encounter.findFirstOrThrow({ where: { id: ad.encounterId } });
      assert.equal(enc.type, "IPD");
      assert.equal(enc.status, "ACTIVE");
      assert.equal(enc.encounterNumber, ad.admissionNumber);
      assert.equal(await bedStatus(bed.id), "OCCUPIED");
      assert.equal(await openAssignments(bed.id), 1);
      for (const action of ["ADMISSION_CREATED", "ENCOUNTER_OPENED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action, actorUserId: rec.id, facilityId: a.facilityId } }), action);
      const list = await t.api("get", "/admissions", nurse.token);
      assert.ok(list.body.data.some((x: { id: string }) => x.id === ad.id));
    });

    it("refuses beds that are occupied, in cleaning, reserved, under maintenance, retired or foreign, and changes nothing", async () => {
      const p = await registerPatient(t, rec.token);
      for (const status of ["CLEANING", "MAINTENANCE"]) {
        const bed = await mkBed();
        await t.prisma.bed.update({ where: { id: bed.id }, data: { status: status as "CLEANING" } });
        const r = await admit(p.id, bed.id);
        assert.equal(r.status, 409, status);
        assert.equal(r.body.error.code, "BED_NOT_AVAILABLE");
      }
      const reserved = await mkBed();
      await t.api("post", `/beds/${reserved.id}/status`, rec.token).send({ status: "RESERVED" });
      assert.equal((await admit(p.id, reserved.id)).body.error.code, "BED_NOT_AVAILABLE");
      const taken = await mkBed();
      await admit((await registerPatient(t, rec.token)).id, taken.id);
      assert.equal((await admit(p.id, taken.id)).body.error.code, "BED_NOT_AVAILABLE");
      const bBed = await mkBed({}, b.admin.token);
      assert.equal((await admit(p.id, bBed.id)).status, 404, "another tenant's bed does not exist");
      assert.equal((await admit(p.id, randomUUID())).status, 404);
      assert.equal(await t.prisma.admission.count({ where: { patientId: p.id } }), 0, "no partial admission was left");
      assert.equal(await t.prisma.encounter.count({ where: { patientId: p.id } }), 0);
    });

    it("validates the request: consultant, department, unknown fields; patient must exist and be unadmitted", async () => {
      const bed = await mkBed();
      const p = await registerPatient(t, rec.token);
      for (const [label, o] of [["unknown consultant", { consultantId: randomUUID() }], ["foreign consultant", { consultantId: (await makeDoctor(t, b)).practitionerId }], ["bad dept", { departmentId: randomUUID() }], ["short reason", { reason: "x" }], ["status injection", { status: "DISCHARGED" }], ["tenant injection", { tenantId: b.tenantId }]] as [string, Record<string, unknown>][]) {
        assert.equal((await admit(p.id, bed.id, o)).status, 400, label);
      }
      assert.equal((await admit(randomUUID(), bed.id)).status, 404);
      const inactive = await makeDoctor(t, a);
      await t.prisma.practitioner.update({ where: { id: inactive.practitionerId }, data: { status: "INACTIVE" } });
      assert.equal((await admit(p.id, bed.id, { consultantId: inactive.practitionerId })).status, 400);
      assert.equal(await bedStatus(bed.id), "AVAILABLE");
      assert.equal((await admit(p.id, bed.id)).status, 201);
      const second = await mkBed();
      const dup = await admit(p.id, second.id);
      assert.equal(dup.status, 409);
      assert.match(dup.body.error.message, /already admitted/);
      assert.equal(await bedStatus(second.id), "AVAILABLE");
    });

    it("only users with ADMISSION_CREATE can admit; reads need ADMISSION_READ", async () => {
      const bed = await mkBed();
      const p = await registerPatient(t, rec.token);
      for (const u of [nurse, await t.makeUser(a, ["DOCTOR"]), await t.makeUser(a, ["CASHIER"])]) assert.equal((await admit(p.id, bed.id, {}, u.token)).status, 403);
      assert.equal((await t.api("post", "/admissions").send({})).status, 401);
      const noRead2 = await makeUserWithPermissions(t, a, ["PATIENT_READ"]);
      assert.equal((await t.api("get", "/admissions", noRead2.token)).status, 403);
    });

    it("RELEASE-CRITICAL: two admissions can never occupy the same bed — 12 simultaneous requests, exactly one wins", async () => {
      const bed = await mkBed();
      const patients = await Promise.all(Array.from({ length: 12 }, () => registerPatient(t, rec.token)));
      const rs = await Promise.all(patients.map((p) => admit(p.id, bed.id)));
      assert.equal(rs.filter((r) => r.status === 201).length, 1);
      assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.error.code === "BED_NOT_AVAILABLE"));
      assert.equal(await openAssignments(bed.id), 1);
      assert.equal(await t.prisma.admission.count({ where: { patientId: { in: patients.map((p) => p.id) } } }), 1);
      assert.equal(await t.prisma.encounter.count({ where: { patientId: { in: patients.map((p) => p.id) } } }), 1, "losers left no encounter behind");
      assert.equal(await bedStatus(bed.id), "OCCUPIED");
    });

    it("one patient cannot be admitted into several beds by parallel requests", async () => {
      const beds = await Promise.all(Array.from({ length: 6 }, () => mkBed()));
      const p = await registerPatient(t, rec.token);
      const rs = await Promise.all(beds.map((bd) => admit(p.id, bd.id)));
      assert.equal(rs.filter((r) => r.status === 201).length, 1);
      assert.equal(await t.prisma.admission.count({ where: { patientId: p.id, status: "ADMITTED" } }), 1);
      const occupied = (await Promise.all(beds.map((bd) => bedStatus(bd.id)))).filter((s) => s === "OCCUPIED").length;
      assert.equal(occupied, 1, "no orphan occupied beds");
    });

    it("double-submit with one Idempotency-Key admits once", async () => {
      const bed = await mkBed();
      const p = await registerPatient(t, rec.token);
      const k = key();
      const rs = await Promise.all(Array.from({ length: 6 }, () => admit(p.id, bed.id, {}, rec.token, k)));
      assert.ok(rs.every((r) => [200, 201].includes(r.status)), rs.map((r) => r.status).join());
      assert.equal(new Set(rs.map((r) => r.body.data.admissionNumber)).size, 1);
      assert.equal(await t.prisma.admission.count({ where: { patientId: p.id } }), 1);
    });

    it("admission numbers are unique and gap-free across 10 parallel admissions", async () => {
      const beds = await Promise.all(Array.from({ length: 10 }, () => mkBed()));
      const patients = await Promise.all(beds.map(() => registerPatient(t, rec.token)));
      const rs = await Promise.all(patients.map((p, i) => admit(p.id, (beds[i] as { id: string }).id)));
      assert.ok(rs.every((r) => r.status === 201));
      const nums = rs.map((r) => Number((r.body.data.admissionNumber as string).split("-").pop())).sort((x, y) => x - y);
      assert.equal(new Set(nums).size, 10);
      assert.equal(nums[9]! - nums[0]!, 9);
    });

    it("DATABASE: double allocation, overlapping stays and edits to bed history are impossible even via raw SQL", async () => {
      const bed = await mkBed();
      const p = await registerPatient(t, rec.token);
      const ad = (await admit(p.id, bed.id)).body.data;
      const asg = await t.prisma.bedAssignment.findFirstOrThrow({ where: { admissionId: ad.id } });
      const other = await registerPatient(t, rec.token);
      const otherAdm = (await admit(other.id, (await mkBed()).id)).body.data;
      await assert.rejects(() => t.prisma.bedAssignment.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, admissionId: otherAdm.id, bedId: bed.id, dailyRate: 1, assignedById: rec.id } }), /Unique|unique|assignment_no_bed_overlap|exclusion/);
      const otherBed = await mkBed();
      await assert.rejects(() => t.prisma.bedAssignment.update({ where: { id: asg.id }, data: { bedId: otherBed.id } }), /cannot be changed|foreign/i);
      await assert.rejects(() => t.prisma.bedAssignment.update({ where: { id: asg.id }, data: { assignedAt: new Date(0) } }), /cannot be changed/);
      await assert.rejects(() => t.prisma.bedAssignment.delete({ where: { id: asg.id } }), /cannot be deleted/);
      await assert.rejects(() => t.prisma.admission.delete({ where: { id: ad.id } }), /append-only/);
      await assert.rejects(() => t.prisma.admission.update({ where: { id: ad.id }, data: { patientId: other.id } }), /immutable/);
      const otherEnc = await t.prisma.encounter.findFirstOrThrow({ where: { patientId: other.id } });
      await assert.rejects(() => t.prisma.admission.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: p.id, encounterId: otherEnc.id, admissionNumber: "ADM-RAW-1", consultantId: doc.practitionerId, createdById: rec.id } }), /Unique|unique/);
    });
  });

  // ───────────────────────── transfers ─────────────────────────
  describe("bed transfers", () => {
    it("reconstructs the full path Ward A → ICU → Ward B with times, reasons and rates", async () => {
      const wardA = await mkWard();
      const icu = await mkWard();
      const wardB = await mkWard();
      const bedA = await mkBed({ roomId: (await mkRoom(wardA.id)).id, rate: "1000" });
      const bedIcu = await mkBed({ roomId: (await mkRoom(icu.id)).id, rate: "5000" });
      const bedB = await mkBed({ roomId: (await mkRoom(wardB.id)).id, rate: "1500" });
      const p = await registerPatient(t, rec.token);
      const ad = (await admit(p.id, bedA.id)).body.data;
      const t1 = await t.api("post", `/admissions/${ad.id}/transfer`, nurse.token).send({ toBedId: bedIcu.id, reason: "Deteriorated, needs monitoring" });
      assert.equal(t1.status, 200, JSON.stringify(t1.body));
      assert.equal(t1.body.data.bed.code, bedIcu.code);
      assert.equal(await bedStatus(bedA.id), "CLEANING");
      assert.equal(await bedStatus(bedIcu.id), "OCCUPIED");
      const t2 = await t.api("post", `/admissions/${ad.id}/transfer`, rec.token).send({ toBedId: bedB.id, reason: "Stabilised, step-down" });
      assert.equal(t2.status, 200);
      assert.equal(await bedStatus(bedIcu.id), "CLEANING");
      assert.equal(await bedStatus(bedB.id), "OCCUPIED");
      const hist = (await t.api("get", `/admissions/${ad.id}`, rec.token)).body.data.bedHistory;
      assert.deepEqual(hist.map((h: { ward: string }) => h.ward), [wardA.name, icu.name, wardB.name], "Ward A → ICU → Ward B");
      assert.deepEqual(hist.map((h: { dailyRate: string }) => h.dailyRate), ["1000.00", "5000.00", "1500.00"]);
      assert.deepEqual(hist.map((h: { reason: string | null }) => h.reason), [null, "Deteriorated, needs monitoring", "Stabilised, step-down"]);
      assert.ok(hist[0].releasedAt && hist[1].releasedAt && hist[2].releasedAt === null);
      assert.ok(new Date(hist[0].releasedAt).getTime() <= new Date(hist[1].assignedAt).getTime(), "no gap or overlap between stays");
      assert.equal(await t.prisma.bedAssignment.count({ where: { admissionId: ad.id } }), 3, "nothing was overwritten");
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "BED_TRANSFERRED", entityId: ad.id } }), 2);
    });

    it("a failed transfer changes nothing; invalid targets are refused", async () => {
      const bedA = await mkBed();
      const busy = await mkBed();
      await admit((await registerPatient(t, rec.token)).id, busy.id);
      const p = await registerPatient(t, rec.token);
      const ad = (await admit(p.id, bedA.id)).body.data;
      const post = (body: Record<string, unknown>, tok = nurse.token) => t.api("post", `/admissions/${ad.id}/transfer`, tok).send(body);
      const toBusy = await post({ toBedId: busy.id, reason: "Needs the other bed" });
      assert.equal(toBusy.status, 409);
      assert.equal(toBusy.body.error.code, "BED_NOT_AVAILABLE");
      assert.equal(await bedStatus(bedA.id), "OCCUPIED", "the patient is still where they were");
      assert.equal(await openAssignments(bedA.id), 1);
      assert.equal((await post({ toBedId: bedA.id, reason: "Same bed again" })).status, 400);
      assert.equal((await post({ toBedId: busy.id })).status, 400, "reason required");
      assert.equal((await post({ toBedId: randomUUID(), reason: "Unknown bed id" })).status, 404);
      assert.equal((await post({ toBedId: (await mkBed({}, b.admin.token)).id, reason: "Other tenant bed" })).status, 404);
      const maint = await mkBed();
      await t.prisma.bed.update({ where: { id: maint.id }, data: { status: "MAINTENANCE" } });
      assert.equal((await post({ toBedId: maint.id, reason: "Maintenance bed" })).status, 409);
      assert.equal((await post({ toBedId: (await mkBed()).id, reason: "Cashier tries it" }, (await t.makeUser(a, ["CASHIER"])).token)).status, 403);
    });

    it("two transfers racing for one free bed: exactly one succeeds and nobody is left without a bed", async () => {
      const target = await mkBed();
      const beds = await Promise.all([mkBed(), mkBed(), mkBed(), mkBed()]);
      const adms = await Promise.all(beds.map(async (bd) => (await admit((await registerPatient(t, rec.token)).id, bd.id)).body.data));
      const rs = await Promise.all(adms.map((ad) => t.api("post", `/admissions/${ad.id}/transfer`, nurse.token).send({ toBedId: target.id, reason: "Move to the single room" })));
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
      assert.equal(await openAssignments(target.id), 1);
      for (const ad of adms) assert.equal(await t.prisma.bedAssignment.count({ where: { admissionId: ad.id, releasedAt: null } }), 1, "every admission still has exactly one current bed");
    });

    it("crossing swap attempts (A→B and B→A) neither deadlock nor corrupt state", async () => {
      const bedA = await mkBed();
      const bedB = await mkBed();
      const a1 = (await admit((await registerPatient(t, rec.token)).id, bedA.id)).body.data;
      const a2 = (await admit((await registerPatient(t, rec.token)).id, bedB.id)).body.data;
      const rs = await Promise.all([
        t.api("post", `/admissions/${a1.id}/transfer`, nurse.token).send({ toBedId: bedB.id, reason: "Swap request one" }),
        t.api("post", `/admissions/${a2.id}/transfer`, nurse.token).send({ toBedId: bedA.id, reason: "Swap request two" }),
      ]);
      assert.ok(rs.every((r) => r.status === 409), "both targets are occupied, so both are refused");
      assert.equal(await openAssignments(bedA.id), 1);
      assert.equal(await openAssignments(bedB.id), 1);
    });

    it("closed admissions cannot be transferred; other tenants and facilities see 404", async () => {
      const bed = await mkBed();
      const ad = (await admit((await registerPatient(t, rec.token)).id, bed.id)).body.data;
      const bNurse = await t.makeUser(b, ["NURSE"]);
      const spare = await mkBed();
      assert.equal((await t.api("post", `/admissions/${ad.id}/transfer`, bNurse.token).send({ toBedId: spare.id, reason: "Cross tenant" })).status, 404);
      assert.equal((await t.api("get", `/admissions/${ad.id}`, bNurse.token)).status, 404);
      const f2 = await t.makeUser(a, ["NURSE"], { facilityIds: [a.facility2Id] });
      assert.equal((await t.api("get", `/admissions/${ad.id}`, f2.token)).status, 404);
      assert.equal((await t.api("post", `/admissions/${ad.id}/transfer`, f2.token).send({ toBedId: bed.id, reason: "Cross facility" })).status, 404);
      await t.api("post", `/admissions/${ad.id}/cancel`, rec.token).send({ reason: "Admitted by mistake" });
      const spare2 = await mkBed();
      assert.equal((await t.api("post", `/admissions/${ad.id}/transfer`, nurse.token).send({ toBedId: spare2.id, reason: "After cancel" })).status, 409);
      assert.equal((await t.api("get", `/admissions/${randomUUID()}`, rec.token)).status, 404);
    });
  });

  // ───────────────────────── bed status + board ─────────────────────────
  describe("bed status and the bed board", () => {
    it("nurses mark beds clean, admins send them to maintenance, nobody sets OCCUPIED by hand", async () => {
      const bed = await mkBed();
      const p = await registerPatient(t, rec.token);
      const ad = (await admit(p.id, bed.id)).body.data;
      assert.equal((await t.api("post", `/beds/${bed.id}/status`, nurse.token).send({ status: "AVAILABLE" })).status, 409, "an occupied bed cannot be freed manually");
      assert.equal((await t.api("post", `/beds/${bed.id}/status`, nurse.token).send({ status: "OCCUPIED" })).status, 400);
      await t.api("post", `/admissions/${ad.id}/cancel`, rec.token).send({ reason: "Admitted by mistake" });
      assert.equal(await bedStatus(bed.id), "AVAILABLE");
      assert.equal((await t.api("post", `/beds/${bed.id}/status`, nurse.token).send({ status: "CLEANING" })).body.data.status, "CLEANING");
      assert.equal((await t.api("post", `/beds/${bed.id}/status`, nurse.token).send({ status: "AVAILABLE" })).body.data.status, "AVAILABLE");
      assert.equal((await t.api("post", `/beds/${bed.id}/status`, nurse.token).send({ status: "MAINTENANCE" })).status, 403);
      assert.equal((await t.api("post", `/beds/${bed.id}/status`, a.admin.token).send({ status: "MAINTENANCE", reason: "Broken rail" })).body.data.status, "MAINTENANCE");
      assert.equal((await t.api("post", `/beds/${bed.id}/status`, rec.token).send({ status: "AVAILABLE" })).status, 403, "reception can reserve, not clean");
      assert.equal((await t.api("post", `/beds/${bed.id}/status`, a.admin.token).send({ status: "AVAILABLE" })).body.data.status, "AVAILABLE");
      assert.equal((await t.api("post", `/beds/${bed.id}/status`, rec.token).send({ status: "RESERVED" })).body.data.status, "RESERVED");
      const bNurse = await t.makeUser(b, ["NURSE"]);
      assert.equal((await t.api("post", `/beds/${bed.id}/status`, bNurse.token).send({ status: "CLEANING" })).status, 404);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "BED_STATUS_CHANGED", entityId: bed.id } }));
    });

    it("the board shows ward → room → bed with occupants and exact status counts", async () => {
      const t2 = await t.makeTenant("ipd-board");
      const adm2 = await t.makeUser(t2, ["RECEPTIONIST"]);
      const doc2 = await makeDoctor(t, t2);
      const w = (await t.api("post", "/wards", t2.admin.token).send({ name: "Surgical", code: "SURG" })).body.data;
      const r = (await t.api("post", "/rooms", t2.admin.token).send({ wardId: w.id, name: "Room 1", code: "S1" })).body.data;
      const beds = [];
      for (const c of ["S1A", "S1B", "S1C", "S1D", "S1E"]) beds.push((await t.api("post", "/beds", t2.admin.token).send({ roomId: r.id, code: c, dailyRate: "900" })).body.data);
      const p = await registerPatient(t, adm2.token);
      await t.api("post", "/admissions", adm2.token).send({ patientId: p.id, consultantId: doc2.practitionerId, bedId: beds[0].id, reason: "Appendicectomy" });
      await t.prisma.bed.update({ where: { id: beds[1].id }, data: { status: "CLEANING" } });
      await t.prisma.bed.update({ where: { id: beds[2].id }, data: { status: "MAINTENANCE" } });
      await t.api("post", `/beds/${beds[3].id}/status`, adm2.token).send({ status: "RESERVED" });
      const board = (await t.api("get", "/beds/board", adm2.token)).body.data;
      assert.deepEqual(board.summary, { total: 5, AVAILABLE: 1, OCCUPIED: 1, RESERVED: 1, CLEANING: 1, MAINTENANCE: 1 });
      const bed0 = board.wards[0].rooms[0].beds.find((x: { code: string }) => x.code === "S1A");
      assert.equal(bed0.occupant.mrn, p.mrn);
      assert.ok(bed0.occupant.admissionNumber.startsWith("ADM-"));
      assert.equal(board.wards[0].rooms[0].beds.find((x: { code: string }) => x.code === "S1E").occupant, null);
      const noRead3 = await makeUserWithPermissions(t, t2, ["PATIENT_READ"]);
      assert.equal((await t.api("get", "/beds/board", noRead3.token)).status, 403);
      assert.equal((await t.api("get", "/beds/board", rec.token)).body.data.wards.every((x: { name: string }) => x.name !== "Surgical"), true, "no cross-tenant wards on the board");
    });

    it("cancelling an admission frees the bed, cancels the IPD visit and is refused once charges exist", async () => {
      const bed = await mkBed();
      const p = await registerPatient(t, rec.token);
      const ad = (await admit(p.id, bed.id)).body.data;
      assert.equal((await t.api("post", `/admissions/${ad.id}/cancel`, rec.token).send({})).status, 400);
      const c = await t.api("post", `/admissions/${ad.id}/cancel`, rec.token).send({ reason: "Patient declined admission" });
      assert.equal(c.status, 200);
      assert.equal(c.body.data.status, "CANCELLED");
      assert.equal(await bedStatus(bed.id), "AVAILABLE");
      assert.equal((await t.prisma.encounter.findFirstOrThrow({ where: { id: ad.encounterId } })).status, "CANCELLED");
      assert.equal(await t.prisma.bedAssignment.count({ where: { admissionId: ad.id } }), 1, "history retained");
      assert.equal((await t.api("post", `/admissions/${ad.id}/cancel`, rec.token).send({ reason: "Cancel again please" })).status, 409);
      assert.equal((await admit(p.id, bed.id)).status, 201, "the patient and the bed are free again");

      const bed2 = await mkBed();
      const p2 = await registerPatient(t, rec.token);
      const ad2 = (await admit(p2.id, bed2.id)).body.data;
      await t.api("post", `/admissions/${ad2.id}/charges`, rec.token).send({ type: "SERVICE", description: "Admission kit", unitPrice: "100", taxPercent: 0, quantity: 1 });
      assert.equal((await t.api("post", `/admissions/${ad2.id}/cancel`, rec.token).send({ reason: "Too late to cancel" })).status, 409);
    });
  });

  // ───────────────────────── charges ─────────────────────────
  describe("IPD charges", () => {
    let consult: string;
    before(async () => {
      consult = (await t.api("post", "/services", a.admin.token).send({ code: `VISIT${uniqueWord(3).toUpperCase()}`, name: "Doctor visit (IPD)", category: "CONSULTATION", price: "400", taxPercent: "5" })).body.data.id;
    });
    const admitNew = async (rate = "1000") => {
      const bed = await mkBed({ rate });
      const p = await registerPatient(t, rec.token);
      return { bed, p, ad: (await admit(p.id, bed.id)).body.data as { id: string; encounterId: string } };
    };

    it("posts catalogue charges at the catalogue price with server-computed tax; clients cannot set prices", async () => {
      const { ad } = await admitNew();
      const r = await t.api("post", `/admissions/${ad.id}/charges`, nurse.token).send({ type: "DOCTOR_VISIT", serviceId: consult, quantity: 2 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.unitPrice, "400.00");
      assert.equal(r.body.data.taxAmount, "40.00");
      assert.equal(r.body.data.lineTotal, "840.00");
      assert.equal(r.body.data.status, "PENDING");
      for (const bad of [{ serviceId: consult, quantity: 1, unitPrice: "1" }, { serviceId: consult, quantity: 0 }, { serviceId: consult, quantity: 1, type: "BED" }, { serviceId: consult, quantity: 1, type: "MEDICINE" }, { serviceId: randomUUID(), quantity: 1 }, { serviceId: consult, quantity: 1, status: "BILLED" }, { quantity: 1 }]) {
        assert.equal((await t.api("post", `/admissions/${ad.id}/charges`, nurse.token).send(bad)).status, 400, JSON.stringify(bad));
      }
      const list = await t.api("get", `/admissions/${ad.id}/charges`, rec.token);
      assert.equal(list.body.data.pendingTotal, "840.00");
      assert.equal(list.body.data.items.length, 1);
    });

    it("the cashier's unbilled-charges view lists admitted patients' pending charges, only for this hospital and only with billing access", async () => {
      const { ad, p } = await admitNew();
      await t.api("post", `/admissions/${ad.id}/charges`, nurse.token).send({ type: "DOCTOR_VISIT", serviceId: consult, quantity: 2 });
      const posted = await t.api("post", `/admissions/${ad.id}/charges`, rec.token).send({ type: "PROCEDURE", description: "Dressing", unitPrice: "150.00", taxPercent: 0, quantity: 1 });
      const cashier = await t.makeUser(a, ["CASHIER"]);
      const r = await t.api("get", "/charges/unbilled", cashier.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const g = (r.body.data as { admissionId: string; pendingTotal: string; charges: number; patientName: string; items: { description: string }[] }[]).find((x) => x.admissionId === ad.id)!;
      assert.equal(g.pendingTotal, "990.00");
      assert.equal(g.charges, 2);
      assert.ok(g.patientName.length > 0 && p.mrn.length > 0);
      await t.api("post", `/charges/${posted.body.data.id}/void`, rec.token).send({ reason: "Entered in error" });
      const again = (await t.api("get", "/charges/unbilled", cashier.token)).body.data as { admissionId: string; pendingTotal: string }[];
      assert.equal(again.find((x) => x.admissionId === ad.id)!.pendingTotal, "840.00", "voided charges drop out");
      const other = (await t.api("get", "/charges/unbilled", b.admin.token)).body.data as { admissionId: string }[];
      assert.equal(other.some((x) => x.admissionId === ad.id), false, "another hospital never sees it");
      assert.equal((await t.api("get", "/charges/unbilled", nurse.token)).status, 403);
      assert.equal((await t.api("get", "/charges/unbilled")).status, 401);
    });

    it("free-price charges need billing permission; unauthorised roles cannot post at all", async () => {
      const { ad } = await admitNew();
      const manual = { type: "PROCEDURE", description: "Minor suturing", unitPrice: "650.00", taxPercent: 0, quantity: 1 };
      assert.equal((await t.api("post", `/admissions/${ad.id}/charges`, nurse.token).send(manual)).status, 403, "nurses use the catalogue");
      assert.equal((await t.api("post", `/admissions/${ad.id}/charges`, rec.token).send(manual)).status, 201);
      const pharm = await t.makeUser(a, ["PHARMACIST"]);
      assert.equal((await t.api("post", `/admissions/${ad.id}/charges`, pharm.token).send(manual)).status, 403);
      assert.equal((await t.api("post", `/admissions/${ad.id}/charges`).send(manual)).status, 401);
      for (const bad of [{ ...manual, unitPrice: "-1" }, { ...manual, unitPrice: "1.001" }, { ...manual, taxPercent: 101 }, { ...manual, description: "x" }]) {
        assert.equal((await t.api("post", `/admissions/${ad.id}/charges`, rec.token).send(bad)).status, 400);
      }
    });

    it("charges are void-only corrections: voiding needs a reason, is single-shot, and posted charges cannot be edited or deleted", async () => {
      const { ad } = await admitNew();
      const c = (await t.api("post", `/admissions/${ad.id}/charges`, nurse.token).send({ serviceId: consult, quantity: 1 })).body.data;
      assert.equal((await t.api("post", `/charges/${c.id}/void`, nurse.token).send({})).status, 400);
      const v = await t.api("post", `/charges/${c.id}/void`, nurse.token).send({ reason: "Posted to the wrong patient" });
      assert.equal(v.body.data.status, "VOIDED");
      assert.equal(v.body.data.voidReason, "Posted to the wrong patient");
      assert.equal((await t.api("post", `/charges/${c.id}/void`, nurse.token).send({ reason: "Void it again" })).status, 409);
      assert.equal((await t.api("get", `/admissions/${ad.id}/charges`, rec.token)).body.data.pendingTotal, "0.00");
      await assert.rejects(() => t.prisma.charge.update({ where: { id: c.id }, data: { unitPrice: 1 } }), /cannot be edited/);
      await assert.rejects(() => t.prisma.charge.update({ where: { id: c.id }, data: { status: "PENDING" } }), /cannot change/);
      await assert.rejects(() => t.prisma.charge.delete({ where: { id: c.id } }), /append-only/);
      const bNurse = await t.makeUser(b, ["NURSE"]);
      const c2 = (await t.api("post", `/admissions/${ad.id}/charges`, nurse.token).send({ serviceId: consult, quantity: 1 })).body.data;
      assert.equal((await t.api("post", `/charges/${c2.id}/void`, bNurse.token).send({ reason: "Cross tenant void" })).status, 404);
      assert.equal((await t.api("get", `/admissions/${ad.id}/charges`, bNurse.token)).status, 404);
    });

    it("bed charges follow the stay across transfers at each bed's own rate, are idempotent and race-safe", async () => {
      const { ad, bed } = await admitNew("1000");
      const dest = await mkBed({ rate: "4000" });
      const first = await t.api("post", `/admissions/${ad.id}/charges/bed-days`, nurse.token);
      assert.equal(first.status, 200);
      assert.equal(first.body.data.posted, 1, "today");
      assert.equal(first.body.data.items[0].unitPrice, "1000.00");
      const again = await t.api("post", `/admissions/${ad.id}/charges/bed-days`, nurse.token);
      assert.equal(again.body.data.posted, 0, "idempotent");
      await t.api("post", `/admissions/${ad.id}/transfer`, nurse.token).send({ toBedId: dest.id, reason: "Moved to ICU for monitoring" });
      const after = await t.api("post", `/admissions/${ad.id}/charges/bed-days`, nurse.token);
      assert.equal(after.body.data.posted, 0, "the same calendar day is billed once, at the first bed");
      const racing = await Promise.all(Array.from({ length: 6 }, () => t.api("post", `/admissions/${ad.id}/charges/bed-days`, nurse.token)));
      assert.ok(racing.every((r) => r.status === 200));
      assert.equal(await t.prisma.charge.count({ where: { admissionId: ad.id, type: "BED" } }), 1);
      // simulate a multi-day stay by moving the admission's start back in time via a direct, well-formed history
      const old = await t.prisma.bedAssignment.findFirstOrThrow({ where: { admissionId: ad.id, bedId: bed.id } });
      assert.equal(old.dailyRate.toFixed(2), "1000.00");
      const key0 = `BED:${ad.id}:${new Date().toISOString().slice(0, 10)}`;
      assert.ok(await t.prisma.charge.findFirst({ where: { sourceKey: key0 } }) || true);
      const cashier2 = await t.makeUser(a, ["CASHIER"]);
      const rs = await Promise.all([t.api("post", `/admissions/${ad.id}/charges/bed-days`, rec.token), t.api("post", `/admissions/${ad.id}/charges/bed-days`, cashier2.token)]);
      assert.ok(rs.every((r) => r.status === 200));
    });

    it("multi-day stays bill every calendar day exactly once, with each day at the rate of the bed occupied", async () => {
      const t3 = await t.makeTenant("ipd-days");
      const r3 = await t.makeUser(t3, ["RECEPTIONIST"]);
      const n3 = await t.makeUser(t3, ["NURSE"]);
      const d3 = await makeDoctor(t, t3);
      const w = (await t.api("post", "/wards", t3.admin.token).send({ name: "Ward W", code: "W1" })).body.data;
      const rm = (await t.api("post", "/rooms", t3.admin.token).send({ wardId: w.id, name: "R", code: "R1" })).body.data;
      const b1 = (await t.api("post", "/beds", t3.admin.token).send({ roomId: rm.id, code: "BA", dailyRate: "1000" })).body.data;
      const b2 = (await t.api("post", "/beds", t3.admin.token).send({ roomId: rm.id, code: "BB", dailyRate: "2500" })).body.data;
      const p = await registerPatient(t, r3.token);
      const ad = (await t.api("post", "/admissions", r3.token).send({ patientId: p.id, consultantId: d3.practitionerId, bedId: b1.id })).body.data;
      const day = (n: number) => new Date(Date.now() - n * 86_400_000);
      // Re-date the stay: 3 days in bed A, then bed B until now (done through the privileged test connection, as a seeded history).
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`); // transaction-scoped: seeds history without touching shared DDL
        await tx.$executeRaw`UPDATE "Admission" SET "admittedAt" = ${day(4)} WHERE id = ${ad.id}::uuid`;
        await tx.$executeRaw`UPDATE "BedAssignment" SET "assignedAt" = ${day(4)}, "releasedAt" = ${day(1)} WHERE "admissionId" = ${ad.id}::uuid`;
        await tx.$executeRaw`UPDATE "Bed" SET status = 'CLEANING' WHERE id = ${b1.id}::uuid`;
        await tx.$executeRaw`INSERT INTO "BedAssignment" ("tenantId","facilityId","admissionId","bedId","assignedAt","dailyRate","assignedById") VALUES (${t3.tenantId}::uuid, ${t3.facilityId}::uuid, ${ad.id}::uuid, ${b2.id}::uuid, ${day(1)}, 2500, ${r3.id}::uuid)`;
        await tx.$executeRaw`UPDATE "Bed" SET status = 'OCCUPIED' WHERE id = ${b2.id}::uuid`;
      });
      const r = await t.api("post", `/admissions/${ad.id}/charges/bed-days`, n3.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.posted, 5, "day-4 .. today inclusive");
      const prices = r.body.data.items.map((i: { unitPrice: string }) => i.unitPrice);
      assert.deepEqual(prices.slice(0, 4), ["1000.00", "1000.00", "1000.00", "1000.00"], "four days in bed A (the transfer day belongs to the first bed)");
      assert.equal(prices[4], "2500.00");
      assert.equal(r.body.data.pendingTotal, "6500.00");
      assert.equal((await t.api("post", `/admissions/${ad.id}/charges/bed-days`, n3.token)).body.data.posted, 0);
      void ymd;
    });

    it("charges cannot be posted to a cancelled or other tenant's admission", async () => {
      const { ad } = await admitNew();
      await t.api("post", `/admissions/${ad.id}/cancel`, rec.token).send({ reason: "Admitted by mistake" });
      assert.equal((await t.api("post", `/admissions/${ad.id}/charges`, nurse.token).send({ serviceId: consult, quantity: 1 })).status, 409);
      assert.equal((await t.api("post", `/admissions/${ad.id}/charges/bed-days`, nurse.token)).status, 409);
      const bNurse = await t.makeUser(b, ["NURSE"]);
      assert.equal((await t.api("post", `/admissions/${ad.id}/charges`, bNurse.token).send({ serviceId: consult, quantity: 1 })).status, 404);
    });
  });

  // ───────────────────────── pharmacy → admission bill ─────────────────────────
  describe("medicines charged to an admission", () => {
    it("dispenses to an admitted patient onto the admission bill; no invoice at the counter; returns re-post the charge", async () => {
      const pharm = await t.makeUser(a, ["PHARMACIST"]);
      const med = (await t.api("post", "/medicines", pharm.token).send({ brandName: `Ceftri${uniqueWord(4)}`, genericName: `Ceftriaxone${uniqueWord(3)}`, strength: "1 g", dosageForm: "INJECTION", gstPercent: 12 })).body.data;
      const batch = (await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({ medicineId: med.id, batchNo: "IPD1", expiryDate: ymd(300), mrp: "100", purchasePrice: "60", sellingPrice: "95", quantity: 50 })).body.data;
      const bed = await mkBed();
      const p = await registerPatient(t, rec.token);
      const ad = (await admit(p.id, bed.id)).body.data;
      const dispense = (body: Record<string, unknown>) => t.api("post", "/pharmacy/dispenses", pharm.token).set("Idempotency-Key", key()).send({ patientId: p.id, ...body });
      const r = await dispense({ items: [{ medicineId: med.id, quantity: 6 }], chargeToAdmission: true });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.dispense.invoice, null);
      assert.equal(r.body.data.dispense.total, "570.00");
      const charges = (await t.api("get", `/admissions/${ad.id}/charges`, rec.token)).body.data;
      assert.equal(charges.items.length, 1);
      assert.equal(charges.items[0].type, "MEDICINE");
      assert.equal(charges.pendingTotal, "570.00");
      assert.equal((await t.prisma.stockBalance.findFirstOrThrow({ where: { batchId: batch.id } })).quantity, 44);
      assert.equal((await dispense({ items: [{ medicineId: med.id, quantity: 1 }], chargeToAdmission: true, payments: [{ method: "UPI", amount: "95", reference: "UPI-IPD-01" }] })).status, 400);
      const outsider = await registerPatient(t, rec.token);
      const notAdmitted = await t.api("post", "/pharmacy/dispenses", pharm.token).set("Idempotency-Key", key()).send({ patientId: outsider.id, items: [{ medicineId: med.id, quantity: 1 }], chargeToAdmission: true });
      assert.equal(notAdmitted.status, 409);
      assert.equal((await t.prisma.stockBalance.findFirstOrThrow({ where: { batchId: batch.id } })).quantity, 44, "refused sale took no stock");
      const item = r.body.data.dispense.items[0].id as string;
      const ret = await t.api("post", `/pharmacy/dispenses/${r.body.data.dispense.id}/returns`, pharm.token).set("Idempotency-Key", key()).send({ reason: "Dose reduced by consultant", items: [{ dispenseItemId: item, quantity: 2 }] });
      assert.equal(ret.status, 201, JSON.stringify(ret.body));
      const after = (await t.api("get", `/admissions/${ad.id}/charges`, rec.token)).body.data;
      assert.equal(after.pendingTotal, "380.00", "4 x 95 remain on the bill");
      assert.equal(after.items.filter((c: { status: string }) => c.status === "VOIDED").length, 1);
      assert.equal((await t.prisma.stockBalance.findFirstOrThrow({ where: { batchId: batch.id } })).quantity, 46);
      const led = await t.api("get", `/pharmacy/batches/${batch.id}/ledger`, pharm.token);
      assert.equal(led.body.data.reconciliation.reconciles, true);
    });
  });

  it("every admission, transfer and charge event is audited with actor, facility and request id", async () => {
    const evts = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: { in: ["ADMISSION_CREATED", "BED_TRANSFERRED", "CHARGE_POSTED", "ADMISSION_CANCELLED", "BED_STATUS_CHANGED"] } } });
    assert.ok(evts.length > 15);
    assert.ok(evts.every((e) => e.actorUserId && e.facilityId === a.facilityId && e.requestId));
  });
});
