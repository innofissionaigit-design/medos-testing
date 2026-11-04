import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptFile, encryptFile, isEncrypted, keyIdOf, readKeyId, type Keyring } from "./crypto";
import { loadKeys } from "./keys";
import { applyRetention, backupStatus, listManifests, type Manifest } from "./service";
import { assertPlainName, parseDatabaseUrl } from "./pgtools";

describe("backup encryption (AES-256-GCM, chunked)", () => {
  let dir: string;
  const key = randomBytes(32);
  const ring: Keyring = new Map([[keyIdOf(key), key]]);
  const CHUNK = 1024; // small, so every boundary case is cheap to test
  before(() => { dir = mkdtempSync(join(tmpdir(), "medos-crypto-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  const plain = (name: string, bytes: Buffer): string => { const p = join(dir, name); writeFileSync(p, bytes); return p; };
  const roundTrip = async (bytes: Buffer): Promise<{ enc: string; out: Buffer }> => {
    const src = plain(`p-${randomBytes(4).toString("hex")}`, bytes);
    const enc = `${src}.enc`;
    await encryptFile(src, enc, key, CHUNK);
    const dst = `${src}.out`;
    await decryptFile(enc, dst, ring);
    return { enc, out: readFileSync(dst) };
  };

  it("round-trips every size around the chunk boundaries, with exactly the expected overhead", async () => {
    for (const n of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 3 * CHUNK + 17, 10_000]) {
      const data = randomBytes(n);
      const { enc, out } = await roundTrip(data);
      assert.ok(out.equals(data), `size ${n} came back identical`);
      const chunks = Math.max(1, Math.ceil(n / CHUNK));
      assert.equal(statSync(enc).size, 25 + n + 16 * chunks, `size ${n}: header + data + one tag per chunk`);
    }
  });

  it("hides the content and encrypts the same data differently each time", async () => {
    const marker = Buffer.from("MEDOS-PLAINTEXT-MARKER-patient-name-Ramannagari");
    const data = Buffer.concat(Array.from({ length: 200 }, () => marker));
    const a = await roundTrip(data);
    const b = await roundTrip(data);
    assert.equal(readFileSync(a.enc).includes(marker), false, "the plaintext is not in the file");
    assert.equal(readFileSync(a.enc).subarray(0, 8).toString(), "MEDOSBK1");
    assert.notDeepEqual(readFileSync(a.enc).subarray(25), readFileSync(b.enc).subarray(25), "a fresh random nonce per file");
    assert.equal(await isEncrypted(a.enc), true);
    assert.equal(await isEncrypted(plain("not-encrypted", Buffer.from("PGDMP...."))), false);
    assert.equal(await readKeyId(a.enc), keyIdOf(key), "the file says which key opens it, without any key");
  });

  it("refuses a modified file: any changed byte, in the body, a tag, or the header", async () => {
    const data = randomBytes(3 * CHUNK + 50);
    const { enc } = await roundTrip(data);
    const original = readFileSync(enc);
    const attempt = async (mutate: (b: Buffer) => Buffer, label: string, expected: RegExp): Promise<void> => {
      const p = plain(`m-${randomBytes(4).toString("hex")}`, mutate(Buffer.from(original)));
      await assert.rejects(decryptFile(p, `${p}.out`, ring), expected, label);
      assert.equal(existsSync(`${p}.out`), false, `${label}: no partial plaintext is left behind`);
    };
    const flip = (b: Buffer, i: number): Buffer => { b.writeUInt8(b.readUInt8(i) ^ 1, i); return b; };
    await attempt((b) => flip(b, 40), "a body byte", /authentication/);
    await attempt((b) => flip(b, 25 + CHUNK + 3), "a tag byte", /authentication/);
    await attempt((b) => flip(b, b.length - 1), "the last tag byte", /authentication/);
    await attempt((b) => flip(b, 10), "the key id in the header", /needs key/);
    await attempt((b) => flip(b, 0), "the magic", /Not an encrypted MedOS backup/);
    await attempt((b) => { b.writeUInt8(9, 8); return b; }, "the version", /Unsupported/);
    await attempt((b) => { b.writeUInt32BE(0, 21); return b; }, "the chunk size", /Corrupt backup header|authentication|truncated/);
  });

  it("refuses a truncated, extended or reordered file, even when cut exactly at a chunk boundary", async () => {
    const data = randomBytes(4 * CHUNK + 100);
    const { enc } = await roundTrip(data);
    const original = readFileSync(enc);
    const rec = CHUNK + 16;
    const attempt = async (bytes: Buffer, label: string): Promise<void> => {
      const p = plain(`t-${randomBytes(4).toString("hex")}`, bytes);
      await assert.rejects(decryptFile(p, `${p}.out`, ring), /authentication|truncated|corrupt|Not an encrypted/i, label);
    };
    await attempt(original.subarray(0, 25 + 4 * rec), "the short last chunk removed (cut on a chunk boundary)");
    await attempt(original.subarray(0, 25 + 2 * rec), "two chunks removed");
    await attempt(original.subarray(0, original.length - 5), "cut inside the last tag");
    await attempt(original.subarray(0, 25), "header only");
    await attempt(original.subarray(0, 10), "less than a header");
    await attempt(Buffer.concat([original, randomBytes(40)]), "garbage appended");
    const swapped = Buffer.from(original);
    original.copy(swapped, 25, 25 + rec, 25 + 2 * rec);
    original.copy(swapped, 25 + rec, 25, 25 + rec);
    await attempt(swapped, "two chunks swapped");
  });

  it("refuses the wrong key, and says which key is needed when it is not available", async () => {
    const { enc } = await roundTrip(randomBytes(500));
    const other = randomBytes(32);
    await assert.rejects(decryptFile(enc, join(dir, "x1"), new Map([[keyIdOf(key), other]])), /authentication/, "a different key under the right id");
    await assert.rejects(decryptFile(enc, join(dir, "x2"), new Map([[keyIdOf(other), other]])), new RegExp(`needs key ${keyIdOf(key)}`));
    await assert.rejects(encryptFile(plain("k", Buffer.from("x")), join(dir, "k.enc"), randomBytes(16)), /32 bytes/);
  });

  it("supports key rotation: old backups open with the old key while new ones use the new key", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const src = plain("rot", randomBytes(3000));
    await encryptFile(src, `${src}.old`, oldKey, CHUNK);
    await encryptFile(src, `${src}.new`, newKey, CHUNK);
    const both: Keyring = new Map([[keyIdOf(oldKey), oldKey], [keyIdOf(newKey), newKey]]);
    await decryptFile(`${src}.old`, `${src}.o`, both);
    await decryptFile(`${src}.new`, `${src}.n`, both);
    assert.ok(readFileSync(`${src}.o`).equals(readFileSync(src)) && readFileSync(`${src}.n`).equals(readFileSync(src)));
  });
});

describe("backup keys from the environment", () => {
  it("loads a single key, a keyring with a current key, and prefers the single key", () => {
    const a = randomBytes(32); const b = randomBytes(32);
    assert.equal(loadKeys({}).current, null);
    assert.equal(loadKeys({ BACKUP_ENCRYPTION_KEY: a.toString("base64") }).current?.id, keyIdOf(a));
    const dir = mkdtempSync(join(tmpdir(), "medos-keys-"));
    const file = join(dir, "ring.json");
    writeFileSync(file, JSON.stringify({ current: "q4", keys: { q3: a.toString("base64"), q4: b.toString("base64") } }));
    const ring = loadKeys({ BACKUP_KEYRING_FILE: file });
    assert.equal(ring.current?.id, keyIdOf(b));
    assert.deepEqual([...ring.ring.keys()].sort(), [keyIdOf(a), keyIdOf(b)].sort(), "older keys stay available for restores");
    assert.equal(loadKeys({ BACKUP_KEYRING_FILE: file, BACKUP_ENCRYPTION_KEY: a.toString("base64") }).current?.id, keyIdOf(a));
    writeFileSync(file, JSON.stringify({ current: "nope", keys: { q3: a.toString("base64") } }));
    assert.throws(() => loadKeys({ BACKUP_KEYRING_FILE: file }), /current key "nope"/);
    writeFileSync(file, JSON.stringify({ keys: { bad: "AAAA" } }));
    assert.throws(() => loadKeys({ BACKUP_KEYRING_FILE: file }), /not a valid 32-byte/);
    assert.throws(() => loadKeys({ BACKUP_ENCRYPTION_KEY: "AAAA" }), /exactly 32 bytes/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("connection and name handling", () => {
  it("keeps credentials out of arguments and rejects unsafe names", () => {
    const c = parseDatabaseUrl("postgresql://medos:p%40ss@db.example.com:6543/medos_prod?sslmode=require");
    assert.deepEqual([c.host, c.port, c.user, c.password, c.database, c.sslmode], ["db.example.com", "6543", "medos", "p@ss", "medos_prod", "require"]);
    assert.throws(() => parseDatabaseUrl("mysql://x@y/z"), /postgresql/);
    for (const bad of ['a"; drop database x; --', "a b", "", "x".repeat(51), "a-b", "../x"]) assert.throws(() => assertPlainName(bad), /must be 1-50/);
    assert.equal(assertPlainName("medos_dev"), "medos_dev");
  });
});

describe("retention and status", () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), "medos-ret-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  const fake = (db: string, stamp: string): string => {
    const file = `${db}-${stamp}.dump.enc`;
    writeFileSync(join(dir, file), "x");
    const m: Manifest = { version: 1, database: db, createdAt: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`, file, sizeBytes: 1, sha256: "0", encrypted: true, keyId: "k", pgDumpVersion: "", serverVersion: "", counts: {}, rlsState: "", seconds: 0 };
    writeFileSync(join(dir, `${db}-${stamp}.manifest.json`), JSON.stringify(m));
    return file;
  };

  it("keeps the newest backups and never touches anything else", () => {
    const files = ["20261001T020000Z", "20261002T020000Z", "20261003T020000Z", "20261004T020000Z"].map((s) => fake("medos_dev", s));
    fake("medos_other", "20260101T020000Z");
    writeFileSync(join(dir, "notes.txt"), "keep me");
    writeFileSync(join(dir, "medos_dev-notabackup.dump"), "keep me too");
    assert.deepEqual(listManifests(dir, "medos_dev").map((m) => m.file), [files[3], files[2], files[1], files[0]], "newest first");
    const removed = applyRetention(dir, "medos_dev", 2);
    assert.deepEqual(removed.sort(), [files[0], files[1]].sort());
    assert.deepEqual(listManifests(dir, "medos_dev").map((m) => m.file), [files[3], files[2]]);
    const left = readdirSync(dir);
    for (const f of ["notes.txt", "medos_dev-notabackup.dump", "medos_other-20260101T020000Z.dump.enc", "medos_other-20260101T020000Z.manifest.json"]) assert.ok(left.includes(f), `${f} untouched`);
    assert.deepEqual(applyRetention(dir, "medos_dev", 0), [files[2]], "always keeps at least the newest backup");
  });

  it("reports an unhealthy state for a missing, old, failed, or not-copied backup or drill", () => {
    const status = (obj: unknown): void => writeFileSync(join(dir, "status.json"), JSON.stringify(obj));
    const now = new Date("2026-10-28T12:00:00.000Z");
    const rep = (): ReturnType<typeof backupStatus> => backupStatus({ outDir: dir, database: "medos_dev", maxBackupAgeHours: 26, maxDrillAgeDays: 8, now });
    rmSync(join(dir, "status.json"), { force: true });
    assert.deepEqual(rep().problems, ["no backup has been recorded", "no restore drill has been recorded"]);
    const drill = (ok: boolean, at: string) => ({ ok, backup: "b", scratch: "s", seconds: 1, at, checks: [{ name: "row counts and totals match the backup", ok, detail: "" }] });
    status({ databases: { medos_dev: { lastBackup: { at: "2026-10-28T02:00:00.000Z", file: "f", sizeBytes: 1, encrypted: true, uploaded: true }, lastDrill: drill(true, "2026-10-26T03:00:00.000Z") } } });
    assert.equal(rep().ok, true);
    status({ databases: { medos_dev: { lastBackup: { at: "2026-10-26T02:00:00.000Z", file: "f", sizeBytes: 1, encrypted: true, uploaded: true }, lastDrill: drill(true, "2026-10-26T03:00:00.000Z") } } });
    assert.match(rep().problems[0]!, /hours old/);
    status({ databases: { medos_dev: { lastBackup: { at: "2026-10-28T02:00:00.000Z", file: "f", sizeBytes: 1, encrypted: true, uploaded: false }, lastDrill: drill(true, "2026-10-26T03:00:00.000Z") } } });
    assert.match(rep().problems[0]!, /NOT copied off the host/);
    status({ databases: { medos_dev: { lastBackup: { at: "2026-10-28T02:00:00.000Z", file: "f", sizeBytes: 1, encrypted: true, uploaded: null }, lastDrill: drill(false, "2026-10-27T03:00:00.000Z") } } });
    assert.match(rep().problems[0]!, /FAILED \(row counts/);
    status({ databases: { medos_dev: { lastBackup: { at: "2026-10-28T02:00:00.000Z", file: "f", sizeBytes: 1, encrypted: true, uploaded: null }, lastDrill: drill(true, "2026-10-10T03:00:00.000Z") } } });
    assert.match(rep().problems[0]!, /days old/);
  });
});
