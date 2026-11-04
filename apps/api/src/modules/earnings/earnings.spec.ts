import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, makeUserWithPermissions, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { doctorShare, pickRule, type ShareRule } from "./earnings.domain";

const rule = (r: Partial<ShareRule> & Pick<ShareRule, "mode">): ShareRule => ({ practitionerId: null, percent: null, fixedAmount: null, effectiveFrom: new Date("2026-01-01T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z"), ...r });

describe("earnings split: the rules", () => {
  it("PERCENT is a share of what was collected, to the paisa", () => {
    assert.equal(doctorShare(rule({ mode: "PERCENT", percent: "40" }), "500", "CONSULTED").toFixed(2), "200.00");
    assert.equal(doctorShare(rule({ mode: "PERCENT", percent: "33.33" }), "100", "CONSULTED").toFixed(2), "33.33");
    assert.equal(doctorShare(rule({ mode: "PERCENT", percent: "12.5" }), "99.99", "CONSULTED").toFixed(2), "12.50");
    assert.equal(doctorShare(rule({ mode: "PERCENT", percent: "100" }), "300", "CONSULTED").toFixed(2), "300.00");
    assert.equal(doctorShare(rule({ mode: "PERCENT", percent: "0" }), "300", "CONSULTED").toFixed(2), "0.00");
  });
  it("FIXED is an amount per consulted visit, never more than was collected, and nothing for a cancellation charge", () => {
    const fixed = rule({ mode: "FIXED", fixedAmount: "300" });
    assert.equal(doctorShare(fixed, "500", "CONSULTED").toFixed(2), "300.00");
    assert.equal(doctorShare(fixed, "200", "CONSULTED").toFixed(2), "200.00", "capped at what was collected");
    assert.equal(doctorShare(fixed, "500", "CANCELLATION_CHARGE").toFixed(2), "0.00");
  });
  it("MIXED is the fixed amount plus a percentage, capped at what was collected", () => {
    const mixed = rule({ mode: "MIXED", fixedAmount: "100", percent: "20" });
    assert.equal(doctorShare(mixed, "500", "CONSULTED").toFixed(2), "200.00");
    assert.equal(doctorShare(mixed, "100", "CONSULTED").toFixed(2), "100.00", "100 fixed + 20 = 120, capped at the 100 collected");
    assert.equal(doctorShare(mixed, "500", "CANCELLATION_CHARGE").toFixed(2), "100.00", "only the percentage applies to a cancellation charge");
  });
  it("no rule, no money, or a negative amount gives the doctor nothing", () => {
    assert.equal(doctorShare(null, "500", "CONSULTED").toFixed(2), "0.00");
    assert.equal(doctorShare(rule({ mode: "PERCENT", percent: "50" }), "0", "CONSULTED").toFixed(2), "0.00");
    assert.equal(doctorShare(rule({ mode: "PERCENT", percent: "50" }), "-40", "CONSULTED").toFixed(2), "0.00");
  });
  it("a doctor's own rule beats the default; the rule in force on the visit day is the one used; later rules never change earlier visits", () => {
    const rules = [
      rule({ mode: "PERCENT", percent: "30", effectiveFrom: new Date("2026-01-01T00:00:00Z") }),
      rule({ mode: "PERCENT", percent: "35", effectiveFrom: new Date("2026-06-01T00:00:00Z") }),
      rule({ practitionerId: "dr-a", mode: "PERCENT", percent: "60", effectiveFrom: new Date("2026-03-01T00:00:00Z") }),
      rule({ practitionerId: "dr-a", mode: "FIXED", fixedAmount: "400", effectiveFrom: new Date("2026-09-01T00:00:00Z") }),
    ];
    const pct = (p: string, d: string) => pickRule(rules, p, d)?.percent?.toString() ?? pickRule(rules, p, d)?.mode ?? null;
    assert.equal(pct("dr-b", "2026-02-15"), "30");
    assert.equal(pct("dr-b", "2026-07-01"), "35");
    assert.equal(pct("dr-a", "2026-02-15"), "30", "before the doctor's own rule started, the default applies");
    assert.equal(pct("dr-a", "2026-04-01"), "60");
    assert.equal(pct("dr-a", "2026-09-01"), "FIXED", "the new rule applies from its start day");
    assert.equal(pct("dr-a", "2026-08-31"), "60", "and not before it");
    assert.equal(pickRule(rules, "dr-a", "2025-12-31"), null, "before any rule: none");
    const sameDay = [rule({ mode: "PERCENT", percent: "10", createdAt: new Date("2026-05-01T08:00:00Z"), effectiveFrom: new Date("2026-05-01T00:00:00Z") }), rule({ mode: "PERCENT", percent: "20", createdAt: new Date("2026-05-01T09:00:00Z"), effectiveFrom: new Date("2026-05-01T00:00:00Z") })];
    assert.equal(pickRule(sameDay, "x", "2026-05-02")?.percent?.toString(), "20", "two rules starting the same day: the later entry wins");
  });
});

describe("earnings split and booking reports (organisation and doctor views)", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let cashier: { id: string; token: string };
  let d1: TestDoctor;
  let d2: TestDoctor;
  let d3: TestDoctor;
  let day = 0;
  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const addRule = (body: Record<string, unknown>, tok = a.admin.token) => t.api("post", "/earnings/rules", tok).send(body);
  const farAt = (hour = 10) => { const d = new Date(Date.now() + (200 + 10 * day++) * 86_400_000); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 5, 30)).toISOString(); };

  /** A visit that really happened: seen, signed, and billed (and paid, when an amount is given). */
  const consulted = async (doc: TestDoctor, paid: string | null, billed = paid ?? "300") => {
    const p = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, doc, p.id);
    assert.equal((await t.api("post", `/queue/${v.queueId}/start`, doc.token)).status, 200);
    const n = await t.api("put", `/encounters/${v.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Fever for two days" } });
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doc.token).send({ text: "Viral fever", type: "PROVISIONAL" })).status, 201);
    const s = await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doc.token).send({ version: n.body.data.version });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal((await t.api("post", `/queue/${v.queueId}/complete`, doc.token)).status, 200);
    const inv = await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, encounterId: v.encounterId, kind: "OPD", lines: [{ description: "Consultation", unitPrice: billed, taxPercent: 0, quantity: 1 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal((await t.api("post", `/invoices/${inv.body.data.id}/issue`, cashier.token)).status, 200);
    if (paid) assert.equal((await t.api("post", `/invoices/${inv.body.data.id}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: paid }] })).status, 201);
    return { patient: p, ...v };
  };
  const org = async (q = "", tok = a.admin.token) => t.api("get", `/reports/bookings/by-doctor${q}`, tok);
  const mine = async (tok: string, q = "") => t.api("get", `/reports/bookings/my${q}`, tok);
  type DocRow = { practitionerId: string; doctor: string; booked: number; walkIns: number; cancelled: number; noShow: number; consulted: number; bookedAndConsulted: number; collected: string; hospitalShare: string; doctorShare: string; shareRule: string };
  const row = (body: { data: { doctors: DocRow[] } }, d: TestDoctor) => body.data.doctors.find((x) => x.practitionerId === d.practitionerId);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("earn-a");
    b = await t.makeTenant("earn-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    d1 = await makeDoctor(t, a);
    d2 = await makeDoctor(t, a);
    d3 = await makeDoctor(t, a);
    for (const d of [d1, d2, d3]) {
      await t.prisma.practitionerSchedule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ tenantId: a.tenantId, facilityId: a.facilityId, practitionerId: d.practitionerId, dayOfWeek, startMinute: 0, endMinute: 1439, slotMinutes: 15 })) });
    }
    assert.equal((await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "0" })).status, 201);
  });
  after(async () => { await t.close(); });

  describe("setting the split", () => {
    it("only people with EARNINGS_CONFIGURE set it; managers and reports staff can read it", async () => {
      const body = { mode: "PERCENT", percent: 50 };
      assert.equal((await addRule(body, rec.token)).status, 403);
      assert.equal((await addRule(body, cashier.token)).status, 403);
      assert.equal((await addRule(body, d1.token)).status, 403, "a doctor cannot set their own share");
      const manager = await t.makeUser(a, ["MANAGER"]);
      assert.equal((await addRule(body, manager.token)).status, 403);
      assert.equal((await t.api("get", "/earnings/rules", manager.token)).status, 200);
      assert.equal((await t.api("get", "/earnings/rules", rec.token)).status, 403);
      assert.equal((await t.api("get", "/earnings/rules")).status, 401);
    });
    it("validates what each mode needs, and the doctor must belong to this hospital", async () => {
      assert.equal((await addRule({ mode: "PERCENT" })).status, 400, "percent is needed");
      assert.equal((await addRule({ mode: "PERCENT", percent: 101 })).status, 400);
      assert.equal((await addRule({ mode: "PERCENT", percent: -1 })).status, 400);
      assert.equal((await addRule({ mode: "PERCENT", percent: 10.123 })).status, 400, "two decimals at most");
      assert.equal((await addRule({ mode: "PERCENT", percent: 50, fixedAmount: "100" })).status, 400, "a percentage rule has no fixed amount");
      assert.equal((await addRule({ mode: "FIXED" })).status, 400);
      assert.equal((await addRule({ mode: "FIXED", fixedAmount: "100", percent: 10 })).status, 400);
      assert.equal((await addRule({ mode: "FIXED", fixedAmount: "-5" })).status, 400);
      assert.equal((await addRule({ mode: "MIXED", fixedAmount: "100" })).status, 400);
      assert.equal((await addRule({ mode: "PERCENT", percent: 50, extra: 1 })).status, 400);
      assert.equal((await addRule({ mode: "PERCENT", percent: 50, practitionerId: randomUUID() })).status, 404);
      const bDoc = await makeDoctor(t, b);
      assert.equal((await addRule({ mode: "PERCENT", percent: 50, practitionerId: bDoc.practitionerId })).status, 404, "another hospital's doctor");
      const ok = await addRule({ mode: "MIXED", fixedAmount: "100", percent: 20, practitionerId: d3.practitionerId, effectiveFrom: "2030-01-01", note: "Test" });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.deepEqual([ok.body.data.mode, ok.body.data.percent, ok.body.data.fixedAmount, ok.body.data.effectiveFrom, ok.body.data.doctor !== null], ["MIXED", "20.00", "100.00", "2030-01-01", true]);
    });
    it("rules are kept as history, audited, and cannot be edited or deleted", async () => {
      const r = await addRule({ mode: "PERCENT", percent: 25 });
      assert.equal(r.status, 201);
      const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "EARNINGS_RULE_CREATED", entityId: r.body.data.id } });
      assert.equal((ev.metadata as Record<string, unknown>)["mode"], "PERCENT");
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "DoctorShareRule" SET percent = 99 WHERE id = '${r.body.data.id}'::uuid`), /append-only/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "DoctorShareRule" WHERE id = '${r.body.data.id}'::uuid`), /append-only/);
      assert.equal(((await t.api("get", "/earnings/rules", a.admin.token)).body.data as unknown[]).length >= 2, true);
    });
    it("the database refuses a rule with the wrong numbers for its mode", async () => {
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "DoctorShareRule" ("tenantId", "facilityId", mode, percent, "fixedAmount", "effectiveFrom", "createdById") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, 'PERCENT', 50, 10, '2026-01-01', '${a.admin.id}'::uuid)`), /doctor_share_rule_numbers|check constraint/i);
    });
  });

  describe("the reports", () => {
    let fresh: TestTenant;
    let e1: TestDoctor;
    let e2: TestDoctor;
    let e3: TestDoctor;
    let recF: { id: string; token: string };
    let cashF: { id: string; token: string };

    /** The same scenario in its own hospital so every number is exactly known. */
    before(async () => {
      fresh = await t.makeTenant("earn-r");
      recF = await t.makeUser(fresh, ["RECEPTIONIST"]);
      cashF = await t.makeUser(fresh, ["CASHIER"]);
      [e1, e2, e3] = [await makeDoctor(t, fresh), await makeDoctor(t, fresh), await makeDoctor(t, fresh)] as [TestDoctor, TestDoctor, TestDoctor];
      for (const d of [e1, e2, e3]) await t.prisma.practitionerSchedule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ tenantId: fresh.tenantId, facilityId: fresh.facilityId, practitionerId: d.practitionerId, dayOfWeek, startMinute: 0, endMinute: 1439, slotMinutes: 15 })) });
      assert.equal((await t.api("post", "/shifts/open", cashF.token).send({ openingCash: "0" })).status, 201);
      const visit = async (doc: TestDoctor, paid: string | null) => {
        const p = await registerPatient(t, recF.token);
        const v = await startVisit(t, recF.token, doc, p.id);
        await t.api("post", `/queue/${v.queueId}/start`, doc.token);
        const n = await t.api("put", `/encounters/${v.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Cough" } });
        await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doc.token).send({ text: "Cough", type: "PROVISIONAL" });
        assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doc.token).send({ version: n.body.data.version })).status, 200);
        assert.equal((await t.api("post", `/queue/${v.queueId}/complete`, doc.token)).status, 200);
        const inv = await t.api("post", "/invoices", cashF.token).send({ patientId: p.id, encounterId: v.encounterId, kind: "OPD", lines: [{ description: "Consultation", unitPrice: paid ?? "300", taxPercent: 0, quantity: 1 }] });
        await t.api("post", `/invoices/${inv.body.data.id}/issue`, cashF.token);
        if (paid) await t.api("post", `/invoices/${inv.body.data.id}/payments`, cashF.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: paid }] });
      };
      // Doctor e1: two consulted visits (one paid 500, one billed 300 and not yet paid), one booking later cancelled.
      await visit(e1, "500");
      await visit(e1, null);
      const p = await registerPatient(t, recF.token);
      const bk = await t.api("post", "/appointments", recF.token).send({ patientId: p.id, practitionerId: e1.practitionerId, startAt: farAt() });
      assert.equal(bk.status, 201, JSON.stringify(bk.body));
      // Doctor e2: one visit paid 1000 and one booking not turned up.
      await visit(e2, "1000");
      const p2 = await registerPatient(t, recF.token);
      const late = await t.api("post", "/appointments", recF.token).send({ patientId: p2.id, practitionerId: e2.practitionerId, startAt: new Date(Date.now() - 10 * 60_000).toISOString(), durationMinutes: 5 });
      assert.equal(late.status, 201, JSON.stringify(late.body));
      assert.equal((await t.api("post", `/appointments/${late.body.data.id}/no-show`, recF.token)).status, 200);
      // The first booking of e1 is for a far date, so it falls outside "today"; move its record to today to be counted, then cancel it.
      await t.prisma.$executeRawUnsafe(`UPDATE "Appointment" SET "startAt" = now() + interval '3 hours', "endAt" = now() + interval '3 hours 15 minutes' WHERE id = '${bk.body.data.id}'::uuid`);
      assert.equal((await t.api("post", `/appointments/${bk.body.data.id}/cancel`, recF.token).send({ reason: "Patient cannot come" })).status, 200);
      // Doctor e3 saw no one.
      assert.equal((await t.api("post", "/earnings/rules", fresh.admin.token).send({ mode: "PERCENT", percent: 40 })).status, 201);
      assert.equal((await t.api("post", "/earnings/rules", fresh.admin.token).send({ mode: "FIXED", fixedAmount: "300", practitionerId: e2.practitionerId })).status, 201);
    });

    it("organisation view: counts, money collected and the split, doctor by doctor", async () => {
      const r = await t.api("get", "/reports/bookings/by-doctor", fresh.admin.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const rows = r.body.data.doctors as DocRow[];
      const x1 = rows.find((d) => d.practitionerId === e1.practitionerId);
      const x2 = rows.find((d) => d.practitionerId === e2.practitionerId);
      assert.ok(x1 && x2);
      assert.deepEqual([x1.booked, x1.walkIns, x1.cancelled, x1.noShow, x1.consulted], [1, 2, 1, 0, 2], "e1: one booking (cancelled) and two walk-ins consulted");
      assert.deepEqual([x1.collected, x1.doctorShare, x1.hospitalShare], ["500.00", "200.00", "300.00"], "40% of 500; the unpaid 300 adds nothing yet");
      assert.match(x1.shareRule, /40% of the amount collected/);
      assert.deepEqual([x2.booked, x2.walkIns, x2.noShow, x2.consulted], [1, 1, 1, 1]);
      assert.deepEqual([x2.collected, x2.doctorShare, x2.hospitalShare], ["1000.00", "300.00", "700.00"], "e2 has their own fixed 300 per consulted visit");
      assert.match(x2.shareRule, /300\.00 for each consulted visit/);
      assert.equal(rows.some((d) => d.practitionerId === e3.practitionerId), false, "a doctor with no bookings is not listed");
      assert.deepEqual(r.body.data.totals, { booked: 2, walkIns: 3, cancelled: 1, noShow: 1, consulted: 3, bookedAndConsulted: 0, stillOpen: 0, collected: "1500.00", hospitalShare: "1000.00", doctorShare: "500.00" });
      assert.equal(r.body.data.days.length, 1);
    });
    it("a doctor sees only their own numbers, and not the hospital's share", async () => {
      const m1 = await mine(e1.token);
      assert.equal(m1.status, 200, JSON.stringify(m1.body));
      assert.equal(m1.body.data.doctor, (await t.prisma.practitioner.findFirstOrThrow({ where: { id: e1.practitionerId } })).displayName);
      assert.deepEqual(m1.body.data.totals, { booked: 1, walkIns: 2, cancelled: 1, noShow: 0, consulted: 2, bookedAndConsulted: 0, stillOpen: 0, collectedForMyVisits: "500.00", myShare: "200.00" });
      const m2 = await mine(e2.token);
      assert.deepEqual([m2.body.data.totals.consulted, m2.body.data.totals.collectedForMyVisits, m2.body.data.totals.myShare, m2.body.data.totals.noShow], [1, "1000.00", "300.00", 1]);
      const text = JSON.stringify(m1.body);
      assert.ok(!text.includes("hospitalShare") && !text.includes("doctors"), "no hospital share and no other doctors");
      assert.ok(!text.includes(e2.practitionerId), "nothing about another doctor");
      assert.equal(((await mine(e3.token)).body.data.days as unknown[]).length, 0, "a doctor with no bookings sees an empty report");
    });
    it("a doctor cannot ask for another doctor's numbers or the organisation view", async () => {
      assert.equal((await t.api("get", "/reports/bookings/by-doctor", e1.token)).status, 403);
      const sneaky = await t.api("get", `/reports/bookings/my?practitionerId=${e2.practitionerId}`, e1.token);
      assert.equal(sneaky.status, 400, "unknown parameter refused");
      assert.equal((await mine(e1.token, `?from=2020-01-01&to=2020-01-02`)).body.data.totals.consulted, 0);
    });
    it("who may open which view", async () => {
      const manager = await t.makeUser(fresh, ["MANAGER"]);
      const nurse = await t.makeUser(fresh, ["NURSE"]);
      assert.equal((await t.api("get", "/reports/bookings/by-doctor", manager.token)).status, 200, "REPORT_READ");
      assert.equal((await t.api("get", "/reports/bookings/by-doctor", cashF.token)).status, 200, "REPORT_FINANCE");
      assert.equal((await t.api("get", "/reports/bookings/by-doctor", recF.token)).status, 403);
      assert.equal((await t.api("get", "/reports/bookings/by-doctor", nurse.token)).status, 403);
      assert.equal((await t.api("get", "/reports/bookings/by-doctor")).status, 401);
      for (const tok of [fresh.admin.token, manager.token, cashF.token, recF.token, nurse.token]) assert.equal((await mine(tok)).status, 403, "the doctor view is for doctors");
      const notLinked = await makeUserWithPermissions(t, fresh, ["REPORT_MY_PRACTICE"]);
      const r = await mine(notLinked.token);
      assert.equal(r.status, 403);
      assert.match(r.body.error.message, /not linked to a doctor/);
    });
    it("a later rule does not change what earlier visits earned, and each view is limited to the hospital", async () => {
      assert.equal((await t.api("post", "/earnings/rules", fresh.admin.token).send({ mode: "PERCENT", percent: 90, effectiveFrom: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) })).status, 201);
      const r = await t.api("get", "/reports/bookings/by-doctor", fresh.admin.token);
      assert.equal((r.body.data.doctors as DocRow[]).find((d) => d.practitionerId === e1.practitionerId)?.doctorShare, "200.00", "today's visits still earn at today's 40%");
      const other = await t.api("get", "/reports/bookings/by-doctor", a.admin.token);
      assert.ok(!JSON.stringify(other.body).includes(e1.practitionerId), "another hospital sees none of it");
      assert.equal((await t.api("get", "/reports/bookings/by-doctor?from=2026-12-31&to=2026-01-01", fresh.admin.token)).status, 400);
      assert.equal((await t.api("get", "/reports/bookings/by-doctor?from=2026-01-01&to=2027-12-31", fresh.admin.token)).status, 400, "ranges are limited");
    });
  });

  // Quiet the unused helpers of the first hospital: they document how a single visit is built.
  it("a visit can be billed and paid in the first hospital too", async () => {
    const v = await consulted(d1, "400");
    assert.ok(v.encounterId);
    assert.equal(((await org()).body.data.doctors as DocRow[]).length >= 1, true);
    assert.equal(row({ data: { doctors: (await org()).body.data.doctors } }, d2), undefined);
    assert.equal((await mine(d1.token)).status, 200);
  });
});
