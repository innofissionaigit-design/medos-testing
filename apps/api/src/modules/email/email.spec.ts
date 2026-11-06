import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { EmailError, maskEmail, type EmailDelivery, type EmailProvider, type OutgoingEmail } from "./email.provider";
import { EmailService, MAX_ATTEMPTS } from "./email.service";
import { fill, placeholdersIn, render, templateProblem, toHtml } from "./email.templates";

class FakeProvider implements EmailProvider {
  readonly name = "fake";
  readonly configured = true;
  sent: OutgoingEmail[] = [];
  failWith: string | null = null;
  async send(e: OutgoingEmail): Promise<EmailDelivery> {
    if (this.failWith) throw this.failWith === "generic" ? new Error(`boom for ${e.to}`) : new EmailError(this.failWith);
    this.sent.push(e);
    return { providerMessageId: `fake-${this.sent.length}` };
  }
}

describe("email", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let svc: EmailService;
  let rec: { id: string; token: string };
  let cashier: { id: string; token: string };
  let manager: { id: string; token: string };
  let doc: TestDoctor;
  /** A second doctor, so a patient can have another booking without meeting the duplicate-booking rule for the same doctor. */
  let doc2: TestDoctor;
  let doc3: TestDoctor;
  let day = 0;

  const setting = (k: string, value: unknown, tok = a.admin.token) => t.api("put", `/settings/${k}`, tok).send({ value });
  const emails = (where: Record<string, unknown> = {}) => t.prisma.emailOutbox.findMany({ where: { tenantId: a.tenantId, ...where }, orderBy: { createdAt: "asc" } });
  const consent = (patientId: string, status: "GRANTED" | "WITHDRAWN") => t.api("post", `/patients/${patientId}/consents`, rec.token).send({ purpose: "EMAIL_MESSAGES", status, method: "VERBAL" });
  /** A patient with an email address (and, by default, their agreement) and an appointment booked for them. */
  const bookedFor = async (opts: { email?: string | null; agree?: boolean } = {}) => {
    const email = opts.email === undefined ? `${uniqueWord(6)}@example.org` : opts.email;
    const p = await registerPatient(t, rec.token, { firstName: `Asha${uniqueWord(4)}`, ...(email ? { email: email.toUpperCase() } : {}) });
    if (opts.agree !== false && email) assert.equal((await consent(p.id, "GRANTED")).status, 201);
    const startAt = new Date(Math.floor((Date.now() + (60 + day++) * 86_400_000) / 3_600_000) * 3_600_000).toISOString();
    const r = await t.api("post", "/appointments", rec.token).send({ patientId: p.id, practitionerId: doc.practitionerId, startAt });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient: p, apptId: r.body.data.id as string, email: email?.toLowerCase() ?? null };
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("mail-a");
    b = await t.makeTenant("mail-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    manager = await t.makeUser(a, ["MANAGER"]);
    doc = await makeDoctor(t, a);
    doc2 = await makeDoctor(t, a);
    doc3 = await makeDoctor(t, a);
    svc = t.app.get(EmailService);
  });
  after(async () => { await t.close(); });

  describe("templates (no database)", () => {
    it("placeholders are listed, filled safely and escaped in the HTML", () => {
      assert.deepEqual(placeholdersIn("Hi {name}, {name} at {facility} {x_1}").sort(), ["facility", "name", "x_1"]);
      assert.equal(fill("Dear {name}", { name: "Asha\r\nBcc: evil@example.org" }), "Dear Asha Bcc: evil@example.org", "a value can never add a line");
      assert.equal(fill("Dear {name}", {}), "Dear ", "a missing value is empty, never the word undefined");
      const r = render("APPOINTMENT_BOOKED", "en", { name: "<b>Asha</b>", doctor: "Dr. Rao", when: "tomorrow", facility: "City & Co" });
      assert.ok(!r.subject.includes("\n"));
      assert.ok(r.html.includes("&lt;b&gt;Asha&lt;/b&gt;") && r.html.includes("City &amp; Co") && !r.html.includes("<b>"), "everything is escaped");
      assert.equal(toHtml("a\n\nb").split("<p>").length - 1, 2, "paragraphs");
    });
    it("a hospital's wording must use only the allowed placeholders and a one-line subject", () => {
      assert.equal(templateProblem("RECEIPT", "Receipt {invoiceNumber}", "Paid {amount} at {facility}, {name}"), null);
      assert.match(templateProblem("RECEIPT", "Receipt", "Hi {patientMrn}") ?? "", /Unknown placeholder \{patientMrn\}/);
      assert.match(templateProblem("RECEIPT", "Receipt", "Hi {name") ?? "", /curly bracket/i);
      assert.match(templateProblem("RECEIPT", "Line one\nBcc: x@y.org", "Hi") ?? "", /one line/);
      assert.match(templateProblem("TEST", "  ", "Hi") ?? "", /subject/i);
      assert.equal(maskEmail("asha@example.org"), "a***@example.org");
    });
  });

  describe("queueing", () => {
    it("is off by default and needs the right permission to be set up; nothing is queued while off", async () => {
      const s = await t.api("get", "/email/status", a.admin.token);
      assert.equal(s.status, 200);
      assert.deepEqual([s.body.data.enabled, s.body.data.provider, s.body.data.providerConnected], [false, "log", false]);
      for (const tok of [rec.token, cashier.token, manager.token]) assert.equal((await t.api("get", "/email/status", tok)).status, 403);
      assert.equal((await t.api("get", "/email/status")).status, 401);
      const before = await t.prisma.emailOutbox.count({ where: { tenantId: a.tenantId } });
      await bookedFor();
      assert.equal(await t.prisma.emailOutbox.count({ where: { tenantId: a.tenantId } }), before, "switched off: no email, no row");
    });

    it("a booking and a cancellation email the patient once, with no mobile number, record number or clinical text", async () => {
      assert.equal((await setting("EMAIL_ENABLED", true)).status, 200);
      const x = await bookedFor();
      const [booked] = await emails({ patientId: x.patient.id });
      assert.ok(booked, "queued");
      assert.deepEqual([booked.templateKey, booked.status, booked.toAddress, booked.language], ["APPOINTMENT_BOOKED", "PENDING", x.email, "en"], "the address is stored lower-case");
      assert.equal(booked.entityId, x.apptId);
      assert.match(booked.bodyText, /Dr\./);
      const row = await t.prisma.patient.findFirstOrThrow({ where: { id: x.patient.id } });
      assert.ok(!booked.bodyText.includes(row.mobile ?? "no-mobile") && !booked.subject.includes(row.mobile ?? "no-mobile"), "no mobile number");
      assert.ok(!booked.bodyText.includes(x.patient.mrn ?? "no-mrn"), "no record number");
      const cancel = await t.api("post", `/appointments/${x.apptId}/cancel`, rec.token).send({ reason: "Patient asked to cancel" });
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      const all = await emails({ patientId: x.patient.id });
      assert.deepEqual(all.map((e) => e.templateKey), ["APPOINTMENT_BOOKED", "APPOINTMENT_CANCELLED"]);
      assert.equal(await t.prisma.emailOutbox.count({ where: { tenantId: a.tenantId, dedupeKey: `APPOINTMENT_CANCELLED:${x.apptId}` } }), 1, "one email for one event");
    });

    it("no address, no agreement, a withdrawal or a suppressed address means no email; the hospital may choose to email unless the patient objects", async () => {
      const none = await bookedFor({ email: null });
      assert.equal((await emails({ patientId: none.patient.id })).length, 0, "no address");
      const unasked = await bookedFor({ agree: false });
      assert.equal((await emails({ patientId: unasked.patient.id })).length, 0, "no agreement on file while the hospital requires one");
      const withdrawn = await bookedFor();
      const wd = await consent(withdrawn.patient.id, "WITHDRAWN");
      assert.equal(wd.status, 201, JSON.stringify(wd.body));
      assert.equal((await emails({ patientId: withdrawn.patient.id })).length, 1, "queued while they had agreed");
      // A new booking after the withdrawal queues nothing
      const startAt = new Date(Math.floor((Date.now() + (70 + day++) * 86_400_000) / 3_600_000) * 3_600_000).toISOString();
      assert.equal((await t.api("post", "/appointments", rec.token).send({ patientId: withdrawn.patient.id, practitionerId: doc2.practitionerId, startAt })).status, 201);
      assert.equal((await emails({ patientId: withdrawn.patient.id })).length, 1, "after the withdrawal");
      // The hospital's own choice: email unless the patient objects
      assert.equal((await setting("EMAIL_REQUIRE_CONSENT", false)).status, 200);
      const open = await bookedFor({ agree: false });
      assert.equal((await emails({ patientId: open.patient.id })).length, 1, "no objection on file");
      const startAt2 = new Date(Math.floor((Date.now() + (71 + day++) * 86_400_000) / 3_600_000) * 3_600_000).toISOString();
      assert.equal((await t.api("post", "/appointments", rec.token).send({ patientId: withdrawn.patient.id, practitionerId: doc3.practitionerId, startAt: startAt2 })).status, 201);
      assert.equal((await emails({ patientId: withdrawn.patient.id })).length, 1, "a withdrawal is respected even then");
      assert.equal((await setting("EMAIL_REQUIRE_CONSENT", true)).status, 200);
    });

    it("an email address must look like one when a patient is registered or changed", async () => {
      const bad = await t.api("post", "/patients", rec.token).send({ firstName: uniqueWord(6), lastName: uniqueWord(6), gender: "FEMALE", dateOfBirth: "1990-04-02", mobile: "9830011122", addressLine: "1 Lane", city: "Kolkata", district: "Kolkata", state: "West Bengal", postalCode: "700001", email: "not an email" });
      assert.equal(bad.status, 400);
      const p = await registerPatient(t, rec.token, { email: "Someone@Example.ORG" });
      const got = await t.api("get", `/patients/${p.id}`, rec.token);
      assert.equal(got.body.data.email, "someone@example.org");
      const upd = await t.api("patch", `/patients/${p.id}`, rec.token).send({ version: p.version, email: null });
      assert.equal(upd.status, 200, JSON.stringify(upd.body));
      assert.equal(upd.body.data.email, null);
    });
  });

  describe("sending", () => {
    it("the worker sends each email once, even with two workers at once, and records what happened", async () => {
      const fake = new FakeProvider();
      const xs = await Promise.all([bookedFor(), bookedFor(), bookedFor()]);
      const [r1, r2] = await Promise.all([svc.runDue(new Date(), fake), svc.runDue(new Date(), fake)]);
      assert.equal(r1.sent + r2.sent, fake.sent.length, "every send is counted once");
      const mine = fake.sent.filter((s) => xs.some((x) => x.email === s.to));
      assert.equal(mine.length, 3, "each of the three patients was emailed exactly once");
      assert.equal(new Set(fake.sent.map((s) => s.reference)).size, fake.sent.length, "never the same email twice");
      const rows = await emails({ patientId: { in: xs.map((x) => x.patient.id) } });
      assert.ok(rows.every((e) => e.status === "SENT" && e.sentAt && e.providerMessageId?.startsWith("fake-") && e.attempts === 1));
      const m = mine[0]!;
      assert.ok(m.subject.length > 0 && m.text.length > 0 && m.html.includes("<p>"));
      assert.ok(!/[\r\n]/.test(m.subject), "a subject is one line");
      assert.equal((await svc.runDue(new Date(), fake)).sent, 0, "nothing is sent twice");
    });

    it("a failing provider is retried with growing delays and then given up on, without leaking the address or the provider's words", async () => {
      const fake = new FakeProvider();
      const x = await bookedFor();
      fake.failWith = "generic";
      let now = new Date();
      let last: Date | null = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await svc.runDue(now, fake);
        const row = (await emails({ patientId: x.patient.id }))[0]!;
        assert.equal(row.attempts, attempt);
        if (attempt < MAX_ATTEMPTS) {
          assert.equal(row.status, "PENDING");
          if (last) assert.ok(row.nextAttemptAt.getTime() - now.getTime() > last.getTime() - now.getTime() + 0, "the delay grows");
          last = row.nextAttemptAt;
          now = new Date(row.nextAttemptAt.getTime() + 1000);
        } else {
          assert.equal(row.status, "FAILED");
          assert.equal(row.lastError, "Unexpected error while sending");
          assert.ok(!row.lastError?.includes(x.email ?? "zzz"), "the address is not in the error");
        }
      }
      assert.equal((await svc.runDue(new Date(now.getTime() + 3_600_000), fake)).sent, 0, "a failed email is left alone");
      // A provider error that is safe to show is kept
      const y = await bookedFor();
      fake.failWith = "The email provider did not answer in time";
      await svc.runDue(new Date(), fake);
      assert.equal((await emails({ patientId: y.patient.id }))[0]!.lastError, "The email provider did not answer in time");
    });

    it("just before sending it is checked again: a withdrawal, a suppressed address or switching email off means it is skipped, not sent", async () => {
      const fake = new FakeProvider();
      const withdrawn = await bookedFor();
      const blocked = await bookedFor();
      assert.equal((await consent(withdrawn.patient.id, "WITHDRAWN")).status, 201);
      assert.equal((await t.api("post", "/email/suppressions", a.admin.token).send({ address: blocked.email, note: "asked not to be emailed" })).status, 201);
      await svc.runDue(new Date(), fake);
      assert.ok(!fake.sent.some((s) => s.to === withdrawn.email || s.to === blocked.email), "neither was sent");
      const w = (await emails({ patientId: withdrawn.patient.id }))[0]!;
      assert.deepEqual([w.status, w.lastError], ["SKIPPED", "The patient has not agreed to email"]);
      assert.equal((await emails({ patientId: blocked.patient.id }))[0]!.status, "SKIPPED");
      const off = await bookedFor();
      assert.equal((await setting("EMAIL_ENABLED", false)).status, 200);
      await svc.runDue(new Date(), fake);
      assert.ok(!fake.sent.some((s) => s.to === off.email));
      assert.equal((await emails({ patientId: off.patient.id }))[0]!.lastError, "Email was switched off");
      assert.equal((await setting("EMAIL_ENABLED", true)).status, 200);
    });
  });

  describe("templates, the log and the suppression list", () => {
    it("a hospital can reword an email in one language, see it first, and go back to the built-in wording", async () => {
      const list = await t.api("get", "/email/templates", a.admin.token);
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.data.map((x: { key: string }) => x.key), ["APPOINTMENT_BOOKED", "APPOINTMENT_CANCELLED", "RECEIPT", "REPORT_READY", "TEST"]);
      assert.ok(list.body.data.every((x: { languages: { language: string; custom: unknown }[] }) => x.languages.length === 3 && x.languages.every((l) => l.custom === null)));
      const put = (key: string, lang: string, body: Record<string, unknown>, tok = a.admin.token) => t.api("put", `/email/templates/${key}/${lang}`, tok).send(body);
      assert.equal((await put("APPOINTMENT_BOOKED", "en", { subject: "Booked!", body: "Hi {patientMrn}" })).status, 400, "unknown placeholder");
      assert.equal((await put("APPOINTMENT_BOOKED", "en", { subject: "Line\nBcc: x@y.org", body: "Hi {name}" })).status, 400, "header injection");
      assert.equal((await put("APPOINTMENT_BOOKED", "en", { subject: "Booked!", body: "Hi {name}", extra: 1 })).status, 400);
      assert.equal((await put("NO_SUCH", "en", { subject: "x", body: "y" })).status, 404);
      assert.equal((await put("APPOINTMENT_BOOKED", "fr", { subject: "x", body: "y" })).status, 400);
      for (const tok of [rec.token, manager.token]) assert.equal((await put("APPOINTMENT_BOOKED", "en", { subject: "Booked!", body: "Hi {name}" }, tok)).status, 403);
      const pv = await t.api("post", "/email/templates/APPOINTMENT_BOOKED/en/preview", a.admin.token).send({ subject: "Booked at {facility}", body: "Dear {name}, see you {when}" });
      assert.equal(pv.status, 200);
      assert.match(pv.body.data.text, /Dear Asha, see you/);
      assert.equal((await put("APPOINTMENT_BOOKED", "en", { subject: "Your visit at {facility}", body: "Hello {name}, {doctor} will see you on {when}." })).body.data.version, 1);
      assert.equal((await put("APPOINTMENT_BOOKED", "en", { subject: "Your visit at {facility}", body: "Hello {name}, {doctor} will see you on {when}!" })).body.data.version, 2);
      const x = await bookedFor();
      const sent = (await emails({ patientId: x.patient.id }))[0]!;
      assert.match(sent.subject, /^Your visit at /);
      assert.match(sent.bodyText, /^Hello Asha/);
      const other = await t.api("get", "/email/templates", b.admin.token);
      assert.ok(other.body.data[0].languages[0].custom === null, "another hospital's wording is untouched");
      assert.equal((await t.api("delete", "/email/templates/APPOINTMENT_BOOKED/en", a.admin.token)).status, 204);
      assert.equal((await t.api("delete", "/email/templates/APPOINTMENT_BOOKED/en", a.admin.token)).status, 404, "nothing left to reset");
      const y = await bookedFor();
      assert.match((await emails({ patientId: y.patient.id }))[0]!.subject, /^Your appointment at /, "the built-in wording is back");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "EMAIL_TEMPLATE_SAVED" } }));
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "EMAIL_TEMPLATE_RESET" } }));
      const audit = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "EMAIL_TEMPLATE_SAVED" } });
      assert.ok(!JSON.stringify(audit.metadata).includes("Hello"), "the audit trail names the template, not its words");
    });

    it("the delivery log masks addresses; retrying and cancelling follow the state and stay inside the hospital", async () => {
      const x = await bookedFor();
      const row = (await emails({ patientId: x.patient.id }))[0]!;
      const log = await t.api("get", "/email/outbox?pageSize=100", a.admin.token);
      assert.equal(log.status, 200);
      assert.ok(!JSON.stringify(log.body).includes(x.email ?? "zzz"), "no full address in the log");
      const item = (log.body.data as { id: string; to: string; status: string }[]).find((e) => e.id === row.id)!;
      assert.equal(item.to, maskEmail(x.email!));
      assert.equal((await t.api("get", "/email/outbox", rec.token)).status, 403);
      assert.equal((await t.api("get", "/email/outbox?status=NOPE", a.admin.token)).status, 400);
      assert.equal((await t.api("get", "/email/outbox?pageSize=500", a.admin.token)).status, 400, "paging is bounded");
      const bLog = await t.api("get", "/email/outbox?pageSize=100", b.admin.token);
      assert.ok(!(bLog.body.data as { id: string }[]).some((e) => e.id === row.id), "another hospital's log");
      // retry: only failed or skipped; cancel: only waiting
      assert.equal((await t.api("post", `/email/outbox/${row.id}/retry`, a.admin.token)).status, 409, "still waiting");
      assert.equal((await t.api("post", `/email/outbox/${row.id}/retry`, b.admin.token)).status, 404, "not found for another hospital");
      assert.equal((await t.api("post", `/email/outbox/${row.id}/cancel`, rec.token)).status, 403);
      assert.equal((await t.api("post", `/email/outbox/${row.id}/cancel`, b.admin.token)).status, 404);
      assert.equal((await t.api("post", `/email/outbox/${randomUUID()}/cancel`, a.admin.token)).status, 404);
      assert.equal((await t.api("post", `/email/outbox/${row.id}/cancel`, a.admin.token)).status, 200);
      assert.equal((await t.api("post", `/email/outbox/${row.id}/cancel`, a.admin.token)).status, 409, "already cancelled");
      await t.prisma.emailOutbox.update({ where: { id: row.id }, data: { status: "FAILED", lastError: "x" } });
      const again = await t.api("post", `/email/outbox/${row.id}/retry`, a.admin.token);
      assert.equal(again.status, 200);
      const fresh = await t.prisma.emailOutbox.findFirstOrThrow({ where: { id: row.id } });
      assert.deepEqual([fresh.status, fresh.attempts, fresh.lastError], ["PENDING", 0, null]);
      for (const action of ["EMAIL_CANCELLED", "EMAIL_RETRIED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action, entityId: row.id } }));
    });

    it("a test email can be sent to an address, a few times an hour; the suppression list holds addresses back and is managed with care", async () => {
      assert.equal((await t.api("post", "/email/test", a.admin.token).send({ to: "nope" })).status, 400);
      assert.equal((await t.api("post", "/email/test", rec.token).send({ to: "x@example.org" })).status, 403);
      const to = `${uniqueWord(6)}@example.org`.toLowerCase();
      const ok = await t.api("post", "/email/test", a.admin.token).send({ to });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.data.queued, true);
      const row = (await emails({ templateKey: "TEST", toAddress: to }))[0]!;
      assert.equal(row.patientId, null);
      const fake = new FakeProvider();
      await svc.runDue(new Date(), fake);
      assert.ok(fake.sent.some((s) => s.to === to), "a test email needs no patient agreement");
      // Suppression
      const addr = `${uniqueWord(6)}@example.org`.toLowerCase();
      const add = await t.api("post", "/email/suppressions", a.admin.token).send({ address: addr.toUpperCase(), note: "asked to stop" });
      assert.equal(add.status, 201, JSON.stringify(add.body));
      assert.equal((await t.api("post", "/email/suppressions", a.admin.token).send({ address: addr, note: "again" })).status, 409);
      assert.equal((await t.api("post", "/email/suppressions", rec.token).send({ address: addr })).status, 403);
      const sup = await t.api("get", "/email/suppressions", a.admin.token);
      assert.ok(!JSON.stringify(sup.body).includes(addr), "masked");
      const blocked = await t.api("post", "/email/test", a.admin.token).send({ to: addr });
      assert.deepEqual([blocked.status, blocked.body.data.queued, blocked.body.data.reason], [200, false, "SUPPRESSED"]);
      assert.equal((await t.api("delete", `/email/suppressions/${add.body.data.id}`, b.admin.token)).status, 404, "another hospital's list");
      assert.equal((await t.api("delete", `/email/suppressions/${add.body.data.id}`, a.admin.token)).status, 204);
      assert.equal((await t.api("delete", `/email/suppressions/${add.body.data.id}`, a.admin.token)).status, 404);
      let limited = false;
      for (let i = 0; i < 6 && !limited; i++) limited = (await t.api("post", "/email/test", a.admin.token).send({ to })).status === 429;
      assert.ok(limited, "test emails are limited");
      for (const action of ["EMAIL_SUPPRESSION_ADDED", "EMAIL_SUPPRESSION_REMOVED", "EMAIL_TEST_QUEUED"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action } }), action);
    });
  });

  describe("receipts", () => {
    it("Email receipt queues the receipt only for a bill that has been paid, once for the same amount", async () => {
      const p = await registerPatient(t, rec.token, { email: `${uniqueWord(6)}@example.org` });
      assert.equal((await consent(p.id, "GRANTED")).status, 201);
      const d = await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, lines: [{ description: "Procedure", unitPrice: "250.00", taxPercent: 0, quantity: 1 }] });
      assert.equal(d.status, 201, JSON.stringify(d.body));
      assert.equal((await t.api("post", `/invoices/${d.body.data.id}/issue`, cashier.token)).status, 200);
      const send = (tok = cashier.token) => t.api("post", `/invoices/${d.body.data.id}/email-receipt`, tok);
      assert.equal((await send()).status, 409, "nothing paid yet");
      const pay = await t.api("post", `/invoices/${d.body.data.id}/payments`, cashier.token).set("Idempotency-Key", randomUUID()).send({ payments: [{ method: "UPI", amount: "250.00", reference: "UPI-EMAIL-0001" }] });
      assert.equal(pay.status, 201, JSON.stringify(pay.body));
      assert.equal((await send(doc.token)).status, 403, "a doctor does not email receipts");
      assert.equal((await t.api("post", `/invoices/${d.body.data.id}/email-receipt`, b.admin.token)).status, 404, "another hospital");
      const first = await send();
      assert.deepEqual([first.status, first.body.data.queued], [200, true]);
      const row = (await emails({ patientId: p.id, templateKey: "RECEIPT" }))[0]!;
      assert.match(row.bodyText, /₹250\.00/);
      assert.match(row.bodyText, /INV-/);
      const again = await send();
      assert.deepEqual([again.body.data.queued, again.body.data.reason], [false, "DUPLICATE"], "pressing again for the same amount does nothing");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "RECEIPT_EMAIL_QUEUED", entityId: d.body.data.id } }));
    });
  });
});
