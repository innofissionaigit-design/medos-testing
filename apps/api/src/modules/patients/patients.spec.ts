import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { patientBody, randomMobile, registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

describe("patient registration, search and duplicate detection", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("pat-a");
    b = await t.makeTenant("pat-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
  });
  after(async () => { await t.close(); });

  it("registers a patient: canonical record, MRN from the numbering engine, audit event", async () => {
    const body = patientBody({ firstName: "Anirban", lastName: uniqueWord(7), mobile: "+91 98300 12345" });
    const r = await t.api("post", "/patients", rec.token).send(body);
    assert.equal(r.status, 201);
    const p = r.body.data;
    const facility = await t.prisma.facility.findFirstOrThrow({ where: { id: a.facilityId } });
    assert.match(p.mrn, new RegExp(`^${facility.code}-\\d{6}$`));
    assert.equal(p.mobile, "9830012345", "mobile normalised");
    assert.equal(p.age.estimated, false);
    assert.equal(p.version, 1);
    assert.equal(p.registeredFacilityId, a.facilityId);
    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PATIENT_CREATED", entityId: p.id } });
    assert.equal(evt.actorUserId, rec.id);
    assert.deepEqual(evt.metadata, { mrn: p.mrn });
  });

  it("supports estimated age instead of date of birth and rejects having neither or both", async () => {
    const est = await t.api("post", "/patients", rec.token).send(patientBody({ dateOfBirth: undefined, estimatedAgeYears: 45 }));
    assert.equal(est.status, 201);
    assert.deepEqual(est.body.data.age, { years: 45, estimated: true });
    assert.equal(est.body.data.dateOfBirth, null);
    const neither = await t.api("post", "/patients", rec.token).send(patientBody({ dateOfBirth: undefined }));
    assert.equal(neither.status, 400);
    const both = await t.api("post", "/patients", rec.token).send(patientBody({ estimatedAgeYears: 30 }));
    assert.equal(both.status, 400);
  });

  it("validates input boundaries and rejects unsafe or malformed values", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["missing first name", { firstName: undefined }],
      ["empty first name", { firstName: "   " }],
      ["digits in name", { firstName: "R2D2" }],
      ["script in name", { firstName: "<script>alert(1)</script>" }],
      ["name too long", { firstName: "A".repeat(61) }],
      ["bad gender", { gender: "ROBOT" }],
      ["future DOB", { dateOfBirth: "2999-01-01" }],
      ["impossible DOB", { dateOfBirth: "2020-02-30" }],
      ["bad DOB format", { dateOfBirth: "02/04/1990" }],
      ["short mobile", { mobile: "12345" }],
      ["foreign mobile", { mobile: "+1 415 555 0100" }],
      ["bad postal", { postalCode: "70001" }],
      ["negative age", { dateOfBirth: undefined, estimatedAgeYears: -1 }],
      ["age too high", { dateOfBirth: undefined, estimatedAgeYears: 131 }],
      ["fractional age", { dateOfBirth: undefined, estimatedAgeYears: 40.5 }],
      ["bad blood group", { bloodGroup: "Z_POS" }],
      ["unknown field", { isAdmin: true }],
      ["tenant injection", { tenantId: b.tenantId }],
      ["mrn injection", { mrn: "HACK-1" }],
    ];
    for (const [label, o] of cases) {
      const r = await t.api("post", "/patients", rec.token).send(patientBody(o));
      assert.equal(r.status, 400, label);
      assert.equal(r.body.error.code, "VALIDATION_FAILED", label);
    }
    assert.equal((await t.api("post", "/patients", rec.token).send(patientBody({ dateOfBirth: new Date().toISOString().slice(0, 10) }))).status, 201, "born today is valid");
    assert.equal((await t.api("post", "/patients", rec.token).send(patientBody({ dateOfBirth: undefined, estimatedAgeYears: 0 }))).status, 201);
    assert.equal((await t.api("post", "/patients", rec.token).send(patientBody({ dateOfBirth: undefined, estimatedAgeYears: 130 }))).status, 201);
  });

  it("stores hostile-looking but valid text safely (no script execution surface in the API)", async () => {
    const r = await t.api("post", "/patients", rec.token).send(patientBody({ addressLine: "<img src=x onerror=alert(1)> Rd; DROP TABLE \"Patient\";--" }));
    assert.equal(r.status, 201);
    assert.equal(r.body.data.addressLine, "<img src=x onerror=alert(1)> Rd; DROP TABLE \"Patient\";--", "stored verbatim as data; the UI must escape on output");
    assert.ok(await t.prisma.patient.count({ where: { tenantId: a.tenantId } }) > 0);
  });

  it("enforces permissions: only PATIENT_CREATE can register; PATIENT_READ can search", async () => {
    const doc = await t.makeUser(a, ["DOCTOR"]);
    const cashier = await t.makeUser(a, ["CASHIER"]);
    const pharmacist = await t.makeUser(a, ["PHARMACIST"]);
    for (const u of [doc, cashier, pharmacist]) {
      assert.equal((await t.api("post", "/patients", u.token).send(patientBody())).status, 403);
      assert.equal((await t.api("patch", `/patients/${randomUUID()}`, u.token).send({ version: 1, city: "X" })).status, 403);
    }
    assert.equal((await t.api("get", "/patients", doc.token).query({ q: "zz" })).status, 200);
    assert.equal((await t.api("get", "/patients").query({ q: "zz" })).status, 401);
    const adminOnly = await t.api("post", "/patients", a.admin.token).send(patientBody());
    assert.equal(adminOnly.status, 403, "administrator role has no clinical/registration permission by default");
  });

  it("searches by MRN, mobile (partial) and name (partial, case-insensitive), paginated", async () => {
    const first = uniqueWord(9);
    const mob = randomMobile();
    const p = await registerPatient(t, rec.token, { firstName: first, lastName: "Chatterjee", mobile: mob });
    const byMrn = await t.api("get", "/patients", rec.token).query({ q: p.mrn.toLowerCase() });
    assert.equal(byMrn.body.data[0].id, p.id);
    const byMobile = await t.api("get", "/patients", rec.token).query({ q: mob.slice(0, 7) });
    assert.ok(byMobile.body.data.some((x: { id: string }) => x.id === p.id));
    const byName = await t.api("get", "/patients", rec.token).query({ q: first.toUpperCase().slice(0, 6) });
    assert.ok(byName.body.data.some((x: { id: string }) => x.id === p.id));
    const full = await t.api("get", "/patients", rec.token).query({ q: `${first} chatterjee` });
    assert.equal(full.body.data[0].id, p.id);
    const paged = await t.api("get", "/patients", rec.token).query({ q: "ch", pageSize: 1, page: 1 });
    assert.equal(paged.status, 200);
    assert.ok(paged.body.data.length <= 1);
    assert.equal((await t.api("get", "/patients", rec.token).query({ q: "a" })).status, 400, "single character is too broad");
    assert.equal((await t.api("get", "/patients", rec.token).query({ q: "ab", pageSize: 500 })).status, 400);
    assert.equal((await t.api("get", "/patients", rec.token).query({ q: "%" + "_".repeat(2) })).status, 200, "LIKE wildcards are treated literally");
  });

  it("a name search is 'starts with': the text must begin the name, not merely appear in it", async () => {
    const stem = uniqueWord(8);
    const begins = await registerPatient(t, rec.token, { firstName: `${stem}ana`, lastName: "Roy" });
    const inSurname = await registerPatient(t, rec.token, { firstName: "Rina", lastName: `${stem}ghosh` });
    const inMiddle = await registerPatient(t, rec.token, { firstName: `Xo${stem}`, lastName: "Das" });
    const search = async (q: string, tok = rec.token) => ((await t.api("get", "/patients", tok).query({ q })).body.data as { id: string }[]).map((x) => x.id);

    const found = await search(stem.slice(0, 5));
    assert.ok(found.includes(begins.id), "a name that begins with the text is found");
    assert.ok(!found.includes(inSurname.id), "text at the start of the surname only is not a match");
    assert.ok(!found.includes(inMiddle.id), "text in the middle of a name is not a match");
    assert.deepEqual(await search(stem.slice(2, 7)), [], "text from the middle of a name finds nothing");
    assert.ok((await search(stem.slice(0, 5).toUpperCase())).includes(begins.id), "capitals do not matter");
    assert.ok((await search(`${stem}ana roy`)).includes(begins.id), "the full name, first name first, also works");
    assert.deepEqual(await search("roy"), (await search("roy")).filter((id) => id !== begins.id), "the surname alone is not a name start");
    assert.deepEqual(await search(stem.slice(0, 5), b.admin.token), [], "another hospital finds none of them");
  });

  it("an exact MRN search never also returns patients whose mobile merely contains the MRN's digits", async () => {
    const c = await t.makeTenant("pat-c");
    // A letters-only facility code leaves the MRN's digits as just the zero-padded sequence, e.g. "000001".
    await t.prisma.facility.updateMany({ where: { id: c.facilityId, tenantId: c.tenantId }, data: { code: uniqueWord(6).toUpperCase() } });
    const crec = await t.makeUser(c, ["RECEPTIONIST"]);
    const target = await registerPatient(t, crec.token);
    const digits = target.mrn.replace(/\D/g, "");
    await registerPatient(t, crec.token, { mobile: `9${digits.padStart(9, "0")}` });
    const r = await t.api("get", "/patients", crec.token).query({ q: target.mrn });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.map((p: { id: string }) => p.id), [target.id]);
    const byMobile = await t.api("get", "/patients", crec.token).query({ q: digits });
    assert.ok(byMobile.body.data.length >= 1, "a digits-only query still searches mobile numbers");
  });

  it("is isolated across tenants: search, read and update never cross the boundary (IDOR)", async () => {
    const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
    const victim = await registerPatient(t, bRec.token, { firstName: "Isolated", lastName: uniqueWord(8) });
    const search = await t.api("get", "/patients", rec.token).query({ q: victim.mrn });
    assert.equal(search.body.data.length, 0);
    const byName = await t.api("get", "/patients", rec.token).query({ q: "Isolated" });
    assert.ok(!byName.body.data.some((x: { id: string }) => x.id === victim.id));
    const cross = await t.api("get", `/patients/${victim.id}`, rec.token);
    const missing = await t.api("get", `/patients/${randomUUID()}`, rec.token);
    assert.equal(cross.status, 404);
    assert.equal(cross.body.error.code, "PATIENT_NOT_FOUND");
    assert.equal(cross.body.error.message, missing.body.error.message);
    assert.equal((await t.api("patch", `/patients/${victim.id}`, rec.token).send({ version: 1, city: "Hijack" })).status, 404);
    const intact = await t.prisma.patient.findFirstOrThrow({ where: { id: victim.id } });
    assert.notEqual(intact.city, "Hijack");
    assert.equal((await t.api("get", "/patients/not-a-uuid", rec.token)).status, 404);
  });

  it("the same MRN pattern in two tenants never collides, and the database enforces one MRN per patient", async () => {
    const pa = await registerPatient(t, rec.token);
    const pb = await registerPatient(t, (await t.makeUser(b, ["RECEPTIONIST"])).token);
    assert.ok(pa.mrn && pb.mrn);
    await assert.rejects(() => t.prisma.patientIdentifier.create({ data: { tenantId: a.tenantId, patientId: pa.id, type: "MRN", value: "SECOND-MRN" } }));
    const ident = await t.prisma.patientIdentifier.findFirstOrThrow({ where: { patientId: pa.id } });
    await assert.rejects(() => t.prisma.patientIdentifier.update({ where: { id: ident.id }, data: { value: "CHANGED" } }), /immutable/);
  });

  it("generates unique MRNs under 25 parallel registrations", async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => t.api("post", "/patients", rec.token).send(patientBody())));
    assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join());
    const mrns = results.map((r) => r.body.data.mrn as string);
    assert.equal(new Set(mrns).size, 25);
    const seqs = mrns.map((m) => Number(m.split("-").pop())).sort((x, y) => x - y);
    assert.equal(seqs[seqs.length - 1]! - seqs[0]!, 24, "contiguous, no gaps");
  });

  it("double-submit with the same Idempotency-Key creates exactly one patient", async () => {
    const body = patientBody();
    const key = `idem-${uniqueWord(10)}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => t.api("post", "/patients", rec.token).set("Idempotency-Key", key).send(body)));
    assert.ok(results.every((r) => [200, 201].includes(r.status)), results.map((r) => r.status).join());
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(new Set(results.map((r) => r.body.data.id)).size, 1);
    assert.equal(await t.prisma.patient.count({ where: { tenantId: a.tenantId, firstName: body["firstName"] as string } }), 1);
    const reuse = await t.api("post", "/patients", rec.token).set("Idempotency-Key", key).send(patientBody());
    assert.equal(reuse.status, 422);
    assert.equal(reuse.body.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal((await t.api("post", "/patients", rec.token).set("Idempotency-Key", "x").send(patientBody())).status, 400);
  });

  it("a failed registration rolls back completely: no patient, no MRN consumed, key reusable", async () => {
    const key = `idem-${uniqueWord(10)}`;
    const bad = await t.api("post", "/patients", rec.token).set("Idempotency-Key", key).send(patientBody({ gender: "NOPE" }));
    assert.equal(bad.status, 400);
    const ok = await t.api("post", "/patients", rec.token).set("Idempotency-Key", key).send(patientBody());
    assert.equal(ok.status, 201);
  });

  describe("duplicate detection", () => {
    it("shows HIGH-severity candidates for same mobile + similar name and blocks silent registration", async () => {
      const first = uniqueWord(8);
      const mob = randomMobile();
      const orig = await registerPatient(t, rec.token, { firstName: first, lastName: "Banerjee", mobile: mob, dateOfBirth: "1985-07-20" });
      const r = await t.api("post", "/patients", rec.token).send(patientBody({ firstName: first, lastName: "Banerji", mobile: mob, dateOfBirth: undefined, estimatedAgeYears: 40 }));
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "DUPLICATE_PATIENT_SUSPECTED");
      const c = r.body.error.details.candidates[0];
      assert.equal(c.patient.id, orig.id);
      assert.equal(c.severity, "HIGH");
      assert.ok(c.reasons.includes("MOBILE_AND_NAME"));
      assert.equal(c.patient.mrn, orig.mrn);
      assert.equal(await t.prisma.patient.count({ where: { tenantId: a.tenantId, mobile: mob } }), 1, "nothing was created");
    });

    it("detects name + date of birth and name + approximate age; ignores unrelated people", async () => {
      const first = uniqueWord(8);
      const last = uniqueWord(8);
      const orig = await registerPatient(t, rec.token, { firstName: first, lastName: last, dateOfBirth: "1970-01-15", gender: "MALE" });
      const dob = await t.api("post", "/patients/duplicate-check", rec.token).send({ firstName: first, lastName: last, gender: "MALE", dateOfBirth: "1970-01-15", mobile: randomMobile() });
      assert.equal(dob.status, 200);
      assert.equal(dob.body.data[0].patient.id, orig.id);
      assert.ok(dob.body.data[0].reasons.includes("NAME_AND_DOB"));

      const age = await t.api("post", "/patients/duplicate-check", rec.token).send({ firstName: first, lastName: last, gender: "MALE", estimatedAgeYears: 55 });
      assert.equal(age.body.data[0].patient.id, orig.id);
      assert.ok(age.body.data[0].reasons.includes("NAME_AND_AGE"));
      assert.equal(age.body.data[0].severity, "MEDIUM");

      const wrongGender = await t.api("post", "/patients/duplicate-check", rec.token).send({ firstName: first, lastName: last, gender: "FEMALE", estimatedAgeYears: 55 });
      assert.ok(!wrongGender.body.data.some((x: { patient: { id: string } }) => x.patient.id === orig.id));
      const stranger = await t.api("post", "/patients/duplicate-check", rec.token).send({ firstName: uniqueWord(8), lastName: uniqueWord(8), gender: "MALE", dateOfBirth: "1970-01-15" });
      assert.deepEqual(stranger.body.data, []);
    });

    it("lists a shared mobile as LOW severity (families share phones) but still asks for confirmation", async () => {
      const mob = randomMobile();
      await registerPatient(t, rec.token, { mobile: mob });
      const r = await t.api("post", "/patients", rec.token).send(patientBody({ mobile: mob }));
      assert.equal(r.status, 409);
      assert.equal(r.body.error.details.candidates[0].severity, "LOW");
    });

    it("allows a deliberate override, records who/why, and links the candidates in the audit trail", async () => {
      const mob = randomMobile();
      const orig = await registerPatient(t, rec.token, { mobile: mob });
      const r = await t.api("post", "/patients", rec.token).send(patientBody({ mobile: mob, duplicateOverride: { confirmedDistinct: true, reason: "Twin sibling, same phone" } }));
      assert.equal(r.status, 201);
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PATIENT_DUPLICATE_OVERRIDDEN", entityId: r.body.data.id } });
      assert.equal(evt.actorUserId, rec.id);
      assert.deepEqual(evt.metadata, { candidateIds: [orig.id], reason: "Twin sibling, same phone" });
    });

    it("an override flag without any duplicates is harmless; an invalid override shape is rejected", async () => {
      assert.equal((await t.api("post", "/patients", rec.token).send(patientBody({ duplicateOverride: { confirmedDistinct: true } }))).status, 201);
      assert.equal((await t.api("post", "/patients", rec.token).send(patientBody({ duplicateOverride: { confirmedDistinct: false } }))).status, 400);
      assert.equal((await t.api("post", "/patients", rec.token).send(patientBody({ duplicateOverride: true }))).status, 400);
    });

    it("requires DUPLICATE_OVERRIDE to override; a user with only PATIENT_CREATE is refused", async () => {
      const role = await t.api("post", "/roles", a.admin.token).send({ name: "Registrar", permissions: ["PATIENT_READ", "PATIENT_CREATE"] });
      const limited = await t.makeUser(a, []);
      await t.api("put", `/users/${limited.id}/roles`, a.admin.token).send({ roleIds: [role.body.data.id] });
      const mob = randomMobile();
      await registerPatient(t, rec.token, { mobile: mob });
      const r = await t.api("post", "/patients", limited.token).send(patientBody({ mobile: mob, duplicateOverride: { confirmedDistinct: true } }));
      assert.equal(r.status, 403);
      assert.equal(await t.prisma.patient.count({ where: { tenantId: a.tenantId, mobile: mob } }), 1);
    });

    it("never reveals patients of other tenants as duplicates", async () => {
      const mob = randomMobile();
      const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
      await registerPatient(t, bRec.token, { firstName: "Crosstenant", lastName: "Match", mobile: mob, dateOfBirth: "1980-01-01" });
      const r = await t.api("post", "/patients/duplicate-check", rec.token).send({ firstName: "Crosstenant", lastName: "Match", gender: "FEMALE", dateOfBirth: "1980-01-01", mobile: mob });
      assert.deepEqual(r.body.data, []);
    });

    it("the duplicate check itself is permission-protected", async () => {
      const doc = await t.makeUser(a, ["DOCTOR"]);
      assert.equal((await t.api("post", "/patients/duplicate-check", doc.token).send({ firstName: "A", gender: "MALE", estimatedAgeYears: 5 })).status, 403);
    });
  });

  describe("demographic updates", () => {
    it("updates with optimistic locking, re-derives search name, audits before/after values", async () => {
      const p = await registerPatient(t, rec.token, { firstName: "Mita", lastName: uniqueWord(8) });
      const r = await t.api("patch", `/patients/${p.id}`, rec.token).send({ version: p.version, city: "Howrah", mobile: "98300 99999" });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.version, 2);
      assert.equal(r.body.data.mobile, "9830099999");
      assert.equal(r.body.data.mrn, p.mrn, "MRN is immutable");
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PATIENT_UPDATED", entityId: p.id } });
      const ch = (evt.metadata as { changes: Record<string, [unknown, unknown]> }).changes;
      assert.deepEqual(ch["city"], ["Kolkata", "Howrah"]);
      assert.equal(ch["mobile"]?.[1], "9830099999");

      const rename = await t.api("patch", `/patients/${p.id}`, rec.token).send({ version: 2, firstName: "Mitali" });
      assert.equal(rename.status, 200);
      const found = await t.api("get", "/patients", rec.token).query({ q: "mitali" });
      assert.ok(found.body.data.some((x: { id: string }) => x.id === p.id), "search name re-derived");
    });

    it("rejects stale updates (concurrent edit) and leaves the newer data intact", async () => {
      const p = await registerPatient(t, rec.token);
      assert.equal((await t.api("patch", `/patients/${p.id}`, rec.token).send({ version: 1, city: "First Edit" })).status, 200);
      const stale = await t.api("patch", `/patients/${p.id}`, rec.token).send({ version: 1, city: "Stale Edit" });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, "STALE_VERSION");
      assert.equal((await t.prisma.patient.findFirstOrThrow({ where: { id: p.id } })).city, "First Edit");
    });

    it("lets exactly one of several simultaneous edits win", async () => {
      const p = await registerPatient(t, rec.token);
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => t.api("patch", `/patients/${p.id}`, rec.token).send({ version: 1, city: `Edit${i}` })));
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
      assert.equal((await t.prisma.patient.findFirstOrThrow({ where: { id: p.id } })).version, 2);
    });

    it("switches between DOB and estimated age consistently and can clear optional fields", async () => {
      const p = await registerPatient(t, rec.token, { bloodGroup: "O_POS", guardianName: "Guardian Name", guardianRelation: "Father" });
      const r = await t.api("patch", `/patients/${p.id}`, rec.token).send({ version: 1, estimatedAgeYears: 33, bloodGroup: null, guardianName: null });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.dateOfBirth, null);
      assert.deepEqual(r.body.data.age, { years: 33, estimated: true });
      assert.equal(r.body.data.bloodGroup, null);
      const back = await t.api("patch", `/patients/${p.id}`, rec.token).send({ version: 2, dateOfBirth: "1992-02-02" });
      assert.equal(back.body.data.age.estimated, false);
      assert.equal(back.body.data.dateOfBirth, "1992-02-02");
      const row = await t.prisma.patient.findFirstOrThrow({ where: { id: p.id } });
      assert.equal(row.estimatedAgeYears, null);
      assert.equal(row.ageRecordedOn, null);
    });

    it("rejects empty updates, no-op updates, protected fields and invalid values", async () => {
      const p = await registerPatient(t, rec.token);
      for (const body of [{ version: 1 }, { city: "x" }, { version: 1, mrn: "X" }, { version: 1, tenantId: b.tenantId }, { version: 1, status: "INACTIVE" }, { version: 1, mobile: "123" }, { version: 1, dateOfBirth: "2999-01-01" }, { version: 1, dateOfBirth: "1990-01-01", estimatedAgeYears: 20 }, { version: 0, city: "x" }]) {
        const r = await t.api("patch", `/patients/${p.id}`, rec.token).send(body);
        assert.equal(r.status, 400, JSON.stringify(body));
      }
      const noop = await t.api("patch", `/patients/${p.id}`, rec.token).send({ version: 1, city: "Kolkata" });
      assert.equal(noop.status, 400, "unchanged values are not a change");
      assert.equal((await t.prisma.patient.findFirstOrThrow({ where: { id: p.id } })).version, 1);
    });
  });

  it("patients can never be hard-deleted at the database level", async () => {
    const p = await registerPatient(t, rec.token);
    await assert.rejects(() => t.prisma.patient.delete({ where: { tenantId_id: { tenantId: a.tenantId, id: p.id } } }), /append-only|foreign key|violates/i);
    await assert.rejects(() => t.prisma.$executeRawUnsafe(`DELETE FROM "Patient" WHERE id = '${p.id}'`));
    assert.ok(await t.prisma.patient.findFirst({ where: { id: p.id } }));
  });

  it("the database rejects patients without an age basis or with malformed mobiles even via raw SQL", async () => {
    await assert.rejects(() => t.prisma.patient.create({ data: { tenantId: a.tenantId, registeredFacilityId: a.facilityId, firstName: "Raw", searchName: "raw", gender: "MALE", createdById: a.admin.id } }), /patient_age_present|check/i);
    await assert.rejects(() => t.prisma.patient.create({ data: { tenantId: a.tenantId, registeredFacilityId: a.facilityId, firstName: "Raw", searchName: "raw", gender: "MALE", createdById: a.admin.id, estimatedAgeYears: 20, ageRecordedOn: new Date(), mobile: "1234567890" } }), /patient_mobile_format|check/i);
    await assert.rejects(() => t.prisma.patient.create({ data: { tenantId: a.tenantId, registeredFacilityId: b.facilityId, firstName: "Raw", searchName: "raw", gender: "MALE", createdById: a.admin.id, estimatedAgeYears: 20, ageRecordedOn: new Date() } }), /foreign key/i);
  });
});
