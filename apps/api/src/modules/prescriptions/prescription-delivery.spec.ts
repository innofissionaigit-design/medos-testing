import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { createMessageProvider, indianMobile, LogMessageProvider, MessageError } from "./message.provider";
import { PrescriptionDeliveryService } from "./prescription-delivery.service";

interface Hit { auth: string | undefined; body: { channel: string; to: string; text: string; reference: string } }
const KEY = "msg-key-123456";
const BASE = "https://hospital.example.com";
let seq = 0;
const mobileNo = () => `98300${String(10000 + ++seq).slice(-5)}`;

describe("sending the patient their prescription by message", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let nurse: { id: string; token: string };
  let doc: TestDoctor;
  let bRec: { id: string; token: string };
  let server: Server;
  const hits: Hit[] = [];
  let answer = 200;

  const setting = (key: string, value: unknown, tenant = a) => t.api("put", `/settings/${key}`, tenant.admin.token).send({ value });
  /** A visit with a prescription and a consultation, signed when `sign` is true. */
  const visit = async (o: { mobile?: string | null; sign?: boolean; first?: string } = {}) => {
    const own = mobileNo();
    const patient = await registerPatient(t, rec.token, { firstName: o.first ?? "Meera", mobile: own });
    // Registration needs a real Indian mobile number; a patient with none on record (an old record, say) is made by removing it afterwards.
    if (o.mobile !== undefined) await t.prisma.patient.update({ where: { id: patient.id }, data: { mobile: o.mobile } });
    const mobile = o.mobile === undefined ? own : o.mobile;
    const v = await startVisit(t, rec.token, doc, patient.id);
    await t.api("post", `/queue/${v.queueId}/start`, doc.token);
    await t.api("put", `/encounters/${v.encounterId}/prescription`, doc.token).send({ items: [{ genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3 }] });
    const n = await t.api("put", `/encounters/${v.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Fever for two days" } });
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doc.token).send({ text: "Viral fever", type: "PROVISIONAL" });
    const sign = async () => t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doc.token).send({ version: n.body.data.version });
    if (o.sign !== false) assert.equal((await sign()).status, 200);
    return { patient, mobile, encounterId: v.encounterId, sign };
  };
  const sendNow = (enc: string, tok = rec.token) => t.api("post", `/encounters/${enc}/prescription-deliveries`, tok);
  const soon = (ms = 3_000) => new Date(Date.now() + ms);
  const run = (now = soon()) => t.app.get(PrescriptionDeliveryService).runDue(now);
  const rowsOf = (enc: string) => t.prisma.prescriptionDelivery.findMany({ where: { encounterId: enc }, orderBy: { createdAt: "asc" } });
  /** The messages that went to one patient (the worker also sends anything else that is due, so a count of all messages would not be about this patient). */
  const sentTo = (mobile: string | null) => hits.filter((h) => h.body.to === `91${mobile}`);
  const tokenIn = (text: string) => /\/api\/share\/([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? "";

  before(async () => {
    process.env["MESSAGE_PROVIDER"] = "http";
    process.env["MESSAGE_API_KEY"] = KEY;
    process.env["PUBLIC_WEB_URL"] = BASE;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (answer === 200) hits.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) as Hit["body"] });
        res.writeHead(answer, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `wamid.${hits.length}` }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    process.env["MESSAGE_API_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}/send`;
    t = await startApp();
    a = await t.makeTenant("msg-a");
    b = await t.makeTenant("msg-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    bRec = await t.makeUser(b, ["RECEPTIONIST"]);
    nurse = await t.makeUser(a, ["NURSE"]);
    doc = await makeDoctor(t, a);
  });
  after(async () => { await t.close(); server.close(); for (const k of ["MESSAGE_PROVIDER", "MESSAGE_API_KEY", "PUBLIC_WEB_URL", "MESSAGE_API_URL"]) delete process.env[k]; });

  it("the provider settings: what is connected, and what the hospital chose; only people who share prescriptions see them", async () => {
    const c = await t.api("get", "/prescription-deliveries/config", rec.token);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.deepEqual(c.body.data, { provider: "http", connected: true, autoSend: false, channel: "WHATSAPP", linkDays: 7 });
    assert.equal((await t.api("get", "/prescription-deliveries/config", nurse.token)).status, 403);
    assert.equal((await t.api("get", "/prescription-deliveries/config")).status, 401);
    assert.equal((await setting("PRESCRIPTION_LINK_DAYS", 31)).status, 400);
    assert.equal((await setting("PRESCRIPTION_SEND_CHANNEL", "FAX")).status, 400);
  });

  it("staff press Send: the patient's mobile gets one message with a private link that opens the prescription; nothing readable is kept", async () => {
    const v = await visit({ first: "Meera" });
    hits.length = 0;
    const r = await sendNow(v.encounterId);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.data.status, r.body.data.attempts, r.body.data.channel, r.body.data.trigger, r.body.data.provider, r.body.data.sentForReal], ["SENT", 1, "WHATSAPP", "MANUAL", "http", true]);
    assert.equal(hits.length, 1);
    const h = hits[0]!;
    assert.equal(h.auth, `Bearer ${KEY}`);
    assert.deepEqual([h.body.channel, h.body.to, h.body.reference], ["WHATSAPP", `91${v.mobile}`, r.body.data.id]);
    assert.match(h.body.text, /^Dear Meera, your prescription from .+ is ready: https:\/\/hospital\.example\.com\/api\/share\/[A-Za-z0-9_-]{40,} \(this link works for 7 days\)\.$/);
    const open = await t.api("get", `/public/prescriptions/${tokenIn(h.body.text)}`);
    assert.equal(open.status, 200, "the link in the message opens the prescription");
    assert.match(open.text, /Paracetamol/);
    // What is kept: who it was for (masked), the channel and what happened. Not the text, not the number, not the link.
    assert.match(r.body.data.to, /^•+\d{4}$/);
    assert.equal(r.body.data.to.endsWith(String(v.mobile).slice(-4)), true);
    const row = (await rowsOf(v.encounterId))[0]!;
    const stored = JSON.stringify(row);
    assert.ok(!stored.includes(String(v.mobile)) && !stored.includes(tokenIn(h.body.text)) && !stored.includes("Dear Meera"));
    assert.equal(row.providerMessageId, "wamid.1");
    const audit = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: row.id } });
    assert.deepEqual(audit.map((e) => e.action).sort(), ["PRESCRIPTION_SEND_REQUESTED", "PRESCRIPTION_SENT"]);
    assert.ok(!JSON.stringify(audit).includes(String(v.mobile)), "the number is not in the audit trail");
    const list = (await t.api("get", `/encounters/${v.encounterId}/prescription-deliveries`, rec.token)).body.data;
    assert.equal(list.length, 1);
    assert.equal((await t.api("get", `/encounters/${v.encounterId}/prescription-deliveries`, nurse.token)).status, 403);
  });

  it("the hospital's channel choice is used; a message is refused when there is nothing signed, no number, or the patient said no", async () => {
    assert.equal((await setting("PRESCRIPTION_SEND_CHANNEL", "SMS")).status, 200);
    const v = await visit();
    hits.length = 0;
    assert.equal((await sendNow(v.encounterId)).status, 201);
    assert.equal(hits[0]!.body.channel, "SMS");
    assert.equal((await setting("PRESCRIPTION_SEND_CHANNEL", "WHATSAPP")).status, 200);
    const unsigned = await visit({ sign: false });
    assert.equal((await sendNow(unsigned.encounterId)).status, 409, "nothing signed yet");
    const none = await visit({ mobile: null });
    assert.equal((await sendNow(none.encounterId)).status, 409, "no mobile number");
    const said = await visit();
    assert.equal((await t.api("post", `/patients/${said.patient.id}/consents`, rec.token).send({ purpose: "APPOINTMENT_REMINDERS", status: "WITHDRAWN", method: "VERBAL" })).status, 201);
    hits.length = 0;
    const refused = await sendNow(said.encounterId);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /asked not to be sent messages/);
    assert.equal(hits.length, 0, "nothing was sent");
  });

  it("who may send; another hospital's visit answers 404; an unsigned or unknown visit", async () => {
    const v = await visit();
    assert.equal((await sendNow(v.encounterId, nurse.token)).status, 403);
    assert.equal((await sendNow(v.encounterId, bRec.token)).status, 404);
    assert.equal((await sendNow(randomUUID())).status, 404);
    assert.equal((await sendNow("not-an-id")).status, 404);
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/prescription-deliveries`)).status, 401);
    assert.equal((await t.api("get", `/encounters/${v.encounterId}/prescription-deliveries`, bRec.token)).status, 404);
    assert.equal((await t.api("post", `/prescription-deliveries/${randomUUID()}/retry`, rec.token)).status, 404);
    assert.equal((await t.api("post", `/prescription-deliveries/${randomUUID()}/retry`, bRec.token)).status, 404);
  });

  it("a provider that fails is tried again later; every failed try withdraws its link; after the last try the message is given up and staff can retry it", async () => {
    const v = await visit();
    answer = 500;
    const first = await sendNow(v.encounterId);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([first.body.data.status, first.body.data.attempts, first.body.data.sentForReal], ["PENDING", 1, false]);
    assert.match(first.body.data.error, /HTTP 500/);
    let row = (await rowsOf(v.encounterId))[0]!;
    assert.ok(row.nextAttemptAt.getTime() > Date.now(), "it waits before the next try");
    const shares = await t.prisma.prescriptionShare.findMany({ where: { encounterId: v.encounterId } });
    assert.deepEqual(shares.map((s) => s.status), ["REVOKED"], "the link of a failed try is withdrawn");
    let clock = Date.now();
    for (const mins of [2, 10, 40]) { clock += mins * 60_000; await run(new Date(clock)); }
    row = (await rowsOf(v.encounterId))[0]!;
    assert.deepEqual([row.status, row.attempts], ["FAILED", 4]);
    assert.ok((await t.prisma.prescriptionShare.findMany({ where: { encounterId: v.encounterId } })).every((s) => s.status === "REVOKED"), "no link from a failed message stays open");
    answer = 200;
    hits.length = 0;
    const retry = await t.api("post", `/prescription-deliveries/${row.id}/retry`, rec.token);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual([retry.body.data.status, retry.body.data.attempts], ["SENT", 1]);
    assert.equal(hits.length, 1);
    assert.equal((await t.api("post", `/prescription-deliveries/${row.id}/retry`, rec.token)).status, 404, "only a failed message can be retried");
    assert.equal(await t.prisma.prescriptionShare.count({ where: { encounterId: v.encounterId, status: "ACTIVE" } }), 1, "exactly one link is open: the one that was sent");
  });

  it("automatic sending: nothing happens while it is off; when it is on, signing queues a message that goes out; it respects consent and never blocks signing", async () => {
    const off = await visit();
    assert.equal((await rowsOf(off.encounterId)).length, 0, "off: signing queues nothing");
    assert.equal((await setting("PRESCRIPTION_AUTO_SEND", true)).status, 200);
    const on = await visit();
    let rows = await rowsOf(on.encounterId);
    assert.deepEqual(rows.map((r) => [r.trigger, r.status]), [["AUTO", "PENDING"]], "queued when signed");
    hits.length = 0;
    await run();
    rows = await rowsOf(on.encounterId);
    assert.deepEqual(rows.map((r) => r.status), ["SENT"]);
    assert.equal(sentTo(on.mobile).length, 1);
    await run();
    assert.equal(sentTo(on.mobile).length, 1, "sent once");
    // Nothing to send to: signing still works and queues nothing.
    const noMobile = await visit({ mobile: null });
    assert.equal((await rowsOf(noMobile.encounterId)).length, 0, "no mobile number");
    // A patient who has withdrawn is never messaged; with the hospital's consent rule on, only patients who agreed are.
    const said = await visit({ sign: false });
    assert.equal((await t.api("post", `/patients/${said.patient.id}/consents`, rec.token).send({ purpose: "APPOINTMENT_REMINDERS", status: "WITHDRAWN", method: "VERBAL" })).status, 201);
    assert.equal((await said.sign()).status, 200);
    assert.equal((await rowsOf(said.encounterId)).length, 0);
    assert.equal((await setting("REMINDERS_REQUIRE_CONSENT", true)).status, 200);
    const unknown = await visit();
    assert.equal((await rowsOf(unknown.encounterId)).length, 0, "no record of agreement");
    const agreed = await visit({ sign: false });
    assert.equal((await t.api("post", `/patients/${agreed.patient.id}/consents`, rec.token).send({ purpose: "APPOINTMENT_REMINDERS", status: "GRANTED", method: "VERBAL" })).status, 201);
    assert.equal((await agreed.sign()).status, 200);
    assert.equal((await rowsOf(agreed.encounterId)).length, 1, "agreed");
    assert.equal((await setting("REMINDERS_REQUIRE_CONSENT", false)).status, 200);
    assert.equal((await setting("PRESCRIPTION_AUTO_SEND", false)).status, 200);
  });

  it("consent is looked at again when the message goes out: a patient who withdraws after signing is not messaged", async () => {
    assert.equal((await setting("PRESCRIPTION_AUTO_SEND", true)).status, 200);
    const v = await visit();
    assert.equal((await rowsOf(v.encounterId)).length, 1);
    assert.equal((await t.api("post", `/patients/${v.patient.id}/consents`, rec.token).send({ purpose: "APPOINTMENT_REMINDERS", status: "WITHDRAWN", method: "VERBAL" })).status, 201);
    hits.length = 0;
    await run();
    const row = (await rowsOf(v.encounterId))[0]!;
    assert.equal(row.status, "FAILED");
    assert.match(row.lastError ?? "", /asked not to be sent messages/);
    assert.equal(sentTo(v.mobile).length, 0, "nothing went to this patient");
    assert.equal((await setting("PRESCRIPTION_AUTO_SEND", false)).status, 200);
  });

  it("DATABASE: a delivery cannot be deleted; its channel and trigger are limited to the known ones", async () => {
    const v = await visit();
    const r = await sendNow(v.encounterId);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PrescriptionDelivery" WHERE id = '${r.body.data.id}'::uuid`), /append-only/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PrescriptionDelivery" SET channel = 'TELEGRAM' WHERE id = '${r.body.data.id}'::uuid`), /prescription_delivery_values|check constraint/i);
  });

  it("the message helpers: Indian mobile numbers are recognised in their usual forms; the default provider only logs; failures never reveal the message or the key", async () => {
    assert.equal(indianMobile("98300 12345"), "9830012345");
    assert.equal(indianMobile("+91 98300-12345"), "9830012345");
    assert.equal(indianMobile("09830012345"), "9830012345");
    assert.equal(indianMobile("919830012345"), "9830012345");
    for (const bad of ["12345", "0334567890", "5830012345", "98300123456", "", null, undefined, "abcdefghij"]) assert.equal(indianMobile(bad as string | null | undefined), null, String(bad));
    const log = createMessageProvider({ MESSAGE_PROVIDER: "log", MESSAGE_TIMEOUT_MS: 5000 });
    assert.ok(log instanceof LogMessageProvider);
    assert.equal(log.configured, false);
    assert.match((await log.send({ channel: "SMS", to: "9830012345", text: "secret words", reference: "r1" })).providerMessageId, /^log-only:/);
    const down = createMessageProvider({ MESSAGE_PROVIDER: "http", MESSAGE_API_URL: "http://127.0.0.1:1/send", MESSAGE_API_KEY: "key-should-stay-hidden", MESSAGE_TIMEOUT_MS: 2000 });
    await assert.rejects(down.send({ channel: "SMS", to: "9830012345", text: "secret words", reference: "r2" }), (e: unknown) => e instanceof MessageError && /could not be reached/.test(e.message) && !/secret words|key-should-stay-hidden|9830012345/.test(e.message));
    const prod = createMessageProvider({ NODE_ENV: "production", MESSAGE_PROVIDER: "http", MESSAGE_API_URL: "https://127.0.0.1/send", MESSAGE_TIMEOUT_MS: 2000 });
    await assert.rejects(prod.send({ channel: "SMS", to: "9830012345", text: "x", reference: "r3" }), /public internet address/);
  });
});
