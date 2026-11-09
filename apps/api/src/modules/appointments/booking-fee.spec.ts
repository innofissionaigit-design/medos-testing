import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { feeState, feePaid } from "./booking-fee";
import { Decimal } from "@medos/shared";

describe("booking fee: asked for at booking, skippable by permission with a reason", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let cashier: { id: string; token: string };
  let manager: { id: string; token: string };
  let doc: TestDoctor;
  let day = 0;

  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const setting = (k: string, value: unknown, tok = a.admin.token) => t.api("put", `/settings/${k}`, tok).send({ value });
  const turnOn = async (amount = "300.00") => { assert.equal((await setting("BOOKING_FEE_ENABLED", true)).status, 200); assert.equal((await setting("BOOKING_FEE_AMOUNT", amount)).status, 200); };
  const turnOff = async () => { assert.equal((await setting("BOOKING_FEE_ENABLED", false)).status, 200); };
  /** Books for a fresh patient on a far-away day (no clashes), then moves the appointment to now so it can be checked in. */
  const booked = async (extra: Record<string, unknown> = {}, tok = rec.token) => {
    const p = await registerPatient(t, rec.token);
    const startAt = new Date(Math.floor((Date.now() + (40 + day++) * 86_400_000) / 3_600_000) * 3_600_000).toISOString();
    const r = await t.api("post", "/appointments", tok).send({ patientId: p.id, practitionerId: doc.practitionerId, startAt, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient: p, appt: r.body.data as { id: string; bookingFee: string | null; feeStatus: string; feeDue: string; feeSkip: { reason: string } | null } };
  };
  let slot = 0;
  /** Moves the appointment to its own quarter-hour earlier today (local time), so several can be checked in for one doctor without clashing. */
  const today = (id: string) => {
    const n = slot++;
    return t.prisma.$executeRawUnsafe(`UPDATE "Appointment" SET "startAt" = (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') + interval '${n * 15} minutes', "endAt" = (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') + interval '${n * 15 + 10} minutes' WHERE id = '${id}'::uuid`);
  };
  const checkIn = (id: string) => t.api("post", `/appointments/${id}/check-in`, rec.token).send({});
  const takeFee = (id: string, tenders: unknown[], tok = cashier.token, k = key()) => t.api("post", `/appointments/${id}/booking-fee`, tok).set("Idempotency-Key", k).send({ tenders });
  const skip = (id: string, body: Record<string, unknown>, tok = a.admin.token) => t.api("post", `/appointments/${id}/booking-fee/skip`, tok).send(body);
  const get = async (id: string) => (await t.api("get", `/appointments/${id}`, a.admin.token)).body.data;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("fee-a");
    b = await t.makeTenant("fee-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    manager = await t.makeUser(a, ["MANAGER"]);
    doc = await makeDoctor(t, a);
    await t.prisma.practitionerSchedule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ tenantId: a.tenantId, facilityId: a.facilityId, practitionerId: doc.practitionerId, dayOfWeek, startMinute: 0, endMinute: 1439, slotMinutes: 15 })) });
    assert.equal((await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "0" })).status, 201);
  });
  after(async () => { await t.close(); });

  describe("domain", () => {
    it("a fee is paid by its advances less anything given back; a skip counts as settled", () => {
      const money = (v: string) => ({ toString: () => v });
      assert.equal(feePaid([{ amount: money("200"), refunds: [{ amount: money("50") }] }, { amount: money("100"), refunds: [] }]).toFixed(2), "250.00");
      assert.deepEqual(feeState({ bookingFee: null, feeSkippedAt: null }, new Decimal(0)).status, "NOT_REQUIRED");
      assert.deepEqual(feeState({ bookingFee: money("300"), feeSkippedAt: null }, new Decimal(100)), { status: "PENDING", fee: "300.00", paid: "100.00", due: "200.00" });
      assert.equal(feeState({ bookingFee: money("300"), feeSkippedAt: null }, new Decimal(300)).status, "PAID");
      assert.equal(feeState({ bookingFee: money("300"), feeSkippedAt: new Date() }, new Decimal(0)).status, "SKIPPED");
    });
  });

  describe("configuration", () => {
    it("is off by default; the settings are validated; anyone signed in can read the amount and reasons", async () => {
      const cfg = (await t.api("get", "/booking-fee/config", rec.token)).body.data;
      assert.deepEqual([cfg.enabled, cfg.amount], [false, "0.00"]);
      assert.ok(cfg.skipReasons.includes("Emergency"));
      assert.equal((await setting("BOOKING_FEE_AMOUNT", "abc")).status, 400);
      assert.equal((await setting("BOOKING_FEE_AMOUNT", "10.123")).status, 400);
      assert.equal((await setting("BOOKING_FEE_SKIP_REASONS", [])).status, 400);
      assert.equal((await setting("BOOKING_FEE_SKIP_REASONS", ["Camp", "camp"])).status, 400, "duplicates");
      assert.equal((await setting("BOOKING_FEE_ENABLED", true, rec.token)).status, 403, "only settings administrators");
      assert.equal((await t.api("get", "/booking-fee/config")).status, 401);
    });
    it("no fee is asked for while it is off, or when the amount is zero", async () => {
      await turnOff();
      assert.deepEqual([(await booked()).appt.bookingFee, (await booked()).appt.feeStatus], [null, "NOT_REQUIRED"]);
      assert.equal((await setting("BOOKING_FEE_ENABLED", true)).status, 200);
      assert.equal((await setting("BOOKING_FEE_AMOUNT", "0.00")).status, 200);
      assert.equal((await booked()).appt.feeStatus, "NOT_REQUIRED");
    });
  });

  describe("asking for the fee", () => {
    it("a new booking carries the fee, and a later change of the setting does not alter it", async () => {
      await turnOn("300.00");
      const { appt } = await booked();
      assert.deepEqual([appt.bookingFee, appt.feeStatus, appt.feeDue], ["300.00", "PENDING", "300.00"]);
      await setting("BOOKING_FEE_AMOUNT", "500.00");
      const again = await get(appt.id);
      assert.equal(again.bookingFee, "300.00", "keeps the fee it was booked with");
      await turnOn("300.00");
    });
    it("follow-ups and walk-ins never carry a fee", async () => {
      await turnOn();
      assert.equal((await booked({ type: "FOLLOW_UP" })).appt.feeStatus, "NOT_REQUIRED");
      const p = await registerPatient(t, rec.token);
      const w = await t.api("post", "/appointments/walk-in", rec.token).send({ patientId: p.id, practitionerId: doc.practitionerId });
      assert.equal(w.status, 201, JSON.stringify(w.body));
      assert.equal(w.body.data.appointment.feeStatus, "NOT_REQUIRED");
    });
    it("check-in is blocked while the fee is unpaid, and says how much", async () => {
      await turnOn("300.00");
      const { appt } = await booked();
      await today(appt.id);
      const r = await checkIn(appt.id);
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, "BOOKING_FEE_PENDING");
      assert.equal(r.body.error.details.due, "300.00");
      assert.equal((await get(appt.id)).status, "BOOKED");
    });
  });

  describe("paying the fee", () => {
    it("takes the fee as an advance tied to the appointment; then check-in works; a retry is replayed", async () => {
      await turnOn("300.00");
      const { appt, patient } = await booked();
      await today(appt.id);
      const k = key();
      assert.equal((await takeFee(appt.id, [{ method: "CASH", amount: "299.99" }])).status, 409, "less than the fee");
      const ok = await takeFee(appt.id, [{ method: "CASH", amount: "100" }, { method: "UPI", amount: "200", reference: "UPI-445566" }], cashier.token, k);
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal((await takeFee(appt.id, [{ method: "CASH", amount: "100" }, { method: "UPI", amount: "200", reference: "UPI-445566" }], cashier.token, k)).status, 200, "replayed");
      assert.equal(await t.prisma.advanceDeposit.count({ where: { tenantId: a.tenantId, appointmentId: appt.id } }), 1);
      const after = await get(appt.id);
      assert.deepEqual([after.feeStatus, after.feePaid, after.feeDue], ["PAID", "300.00", "0.00"]);
      assert.equal((await takeFee(appt.id, [{ method: "CASH", amount: "300" }])).status, 409, "already paid");
      assert.equal((await checkIn(appt.id)).status, 200);
      const adv = (await t.api("get", `/patients/${patient.id}/advances`, cashier.token)).body.data;
      assert.equal(adv.balance, "300.00", "the fee is the patient's advance, usable against the visit's bill");
    });
    it("cashiers and reception take it; other roles and other hospitals are refused", async () => {
      await turnOn("300.00");
      const { appt } = await booked();
      const nurse = await t.makeUser(a, ["NURSE"]);
      assert.equal((await takeFee(appt.id, [{ method: "CASH", amount: "300" }], nurse.token)).status, 403, "a nurse cannot take money");
      const bCashier = await t.makeUser(b, ["CASHIER"]);
      assert.equal((await takeFee(appt.id, [{ method: "UPI", amount: "300", reference: "UPI-000111" }], bCashier.token)).status, 404);
      assert.equal((await takeFee(randomUUID(), [{ method: "CASH", amount: "300" }])).status, 404);
    });
    it("an appointment without a fee has nothing to take", async () => {
      await turnOff();
      const { appt } = await booked();
      assert.equal((await takeFee(appt.id, [{ method: "CASH", amount: "300" }])).status, 409);
      await turnOn("300.00");
    });
  });

  describe("at the front desk", () => {
    it("reception takes the fee or skips it for a special case, and then checks the patient in", async () => {
      await turnOn("300.00");
      const one = await booked();
      await today(one.appt.id);
      const paid = await takeFee(one.appt.id, [{ method: "UPI", amount: "300", reference: "UPI-778899" }], rec.token);
      assert.equal(paid.status, 201, JSON.stringify(paid.body));
      assert.equal((await checkIn(one.appt.id)).status, 200);
      const two = await booked();
      await today(two.appt.id);
      assert.equal((await skip(two.appt.id, { reason: "Staff or family" }, rec.token)).status, 200);
      assert.equal((await checkIn(two.appt.id)).status, 200);
      const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "BOOKING_FEE_SKIPPED", entityId: two.appt.id } });
      assert.equal(ev.actorUserId, rec.id, "the skip is recorded against the receptionist");
    });
  });

  describe("skipping the fee in a special case", () => {
    it("needs the permission and one of the configured reasons; then check-in works", async () => {
      await turnOn("300.00");
      const { appt } = await booked();
      await today(appt.id);
      const nurse = await t.makeUser(a, ["NURSE"]);
      assert.equal((await skip(appt.id, { reason: "Emergency" }, nurse.token)).status, 403, "a nurse cannot skip a fee");
      assert.equal((await skip(appt.id, { reason: "Because I said so" })).status, 400, "not a configured reason");
      assert.equal((await skip(appt.id, {})).status, 400);
      const ok = await skip(appt.id, { reason: "emergency", note: "Brought in by ambulance" }, manager.token);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual([ok.body.data.feeStatus, ok.body.data.feeSkip.reason], ["SKIPPED", "Emergency"], "stored as configured, whatever the case typed");
      assert.equal((await checkIn(appt.id)).status, 200);
    });
    it("is recorded: who, why, how much; it appears in the audit trail and the report", async () => {
      await turnOn("450.00");
      const { appt } = await booked();
      assert.equal((await skip(appt.id, { reason: "Free camp", note: "Eye camp" })).status, 200);
      const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "BOOKING_FEE_SKIPPED", entityId: appt.id } });
      const meta = ev.metadata as Record<string, unknown>;
      assert.deepEqual([meta["fee"], meta["reason"], ev.actorUserId], ["450.00", "Free camp", a.admin.id]);
      const rep = (await t.api("get", "/reports/booking-fee-skips", a.admin.token)).body.data;
      assert.ok(rep.skipped >= 1);
      assert.ok(rep.byReason.some((x: { reason: string }) => x.reason === "Free camp"));
      const row = rep.rows.find((x: { note: string | null }) => x.note === "Eye camp");
      assert.deepEqual([row.fee, row.reason, row.skippedBy !== null], ["450.00", "Free camp", true]);
      assert.equal((await t.api("get", "/reports/booking-fee-skips", rec.token)).status, 403);
      assert.equal((await t.api("get", "/reports/booking-fee-skips", manager.token)).status, 200);
    });
    it("cannot be skipped twice, after payment, after check-in, where there is no fee, or by another hospital", async () => {
      await turnOn("300.00");
      const one = await booked();
      assert.equal((await skip(one.appt.id, { reason: "Referral" })).status, 200);
      assert.equal((await skip(one.appt.id, { reason: "Referral" })).status, 409, "twice");
      assert.equal((await takeFee(one.appt.id, [{ method: "CASH", amount: "300" }])).status, 409, "a skipped fee is not then collected");

      const two = await booked();
      await takeFee(two.appt.id, [{ method: "CASH", amount: "300" }]);
      assert.equal((await skip(two.appt.id, { reason: "Referral" })).status, 409, "already paid");

      const three = await booked();
      await skip(three.appt.id, { reason: "Referral" });
      await today(three.appt.id);
      await checkIn(three.appt.id);
      const four = await booked();
      await today(four.appt.id);
      await skip(four.appt.id, { reason: "Referral" });
      await checkIn(four.appt.id);
      assert.equal((await skip(four.appt.id, { reason: "Referral" })).status, 409);

      await turnOff();
      const none = await booked();
      assert.equal((await skip(none.appt.id, { reason: "Referral" })).status, 409, "no fee to skip");
      await turnOn("300.00");
      const five = await booked();
      assert.equal((await skip(five.appt.id, { reason: "Referral" }, b.admin.token)).status, 404);
    });
  });

  describe("the database", () => {
    it("fixes the fee and a recorded skip once written", async () => {
      await turnOn("300.00");
      const { appt } = await booked();
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Appointment" SET "bookingFee" = 1 WHERE id = '${appt.id}'::uuid`), /cannot be changed/);
      await skip(appt.id, { reason: "Referral" });
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Appointment" SET "feeSkipReason" = 'Other' WHERE id = '${appt.id}'::uuid`), /cannot be changed/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Appointment" SET "feeSkippedAt" = NULL, "feeSkippedById" = NULL, "feeSkipReason" = NULL, "feeSkipNote" = NULL WHERE id = '${appt.id}'::uuid`), /cannot be changed/);
    });
    it("a booking fee must be paid for the appointment's own patient", async () => {
      await turnOn("300.00");
      const { appt } = await booked();
      const other = await registerPatient(t, rec.token);
      await assert.rejects(
        t.prisma.$executeRawUnsafe(`INSERT INTO "AdvanceDeposit" (id, "tenantId", "facilityId", "patientId", "appointmentId", "receiptNumber", amount, "receivedById") VALUES (gen_random_uuid(), '${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${other.id}'::uuid, '${appt.id}'::uuid, 'X-${randomUUID().slice(0, 8)}', 1, '${cashier.id}'::uuid)`),
        /own patient/,
      );
    });
  });
});
