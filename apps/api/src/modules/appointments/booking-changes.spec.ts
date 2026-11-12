import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, makeUserWithPermissions, patientBody, registerPatient, startApp, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

describe("booking changes: postpone and prepone, duplicate bookings, cancellation and the patient ledger", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let cashier: { id: string; token: string };
  let doc: TestDoctor;
  let sameDept: TestDoctor;
  let otherDept: TestDoctor;
  let day = 0;

  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const at = (daysAhead: number, hour = 10) => {
    const d = new Date(Date.now() + daysAhead * 86_400_000);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 5, 30)).toISOString(); // hour:00 IST
  };
  const nextDay = () => 40 + 10 * day++; // each test gets its own stretch of days, so slots never clash between tests
  const book = (patientId: string, practitionerId: string, startAt: string, extra: Record<string, unknown> = {}, tok = rec.token) =>
    t.api("post", "/appointments", tok).send({ patientId, practitionerId, startAt, ...extra });
  const setting = (k: string, value: unknown) => t.api("put", `/settings/${k}`, a.admin.token).send({ value });
  /** The same person registered a second time with another mobile number (the desk confirmed it as a different person). */
  const twin = async (first: Record<string, unknown>) => registerPatient(t, rec.token, { ...first, mobile: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`, duplicateOverride: { confirmedDistinct: true, reason: "Says it is a different person" } });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("chg-a");
    b = await t.makeTenant("chg-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    doc = await makeDoctor(t, a);
    sameDept = await makeDoctor(t, a);
    otherDept = await makeDoctor(t, a);
    await t.prisma.practitioner.update({ where: { id: sameDept.practitionerId }, data: { departmentId: doc.departmentId } });
    sameDept.departmentId = doc.departmentId;
    for (const d of [doc, sameDept, otherDept]) {
      await t.prisma.practitionerSchedule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ tenantId: a.tenantId, facilityId: a.facilityId, practitionerId: d.practitionerId, dayOfWeek, startMinute: 0, endMinute: 1439, slotMinutes: 15 })) });
    }
    assert.equal((await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "0" })).status, 201);
  });
  after(async () => { await t.close(); });

  describe("postponing and preponing", () => {
    it("an appointment can be moved later or earlier, to another doctor too, and keeps its history", async () => {
      const p = await registerPatient(t, rec.token);
      const d0 = nextDay();
      const r = await book(p.id, doc.practitionerId, at(d0));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const later = await t.api("patch", `/appointments/${r.body.data.id}`, rec.token).send({ version: r.body.data.version, startAt: at(d0 + 3) });
      assert.equal(later.status, 200, JSON.stringify(later.body));
      const earlier = await t.api("patch", `/appointments/${r.body.data.id}`, rec.token).send({ version: later.body.data.version, startAt: at(d0 + 1, 11) });
      assert.equal(earlier.status, 200, "preponed to an earlier future date");
      const events = await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "APPOINTMENT_RESCHEDULED", entityId: r.body.data.id } });
      assert.equal(events, 2);
    });
    it("can never be moved to a date or time that has passed", async () => {
      const p = await registerPatient(t, rec.token);
      const r = await book(p.id, doc.practitionerId, at(nextDay()));
      const id = r.body.data.id as string;
      for (const when of [new Date(Date.now() - 2 * 86_400_000).toISOString(), new Date(Date.now() - 5 * 60_000).toISOString()]) {
        const x = await t.api("patch", `/appointments/${id}`, rec.token).send({ version: r.body.data.version, startAt: when });
        assert.equal(x.status, 400, when);
        assert.match(x.body.error.message, /already passed/);
      }
      assert.equal((await t.api("get", `/appointments/${id}`, rec.token)).body.data.startAt, r.body.data.startAt, "unchanged");
    });
  });

  describe("duplicate bookings", () => {
    it("the same patient twice with the same doctor is stopped; booking anyway needs a reason and is audited", async () => {
      const p = await registerPatient(t, rec.token);
      const d0 = nextDay();
      assert.equal((await book(p.id, doc.practitionerId, at(d0))).status, 201);
      const again = await book(p.id, doc.practitionerId, at(d0 + 2));
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, "DUPLICATE_BOOKING_SUSPECTED");
      assert.deepEqual([again.body.error.details.matches[0].rule, again.body.error.details.matches[0].match], ["SAME_DOCTOR", "SAME_PATIENT"]);
      const forced = await book(p.id, doc.practitionerId, at(d0 + 2), { duplicateOverride: { reason: "Second procedure on a separate day" } });
      assert.equal(forced.status, 201, JSON.stringify(forced.body));
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "APPOINTMENT_DUPLICATE_OVERRIDDEN", entityId: forced.body.data.id } }), 1);
    });
    it("the same person registered again with another mobile number is caught with the same doctor", async () => {
      const body = patientBody();
      const first = await registerPatient(t, rec.token, body);
      const second = await twin(body);
      assert.notEqual(first.id, second.id);
      const d0 = nextDay();
      assert.equal((await book(first.id, doc.practitionerId, at(d0))).status, 201);
      const dup = await book(second.id, doc.practitionerId, at(d0 + 1));
      assert.equal(dup.status, 409);
      const m = dup.body.error.details.matches[0];
      assert.deepEqual([m.rule, m.match, m.mrn], ["SAME_DOCTOR", "LIKELY_SAME_PERSON", first.mrn]);
    });
    it("…and with another doctor of the same department on the same day, but not on another day or in another department", async () => {
      const body = patientBody();
      const first = await registerPatient(t, rec.token, body);
      const second = await twin(body);
      const d0 = nextDay();
      assert.equal((await book(first.id, doc.practitionerId, at(d0, 10))).status, 201);
      const sameDay = await book(second.id, sameDept.practitionerId, at(d0, 16));
      assert.equal(sameDay.status, 409);
      assert.equal(sameDay.body.error.details.matches[0].rule, "SAME_DEPARTMENT_SAME_DAY");
      const otherDay = await book(second.id, sameDept.practitionerId, at(d0 + 1, 16));
      assert.equal(otherDay.status, 201, JSON.stringify(otherDay.body));
      const otherDeptBooking = await book(second.id, otherDept.practitionerId, at(d0, 17));
      assert.equal(otherDeptBooking.status, 201, JSON.stringify(otherDeptBooking.body));
    });
    it("different people, cancelled bookings and follow-ups are not duplicates", async () => {
      const d0 = nextDay();
      const p1 = await registerPatient(t, rec.token);
      const p2 = await registerPatient(t, rec.token);
      assert.equal((await book(p1.id, doc.practitionerId, at(d0, 9))).status, 201);
      assert.equal((await book(p2.id, doc.practitionerId, at(d0, 12))).status, 201, "an unrelated patient");
      const p3 = await registerPatient(t, rec.token);
      const old = await book(p3.id, doc.practitionerId, at(d0 + 1, 9));
      await t.api("post", `/appointments/${old.body.data.id}/cancel`, rec.token).send({ reason: "Patient cannot come" });
      assert.equal((await book(p3.id, doc.practitionerId, at(d0 + 2, 9))).status, 201, "a cancelled booking does not count");
      assert.equal((await book(p3.id, doc.practitionerId, at(d0 + 3, 9), { type: "FOLLOW_UP" })).status, 201, "follow-ups are planned repeats");
    });
    it("walk-ins and reschedules are checked too", async () => {
      const p = await registerPatient(t, rec.token);
      const today = await t.api("post", "/appointments/walk-in", rec.token).send({ patientId: p.id, practitionerId: doc.practitionerId });
      assert.equal(today.status, 201, JSON.stringify(today.body));
      const walk = await t.api("post", "/appointments/walk-in", rec.token).send({ patientId: p.id, practitionerId: sameDept.practitionerId });
      assert.equal(walk.status, 409, "a second walk-in in the same department the same day");
      const q = await registerPatient(t, rec.token);
      const d0 = nextDay();
      const one = await book(q.id, doc.practitionerId, at(d0, 9));
      const two = await book(q.id, otherDept.practitionerId, at(d0 + 1, 9));
      const move = await t.api("patch", `/appointments/${two.body.data.id}`, rec.token).send({ version: two.body.data.version, startAt: at(d0, 15), practitionerId: sameDept.practitionerId });
      assert.equal(move.status, 409, "moved next to a same-department booking that day");
      void one;
    });
    it("booking anyway needs the duplicate-override permission", async () => {
      const limited = await makeUserWithPermissions(t, a, ["PATIENT_READ", "APPOINTMENT_READ", "APPOINTMENT_CREATE"]);
      const p = await registerPatient(t, rec.token);
      const d0 = nextDay();
      await book(p.id, doc.practitionerId, at(d0));
      const r = await book(p.id, doc.practitionerId, at(d0 + 1), { duplicateOverride: { reason: "Needs a second slot" } }, limited.token);
      assert.equal(r.status, 403);
    });
  });

  describe("cancelling a paid booking, and the patient ledger", () => {
    const takeFee = (id: string) => t.api("post", `/appointments/${id}/booking-fee`, cashier.token).set("Idempotency-Key", key()).send({ tenders: [{ method: "CASH", amount: "300" }] });
    const giveBack = (depositId: string, amount: string) => t.api("post", `/advances/${depositId}/refunds`, cashier.token).set("Idempotency-Key", key()).send({ method: "CASH", amount, reason: "Booking cancelled, fee returned" });
    const ledger = async (patientId: string, tok = rec.token) => (await t.api("get", `/patients/${patientId}/ledger`, tok)).body.data as { entries: { kind: string; debit: string; credit: string; balance: string; description: string }[]; totals: { debit: string; credit: string; balance: string }; position: string };
    const paidBooking = async (hoursAhead?: number) => {
      const p = await registerPatient(t, rec.token);
      const r = await book(p.id, doc.practitionerId, at(nextDay()));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await takeFee(r.body.data.id)).status, 201);
      if (hoursAhead !== undefined) {
        await t.prisma.$executeRawUnsafe(`UPDATE "Appointment" SET "startAt" = now() + interval '${hoursAhead} hours', "endAt" = now() + interval '${hoursAhead} hours 15 minutes' WHERE id = '${r.body.data.id}'::uuid`);
      }
      return { patient: p, id: r.body.data.id as string };
    };
    const cancel = (id: string) => t.api("post", `/appointments/${id}/cancel`, rec.token).send({ reason: "Patient cannot come" });

    before(async () => {
      for (const [k, v] of [["BOOKING_FEE_ENABLED", true], ["BOOKING_FEE_AMOUNT", "300.00"], ["BOOKING_FEE_FREE_CANCEL_HOURS", 24], ["BOOKING_FEE_CANCEL_CHARGE_PERCENT", 50]] as [string, unknown][]) {
        assert.equal((await setting(k, v)).status, 200, k);
      }
    });

    it("cancelled in time: nothing is charged, the whole fee is held for the patient, and giving it back is a debit in the ledger", async () => {
      const { patient, id } = await paidBooking();
      assert.equal((await cancel(id)).status, 200);
      const appt = (await t.api("get", `/appointments/${id}`, rec.token)).body.data;
      assert.equal(appt.feeHeld.amount, "300.00");
      let l = await ledger(patient.id);
      assert.deepEqual(l.entries.map((e) => [e.kind, e.debit, e.credit, e.balance]), [["BOOKING_FEE_RECEIVED", "0.00", "300.00", "-300.00"]]);
      assert.equal(l.position, "HELD_FOR_PATIENT");
      assert.equal((await giveBack(appt.feeHeld.depositId, "300")).status, 201);
      l = await ledger(patient.id);
      const last = l.entries.at(-1);
      assert.deepEqual([last?.kind, last?.debit, last?.balance], ["BOOKING_FEE_GIVEN_BACK", "300.00", "0.00"]);
      assert.match(last?.description ?? "", /appointment cancelled/);
      assert.equal(l.position, "SETTLED");
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, patientId: patient.id } }), 0, "no charge");
    });
    it("cancelled late: the cancellation charge is billed and paid from the fee; only the rest can be given back", async () => {
      const { patient, id } = await paidBooking(2);
      assert.equal((await cancel(id)).status, 200);
      const inv = await t.prisma.invoice.findFirstOrThrow({ where: { tenantId: a.tenantId, patientId: patient.id }, include: { lines: true } });
      assert.deepEqual([inv.status, inv.total.toString(), inv.lines[0]?.sourceType], ["PAID", "150", "APPOINTMENT_CANCELLATION"]);
      const appt = (await t.api("get", `/appointments/${id}`, rec.token)).body.data;
      assert.equal(appt.feeHeld.amount, "150.00");
      const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "BOOKING_CANCELLATION_CHARGED", entityId: id } });
      assert.equal((ev.metadata as Record<string, unknown>)["charge"], "150.00");
      assert.equal((await giveBack(appt.feeHeld.depositId, "150.01")).status, 409, "never more than is held");
      assert.equal((await giveBack(appt.feeHeld.depositId, "150")).status, 201);
      const l = await ledger(patient.id);
      assert.deepEqual(l.entries.map((e) => [e.kind, e.debit, e.credit, e.balance]), [
        ["BOOKING_FEE_RECEIVED", "0.00", "300.00", "-300.00"],
        ["BILL", "150.00", "0.00", "-150.00"],
        ["PAID_FROM_ADVANCE", "0.00", "0.00", "-150.00"],
        ["BOOKING_FEE_GIVEN_BACK", "150.00", "0.00", "0.00"],
      ]);
      assert.deepEqual(l.totals, { debit: "300.00", credit: "300.00", balance: "0.00", insurerShare: "0.00", patientBalance: "0.00" });
    });
    it("no charge when the policy is 0%, however late", async () => {
      assert.equal((await setting("BOOKING_FEE_CANCEL_CHARGE_PERCENT", 0)).status, 200);
      const { patient, id } = await paidBooking(1);
      await cancel(id);
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, patientId: patient.id } }), 0);
      assert.equal((await t.api("get", `/appointments/${id}`, rec.token)).body.data.feeHeld.amount, "300.00");
      await setting("BOOKING_FEE_CANCEL_CHARGE_PERCENT", 50);
    });
    it("an ordinary bill paid in cash, then refunded after a credit note, balances to zero", async () => {
      const p = await registerPatient(t, rec.token);
      const d = await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, lines: [{ description: "Consultation", unitPrice: "500", taxPercent: 0, quantity: 1 }] });
      await t.api("post", `/invoices/${d.body.data.id}/issue`, cashier.token);
      await t.api("post", `/invoices/${d.body.data.id}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: "500" }] });
      const approver = await makeUserWithPermissions(t, a, ["INVOICE_READ", "INVOICE_ADJUST", "PAYMENT_REFUND"]);
      await t.api("post", `/invoices/${d.body.data.id}/credit-notes`, approver.token).set("Idempotency-Key", key()).send({ amount: "100", reason: "Discount agreed later" });
      const rf = await t.api("post", `/invoices/${d.body.data.id}/refunds`, cashier.token).set("Idempotency-Key", key()).send({ method: "CASH", amount: "100", reason: "Discount returned" });
      assert.equal(rf.status, 201, JSON.stringify(rf.body));
      const l = await ledger(p.id);
      assert.deepEqual(l.entries.map((e) => [e.kind, e.balance]), [["BILL", "500.00"], ["PAYMENT", "0.00"], ["CREDIT_NOTE", "-100.00"], ["REFUND", "0.00"]]);
    });
    it("is for people who can read bills, and stays inside the hospital", async () => {
      const p = await registerPatient(t, rec.token);
      const nurse = await t.makeUser(a, ["NURSE"]);
      assert.equal((await t.api("get", `/patients/${p.id}/ledger`, nurse.token)).status, 403);
      assert.equal((await t.api("get", `/patients/${p.id}/ledger`, b.admin.token)).status, 404);
      assert.equal((await t.api("get", `/patients/${p.id}/ledger`)).status, 401);
    });
  });
});
