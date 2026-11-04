import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, makeUserWithPermissions, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant, type TestVisit } from "../test/harness";

const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;
const key = () => `k-${randomUUID().slice(0, 18)}`;
const DEPT_PERMISSIONS = ["PATIENT_READ", "APPOINTMENT_READ", "QUEUE_READ", "ADMISSION_READ", "CONSULTATION_READ", "REPORT_OPD", "REPORT_IPD", "REPORT_READ"];

/** Doctors see their own patients, department staff their department, the organisation administrator everything (docs/data-access.md). */
describe("data access by doctor and department", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let nurse: { id: string; token: string };
  let d1: TestDoctor;
  let d2: TestDoctor;
  let dept1: { id: string; token: string };
  let p1: { id: string; mrn: string }; // seen by doctor 1
  let p2: { id: string; mrn: string }; // seen by doctor 2
  let p3: { id: string; mrn: string }; // registered, nobody has seen them yet
  let p4: { id: string; mrn: string }; // admitted under doctor 1
  let p5: { id: string; mrn: string }; // admitted under doctor 2
  let v1: TestVisit;
  let v2: TestVisit;
  let adm1: string;
  let adm2: string;

  const search = async (tok: string, mrn: string) => (await t.api("get", "/patients", tok).query({ q: mrn })).body.data as { id: string }[];
  const found = async (tok: string, p: { mrn: string }) => (await search(tok, p.mrn)).length === 1;
  const ids = (r: { body: { data: { id: string }[] } }) => r.body.data.map((x) => x.id);

  const mkBed = async () => {
    const w = (await t.api("post", "/wards", a.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data as { id: string };
    const r = (await t.api("post", "/rooms", a.admin.token).send({ wardId: w.id, name: `Room ${uniqueWord(3)}`, code: code("R") })).body.data as { id: string };
    const bed = await t.api("post", "/beds", a.admin.token).send({ roomId: r.id, code: code("B"), dailyRate: "1000" });
    assert.equal(bed.status, 201, JSON.stringify(bed.body));
    return bed.body.data.id as string;
  };
  const admit = async (patientId: string, doctor: TestDoctor) => {
    const bedId = await mkBed();
    const r = await t.api("post", "/admissions", rec.token).set("Idempotency-Key", key()).send({ patientId, consultantId: doctor.practitionerId, bedId, reason: "Observation and IV fluids" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.id as string;
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("dac-a");
    b = await t.makeTenant("dac-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    nurse = await t.makeUser(a, ["NURSE"]);
    d1 = await makeDoctor(t, a);
    d2 = await makeDoctor(t, a);
    p1 = await registerPatient(t, rec.token);
    p2 = await registerPatient(t, rec.token);
    p3 = await registerPatient(t, rec.token);
    p4 = await registerPatient(t, rec.token);
    p5 = await registerPatient(t, rec.token);
    v1 = await startVisit(t, rec.token, d1, p1!.id);
    v2 = await startVisit(t, rec.token, d2, p2!.id);
    adm1 = await admit(p4!.id, d1);
    adm2 = await admit(p5!.id, d2);
    dept1 = await makeUserWithPermissions(t, a, DEPT_PERMISSIONS);
    const r = await t.api("put", `/users/${dept1.id}/departments`, a.admin.token).send({ departmentIds: [d1.departmentId] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  after(async () => { await t.close(); });

  describe("a doctor sees only their own patients and records", () => {
    it("patient search: own patients (a visit or an admission) are found; another doctor's and unseen patients are not", async () => {
      assert.ok(await found(d1.token, p1!), "own visit patient");
      assert.ok(await found(d1.token, p4!), "own admitted patient");
      for (const other of [p2!, p3!, p5!]) assert.equal(await found(d1.token, other), false, "not theirs");
      assert.ok(await found(d2.token, p2!));
      assert.equal(await found(d2.token, p1!), false);
    });

    it("opening another doctor's patient, visit, consultation, workspace, diagnoses, vitals, prescription or follow-ups answers 404, like a record that does not exist; the same pages open for the owner", async () => {
      const pages = (patientId: string, v: TestVisit) => [
        `/patients/${patientId}`, `/patients/${patientId}/encounters`, `/patients/${patientId}/allergies`, `/patients/${patientId}/observations`,
        `/encounters/${v.encounterId}`, `/encounters/${v.encounterId}/consultation`, `/encounters/${v.encounterId}/workspace`,
        `/encounters/${v.encounterId}/diagnoses`, `/encounters/${v.encounterId}/prescription`, `/encounters/${v.encounterId}/prescription-scans`,
        `/encounters/${v.encounterId}/follow-ups`, `/encounters/${v.encounterId}/observations`, `/appointments/${v.appointmentId}`,
      ];
      // Each page must work for its owner (so a 404 below really comes from the scope, not from a wrong path) and be hidden from the other doctor.
      for (const path of pages(p1!.id, v1)) {
        const own = await t.api("get", path, d1.token);
        assert.equal(own.status, 200, `owner: ${path} -> ${own.status} ${JSON.stringify(own.body)}`);
      }
      for (const path of pages(p2!.id, v2)) {
        const other = await t.api("get", path, d1.token);
        assert.equal(other.status, 404, `other doctor: ${path} -> ${other.status} ${JSON.stringify(other.body)}`);
      }
      assert.equal((await t.api("get", `/print/prescriptions/${v2.encounterId}`, d1.token)).status, 404);
    });

    it("appointments, the queue and admissions list only the doctor's own", async () => {
      const appts = await t.api("get", "/appointments", d1.token);
      assert.deepEqual(ids(appts), [v1.appointmentId]);
      const queue = (await t.api("get", "/queue", d1.token)).body.data as { id: string }[];
      assert.deepEqual(queue.map((x) => x.id), [v1.queueId]);
      const adms = await t.api("get", "/admissions", d1.token);
      assert.deepEqual(ids(adms), [adm1]);
      assert.equal((await t.api("get", `/admissions/${adm1}`, d1.token)).status, 200);
      for (const path of [`/admissions/${adm2}`, `/admissions/${adm2}/charges`, `/admissions/${adm2}/discharge`, `/admissions/${adm2}/discharge-summary`]) {
        assert.equal((await t.api("get", path, d1.token)).status, 404, path);
      }
    });

    it("reports count only the doctor's own visits, doctors and admissions", async () => {
      const daily = (await t.api("get", "/reports/opd/daily", d1.token)).body.data;
      assert.equal(daily.total, 1);
      const byDoc = (await t.api("get", "/reports/opd/by-doctor", d1.token)).body.data.rows as { practitionerId: string }[];
      assert.deepEqual(byDoc.map((r) => r.practitionerId), [d1.practitionerId]);
      const byDept = (await t.api("get", "/reports/opd/by-department", d1.token)).body.data.rows as { departmentId: string }[];
      assert.deepEqual(byDept.map((r) => r.departmentId), [d1.departmentId]);
      const cur = (await t.api("get", "/reports/ipd/current-admissions", d1.token)).body.data;
      assert.deepEqual(cur.rows.map((r: { id: string }) => r.id), [adm1]);
      const flow = (await t.api("get", "/reports/ipd/admissions-discharges", d1.token)).body.data;
      assert.equal(flow.totalAdmissions, 1);
    });
  });

  describe("department staff see only their department", () => {
    it("search, appointments, queue and admissions are limited to the assigned department's doctors", async () => {
      assert.ok(await found(dept1.token, p1!));
      assert.ok(await found(dept1.token, p4!));
      for (const other of [p2!, p3!, p5!]) assert.equal(await found(dept1.token, other), false);
      assert.deepEqual(ids(await t.api("get", "/appointments", dept1.token)), [v1.appointmentId]);
      assert.deepEqual(((await t.api("get", "/queue", dept1.token)).body.data as { id: string }[]).map((x) => x.id), [v1.queueId]);
      assert.deepEqual(ids(await t.api("get", "/admissions", dept1.token)), [adm1]);
      assert.equal((await t.api("get", `/encounters/${v2.encounterId}`, dept1.token)).status, 404);
      assert.equal((await t.api("get", `/admissions/${adm2}`, dept1.token)).status, 404);
      assert.equal((await t.api("get", `/patients/${p5!.id}`, dept1.token)).status, 404);
    });

    it("reports, including the by-doctor bookings report, show only that department", async () => {
      assert.equal((await t.api("get", "/reports/opd/daily", dept1.token)).body.data.total, 1);
      const byDept = (await t.api("get", "/reports/opd/by-department", dept1.token)).body.data.rows as { departmentId: string }[];
      assert.deepEqual(byDept.map((r) => r.departmentId), [d1.departmentId]);
      const book = (await t.api("get", "/reports/bookings/by-doctor", dept1.token)).body.data;
      assert.deepEqual(book.doctors.map((d: { practitionerId: string }) => d.practitionerId), [d1.practitionerId]);
      assert.equal(book.totals.walkIns, 1);
      assert.deepEqual(((await t.api("get", "/reports/ipd/current-admissions", dept1.token)).body.data.rows as { id: string }[]).map((r) => r.id), [adm1]);
    });

    it("the department comes from the server: a department or doctor named in the request changes nothing", async () => {
      const r = await t.api("get", "/appointments", dept1.token).query({ practitionerId: d2.practitionerId });
      assert.equal(r.status, 200);
      assert.deepEqual(ids(r), [], "asking for another department's doctor returns nothing");
      const q = await t.api("get", "/queue", dept1.token).query({ practitionerId: d2.practitionerId });
      assert.deepEqual((q.body.data as unknown[]).length, 0);
    });
  });

  describe("the organisation administrator and unassigned staff", () => {
    it("the administrator sees every department, doctor, patient, record and report", async () => {
      for (const p of [p1!, p2!, p3!, p4!, p5!]) assert.ok(await found(a.admin.token, p));
      assert.equal(ids(await t.api("get", "/appointments", a.admin.token)).length, 2);
      assert.equal(ids(await t.api("get", "/admissions", a.admin.token)).length, 2);
      assert.equal((await t.api("get", "/reports/opd/daily", a.admin.token)).body.data.total, 2);
      assert.equal((await t.api("get", "/reports/opd/by-doctor", a.admin.token)).body.data.rows.length, 2);
      assert.equal((await t.api("get", `/encounters/${v2.encounterId}`, a.admin.token)).status, 200);
      assert.equal((await t.api("get", `/admissions/${adm2}`, a.admin.token)).status, 200);
    });

    it("an administrator who is also a doctor still sees everything", async () => {
      await t.prisma.practitioner.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, userId: a.admin.id, displayName: `Dr. ${uniqueWord(6)} ${uniqueWord(6)}` } });
      assert.ok(await found(a.admin.token, p2!));
      assert.equal((await t.api("get", "/reports/opd/daily", a.admin.token)).body.data.total, 2);
    });

    it("staff who are neither a doctor nor assigned to a department keep the access their role gives (Reception, Nurse)", async () => {
      for (const tok of [rec.token, nurse.token]) {
        for (const p of [p1!, p2!, p3!]) if (tok === rec.token) assert.ok(await found(tok, p));
        assert.equal(ids(await t.api("get", "/admissions", tok)).length, 2);
      }
      assert.equal(ids(await t.api("get", "/appointments", rec.token)).length, 2);
      assert.equal((await t.api("get", `/appointments/${v2.appointmentId}`, rec.token)).status, 200);
    });

    it("a doctor's scope does not widen through a department assignment, and removing a department lifts that user's limit", async () => {
      const doctorWithDept = await t.api("put", `/users/${d1.userId}/departments`, a.admin.token).send({ departmentIds: [d2.departmentId] });
      assert.equal(doctorWithDept.status, 200);
      assert.equal(await found(d1.token, p2!), false, "still only their own patients");
      assert.ok(await found(d1.token, p1!));
      await t.api("put", `/users/${d1.userId}/departments`, a.admin.token).send({ departmentIds: [] });
      assert.equal((await t.api("put", `/users/${dept1.id}/departments`, a.admin.token).send({ departmentIds: [] })).status, 200);
      assert.ok(await found(dept1.token, p2!), "no department assigned: not limited by department");
      assert.equal((await t.api("put", `/users/${dept1.id}/departments`, a.admin.token).send({ departmentIds: [d1.departmentId] })).status, 200);
      assert.equal(await found(dept1.token, p2!), false, "limited again");
    });
  });

  describe("assigning departments to users", () => {
    it("needs ADMIN_USERS; refuses unknown, inactive and other-hospital departments and self-changes; is audited and shown on the user", async () => {
      assert.equal((await t.api("put", `/users/${dept1.id}/departments`, rec.token).send({ departmentIds: [] })).status, 403);
      assert.equal((await t.api("put", `/users/${dept1.id}/departments`, d1.token).send({ departmentIds: [] })).status, 403);
      const foreign = await t.prisma.department.create({ data: { tenantId: b.tenantId, facilityId: b.facilityId, name: `Dept ${uniqueWord(5)}`, code: code("X") } });
      assert.equal((await t.api("put", `/users/${dept1.id}/departments`, a.admin.token).send({ departmentIds: [foreign.id] })).status, 400, "another hospital's department");
      assert.equal((await t.api("put", `/users/${dept1.id}/departments`, a.admin.token).send({ departmentIds: [randomUUID()] })).status, 400, "unknown department");
      assert.equal((await t.api("put", `/users/${dept1.id}/departments`, a.admin.token).send({ departmentIds: ["not-a-uuid"] })).status, 400);
      assert.equal((await t.api("put", `/users/${dept1.id}/departments`, a.admin.token).send({ departmentIds: [d1.departmentId], extra: 1 })).status, 400, "unexpected fields are rejected");
      assert.equal((await t.api("put", `/users/${a.admin.id}/departments`, a.admin.token).send({ departmentIds: [d1.departmentId] })).status, 409, "not your own");
      const ok = await t.api("put", `/users/${dept1.id}/departments`, a.admin.token).send({ departmentIds: [d1.departmentId] });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body.data.departments.map((d: { id: string }) => d.id), [d1.departmentId]);
      const ev = await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "USER_DEPARTMENTS_CHANGED", entityId: dept1.id }, orderBy: { createdAt: "desc" } });
      assert.ok(ev, "the change is audited");
      assert.deepEqual((ev.metadata as { after: string[] }).after, [d1.departmentId]);
      assert.deepEqual((await t.api("get", `/users/${dept1.id}`, a.admin.token)).body.data.departments.map((d: { id: string }) => d.id), [d1.departmentId]);
    });

    it("hospitals are separate: another hospital's administrator cannot assign or read this hospital's users, and sees none of its patients", async () => {
      assert.equal((await t.api("put", `/users/${dept1.id}/departments`, b.admin.token).send({ departmentIds: [] })).status, 404);
      assert.equal((await t.api("get", `/patients/${p1!.id}`, b.admin.token)).status, 404);
      assert.equal((await t.api("get", `/encounters/${v1.encounterId}`, b.admin.token)).status, 404);
      assert.equal((await t.api("get", "/reports/opd/daily", b.admin.token)).body.data.total, 0);
    });
  });
});
