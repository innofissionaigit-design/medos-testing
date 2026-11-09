import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeUserWithPermissions, registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

describe("patient identifiers beyond the MRN", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let staff: { id: string; token: string };
  let reader: { id: string; token: string };
  let staffB: { id: string; token: string };

  const num = () => `T${uniqueWord(8).toUpperCase()}`;
  const add = (patientId: string, body: Record<string, unknown>, tok = staff.token) => t.api("post", `/patients/${patientId}/identifiers`, tok).send(body);
  const list = (patientId: string, tok = staff.token) => t.api("get", `/patients/${patientId}/identifiers`, tok);
  const remove = (patientId: string, identifierId: string, body: Record<string, unknown> = { reason: "Typed wrongly" }, tok = staff.token) =>
    t.api("post", `/patients/${patientId}/identifiers/${identifierId}/remove`, tok).send(body);
  const search = async (q: string, tok = staff.token) => (await t.api("get", "/patients", tok).query({ q })).body.data as { id: string }[];

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("pid-a");
    b = await t.makeTenant("pid-b");
    staff = await makeUserWithPermissions(t, a, ["PATIENT_READ", "PATIENT_CREATE", "PATIENT_UPDATE", "PATIENT_MERGE"]);
    reader = await makeUserWithPermissions(t, a, ["PATIENT_READ"]);
    staffB = await makeUserWithPermissions(t, b, ["PATIENT_READ", "PATIENT_CREATE", "PATIENT_UPDATE"]);
  });
  after(async () => { await t.close(); });

  it("adds an old hospital number and another ID; the list shows the MRN first; values are tidied; an other ID needs an issuer", async () => {
    const p = await registerPatient(t, staff.token);
    const old = await add(p.id, { type: "LEGACY", value: `  wb  ${uniqueWord(4)}/12 `, issuer: "Old HMS" });
    assert.equal(old.status, 201, JSON.stringify(old.body));
    assert.match(old.body.data.value, /^WB [A-Z0-9]{4}\/12$/, "upper case, one space");
    const card = num();
    assert.equal((await add(p.id, { type: "EXTERNAL", value: card })).status, 400, "an other ID needs to say who issued it");
    assert.equal((await add(p.id, { type: "EXTERNAL", value: card, issuer: "Aadhaar (UIDAI)" })).status, 400, "Aadhaar is not stored");
    const ok = await add(p.id, { type: "EXTERNAL", value: card, issuer: "Star Health" });
    assert.equal(ok.status, 201);
    const rows = (await list(p.id)).body.data as { type: string; value: string; canRetire: boolean }[];
    assert.deepEqual(rows.map((r) => r.type).sort(), ["EXTERNAL", "LEGACY", "MRN"]);
    assert.equal(rows.find((r) => r.type === "MRN")!.value, p.mrn);
    assert.equal(rows.find((r) => r.type === "MRN")!.canRetire, false, "the MRN is never removed");
    // Only what staff may add: not an MRN (the system makes it) and not an ABHA number (the ABDM screen records that).
    for (const type of ["MRN", "ABHA", "OTHER"]) assert.equal((await add(p.id, { type, value: num(), issuer: "x1" })).status, 400, type);
    for (const bad of [{ value: "x" }, { value: "a".repeat(41) }, { value: "bad<script>" }, { value: num(), extra: 1 }]) {
      assert.equal((await add(p.id, { type: "LEGACY", ...bad })).status, 400, JSON.stringify(bad));
    }
  });

  it("a number belongs to one patient at a time: the clash names the other patient's MRN; another hospital may use the same number", async () => {
    const p1 = await registerPatient(t, staff.token);
    const p2 = await registerPatient(t, staff.token);
    const n = num();
    assert.equal((await add(p1.id, { type: "EXTERNAL", value: n, issuer: "PMJAY" })).status, 201);
    const same = await add(p1.id, { type: "EXTERNAL", value: n.toLowerCase(), issuer: "PMJAY" });
    assert.deepEqual([same.status, same.body.error.code], [409, "CONFLICT"]);
    assert.match(same.body.error.message, /already recorded for this patient/, "case does not make it a different number");
    const other = await add(p2.id, { type: "EXTERNAL", value: n, issuer: "PMJAY" });
    assert.deepEqual([other.status, other.body.error.code], [409, "CONFLICT"]);
    assert.ok(other.body.error.message.includes(p1.mrn), "tells staff whose number it is, so they can check for a duplicate");
    assert.equal((await add(p2.id, { type: "LEGACY", value: n })).status, 201, "the same text as a different kind of number is allowed");
    const pb = await registerPatient(t, staffB.token);
    assert.equal((await add(pb.id, { type: "EXTERNAL", value: n, issuer: "PMJAY" }, staffB.token)).status, 201, "another hospital is separate");
  });

  it("patients are found by any of their numbers; a removed number stops finding them and can be recorded correctly on the right patient", async () => {
    const wrong = await registerPatient(t, staff.token);
    const right = await registerPatient(t, staff.token);
    const n = num();
    const added = (await add(wrong.id, { type: "EXTERNAL", value: n, issuer: "Scheme" })).body.data;
    assert.deepEqual((await search(n)).map((x) => x.id), [wrong.id]);
    assert.equal((await add(right.id, { type: "EXTERNAL", value: n, issuer: "Scheme" })).status, 409);

    assert.equal((await remove(wrong.id, added.id, { reason: "x" })).status, 400, "a reason is needed");
    assert.equal((await remove(wrong.id, added.id, { reason: "Entered on the wrong patient", extra: 1 })).status, 400);
    assert.equal((await remove(wrong.id, added.id)).status, 200);
    assert.equal((await remove(wrong.id, added.id)).status, 409, "already removed");
    assert.deepEqual(await search(n), [], "a removed number no longer finds anyone");
    assert.ok(!((await list(wrong.id)).body.data as { id: string }[]).some((r) => r.id === added.id), "and is not listed");
    assert.equal((await add(right.id, { type: "EXTERNAL", value: n, issuer: "Scheme" })).status, 201, "the right patient can now have it");
    assert.deepEqual((await search(n)).map((x) => x.id), [right.id]);

    // The removal is kept for the record, with who and why, and the number itself is not copied into the audit trail.
    const row = await t.prisma.patientIdentifier.findFirstOrThrow({ where: { id: added.id } });
    assert.deepEqual([row.removedById, row.removalReason, row.removedAt !== null], [staff.id, "Typed wrongly", true]);
    const evts = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: wrong.id, action: { in: ["PATIENT_IDENTIFIER_ADDED", "PATIENT_IDENTIFIER_REMOVED"] } } });
    assert.equal(evts.length, 2);
    assert.ok(!JSON.stringify(evts.map((e) => e.metadata)).includes(n), "the number is not written to the audit trail");
    assert.equal((evts.find((e) => e.action === "PATIENT_IDENTIFIER_REMOVED")!.metadata as { reason: string }).reason, "Typed wrongly");
  });

  it("the MRN cannot be removed, and the database enforces it, immutability and the removal record", async () => {
    const p = await registerPatient(t, staff.token);
    const mrnRow = await t.prisma.patientIdentifier.findFirstOrThrow({ where: { patientId: p.id, type: "MRN" } });
    assert.deepEqual([(await remove(p.id, mrnRow.id)).status, (await remove(p.id, mrnRow.id)).body.error.code], [409, "INVALID_STATE"]);
    const ext = (await add(p.id, { type: "LEGACY", value: num() })).body.data;
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientIdentifier" SET "removedAt" = now(), "removedById" = '${staff.id}'::uuid, "removalReason" = 'oops' WHERE id = '${mrnRow.id}'::uuid`), "an MRN cannot be retired");
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientIdentifier" SET value = 'CHANGED1' WHERE id = '${ext.id}'::uuid`), "a value is never edited");
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientIdentifier" SET issuer = 'Other' WHERE id = '${ext.id}'::uuid`), "nor its issuer");
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientIdentifier" SET "removedAt" = now() WHERE id = '${ext.id}'::uuid`), "retiring needs who and why");
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PatientIdentifier" WHERE id = '${ext.id}'::uuid`), "never deleted");
    assert.equal((await remove(p.id, ext.id, { reason: "Duplicate entry" })).status, 200);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientIdentifier" SET "removalReason" = 'rewritten' WHERE id = '${ext.id}'::uuid`), "a retired number is final");
  });

  it("only people who may update patients can add or remove; reading needs PATIENT_READ", async () => {
    const p = await registerPatient(t, staff.token);
    const n = (await add(p.id, { type: "LEGACY", value: num() })).body.data;
    assert.equal((await list(p.id, reader.token)).status, 200);
    assert.equal((await add(p.id, { type: "LEGACY", value: num() }, reader.token)).status, 403);
    assert.equal((await remove(p.id, n.id, { reason: "Not allowed" }, reader.token)).status, 403);
    const nobody = await makeUserWithPermissions(t, a, ["APPOINTMENT_READ"]);
    assert.equal((await list(p.id, nobody.token)).status, 403);
    assert.equal((await t.api("get", `/patients/${p.id}/identifiers`)).status, 401);
  });

  it("another hospital's patients and numbers are simply not found", async () => {
    const p = await registerPatient(t, staff.token);
    const n = (await add(p.id, { type: "LEGACY", value: num() })).body.data;
    const pb = await registerPatient(t, staffB.token);
    assert.equal((await list(p.id, staffB.token)).status, 404);
    assert.equal((await add(p.id, { type: "LEGACY", value: num() }, staffB.token)).status, 404);
    assert.equal((await remove(p.id, n.id, { reason: "Not yours" }, staffB.token)).status, 404);
    assert.equal((await remove(pb.id, n.id, { reason: "Not yours" }, staffB.token)).status, 404, "an id from another hospital under my own patient");
    assert.equal((await remove(p.id, randomUUID())).status, 404);
    assert.equal((await list(randomUUID())).status, 404);
    assert.equal((await t.prisma.patientIdentifier.findFirstOrThrow({ where: { id: n.id } })).removedAt, null, "nothing changed");
  });

  it("when a duplicate is merged, its numbers still lead to the real patient and nothing more can be added to the duplicate", async () => {
    const real = await registerPatient(t, staff.token);
    const dup = await registerPatient(t, staff.token);
    const old = num();
    assert.equal((await add(dup.id, { type: "LEGACY", value: old })).status, 201);
    const merged = await t.api("post", `/patients/${dup.id}/merge`, staff.token).send({ intoPatientId: real.id, version: dup.version, reason: "Same person registered twice" });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    const rows = (await list(real.id)).body.data as { value: string; fromMergedMrn: string | null; canRetire: boolean }[];
    const carried = rows.find((r) => r.value === old.toUpperCase());
    assert.ok(carried, "the duplicate's number is shown on the real patient");
    assert.deepEqual([carried.fromMergedMrn, carried.canRetire], [dup.mrn, false]);
    assert.deepEqual((await search(old)).map((x) => x.id), [real.id], "searching an old number finds the real patient");
    const refused = await add(dup.id, { type: "LEGACY", value: num() });
    assert.deepEqual([refused.status, refused.body.error.code], [409, "PATIENT_MERGED"]);
  });

  it("two people adding the same number to different patients at once: exactly one wins", async () => {
    const patients = await Promise.all(Array.from({ length: 6 }, () => registerPatient(t, staff.token)));
    const n = num();
    const rs = await Promise.all(patients.map((p) => add(p.id, { type: "EXTERNAL", value: n, issuer: "Scheme" })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
    assert.equal(await t.prisma.patientIdentifier.count({ where: { tenantId: a.tenantId, type: "EXTERNAL", value: n, removedAt: null } }), 1);
  });
});
