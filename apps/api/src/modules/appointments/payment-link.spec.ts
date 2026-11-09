import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { AUTO_CANCEL_REASON, MAX_SEND_ATTEMPTS, PaymentLinksService, paymentLinkText } from "./payment-links.service";
import type { PaymentLinkMessage, PaymentLinkProvider } from "./payment-link.provider";

class FakeProvider implements PaymentLinkProvider {
  readonly name = "fake";
  sent: PaymentLinkMessage[] = [];
  failing = false;
  async send(m: PaymentLinkMessage) {
    if (this.failing) throw new Error("gateway down");
    this.sent.push(m);
    return { providerMessageId: `fake-${m.linkId}` };
  }
}

const MIN = 60_000;

describe("booking payment link: a deadline for the booking fee, with automatic cancellation", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let bRec: { id: string; token: string };
  let cashier: { id: string; token: string };
  let doc: TestDoctor;
  let bDoc: TestDoctor;
  let links: PaymentLinksService;
  let day = 0;

  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const setting = (tenant: TestTenant, k: string, value: unknown) => t.api("put", `/settings/${k}`, tenant.admin.token).send({ value });
  const turnOn = async (tenant = a, window = 60) => {
    for (const [k, v] of [["BOOKING_FEE_ENABLED", true], ["BOOKING_FEE_AMOUNT", "300.00"], ["BOOKING_PAYMENT_LINK_ENABLED", true], ["BOOKING_PAYMENT_WINDOW_MINUTES", window]] as [string, unknown][]) {
      assert.equal((await setting(tenant, k, v)).status, 200, k);
    }
  };
  type Appt = { id: string; bookingFee: string | null; feeStatus: string; status: string; cancelReason: string | null; paymentLink: { status: string; dueBy: string; sendStatus: string; placeholder: boolean } | null };
  const booked = async (tenant = a, patientOverrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const [token, doctor] = tenant === a ? [rec.token, doc] : [bRec.token, bDoc];
    const p = await registerPatient(t, token, patientOverrides);
    const startAt = new Date(Math.floor((Date.now() + (40 + day++) * 86_400_000) / 3_600_000) * 3_600_000).toISOString();
    const r = await t.api("post", "/appointments", token).send({ patientId: p.id, practitionerId: doctor.practitionerId, startAt, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient: p, appt: r.body.data as Appt };
  };
  const get = async (id: string, tenant = a) => (await t.api("get", `/appointments/${id}`, tenant.admin.token)).body.data as Appt;
  const link = (id: string) => t.prisma.bookingPaymentLink.findFirstOrThrow({ where: { appointmentId: id } });
  const takeFee = (id: string, amount = "300") => t.api("post", `/appointments/${id}/booking-fee`, cashier.token).set("Idempotency-Key", key()).send({ tenders: [{ method: "CASH", amount }] });
  const skip = (id: string) => t.api("post", `/appointments/${id}/booking-fee/skip`, a.admin.token).send({ reason: "Referral" });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("lnk-a");
    b = await t.makeTenant("lnk-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    bRec = await t.makeUser(b, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    doc = await makeDoctor(t, a);
    bDoc = await makeDoctor(t, b);
    for (const [tenant, d] of [[a, doc], [b, bDoc]] as const) {
      await t.prisma.practitionerSchedule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ tenantId: tenant.tenantId, facilityId: tenant.facilityId, practitionerId: d.practitionerId, dayOfWeek, startMinute: 0, endMinute: 1439, slotMinutes: 15 })) });
    }
    assert.equal((await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "0" })).status, 201);
    links = t.app.get(PaymentLinksService);
  });
  after(async () => { await t.close(); });

  describe("configuration", () => {
    it("is off by default, validated, and shown with the fee settings", async () => {
      const cfg = (await t.api("get", "/booking-fee/config", rec.token)).body.data;
      assert.deepEqual([cfg.paymentLinkEnabled, cfg.paymentWindowMinutes], [false, 60]);
      assert.equal((await setting(a, "BOOKING_PAYMENT_WINDOW_MINUTES", 14)).status, 400);
      assert.equal((await setting(a, "BOOKING_PAYMENT_WINDOW_MINUTES", 10_081)).status, 400);
      assert.equal((await setting(a, "BOOKING_PAYMENT_WINDOW_MINUTES", 30.5)).status, 400);
      assert.equal((await setting(a, "BOOKING_PAYMENT_LINK_ENABLED", "yes")).status, 400);
      assert.equal((await t.api("put", "/settings/BOOKING_PAYMENT_LINK_ENABLED", rec.token).send({ value: true })).status, 403);
    });
  });

  describe("when a link and deadline are created", () => {
    it("a fee-bearing booking gets a link with a deadline, shown on the appointment, and the message is marked as a placeholder", async () => {
      await turnOn(a, 90);
      const before = Date.now();
      const { appt } = await booked();
      assert.equal(appt.feeStatus, "PENDING");
      assert.equal(appt.paymentLink?.status, "PENDING");
      const due = new Date(appt.paymentLink?.dueBy ?? 0).getTime();
      assert.ok(due >= before + 89 * MIN && due <= Date.now() + 91 * MIN, "90 minutes from booking");
      assert.equal(appt.paymentLink?.placeholder, true);
      const row = await link(appt.id);
      assert.equal(row.amount.toString(), "300");
      assert.match(row.token, /^[0-9a-f]{48}$/);
    });
    it("none when the feature is off, there is no fee, the patient has no mobile, or has withdrawn", async () => {
      await turnOn();
      assert.equal((await booked(a, {}, { type: "FOLLOW_UP" })).appt.paymentLink, null, "follow-ups carry no fee");
      const noMobile = await booked(a, { mobile: undefined });
      assert.equal(noMobile.appt.feeStatus, "PENDING");
      assert.equal(noMobile.appt.paymentLink, null, "no mobile number: no deadline");
      const withdrawn = await registerPatient(t, rec.token);
      assert.equal((await t.api("post", `/patients/${withdrawn.id}/consents`, rec.token).send({ purpose: "APPOINTMENT_REMINDERS", status: "WITHDRAWN", method: "VERBAL" })).status, 201);
      const startAt = new Date(Math.floor((Date.now() + (40 + day++) * 86_400_000) / 3_600_000) * 3_600_000).toISOString();
      const r = await t.api("post", "/appointments", rec.token).send({ patientId: withdrawn.id, practitionerId: doc.practitionerId, startAt });
      assert.equal(r.body.data.paymentLink, null, "withdrawn consent is respected");
      assert.equal((await setting(a, "BOOKING_PAYMENT_LINK_ENABLED", false)).status, 200);
      assert.equal((await booked()).appt.paymentLink, null, "off: the fee waits, no deadline");
      await setting(a, "BOOKING_PAYMENT_LINK_ENABLED", true);
    });
    it("the deadline never runs past the appointment time", async () => {
      await turnOn(a, 10_080);
      const { appt } = await booked();
      assert.ok(new Date(appt.paymentLink?.dueBy ?? 0).getTime() <= (await t.prisma.appointment.findFirstOrThrow({ where: { id: appt.id } })).startAt.getTime());
      await turnOn(a, 60);
    });
  });

  describe("sending the link (placeholder delivery)", () => {
    it("sends once, with the amount, the window and the link, and no patient name; a repeat run sends nothing", async () => {
      await turnOn();
      const { appt, patient } = await booked();
      const fake = new FakeProvider();
      const c = await links.runDue(new Date(), fake);
      assert.ok(c.sent >= 1);
      const m = fake.sent.find((x) => x.appointmentId === appt.id);
      assert.ok(m, "the message for this booking was sent");
      const row = await link(appt.id);
      assert.match(m.text, /₹300\.00/);
      assert.match(m.text, /within 60 minutes/);
      assert.ok(m.text.includes(`https://pay.example.invalid/booking/${row.token}`));
      const full = await t.prisma.patient.findFirstOrThrow({ where: { id: patient.id } });
      assert.ok(!m.text.includes(full.firstName), "no patient name in the message");
      assert.equal(row.sendStatus, "SENT");
      assert.equal(row.providerMessageId, `fake-${row.id}`);
      assert.equal((await links.runDue(new Date(), fake)).sent, 0);
    });
    it("a failing gateway is retried, gives up after three tries, and the deadline still stands", async () => {
      await turnOn();
      const { appt } = await booked();
      const fake = new FakeProvider();
      fake.failing = true;
      let now = new Date();
      for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
        await links.runDue(now, fake);
        now = new Date(now.getTime() + 11 * MIN);
      }
      const row = await link(appt.id);
      assert.deepEqual([row.sendStatus, row.sendAttempts, row.status], ["FAILED", MAX_SEND_ATTEMPTS, "PENDING"]);
      assert.match(row.lastError ?? "", /gateway down/);
    });
    it("the default provider only logs: its message id says nothing was sent", async () => {
      await turnOn();
      const { appt } = await booked();
      await links.runDue(new Date());
      const row = await link(appt.id);
      assert.ok(row.providerMessageId?.startsWith("log-only:"));
      assert.equal((await get(appt.id)).paymentLink?.placeholder, true);
    });
    it("the text is short and has no clinical detail", () => {
      const text = paymentLinkText({ doctor: "Dr. Roy", facility: "Demo City Hospital", startAt: new Date("2026-11-20T04:30:00Z"), timezone: "Asia/Kolkata", amount: "300.00", minutes: 60, url: "https://pay.example.invalid/booking/abc" });
      assert.ok(text.length < 320, String(text.length));
      assert.match(text, /10:00/);
    });
  });

  describe("automatic cancellation", () => {
    it("an unpaid booking is cancelled after its deadline, with the reason, the link expired and an audit row with no actor", async () => {
      await turnOn();
      const { appt } = await booked();
      const row = await link(appt.id);
      assert.equal((await links.runDue(new Date(row.dueBy.getTime() - MIN), new FakeProvider())).cancelled, 0, "not yet due");
      assert.equal((await get(appt.id)).status, "BOOKED");

      const c = await links.runDue(new Date(row.dueBy.getTime() + MIN), new FakeProvider());
      assert.ok(c.cancelled >= 1);
      const after = await get(appt.id);
      assert.deepEqual([after.status, after.cancelReason, after.paymentLink?.status], ["CANCELLED", AUTO_CANCEL_REASON, "EXPIRED"]);
      const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "APPOINTMENT_AUTO_CANCELLED", entityId: appt.id } });
      assert.equal(ev.actorUserId, null);
      const meta = ev.metadata as Record<string, unknown>;
      assert.deepEqual([meta["reason"], meta["fee"], meta["paid"]], [AUTO_CANCEL_REASON, "300.00", "0.00"]);
      assert.equal((await links.runDue(new Date(row.dueBy.getTime() + 5 * MIN), new FakeProvider())).cancelled, 0, "nothing to do the second time");
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "APPOINTMENT_AUTO_CANCELLED", entityId: appt.id } }), 1);
      // Reception is told once, and the second run adds nothing (notifications.md); another hospital's reception is not.
      assert.equal(await t.prisma.notification.count({ where: { tenantId: a.tenantId, recipientUserId: rec.id, type: "BOOKING_AUTO_CANCELLED", entityId: appt.id } }), 1);
      assert.equal(await t.prisma.notification.count({ where: { tenantId: b.tenantId, recipientUserId: bRec.id, entityId: appt.id } }), 0);
    });
    it("an automatic cancellation also emails the patient that the appointment was cancelled (with their agreement)", async () => {
      await turnOn();
      assert.equal((await t.api("put", "/settings/EMAIL_ENABLED", a.admin.token).send({ value: true })).status, 200);
      try {
        const address = `auto${Date.now()}@example.org`;
        const { patient, appt } = await booked(a, { email: address });
        await t.prisma.patientConsent.create({ data: { tenantId: a.tenantId, patientId: patient.id, purpose: "EMAIL_MESSAGES", status: "GRANTED", method: "VERBAL", recordedById: rec.id } });
        const row = await link(appt.id);
        await links.runDue(new Date(row.dueBy.getTime() + MIN), new FakeProvider());
        assert.equal((await get(appt.id)).status, "CANCELLED");
        const cancelled = await t.prisma.emailOutbox.findMany({ where: { tenantId: a.tenantId, patientId: patient.id, templateKey: "APPOINTMENT_CANCELLED" } });
        assert.equal(cancelled.length, 1);
        assert.equal(cancelled[0]!.toAddress, address);
      } finally {
        await t.api("put", "/settings/EMAIL_ENABLED", a.admin.token).send({ value: false });
      }
    });
    it("a fee paid before the deadline is never cancelled, even long after it", async () => {
      await turnOn();
      const { appt } = await booked();
      assert.equal((await takeFee(appt.id)).status, 201);
      const row = await link(appt.id);
      assert.deepEqual([row.status, row.closedAt !== null], ["PAID", true]);
      await links.runDue(new Date(row.dueBy.getTime() + 60 * MIN), new FakeProvider());
      const after = await get(appt.id);
      assert.deepEqual([after.status, after.feeStatus], ["BOOKED", "PAID"]);
    });
    it("a skipped fee is not cancelled either", async () => {
      await turnOn();
      const { appt } = await booked();
      assert.equal((await skip(appt.id)).status, 200);
      const row = await link(appt.id);
      assert.equal(row.status, "CANCELLED");
      await links.runDue(new Date(row.dueBy.getTime() + 60 * MIN), new FakeProvider());
      assert.equal((await get(appt.id)).status, "BOOKED");
    });
    it("an appointment cancelled by staff closes its link; no second cancellation", async () => {
      await turnOn();
      const { appt } = await booked();
      assert.equal((await t.api("post", `/appointments/${appt.id}/cancel`, rec.token).send({ reason: "Patient called to cancel" })).status, 200);
      const row = await link(appt.id);
      assert.equal(row.status, "CANCELLED");
      await links.runDue(new Date(row.dueBy.getTime() + 60 * MIN), new FakeProvider());
      assert.equal((await get(appt.id)).cancelReason, "Patient called to cancel", "the person's reason is kept");
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "APPOINTMENT_AUTO_CANCELLED", entityId: appt.id } }), 0);
    });
    it("two workers at once cancel it exactly once", async () => {
      await turnOn();
      const { appt } = await booked();
      const row = await link(appt.id);
      const now = new Date(row.dueBy.getTime() + MIN);
      const [x, y] = await Promise.all([links.runDue(now, new FakeProvider()), links.runDue(now, new FakeProvider())]);
      assert.ok(x.cancelled + y.cancelled >= 1);
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "APPOINTMENT_AUTO_CANCELLED", entityId: appt.id } }), 1);
      assert.equal((await get(appt.id)).status, "CANCELLED");
    });
    it("each hospital's bookings are cancelled in its own books: the audit row carries that hospital", async () => {
      await turnOn(a);
      await turnOn(b);
      const one = await booked(a);
      const two = await booked(b);
      const far = new Date(Date.now() + 3 * 60 * MIN);
      await links.runDue(far, new FakeProvider());
      assert.equal((await get(one.appt.id, a)).status, "CANCELLED");
      assert.equal((await get(two.appt.id, b)).status, "CANCELLED");
      const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { action: "APPOINTMENT_AUTO_CANCELLED", entityId: two.appt.id } });
      assert.equal(ev.tenantId, b.tenantId);
      assert.equal((await t.api("get", `/appointments/${two.appt.id}`, a.admin.token)).status, 404, "and the other hospital cannot see it");
    });
  });

  describe("the database", () => {
    it("a link cannot be changed or reopened, and cannot be deleted", async () => {
      await turnOn();
      const { appt } = await booked();
      const row = await link(appt.id);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "BookingPaymentLink" SET "dueBy" = now() WHERE id = '${row.id}'::uuid`), /cannot be changed/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "BookingPaymentLink" SET amount = 1 WHERE id = '${row.id}'::uuid`), /cannot be changed/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "BookingPaymentLink" WHERE id = '${row.id}'::uuid`), /append-only|cannot/);
      await takeFee(appt.id);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "BookingPaymentLink" SET status = 'PENDING', "closedAt" = NULL WHERE id = '${row.id}'::uuid`), /reopened/);
    });
  });
});
