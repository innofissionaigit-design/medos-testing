import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../common/config";
import { registerPatient, startApp, type TestApp, type TestTenant } from "../../test/harness";
import { S3StorageDriver, StorageService } from "./storage.service";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const BUCKET = "medos-files";
const xml = (code: string, message: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

interface Seen { method: string; path: string; headers: IncomingMessage["headers"]; body: Buffer }

/** A tiny in-memory S3: path-style PUT and GET, honouring If-None-Match, with switches to simulate failures. */
class FakeS3 {
  readonly objects = new Map<string, { body: Buffer; headers: IncomingMessage["headers"] }>();
  readonly seen: Seen[] = [];
  failNext: number[] = []; // HTTP statuses to answer with before behaving normally
  deny = false;
  private server!: Server;
  endpoint = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop(): Promise<void> { return new Promise((r) => { this.server.close(() => r()); this.server.closeAllConnections(); }); }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const path = decodeURIComponent((req.url ?? "").split("?")[0] ?? "");
    this.seen.push({ method: req.method ?? "", path, headers: req.headers, body });
    const reply = (status: number, text = "", extra: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/xml", ...extra }); res.end(text); };
    const forced = this.failNext.shift();
    if (forced) return reply(forced, xml("InternalError", "forced failure"));
    if (this.deny) return reply(403, xml("AccessDenied", "Access Denied"));
    const key = path.replace(`/${BUCKET}/`, "");
    if (!path.startsWith(`/${BUCKET}/`)) return reply(404, xml("NoSuchBucket", "no such bucket"));
    if (req.method === "PUT") {
      if (req.headers["if-none-match"] === "*" && this.objects.has(key)) return reply(412, xml("PreconditionFailed", "At least one of the pre-conditions you specified did not hold"));
      this.objects.set(key, { body, headers: req.headers });
      return reply(200, "", { etag: `"${createHash("md5").update(body).digest("hex")}"` });
    }
    if (req.method === "GET") {
      const o = this.objects.get(key);
      if (!o) return reply(404, xml("NoSuchKey", "The specified key does not exist."));
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(o.body.length), etag: `"x"` });
      return void res.end(o.body);
    }
    return reply(405, xml("MethodNotAllowed", "no"));
  }
}

const baseEnv = { NODE_ENV: "test", DATABASE_URL: "postgresql://medos@127.0.0.1:5432/x_test", JWT_ACCESS_SECRET: "unit-test-secret-unit-test-secret-0001" };
const s3Env = (fake: FakeS3, extra: Record<string, string> = {}) => ({
  ...baseEnv, STORAGE_DRIVER: "s3", S3_BUCKET: BUCKET, S3_REGION: "ap-south-1", S3_ENDPOINT: fake.endpoint, S3_FORCE_PATH_STYLE: "true",
  S3_ACCESS_KEY_ID: "TESTKEY", S3_SECRET_ACCESS_KEY: "testsecret/testsecret", ...extra,
});
const newKey = () => `${randomUUID()}/${randomUUID()}`;

describe("S3-compatible storage driver", () => {
  const fake = new FakeS3();
  before(async () => { await fake.start(); });
  after(async () => { await fake.stop(); });

  it("stores and returns exactly the bytes, signed, under bucket and prefix, written once", async () => {
    const driver = new S3StorageDriver(loadConfig(s3Env(fake, { S3_PREFIX: "medos/prod/" })));
    const key = newKey();
    await driver.put(key, PNG);
    const put = fake.seen.at(-1)!;
    assert.equal(put.method, "PUT");
    assert.equal(put.path, `/${BUCKET}/medos/prod/${key}`, "path-style: bucket, prefix, then the tenant/file key");
    assert.match(String(put.headers["authorization"]), /^AWS4-HMAC-SHA256 Credential=TESTKEY\/\d{8}\/ap-south-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
    assert.match(String(put.headers["x-amz-date"]), /^\d{8}T\d{6}Z$/);
    assert.equal(put.headers["x-amz-content-sha256"], createHash("sha256").update(PNG).digest("hex"), "the signed payload hash matches the bytes");
    assert.equal(put.headers["if-none-match"], "*", "an existing object is never overwritten");
    assert.equal(put.headers["x-amz-server-side-encryption"], undefined, "no encryption header unless asked for");
    assert.equal(put.headers["x-amz-checksum-crc32"], undefined, "no extra checksum that S3-compatible stores may reject");
    assert.ok(Buffer.compare(put.body, PNG) === 0, "the request body is the file, unchanged");
    assert.ok(Buffer.compare(await driver.get(key), PNG) === 0, "bytes round-trip unchanged");
  });

  it("refuses to overwrite an existing object and leaves the original intact", async () => {
    const driver = new S3StorageDriver(loadConfig(s3Env(fake)));
    const key = newKey();
    await driver.put(key, PNG);
    await assert.rejects(driver.put(key, Buffer.from("different bytes")), (e: { $metadata?: { httpStatusCode?: number } }) => e.$metadata?.httpStatusCode === 412);
    assert.ok(Buffer.compare(await driver.get(key), PNG) === 0);
  });

  it("asks the store to encrypt when configured, with a customer key if given", async () => {
    await new S3StorageDriver(loadConfig(s3Env(fake, { S3_SSE: "AES256" }))).put(newKey(), PNG);
    assert.equal(fake.seen.at(-1)!.headers["x-amz-server-side-encryption"], "AES256");
    await new S3StorageDriver(loadConfig(s3Env(fake, { S3_SSE: "aws:kms", S3_KMS_KEY_ID: "alias/medos-files" }))).put(newKey(), PNG);
    const h = fake.seen.at(-1)!.headers;
    assert.equal(h["x-amz-server-side-encryption"], "aws:kms");
    assert.equal(h["x-amz-server-side-encryption-aws-kms-key-id"], "alias/medos-files");
  });

  it("a missing object is NOT_FOUND; access problems are real errors, never disguised as 'not found'", async () => {
    const driver = new S3StorageDriver(loadConfig(s3Env(fake)));
    await assert.rejects(driver.get(newKey()), (e: { code?: string; httpStatus?: number }) => e.code === "NOT_FOUND" && e.httpStatus === 404);
    fake.deny = true;
    try {
      await assert.rejects(driver.get(newKey()), (e: { name?: string; code?: string }) => e.code !== "NOT_FOUND" && e.name === "AccessDenied");
      await assert.rejects(driver.put(newKey(), PNG), (e: { name?: string }) => e.name === "AccessDenied");
    } finally { fake.deny = false; }
  });

  it("retries a temporary server failure and then succeeds; gives up after three tries", async () => {
    const driver = new S3StorageDriver(loadConfig(s3Env(fake)));
    const key = newKey();
    const before = fake.seen.length;
    fake.failNext = [500, 503];
    await driver.put(key, PNG);
    assert.equal(fake.seen.length - before, 3, "two failures, then success");
    assert.ok(Buffer.compare(await driver.get(key), PNG) === 0);
    const b2 = fake.seen.length;
    fake.failNext = [500, 500, 500, 500];
    await assert.rejects(driver.get(key));
    assert.equal(fake.seen.length - b2, 3, "stops after three attempts");
    fake.failNext = [];
  });

  it("StorageService rejects any key that is not <tenant uuid>/<file uuid> before the store is contacted", async () => {
    const svc = new StorageService(loadConfig(s3Env(fake)));
    const before = fake.seen.length;
    for (const bad of ["../etc/passwd", `${randomUUID()}/../x`, `${randomUUID()}`, `${randomUUID()}/${randomUUID()}/extra`, "a/b", ""]) {
      await assert.rejects(svc.put(bad, PNG), (e: { code?: string }) => e.code === "INTERNAL_ERROR", bad);
      await assert.rejects(svc.get(bad), (e: { code?: string }) => e.code === "INTERNAL_ERROR", bad);
    }
    assert.equal(fake.seen.length, before, "nothing reached the store");
  });
});

describe("storage configuration", () => {
  const fake = { endpoint: "http://127.0.0.1:9" } as FakeS3;
  it("is local by default and needs no S3 settings", () => {
    const c = loadConfig(baseEnv);
    assert.equal(c.STORAGE_DRIVER, "local");
    assert.equal(c.S3_PREFIX, "");
  });
  it("refuses an incomplete or inconsistent S3 setup at startup, naming the setting but never its value", () => {
    assert.throws(() => loadConfig({ ...baseEnv, STORAGE_DRIVER: "s3", S3_REGION: "ap-south-1" }), /S3_BUCKET/);
    assert.throws(() => loadConfig({ ...baseEnv, STORAGE_DRIVER: "s3", S3_BUCKET: "medos-files" }), /S3_REGION/);
    assert.throws(() => loadConfig(s3Env(fake, { S3_SECRET_ACCESS_KEY: "" }) as never), /S3_/);
    const half = { ...s3Env(fake) } as Record<string, string | undefined>;
    delete half["S3_SECRET_ACCESS_KEY"];
    assert.throws(() => loadConfig(half), /S3_SECRET_ACCESS_KEY/);
    assert.throws(() => loadConfig(s3Env(fake, { S3_KMS_KEY_ID: "alias/x" })), /S3_KMS_KEY_ID/);
    assert.throws(() => loadConfig(s3Env(fake, { S3_PREFIX: "../escape" })), /S3_PREFIX/);
    assert.throws(() => loadConfig(s3Env(fake, { S3_PREFIX: "medos" })), /S3_PREFIX/);
    try { loadConfig(s3Env(fake, { S3_SECRET_ACCESS_KEY: "" })); } catch (e) { assert.ok(!String((e as Error).message).includes("testsecret")); }
    assert.doesNotThrow(() => loadConfig(s3Env(fake, { S3_PREFIX: "medos/prod/" })));
  });
  it("accepts credentials from the environment's own chain when no keys are set", () => {
    const e = { ...s3Env(fake) } as Record<string, string | undefined>;
    delete e["S3_ACCESS_KEY_ID"]; delete e["S3_SECRET_ACCESS_KEY"];
    assert.doesNotThrow(() => loadConfig(e));
  });
});

describe("patient files kept in an S3-compatible store (end to end through the API)", () => {
  const fake = new FakeS3();
  let t: TestApp;
  let a: TestTenant;
  let rec: { id: string; token: string };

  before(async () => {
    await fake.start();
    // only the storage settings: the harness owns DATABASE_URL, JWT_ACCESS_SECRET and the rest
    for (const [k, v] of Object.entries(s3Env(fake, { S3_PREFIX: "medos-test/" }))) if (/^(STORAGE_DRIVER|S3_)/.test(k)) process.env[k] = v;
    t = await startApp();
    a = await t.makeTenant("s3-a");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
  });
  after(async () => {
    try { await t?.close(); } finally { await fake.stop(); } // the fake server must stop even if setup failed, or the run never ends
    for (const k of ["STORAGE_DRIVER", "S3_BUCKET", "S3_REGION", "S3_ENDPOINT", "S3_FORCE_PATH_STYLE", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_PREFIX"]) delete process.env[k];
  });

  it("an uploaded photo lands in the bucket, not on disk, and downloads unchanged", async () => {
    const p = await registerPatient(t, rec.token);
    const up = await t.api("post", `/patients/${p.id}/files`, rec.token).query({ kind: "PHOTO", filename: "face.png" }).set("Content-Type", "image/png").send(PNG);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const keys = [...fake.objects.keys()];
    assert.equal(keys.length, 1, "exactly one object stored");
    assert.match(keys[0]!, new RegExp(`^medos-test/${a.tenantId}/[0-9a-f-]{36}$`), "under the prefix, the tenant, then the file id");
    assert.ok(Buffer.compare(fake.objects.get(keys[0]!)!.body, PNG) === 0);

    const dir = process.env["STORAGE_DIR"] as string;
    assert.equal(existsSync(`${dir}/${a.tenantId}`) ? readdirSync(`${dir}/${a.tenantId}`).length : 0, 0, "nothing written to the local disk");

    const c = await t.api("get", `/files/${up.body.data.id}/content`, rec.token).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on("data", (d: Buffer) => ch.push(d)); res.on("end", () => cb(null, Buffer.concat(ch))); });
    assert.equal(c.status, 200);
    assert.ok(Buffer.compare(c.body as Buffer, PNG) === 0, "the bytes come back from the store unchanged");
    assert.equal(c.headers["content-type"], "image/png");
    assert.equal(c.headers["x-content-type-options"], "nosniff", "the safe-download headers are unchanged");
  });

  it("when the store is unreachable the upload fails cleanly and no record is kept", async () => {
    const p = await registerPatient(t, rec.token);
    fake.failNext = [500, 500, 500, 500, 500, 500];
    const up = await t.api("post", `/patients/${p.id}/files`, rec.token).query({ kind: "PHOTO", filename: "face.png" }).set("Content-Type", "image/png").send(PNG);
    fake.failNext = [];
    assert.equal(up.status, 500);
    assert.equal(up.body.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(up.body).includes("forced failure"), "no store internals in the response");
    const list = await t.api("get", `/patients/${p.id}/files`, rec.token);
    assert.equal(list.body.data.length, 0, "no file record without stored bytes");
  });
});
