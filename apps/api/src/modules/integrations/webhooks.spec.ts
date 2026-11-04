import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { assertOutboundUrl } from "../../common/outbound";
import { ipAllowed, parseAllowList } from "../../common/ip-allow";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { WebhooksService } from "./webhooks.service";

interface Hit { headers: Record<string, string | string[] | undefined>; body: string }
const idem = () => `bot-${randomUUID().slice(0, 16)}`;
const mobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
let day = 0;
const at = (daysAhead: number, hour = 10) => { const d = new Date(Date.now() + daysAhead * 86_400_000); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 5, 30)).toISOString(); };
const nextDay = () => 40 + 10 * day++;

describe("integration webhooks and the IP allow-list", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let doc: TestDoctor;
  let server: Server;
  let url: string;
  let answer = 200;
  const hits: Hit[] = [];

  const makeClient = async (extra: Record<string, unknown> = {}, tenant = a) => {
    const r = await t.api("post", "/integrations/clients", tenant.admin.token).send({ name: `Bot ${uniqueWord(6)}`, abilities: ["REGISTER_PATIENTS", "BOOK_APPOINTMENTS"], ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { client: { id: string; allowedIps: string[] }; apiKey: string };
  };
  const hook = (clientId: string, body: Record<string, unknown> = {}, tok = a.admin.token) => t.api("put", `/integrations/clients/${clientId}/webhook`, tok).send({ url, events: ["appointment.booked", "appointment.moved", "appointment.cancelled"], ...body });
  /** A key with a webhook, and its secret. */
  const wired = async (body: Record<string, unknown> = {}) => {
    const c = await makeClient();
    const r = await hook(c.client.id, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { ...c, secret: r.body.data.secret as string };
  };
  const book = async (apiKey: string) => {
    const p = await t.api("post", "/booking/patients", apiKey).set("Idempotency-Key", idem()).send({ firstName: "Anita", lastName: uniqueWord(8), gender: "FEMALE", mobile: mobile(), estimatedAgeYears: 34 });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const r = await t.api("post", "/appointments", apiKey).set("Idempotency-Key", idem()).send({ patientId: p.body.data.id, practitionerId: doc.practitionerId, startAt: at(nextDay()) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.data.id as string, version: r.body.data.version as number, patientId: p.body.data.id as string };
  };
  const soon = (ms = 3_000) => new Date(Date.now() + ms);
  const run = (now = soon()) => t.app.get(WebhooksService).runDue(now);
  const state = async (clientId: string) => (await rows(clientId)).map((r) => [r.event, r.status, r.attempts]);
  const rows = (clientId: string) => t.prisma.webhookDelivery.findMany({ where: { endpoint: { clientId } }, orderBy: { createdAt: "asc" } });

  before(async () => {
    process.env["SECRETS_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => { hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString() }); res.writeHead(answer); res.end("{}"); });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    t = await startApp();
    a = await t.makeTenant("whk-a");
    b = await t.makeTenant("whk-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
    await t.prisma.practitionerSchedule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ tenantId: a.tenantId, facilityId: a.facilityId, practitionerId: doc.practitionerId, dayOfWeek, startMinute: 0, endMinute: 1439, slotMinutes: 15 })) });
  });
  after(async () => { await t.close(); server.close(); delete process.env["SECRETS_ENCRYPTION_KEY"]; });

  describe("the address allow-list of a key", () => {
    it("understands single addresses and ranges, IPv4 and IPv6, and refuses nonsense", () => {
      assert.deepEqual(parseAllowList([" 203.0.113.7 ", "203.0.113.0/24", "203.0.113.7", "2001:db8::/32", "::ffff:198.51.100.9"]), { ok: true, entries: ["203.0.113.7", "203.0.113.0/24", "2001:db8::/32", "198.51.100.9"] });
      for (const bad of ["abc", "203.0.113.0/33", "203.0.113.0/-1", "2001:db8::/129", "1.2.3.4/8/8", "999.1.1.1"]) assert.equal(parseAllowList([bad]).ok, false, bad);
      const list = ["203.0.113.0/24", "198.51.100.9", "2001:db8::/32"];
      assert.equal(ipAllowed("203.0.113.200", list), true);
      assert.equal(ipAllowed("203.0.114.1", list), false);
      assert.equal(ipAllowed("::ffff:198.51.100.9", list), true, "an IPv4 client reported as IPv6-mapped");
      assert.equal(ipAllowed("2001:db8:1::5", list), true);
      assert.equal(ipAllowed("2001:db9::1", list), false);
      assert.equal(ipAllowed("10.0.0.1", []), true, "an empty list means from anywhere");
      assert.equal(ipAllowed(undefined, list), false);
    });

    it("a key limited to other addresses is refused like any bad key; the administrator changes the list; every change is audited", async () => {
      const c = await makeClient({ allowedIps: ["198.51.100.0/24"] });
      assert.deepEqual(c.client.allowedIps, ["198.51.100.0/24"]);
      assert.equal((await t.api("get", "/booking/doctors", c.apiKey)).status, 401, "this computer is not on the list");
      const set = (ips: string[], tok = a.admin.token) => t.api("put", `/integrations/clients/${c.client.id}/allowed-ips`, tok).send({ allowedIps: ips });
      assert.equal((await set(["127.0.0.1", "::1", "198.51.100.0/24"])).status, 200);
      assert.equal((await t.api("get", "/booking/doctors", c.apiKey)).status, 200, "now it is");
      assert.equal((await set([])).status, 200);
      assert.equal((await t.api("get", "/booking/doctors", c.apiKey)).status, 200, "an empty list means from anywhere");
      assert.equal((await set(["not-an-address"])).status, 400);
      assert.equal((await set(["198.51.100.1"], rec.token)).status, 403, "only people who manage integrations");
      assert.equal((await set(["198.51.100.1"], b.admin.token)).status, 404, "another hospital's key");
      assert.equal((await t.api("post", "/integrations/clients", a.admin.token).send({ name: `Bad ${uniqueWord(5)}`, abilities: ["BOOK_APPOINTMENTS"], allowedIps: ["300.1.1.1"] })).status, 400);
      const ev = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: "API_CLIENT_IPS_CHANGED", entityId: c.client.id } });
      assert.equal(ev.length, 2);
      const listed = JSON.stringify((await t.api("get", "/integrations/clients", a.admin.token)).body);
      assert.ok(listed.includes(c.client.id));
    });
  });

  describe("webhook set-up", () => {
    it("a new endpoint returns its signing secret once; the database keeps it only encrypted; the secret can be replaced", async () => {
      const c = await makeClient();
      const r = await hook(c.client.id);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const secret = r.body.data.secret as string;
      assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
      const row = await t.prisma.webhookEndpoint.findFirstOrThrow({ where: { clientId: c.client.id } });
      assert.ok(row.secretEnc.startsWith("v1."), "stored encrypted");
      assert.ok(!row.secretEnc.includes(secret));
      assert.equal(row.secretLast4, secret.slice(-4));
      const again = await t.api("get", `/integrations/clients/${c.client.id}/webhook`, a.admin.token);
      assert.ok(!JSON.stringify(again.body).includes(secret), "never shown again");
      assert.equal(again.body.data.webhook.secretLast4, secret.slice(-4));
      const second = await hook(c.client.id, { events: ["appointment.booked"] });
      assert.equal(second.body.data.secret, null, "changing the address or events keeps the secret");
      assert.deepEqual(second.body.data.webhook.events, ["appointment.booked"]);
      const rot = await t.api("post", `/integrations/clients/${c.client.id}/webhook/rotate-secret`, a.admin.token);
      assert.equal(rot.status, 200);
      assert.notEqual(rot.body.data.secret, secret);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "WEBHOOK_SECRET_ROTATED", entityId: c.client.id } }));
      assert.equal(JSON.stringify(await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: c.client.id } })).includes(secret), false, "the secret is not in the audit trail");
    });

    it("validates the address and events; only people who manage integrations; another hospital's key; a revoked key", async () => {
      const c = await makeClient();
      for (const bad of [{ url: "ftp://example.com/x" }, { url: "not a url" }, { url: "https://user:pass@example.com/x" }, { events: [] }, { events: ["appointment.deleted"] }, { events: ["appointment.booked", "appointment.booked"] }, { extra: 1 }]) {
        assert.equal((await hook(c.client.id, bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await hook(c.client.id, {}, rec.token)).status, 403);
      assert.equal((await hook(c.client.id, {}, b.admin.token)).status, 404);
      assert.equal((await t.api("get", `/integrations/clients/${c.client.id}/webhook`, rec.token)).status, 403);
      assert.equal((await t.api("get", `/integrations/clients/${randomUUID()}/webhook`, a.admin.token)).status, 404);
      assert.equal((await t.api("post", `/integrations/clients/${c.client.id}/webhook/test`, a.admin.token)).status, 409, "no webhook yet");
      assert.equal((await t.api("post", `/integrations/clients/${c.client.id}/revoke`, a.admin.token).send({ reason: "Contract ended" })).status, 200);
      assert.equal((await hook(c.client.id)).status, 409, "a revoked key cannot get a webhook");
      assert.equal((await t.api("get", "/integrations/clients/anything/webhook", c.apiKey)).status, 401, "a key can never reach these routes");
    });

    it("in production the address must be a public https address; nothing internal can be reached", () => {
      for (const bad of ["http://example.com/hook", "https://localhost/hook", "https://127.0.0.1/hook", "https://10.1.2.3/hook", "https://169.254.169.254/latest", "https://192.168.0.5/x", "https://[::1]/x", "https://printer.local/x", "https://db.internal/x"]) {
        assert.throws(() => assertOutboundUrl(bad, true, "webhook"), /address|https/i, bad);
      }
      assert.equal(assertOutboundUrl("https://hooks.example.com/medos", true, "webhook").host, "hooks.example.com");
      assert.equal(assertOutboundUrl("http://127.0.0.1:9000/x", false, "webhook").port, "9000", "development allows local receivers");
    });
  });

  describe("events and delivery", () => {
    it("booking, moving and cancelling an appointment each send one signed event with no patient details", async () => {
      const w = await wired();
      hits.length = 0;
      const appt = await book(w.apiKey);
      await run();
      assert.deepEqual(await state(w.client.id), [["appointment.booked", "DELIVERED", 1]]);
      assert.equal(hits.length, 1);
      const first = hits[0]!;
      assert.equal(first.headers["x-medos-event"], "appointment.booked");
      const sig = String(first.headers["x-medos-signature"]);
      const [tPart, vPart] = sig.split(",") as [string, string];
      const stamp = tPart.replace("t=", "");
      assert.equal(vPart, `v1=${createHmac("sha256", w.secret).update(`${stamp}.${first.body}`).digest("hex")}`, "the signature is the HMAC of timestamp.body with the secret");
      assert.ok(Math.abs(Date.now() / 1000 - Number(stamp)) < 60);
      const ev = JSON.parse(first.body);
      assert.deepEqual([ev.event, ev.appointment.id, ev.appointment.status, ev.appointment.practitionerId], ["appointment.booked", appt.id, "BOOKED", doc.practitionerId]);
      assert.equal(first.headers["x-medos-delivery"], ev.id);
      for (const secretish of ["Anita", "mobile", "patient", "firstName"]) assert.ok(!first.body.includes(secretish), `no "${secretish}" in the payload`);

      const moved = await t.api("patch", `/appointments/${appt.id}`, w.apiKey).send({ version: appt.version, startAt: at(nextDay(), 11) });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      await run();
      assert.equal(JSON.parse(hits[1]!.body).event, "appointment.moved");
      assert.equal(JSON.parse(hits[1]!.body).appointment.version, appt.version + 1);

      // Cancelled by hospital staff, not by the key: the key that made the appointment is still told.
      const cancelled = await t.api("post", `/appointments/${appt.id}/cancel`, rec.token).send({ reason: "Doctor on leave" });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      await run();
      const last = JSON.parse(hits[2]!.body);
      assert.deepEqual([last.event, last.appointment.status, last.appointment.cancelReason], ["appointment.cancelled", "CANCELLED", "Doctor on leave"]);
      assert.deepEqual((await rows(w.client.id)).map((r) => [r.event, r.status]), [["appointment.booked", "DELIVERED"], ["appointment.moved", "DELIVERED"], ["appointment.cancelled", "DELIVERED"]]);
      assert.equal(hits.length, 3, "one request for each event");
    });

    it("only events the endpoint listens for, only for appointments its own key made, and nothing when it is switched off", async () => {
      const w = await wired({ events: ["appointment.booked"] });
      const other = await wired();
      const appt = await book(w.apiKey);
      assert.equal((await t.api("patch", `/appointments/${appt.id}`, w.apiKey).send({ version: appt.version, startAt: at(nextDay(), 12) })).status, 200);
      assert.deepEqual((await rows(w.client.id)).map((r) => r.event), ["appointment.booked"], "moved is not listened for");
      assert.equal((await rows(other.client.id)).length, 0, "another key's endpoint hears nothing about this appointment");
      const staffPatient = await registerPatient(t, rec.token);
      const staff = await t.api("post", "/appointments", rec.token).send({ patientId: staffPatient.id, practitionerId: doc.practitionerId, startAt: at(nextDay(), 15) });
      assert.equal(staff.status, 201, JSON.stringify(staff.body));
      assert.equal((await rows(w.client.id)).length, 1, "an appointment made by staff is nobody's webhook business");
      assert.equal((await hook(w.client.id, { status: "INACTIVE" })).status, 200);
      await book(w.apiKey);
      assert.equal((await rows(w.client.id)).length, 1, "a switched-off endpoint queues nothing");
    });

    it("a receiver that fails is retried with growing waits; after the last try the delivery is given up and can be retried by hand", async () => {
      const w = await wired();
      answer = 500;
      await book(w.apiKey);
      const now = soon();
      await run(now);
      let d = (await rows(w.client.id))[0]!;
      assert.deepEqual([d.status, d.attempts, d.lastStatus], ["PENDING", 1, 500]);
      assert.ok(d.nextAttemptAt.getTime() > now.getTime(), "it waits before the next try");
      await run(now);
      assert.equal((await rows(w.client.id))[0]!.attempts, 1, "not due yet, so not tried again");
      const waits = [2, 10, 60, 600];
      let clock = now.getTime();
      let n = 1;
      for (const mins of waits) { clock += mins * 60_000; await run(new Date(clock)); n++; assert.equal((await rows(w.client.id))[0]!.attempts, n, `attempt ${n}`); assert.equal((await rows(w.client.id))[0]!.status, "PENDING"); }
      clock += 24 * 3_600_000;
      await run(new Date(clock));
      d = (await rows(w.client.id))[0]!;
      assert.deepEqual([d.status, d.attempts], ["FAILED", 6]);
      assert.match(d.lastError ?? "", /HTTP 500/);
      answer = 200;
      const retry = await t.api("post", `/integrations/clients/${w.client.id}/webhook/deliveries/${d.id}/retry`, a.admin.token);
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      await run();
      assert.equal((await rows(w.client.id))[0]!.status, "DELIVERED");
      assert.equal((await t.api("post", `/integrations/clients/${w.client.id}/webhook/deliveries/${d.id}/retry`, a.admin.token)).status, 404, "only a given-up delivery can be retried");
    });

    it("an unreachable receiver is a failure, not a crash; the test button reports what the receiver answered", async () => {
      const w = await wired();
      answer = 200;
      const ok = await t.api("post", `/integrations/clients/${w.client.id}/webhook/test`, a.admin.token);
      assert.equal(ok.status, 200);
      assert.deepEqual([ok.body.data.ok, ok.body.data.statusCode], [true, 200]);
      answer = 503;
      const bad = await t.api("post", `/integrations/clients/${w.client.id}/webhook/test`, a.admin.token);
      assert.deepEqual([bad.body.data.ok, bad.body.data.statusCode], [false, 503]);
      assert.match(bad.body.data.message, /HTTP 503/);
      answer = 200;
      assert.equal((await hook(w.client.id, { url: "http://127.0.0.1:1/nothing-listens-here" })).status, 200);
      const down = await t.api("post", `/integrations/clients/${w.client.id}/webhook/test`, a.admin.token);
      assert.equal(down.body.data.ok, false);
      assert.match(down.body.data.message, /could not be reached/);
      assert.equal((await t.api("post", `/integrations/clients/${w.client.id}/webhook/test`, rec.token)).status, 403);
    });

    it("a replaced secret signs new events with the new secret only; another hospital's deliveries are never touched", async () => {
      const w = await wired();
      const rot = (await t.api("post", `/integrations/clients/${w.client.id}/webhook/rotate-secret`, a.admin.token)).body.data.secret as string;
      hits.length = 0;
      await book(w.apiKey);
      await run();
      const h = hits.at(-1)!;
      const stamp = String(h.headers["x-medos-signature"]).split(",")[0]!.replace("t=", "");
      const sign = (secret: string) => `v1=${createHmac("sha256", secret).update(`${stamp}.${h.body}`).digest("hex")}`;
      assert.equal(String(h.headers["x-medos-signature"]).split(",")[1], sign(rot));
      assert.notEqual(String(h.headers["x-medos-signature"]).split(",")[1], sign(w.secret));
      const bClient = await makeClient({}, b);
      assert.equal((await hook(bClient.client.id, {}, b.admin.token)).status, 200);
      assert.equal((await t.api("get", `/integrations/clients/${bClient.client.id}/webhook`, a.admin.token)).status, 404);
      assert.equal((await t.prisma.webhookDelivery.count({ where: { tenantId: a.tenantId, endpoint: { client: { tenantId: b.tenantId } } } })), 0);
    });

    it("DATABASE: a webhook must listen for known events and belong to a key of its own facility; deliveries are never deleted", async () => {
      const w = await wired();
      const ep = await t.prisma.webhookEndpoint.findFirstOrThrow({ where: { clientId: w.client.id } });
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "WebhookEndpoint" SET events = ARRAY['appointment.exploded']::text[] WHERE id = '${ep.id}'::uuid`), /webhook_endpoint_events|check constraint/i);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "WebhookEndpoint" SET url = 'javascript:alert(1)' WHERE id = '${ep.id}'::uuid`), /webhook_endpoint_url|check constraint/i);
      await book(w.apiKey);
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "WebhookDelivery" WHERE "endpointId" = '${ep.id}'::uuid`), /append-only/);
    });
  });
});
