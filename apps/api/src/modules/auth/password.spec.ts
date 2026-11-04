import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scrypt } from "node:crypto";
import { loadConfig } from "../../common/config";
import { PasswordService } from "./password.service";

const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://medos@127.0.0.1:5432/x_test", JWT_ACCESS_SECRET: "unit-test-secret-unit-test-secret-0001" };
const service = (memory: string, passes: string) => new PasswordService(loadConfig({ ...base, ARGON2_MEMORY_KIB: memory, ARGON2_PASSES: passes }));

/** A hash in the format used before Argon2id, made the way the old service made it. */
const legacyScrypt = (password: string, logN = 10): Promise<string> => new Promise((resolve, reject) => {
  const N = 2 ** logN;
  const salt = randomBytes(16);
  scrypt(password.normalize("NFKC"), salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 }, (e, key) => (e ? reject(e) : resolve(["scrypt", N, 8, 1, salt.toString("base64"), key.toString("base64")].join("$"))));
});

describe("password hashing (Argon2id)", () => {
  const pw = service("1024", "1");

  it("hashes to the standard Argon2id format with the configured cost, and verifies only the right password", async () => {
    const h = await pw.hash("Correct-Horse-9");
    assert.match(h, /^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    assert.equal(await pw.verify("Correct-Horse-9", h), true);
    assert.equal(await pw.verify("Correct-Horse-8", h), false);
    assert.equal(await pw.verify("", h), false);
  });

  it("uses a fresh random salt every time", async () => {
    const [a, b] = await Promise.all([pw.hash("Same-Password-1"), pw.hash("Same-Password-1")]);
    assert.notEqual(a, b);
  });

  it("treats visually equivalent Unicode forms of a password as the same password", async () => {
    const h = await pw.hash("Passw0rd-fi");
    assert.equal(await pw.verify("Passw0rd-ﬁ", h), true, "the 'fi' ligature normalises to 'fi'");
  });

  it("still verifies hashes made before Argon2id, and marks them for replacement", async () => {
    const old = await legacyScrypt("Old-Password-1");
    assert.equal(await pw.verify("Old-Password-1", old), true);
    assert.equal(await pw.verify("Old-Password-2", old), false);
    assert.equal(pw.needsRehash(old), true);
  });

  it("marks Argon2id hashes weaker than the configured cost, and no others, for replacement", async () => {
    const weak = await pw.hash("Some-Password-1");
    assert.equal(pw.needsRehash(weak), false, "same cost: keep");
    assert.equal(service("1024", "1").needsRehash(weak), false);
    assert.equal(service("2048", "1").needsRehash(weak), true, "less memory than now configured");
    assert.equal(service("1024", "2").needsRehash(weak), true, "fewer passes than now configured");
    const strong = await service("4096", "2").hash("Some-Password-1");
    assert.equal(pw.needsRehash(strong), false, "stronger than configured is never downgraded");
  });

  it("rejects malformed or hostile stored hashes without hanging or throwing", async () => {
    const hostile = [
      "", "plain-text", "$argon2id$", "$argon2id$v=19$m=1024,t=1,p=1$onlysalt",
      "$argon2id$v=19$m=99999999999,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNo",   // asks for far too much memory
      "$argon2id$v=19$m=1024,t=9999,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNo",       // asks for far too much time
      "$argon2id$v=19$m=1024,t=1,p=1$$",
      "$argon2i$v=19$m=1024,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNo",            // another variant: not accepted
      "scrypt$x$8$1$AAAA$AAAA", "scrypt$1024$8$1$AAAA", "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
    ];
    for (const h of hostile) {
      assert.equal(await pw.verify("anything", h), false, h);
      assert.equal(pw.needsRehash(h), true, `a hash that is not valid Argon2id is always replaced: ${h}`);
    }
  });

  it("does not block the event loop while hashing", async () => {
    const heavy = service("65536", "3");
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    await heavy.hash("Event-Loop-1");
    clearInterval(timer);
    assert.ok(ticks >= 3, `the loop kept running during the hash (${ticks} ticks)`);
  });
});

describe("password hashing configuration", () => {
  it("defaults to the OWASP minimum and refuses anything weaker in production", () => {
    const d = loadConfig(base);
    assert.deepEqual([d.ARGON2_MEMORY_KIB, d.ARGON2_PASSES], [19_456, 2]);
    const prod = { ...base, NODE_ENV: "production" };
    assert.doesNotThrow(() => loadConfig(prod));
    assert.throws(() => loadConfig({ ...prod, ARGON2_MEMORY_KIB: "1024" }), /ARGON2_MEMORY_KIB/);
    assert.throws(() => loadConfig({ ...prod, ARGON2_PASSES: "1" }), /ARGON2_PASSES/);
    assert.doesNotThrow(() => loadConfig({ ...base, ARGON2_MEMORY_KIB: "1024", ARGON2_PASSES: "1" }), "weaker settings are fine outside production");
  });
});
