import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DomainError } from "@medos/shared";
import { makeDoctor, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import type { AppConfig } from "../../common/config";
import { SecretsService } from "../../common/secrets";
import { assertOcrUrl, isPrivateAddress } from "./ocr.provider";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const KEY = "facility-secret-key-9876";

describe("OCR connection: address safety and key encryption", () => {
  it("recognises private, loopback and metadata addresses", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "203.0.113.5", "2606:4700::1111", "100.63.0.1"]) assert.equal(isPrivateAddress(ip), false, ip);
  });
  it("in production only public https addresses are accepted; in development a local test service is fine", () => {
    assert.equal(assertOcrUrl("https://ocr.example.com/read", true).host, "ocr.example.com");
    for (const bad of ["http://ocr.example.com/read", "https://localhost/read", "https://127.0.0.1/read", "https://10.0.0.5/read", "https://169.254.169.254/latest", "https://[::1]/read", "https://ocr.internal/read", "https://printer.local/read", "https://u:p@ocr.example.com/read", "ftp://ocr.example.com", "not a url"]) {
      assert.throws(() => assertOcrUrl(bad, true), /./, bad);
    }
    assert.equal(assertOcrUrl("http://127.0.0.1:9000/read", false).port, "9000");
    assert.throws(() => assertOcrUrl("ftp://x.example.com", false));
    assert.throws(() => assertOcrUrl("https://u:p@x.example.com", false));
  });
  it("encrypts with a random nonce, round-trips, and refuses tampering or a wrong key", () => {
    const key = Buffer.alloc(32, 3).toString("base64");
    const s = new SecretsService({ SECRETS_ENCRYPTION_KEY: key } as AppConfig);
    const a = s.encrypt(KEY);
    assert.notEqual(a, s.encrypt(KEY), "a fresh nonce every time");
    assert.ok(!a.includes(KEY) && a.startsWith("v1."));
    assert.equal(s.decrypt(a), KEY);
    const parts = a.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    assert.throws(() => s.decrypt(parts.join(".")), (e: unknown) => e instanceof DomainError && e.code === "SECRETS_UNREADABLE");
    assert.throws(() => new SecretsService({ SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64") } as AppConfig).decrypt(a), (e: unknown) => e instanceof DomainError && e.code === "SECRETS_UNREADABLE");
    const none = new SecretsService({} as AppConfig);
    assert.equal(none.available, false);
    assert.throws(() => none.encrypt("x"), (e: unknown) => e instanceof DomainError && e.code === "SECRETS_KEY_MISSING");
  });
});

interface Seen { auth: string | undefined }
function fakeOcr(): Promise<{ server: Server; port: number; seen: Seen[]; mode: { current: "ok" | "error" | "empty" } }> {
  const seen: Seen[] = [];
  const mode: { current: "ok" | "error" | "empty" } = { current: "ok" };
  const server = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization });
      res.writeHead(mode.current === "error" ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(mode.current === "empty" ? { text: " " } : { text: "Tab Cetirizine 10mg 0-0-1 x 5 days" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, seen, mode })));
}

describe("managing the OCR service (administration)", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let ocr: Awaited<ReturnType<typeof fakeOcr>>;
  let doc: TestDoctor;
  let rec: { id: string; token: string };
  let encounterId: string;
  const url = () => `http://127.0.0.1:${ocr.port}/read`;
  const get = (tok = a.admin.token) => t.api("get", "/ocr/config", tok);
  const save = (body: Record<string, unknown>, tok = a.admin.token) => t.api("put", "/ocr/config", tok).send(body);
  const upload = (tok: string, enc: string) => t.api("post", `/encounters/${enc}/prescription-scans`, tok).query({ filename: "rx.png" }).set("Content-Type", "image/png").send(PNG);

  before(async () => {
    ocr = await fakeOcr();
    process.env["OCR_PROVIDER"] = "none";
    t = await startApp();
    a = await t.makeTenant("ocfg-a");
    b = await t.makeTenant("ocfg-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
    encounterId = (await startVisit(t, rec.token, doc, (await registerPatient(t, rec.token)).id)).encounterId;
    for (const k of ["PRESCRIPTION_UPLOAD_ENABLED", "PRESCRIPTION_OCR_ENABLED"]) assert.equal((await t.api("put", `/settings/${k}`, a.admin.token).send({ value: true })).status, 200);
  });
  after(async () => { await t.close(); ocr.server.close(); delete process.env["OCR_PROVIDER"]; });

  it("only administrators of settings manage it", async () => {
    for (const tok of [doc.token, rec.token]) {
      assert.equal((await get(tok)).status, 403);
      assert.equal((await save({ apiUrl: url() }, tok)).status, 403);
      assert.equal((await t.api("post", "/ocr/config/test", tok)).status, 403);
      assert.equal((await t.api("post", "/ocr/config/disconnect", tok)).status, 403);
    }
    assert.equal((await t.api("get", "/ocr/config")).status, 401);
  });

  it("starts unconnected and can store a key safely", async () => {
    const first = await get();
    assert.deepEqual([first.body.data.source, first.body.data.hasKey, first.body.data.canStoreKey, first.body.data.apiUrl], ["NONE", false, true, null]);
    assert.equal((await t.api("post", "/ocr/config/test", a.admin.token)).status, 409, "nothing to test yet");
    const r = await save({ apiUrl: url(), apiKey: KEY, timeoutMs: 5000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.data.source, r.body.data.hasKey, r.body.data.keyLast4, r.body.data.timeoutMs], ["FACILITY", true, "9876", 5000]);
    assert.ok(!JSON.stringify(r.body).includes(KEY) && !JSON.stringify((await get()).body).includes(KEY), "the key is never returned");
    const row = await t.prisma.ocrConfig.findFirstOrThrow({ where: { tenantId: a.tenantId } });
    assert.ok(row.apiKeyEnc && !row.apiKeyEnc.includes(KEY) && row.apiKeyEnc.startsWith("v1."), "stored encrypted");
    const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "OCR_CONFIG_SAVED" } });
    assert.ok(!JSON.stringify(ev.metadata).includes(KEY), "not in the audit trail");
    assert.deepEqual([(ev.metadata as Record<string, unknown>)["host"], (ev.metadata as Record<string, unknown>)["keyChanged"]], [`127.0.0.1:${ocr.port}`, true]);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "OcrConfig" WHERE "tenantId" = '${a.tenantId}'::uuid`));
  });

  it("validates the address, the key and the timeout", async () => {
    for (const bad of [{ apiUrl: "not a url" }, { apiUrl: "ftp://ocr.example.com/read" }, { apiUrl: "https://user:pass@ocr.example.com" }, { apiUrl: url(), apiKey: "short" }, { apiUrl: url(), timeoutMs: 10 }, { apiUrl: url(), timeoutMs: 999_999 },
      { apiUrl: url(), apiKey: KEY, clearKey: true }, { apiUrl: url(), other: 1 }, {}]) {
      assert.equal((await save(bad as Record<string, unknown>)).status, 400, JSON.stringify(bad));
    }
  });

  it("tests the connection with a blank picture and remembers the result", async () => {
    ocr.seen.length = 0;
    const ok = await t.api("post", "/ocr/config/test", a.admin.token);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.ok, true);
    assert.equal(ocr.seen[0]?.auth, `Bearer ${KEY}`, "the saved key is used");
    assert.equal((await get()).body.data.lastTest.ok, true);
    ocr.mode.current = "empty";
    const blank = await t.api("post", "/ocr/config/test", a.admin.token);
    assert.equal(blank.body.data.ok, true, "a service that finds no text in a blank picture is still working");
    ocr.mode.current = "error";
    const bad = await t.api("post", "/ocr/config/test", a.admin.token);
    assert.equal(bad.body.data.ok, false);
    assert.match(bad.body.data.message, /HTTP 500/);
    assert.equal((await get()).body.data.lastTest.ok, false);
    ocr.mode.current = "ok";
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "OCR_CONFIG_TESTED" } }));
  });

  it("the hospital's own connection is what reads uploaded prescriptions", async () => {
    assert.deepEqual((await t.api("get", "/prescription-scans/config", doc.token)).body.data, { uploadEnabled: true, ocrEnabled: true, ocrConnected: true });
    ocr.seen.length = 0;
    const r = await upload(doc.token, encounterId);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.status, "OCR_DONE");
    assert.equal(r.body.data.ocr.text, "Tab Cetirizine 10mg 0-0-1 x 5 days");
    assert.equal(ocr.seen[0]?.auth, `Bearer ${KEY}`);
    const s = r.body.data.suggestions[0];
    assert.deepEqual([s.name, s.strength, s.dosage, s.frequency, s.durationDays, s.route], ["Cetirizine", "10mg", "1 tablet", "HS", 5, "ORAL"]);
  });

  it("a saved key never follows a changed address: it must be entered again or removed", async () => {
    const other = `http://localhost:${ocr.port}/read`;
    const r = await save({ apiUrl: other });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /API key again/);
    assert.equal((await save({ apiUrl: other, apiKey: "another-key-1234" })).status, 200);
    assert.equal((await get()).body.data.keyLast4, "1234");
    assert.equal((await get()).body.data.lastTest, null, "a new address or key has not been tested");
    const cleared = await save({ apiUrl: url(), clearKey: true });
    assert.equal(cleared.status, 200);
    assert.deepEqual([cleared.body.data.hasKey, cleared.body.data.keyLast4], [false, null]);
    ocr.seen.length = 0;
    assert.equal((await t.api("post", "/ocr/config/test", a.admin.token)).body.data.ok, true);
    assert.equal(ocr.seen[0]?.auth, undefined, "no key, no Authorization header");
    const keep = await save({ apiUrl: url(), timeoutMs: 8000 });
    assert.equal(keep.body.data.timeoutMs, 8000);
  });

  it("another hospital sees and affects none of it", async () => {
    assert.deepEqual([(await get(b.admin.token)).body.data.source, (await get(b.admin.token)).body.data.apiUrl], ["NONE", null]);
    assert.equal((await t.api("post", "/ocr/config/disconnect", b.admin.token)).status, 409);
    assert.equal(await t.prisma.ocrConfig.count({ where: { tenantId: b.tenantId } }), 0);
  });

  it("disconnecting removes the address and key, and scans are then only stored", async () => {
    const r = await t.api("post", "/ocr/config/disconnect", a.admin.token);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.data.source, r.body.data.hasKey, r.body.data.apiUrl], ["NONE", false, null]);
    const row = await t.prisma.ocrConfig.findFirstOrThrow({ where: { tenantId: a.tenantId } });
    assert.deepEqual([row.apiUrl, row.apiKeyEnc, row.keyLast4], [null, null, null]);
    ocr.seen.length = 0;
    const up = await upload(doc.token, encounterId);
    assert.equal(up.body.data.status, "OCR_NOT_CONFIGURED");
    assert.equal(ocr.seen.length, 0, "nothing was sent");
    assert.equal((await t.api("post", "/ocr/config/disconnect", a.admin.token)).status, 409);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "OCR_CONFIG_DISCONNECTED" } }));
  });
});
