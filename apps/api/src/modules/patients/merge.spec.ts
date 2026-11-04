import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDoctor, patientBody, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

describe("patient merge: a duplicate is linked to the real patient, nothing moves", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let doc: TestDoctor;

  const merge = (duplicateId: string, body: Record<string, unknown>, tok = a.admin.token) => t.api("post", `/patients/${duplicateId}/merge`, tok).send(body);
  const pair = async () => {
    const real = await registerPatient(t, rec.token);
    const dup = await registerPatient(t, rec.token);
    return { real, dup };
  };
  const body = (intoPatientId: string, version = 1) => ({ intoPatientId, version, reason: "Same person registered twice at the desk" });
  const get = async (id: string, tok = a.admin.token) => (await t.api("get", `/patients/${id}`, tok)).body.data;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("mrg-a");
    b = await t.makeTenant("mrg-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
  });
  after(async () => { await t.close(); });

  describe("access", () => {
    it("only people with PATIENT_MERGE can merge; the receptionist and the doctor cannot", async () => {
      const { real, dup } = await pair();
      assert.equal((await t.api("post", `/patients/${dup.id}/merge`).send(body(real.id))).status, 401);
      assert.equal((await merge(dup.id, body(real.id), rec.token)).status, 403);
      assert.equal((await merge(dup.id, body(real.id), doc.token)).status, 403);
      assert.equal((await get(dup.id)).mergedInto, null, "nothing happened");
    });
    it("cannot cross hospitals: another hospital's patient is not found, and nothing changes", async () => {
      const { real, dup } = await pair();
      const other = await registerPatient(t, (await t.makeUser(b, ["RECEPTIONIST"])).token);
      assert.equal((await merge(dup.id, body(other.id))).status, 404);
      assert.equal((await merge(other.id, body(real.id))).status, 404);
      assert.equal((await merge(dup.id, body(real.id), b.admin.token)).status, 404);
    });
    it("validates the request", async () => {
      const { real, dup } = await pair();
      assert.equal((await merge(dup.id, { ...body(real.id), reason: "no" })).status, 400);
      assert.equal((await merge(dup.id, { ...body(real.id), extra: 1 })).status, 400);
      assert.equal((await merge(dup.id, body(dup.id))).status, 400, "not into itself");
      assert.equal((await merge("not-a-uuid", body(real.id))).status, 404, "a malformed id is not found, like every other route");
    });
  });

  describe("the merge", () => {
    it("links the duplicate, keeps its record, and the chart and search follow the real patient", async () => {
      const { real, dup } = await pair();
      const r = await merge(dup.id, body(real.id));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.intoPatientId, real.id);

      const d = await get(dup.id);
      assert.equal(d.status, "INACTIVE");
      assert.deepEqual(d.mergedInto, { id: real.id, mrn: real.mrn });
      assert.equal(d.mrn, dup.mrn, "the duplicate keeps its own number");
      const target = await get(real.id);
      assert.equal(target.status, "ACTIVE");
      assert.deepEqual(target.mergedFrom.map((m: { id: string; mrn: string }) => [m.id, m.mrn]), [[dup.id, dup.mrn]]);

      const byOldMrn = (await t.api("get", `/patients?q=${encodeURIComponent(dup.mrn)}`, rec.token)).body.data as { id: string }[];
      assert.deepEqual(byOldMrn.map((p) => p.id), [real.id], "the old number finds the real patient only");
      const byName = (await t.api("get", `/patients?q=${encodeURIComponent(String(patientBody()["firstName"]).slice(0, 3))}`, rec.token)).body.data as { id: string }[];
      assert.ok(!byName.some((p) => p.id === dup.id), "a merged duplicate is never offered");

      const row = await t.prisma.patient.findFirstOrThrow({ where: { id: dup.id, tenantId: a.tenantId } });
      assert.equal(row.mergeReason, "Same person registered twice at the desk");
      assert.ok(row.mergedAt && row.mergedById);
    });

    it("an allergy, a bill and a consent recorded on the duplicate show on the real patient; nothing is hidden", async () => {
      const { real, dup } = await pair();
      assert.equal((await t.api("post", `/patients/${dup.id}/allergies`, doc.token).send({ allergen: "Penicillin", type: "DRUG", severity: "SEVERE" })).status, 201);
      assert.equal((await t.api("post", `/patients/${dup.id}/consents`, rec.token).send({ purpose: "APPOINTMENT_REMINDERS", status: "WITHDRAWN", method: "VERBAL" })).status, 201);
      const inv = await t.api("post", "/invoices", rec.token).send({ patientId: dup.id, kind: "OTHER", lines: [{ description: "Dressing", unitPrice: "100.00", taxPercent: "0", quantity: 1 }] });
      assert.equal(inv.status, 201, JSON.stringify(inv.body));
      assert.equal((await merge(dup.id, body(real.id))).status, 200);

      const allergies = (await t.api("get", `/patients/${real.id}/allergies`, a.admin.token)).body.data as { allergen: string }[];
      assert.deepEqual(allergies.map((x) => x.allergen), ["Penicillin"]);
      assert.deepEqual(((await t.api("get", `/patients/${dup.id}/allergies`, a.admin.token)).body.data as unknown[]).length, 1, "asking by the old id gives the same chart");
      const current = (await t.api("get", `/patients/${real.id}/consents`, rec.token)).body.data.current as { purpose: string; status: string }[];
      assert.deepEqual(current.map((c) => [c.purpose, c.status]), [["APPOINTMENT_REMINDERS", "WITHDRAWN"]], "a withdrawal on the duplicate still counts");
      const invoices = (await t.api("get", `/invoices?patientId=${real.id}`, rec.token)).body.data as { id: string }[];
      assert.deepEqual(invoices.map((i) => i.id), [inv.body.data.id]);
      const events = await t.prisma.invoice.count({ where: { tenantId: a.tenantId, patientId: dup.id } });
      assert.equal(events, 1, "the bill stays on the record it was made on");
    });

    it("refuses new work on the merged duplicate and says where to go", async () => {
      const { real, dup } = await pair();
      assert.equal((await merge(dup.id, body(real.id))).status, 200);
      const upd = await t.api("patch", `/patients/${dup.id}`, rec.token).send({ version: 2, city: "Howrah" });
      assert.equal(upd.status, 409);
      assert.equal(upd.body.error.code, "PATIENT_MERGED");
      const al = await t.api("post", `/patients/${dup.id}/allergies`, doc.token).send({ allergen: "Peanut", type: "FOOD", severity: "MILD" });
      assert.equal(al.body.error.code, "PATIENT_MERGED");
      assert.equal((await t.api("post", "/appointments/walk-in", rec.token).send({ patientId: dup.id, practitionerId: doc.practitionerId })).status, 404);
      assert.equal((await t.api("post", "/invoices", rec.token).send({ patientId: dup.id, kind: "OTHER", lines: [{ description: "Dressing", unitPrice: "10.00", taxPercent: "0", quantity: 1 }] })).status, 404);
      assert.equal((await t.api("post", `/patients/${dup.id}/consents`, rec.token).send({ purpose: "PRIVACY_NOTICE_ACKNOWLEDGED", status: "GRANTED", method: "VERBAL" })).body.error.code, "PATIENT_MERGED");
    });

    it("is audited with the numbers and the reason, and no demographics", async () => {
      const { real, dup } = await pair();
      await merge(dup.id, body(real.id));
      const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PATIENT_MERGED", entityId: dup.id } });
      const meta = ev.metadata as Record<string, unknown>;
      assert.equal(meta["duplicateMrn"], dup.mrn);
      assert.equal(meta["intoMrn"], real.mrn);
      assert.equal(meta["reason"], "Same person registered twice at the desk");
      assert.ok(!JSON.stringify(meta).includes("Synthetic"), "no address or name in the audit trail");
    });
  });

  describe("rules", () => {
    it("cannot be undone, repeated, chained into a merged patient or run backwards", async () => {
      const { real, dup } = await pair();
      assert.equal((await merge(dup.id, body(real.id))).status, 200);
      const again = await merge(dup.id, body(real.id, 2));
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, "PATIENT_MERGED");
      const back = await merge(real.id, body(dup.id));
      assert.equal(back.body.error.code, "PATIENT_MERGED", "cannot merge the real patient into its own duplicate");
      const third = await registerPatient(t, rec.token);
      assert.equal((await merge(third.id, body(dup.id))).body.error.code, "PATIENT_MERGED", "cannot merge into a merged patient");
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Patient" SET "mergedIntoId" = NULL, "mergedAt" = NULL, "mergedById" = NULL, "mergeReason" = NULL WHERE id = '${dup.id}'::uuid`), /cannot be undone/);
    });

    it("a stale version is refused", async () => {
      const { real, dup } = await pair();
      const r = await merge(dup.id, body(real.id, 9));
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "STALE_VERSION");
    });

    it("is blocked while the duplicate has an open visit, and allowed once it is finished or cancelled", async () => {
      const { real, dup } = await pair();
      const v = await startVisit(t, rec.token, doc, dup.id);
      const blocked = await merge(dup.id, body(real.id));
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, "PATIENT_MERGE_BLOCKED");
      assert.ok(blocked.body.error.details.openVisits >= 1);
      assert.equal((await get(dup.id)).mergedInto, null);
      const cancelled = await t.api("post", `/queue/${v.queueId}/cancel`, rec.token).send({ reason: "Registered under the wrong record" });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      const after = await merge(dup.id, body(real.id));
      assert.equal(after.status, 200, JSON.stringify(after.body));
    });

    it("a patient already linked to the duplicate is re-pointed, so a link is never more than one step", async () => {
      const real = await registerPatient(t, rec.token);
      const mid = await registerPatient(t, rec.token);
      const old = await registerPatient(t, rec.token);
      assert.equal((await merge(old.id, body(mid.id))).status, 200);
      assert.equal((await merge(mid.id, body(real.id))).status, 200);
      const target = await get(real.id);
      assert.deepEqual(target.mergedFrom.map((m: { id: string }) => m.id).sort(), [mid.id, old.id].sort());
      assert.equal((await get(old.id)).mergedInto.id, real.id);
      assert.equal(((await t.api("get", `/patients/${old.id}/allergies`, a.admin.token)).body.data as unknown[]).length, 0);
    });

    it("two merges at once on the same pair: exactly one wins, no deadlock", async () => {
      const { real, dup } = await pair();
      const [x, y] = await Promise.all([merge(dup.id, body(real.id)), merge(real.id, body(dup.id))]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409]);
      const rows = await t.prisma.patient.findMany({ where: { tenantId: a.tenantId, id: { in: [real.id, dup.id] } } });
      assert.equal(rows.filter((r) => r.mergedIntoId).length, 1);
    });
  });
});
