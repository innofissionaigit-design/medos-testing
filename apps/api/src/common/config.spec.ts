import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

const secret = () => randomBytes(36).toString("base64url");
const local = { NODE_ENV: "test", DATABASE_URL: "postgresql://medos@127.0.0.1:54329/medos_test", JWT_ACCESS_SECRET: "unit-test-secret-unit-test-secret-0001" };
const real = (extra: Record<string, string> = {}) => ({
  NODE_ENV: "production", APP_ENV: "production", DATABASE_URL: "postgresql://medos_app:s3cr3t@db.internal:5432/medos", JWT_ACCESS_SECRET: secret(),
  CORS_ORIGINS: "https://hospital.example.org", ...extra,
});

describe("configuration: empty values and secrets from files", () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), "medos-secrets-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });
  const file = (name: string, content: string) => { const p = join(dir, name); writeFileSync(p, content); return p; };

  it("treats an empty value as not set, as Docker passes for a variable that is only declared", () => {
    const c = loadConfig({ ...local, S3_BUCKET: "", S3_REGION: "  ", CLAMAV_HOST: "", S3_PREFIX: "", TRUST_PROXY: "" });
    assert.equal(c.S3_BUCKET, undefined);
    assert.equal(c.CLAMAV_HOST, undefined);
    assert.equal(c.TRUST_PROXY, "loopback", "falls back to the default");
    assert.equal(c.STORAGE_DRIVER, "local");
    assert.throws(() => loadConfig({ ...local, DATABASE_URL: "" }), /DATABASE_URL/, "a required setting that is empty is still missing");
  });

  it("reads DATABASE_URL, JWT_ACCESS_SECRET and the S3 keys from files, dropping one trailing newline only", () => {
    const jwt = secret();
    const c = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL_FILE: file("db", "postgresql://medos@127.0.0.1:5432/medos\n"),
      JWT_ACCESS_SECRET_FILE: file("jwt", `${jwt}\r\n`),
      STORAGE_DRIVER: "s3", S3_BUCKET: "medos-files", S3_REGION: "ap-south-1",
      S3_ACCESS_KEY_ID_FILE: file("ak", "AKIATEST"), S3_SECRET_ACCESS_KEY_FILE: file("sk", " secret with spaces \n\n"),
    });
    assert.equal(c.DATABASE_URL, "postgresql://medos@127.0.0.1:5432/medos");
    assert.equal(c.JWT_ACCESS_SECRET, jwt);
    assert.equal(c.S3_ACCESS_KEY_ID, "AKIATEST");
    assert.equal(c.S3_SECRET_ACCESS_KEY, " secret with spaces \n", "only the final newline is removed; the value is otherwise untouched");
  });

  it("refuses a value given both ways, and a file that is missing or empty, naming the setting but never the content", () => {
    const jwt = secret();
    assert.throws(() => loadConfig({ ...local, JWT_ACCESS_SECRET_FILE: file("both", jwt) }), /JWT_ACCESS_SECRET_FILE/, "set directly and by file");
    const noDirect = { NODE_ENV: "test", DATABASE_URL: local.DATABASE_URL };
    assert.throws(() => loadConfig({ ...noDirect, JWT_ACCESS_SECRET_FILE: join(dir, "does-not-exist") }), /JWT_ACCESS_SECRET_FILE/);
    assert.throws(() => loadConfig({ ...noDirect, JWT_ACCESS_SECRET_FILE: file("empty", "\n") }), /JWT_ACCESS_SECRET_FILE/);
    assert.throws(() => loadConfig({ ...noDirect, JWT_ACCESS_SECRET_FILE: dir }), /JWT_ACCESS_SECRET_FILE/, "a directory is not a secret");
    assert.throws(() => loadConfig({ ...noDirect, JWT_ACCESS_SECRET_FILE: file("short", "tooshort") }), (e: Error) => /JWT_ACCESS_SECRET/.test(e.message) && !e.message.includes("tooshort"));
  });
});

describe("configuration: deployment safety checks (APP_ENV=staging or production)", () => {
  it("a correctly configured production setup starts", () => {
    const c = loadConfig(real());
    assert.deepEqual([c.APP_ENV, c.NODE_ENV], ["production", "production"]);
    assert.doesNotThrow(() => loadConfig(real({ APP_ENV: "staging", CORS_ORIGINS: "https://staging.hospital.example.org, https://admin.hospital.example.org" })));
  });

  it("is off for local work: development secrets, localhost and the dev database are fine there", () => {
    assert.equal(loadConfig(local).APP_ENV, "local");
    assert.doesNotThrow(() => loadConfig({ ...local, CORS_ORIGINS: "http://localhost:3000" }));
  });

  it("refuses each unsafe setting, naming it", () => {
    const refused: [string, Record<string, string>][] = [
      ["JWT_ACCESS_SECRET", { JWT_ACCESS_SECRET: "change-me-min-32-chars-xxxxxxxxxxxxxxxx" }],
      ["JWT_ACCESS_SECRET", { JWT_ACCESS_SECRET: "dev-only-secret-dev-only-secret-0001" }],
      ["JWT_ACCESS_SECRET", { JWT_ACCESS_SECRET: "ci-only-secret-ci-only-secret-000001" }],
      ["JWT_ACCESS_SECRET", { JWT_ACCESS_SECRET: "MyHospitalPassword-MyHospitalPassword-1" }],
      ["DATABASE_URL", { DATABASE_URL: "postgresql://medos@db.internal:5432/medos_dev" }],
      ["DATABASE_URL", { DATABASE_URL: "postgresql://medos@db.internal:5432/medos_test" }],
      ["DATABASE_URL", { DATABASE_URL: "postgresql://medos@127.0.0.1:54329/medos" }],
      ["CORS_ORIGINS", { CORS_ORIGINS: "http://localhost:3000" }],
      ["CORS_ORIGINS", { CORS_ORIGINS: "https://localhost:3000" }],
      ["CORS_ORIGINS", { CORS_ORIGINS: "http://hospital.example.org" }],
      ["CORS_ORIGINS", { CORS_ORIGINS: "https://hospital.example.org, http://127.0.0.1:3000" }],
      ["RATE_LIMIT_ENABLED", { RATE_LIMIT_ENABLED: "false" }],
      ["NODE_ENV", { NODE_ENV: "development" }],
      ["NODE_ENV", { NODE_ENV: "test" }],
    ];
    for (const [setting, change] of refused) {
      for (const appEnv of ["production", "staging"]) {
        assert.throws(() => loadConfig(real({ APP_ENV: appEnv, ...change })), (e: Error) => e.message.includes(setting), `${appEnv}: ${JSON.stringify(change)}`);
      }
    }
  });

  it("never prints a secret or database password when it refuses", () => {
    const jwt = "change-me-min-32-chars-xxxxxxxxxxxxxxxx";
    try { loadConfig(real({ JWT_ACCESS_SECRET: jwt, DATABASE_URL: "postgresql://medos:Sup3rSecretPw@db.internal:5432/medos_dev" })); assert.fail("should have refused"); }
    catch (e) { assert.ok(!(e as Error).message.includes(jwt) && !(e as Error).message.includes("Sup3rSecretPw")); }
  });
});
