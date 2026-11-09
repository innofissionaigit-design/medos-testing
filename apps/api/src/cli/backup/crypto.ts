import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { open, rm, type FileHandle } from "node:fs/promises";

/**
 * Backup encryption: AES-256-GCM over a file, in independently authenticated chunks so any size can be streamed.
 *
 * File layout:  "MEDOSBK1" | version(1) | keyId(8) | noncePrefix(4) | chunkSize(4, big endian) | chunk*
 * Chunk:        ciphertext (chunkSize bytes, fewer in the last chunk) | GCM tag (16)
 * Each chunk uses IV = noncePrefix | counter(8), so no IV repeats under one key, and authenticates AAD = counter | isLast(1).
 * That makes tampering, reordering, dropping a chunk, and truncating the file (even exactly at a chunk boundary) all fail
 * authentication. The plaintext is only ever produced after its chunk has been verified.
 * The keyId is a non-secret fingerprint of the key (first 8 bytes of its SHA-256) so a backup says which key opens it.
 */
const MAGIC = Buffer.from("MEDOSBK1");
const VERSION = 1;
const HEADER_LEN = MAGIC.length + 1 + 8 + 4 + 4;
const TAG_LEN = 16;
export const DEFAULT_CHUNK = 1024 * 1024;

export type Keyring = Map<string, Buffer>; // keyId (hex) -> 32-byte key

export const keyIdOf = (key: Buffer): string => createHash("sha256").update(key).digest().subarray(0, 8).toString("hex");

export function parseKey(b64: string): Buffer {
  const key = Buffer.from(b64.trim(), "base64");
  if (key.length !== 32) throw new Error("A backup key must be exactly 32 bytes (base64). Generate one with: db-backup keygen");
  return key;
}

const u64 = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
const aad = (counter: bigint, last: boolean): Buffer => Buffer.concat([u64(counter), Buffer.from([last ? 1 : 0])]);

async function readUpTo(fh: FileHandle, size: number): Promise<Buffer> {
  const buf = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const { bytesRead } = await fh.read(buf, got, size - got, null);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got === size ? buf : buf.subarray(0, got);
}

export async function encryptFile(src: string, dst: string, key: Buffer, chunkSize = DEFAULT_CHUNK): Promise<{ keyId: string; bytes: number }> {
  if (key.length !== 32) throw new Error("Backup key must be 32 bytes");
  const prefix = randomBytes(4);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), Buffer.from(keyIdOf(key), "hex"), prefix, Buffer.alloc(4)]);
  header.writeUInt32BE(chunkSize, header.length - 4);
  const fin = await open(src, "r");
  const fout = await open(dst, "w", 0o600);
  let bytes = 0;
  try {
    await fout.write(header);
    bytes += header.length;
    let counter = 0n;
    let cur = await readUpTo(fin, chunkSize);
    for (;;) {
      const next = cur.length === chunkSize ? await readUpTo(fin, chunkSize) : Buffer.alloc(0);
      const last = next.length === 0;
      const cipher = createCipheriv("aes-256-gcm", key, Buffer.concat([prefix, u64(counter)]));
      cipher.setAAD(aad(counter, last));
      const out = Buffer.concat([cipher.update(cur), cipher.final(), cipher.getAuthTag()]);
      await fout.write(out);
      bytes += out.length;
      if (last) break;
      cur = next;
      counter += 1n;
    }
  } catch (e) {
    await fin.close(); await fout.close();
    await rm(dst, { force: true });
    throw e;
  }
  await fin.close(); await fout.close();
  return { keyId: keyIdOf(key), bytes };
}

/** Reads only the header: which key a backup needs, without any key. */
export async function readKeyId(file: string): Promise<string | null> {
  const fh = await open(file, "r");
  try {
    const h = await readUpTo(fh, HEADER_LEN);
    if (h.length < HEADER_LEN || !h.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    return h.subarray(MAGIC.length + 1, MAGIC.length + 9).toString("hex");
  } finally { await fh.close(); }
}

export async function isEncrypted(file: string): Promise<boolean> {
  return (await readKeyId(file)) !== null;
}

export async function decryptFile(src: string, dst: string, keys: Keyring): Promise<{ keyId: string; bytes: number }> {
  const fin = await open(src, "r");
  let fout: FileHandle | undefined;
  let bytes = 0;
  try {
    const h = await readUpTo(fin, HEADER_LEN);
    if (h.length < HEADER_LEN || !h.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not an encrypted MedOS backup (bad header)");
    if (h[MAGIC.length] !== VERSION) throw new Error(`Unsupported backup encryption version ${h[MAGIC.length]}`);
    const keyId = h.subarray(MAGIC.length + 1, MAGIC.length + 9).toString("hex");
    const key = keys.get(keyId);
    if (!key) throw new Error(`This backup needs key ${keyId}, which is not in the configured keys`);
    const prefix = h.subarray(MAGIC.length + 9, MAGIC.length + 13);
    const chunkSize = h.readUInt32BE(MAGIC.length + 13);
    if (chunkSize < 1 || chunkSize > 64 * 1024 * 1024) throw new Error("Corrupt backup header (chunk size)");
    const record = chunkSize + TAG_LEN;
    fout = await open(dst, "w", 0o600);
    let counter = 0n;
    let cur = await readUpTo(fin, record);
    if (cur.length < TAG_LEN) throw new Error("Backup is truncated or corrupt");
    for (;;) {
      const next = cur.length === record ? await readUpTo(fin, record) : Buffer.alloc(0);
      const last = next.length === 0;
      const body = cur.subarray(0, cur.length - TAG_LEN);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.concat([prefix, u64(counter)]));
      decipher.setAAD(aad(counter, last));
      decipher.setAuthTag(cur.subarray(cur.length - TAG_LEN));
      let plain: Buffer;
      try { plain = Buffer.concat([decipher.update(body), decipher.final()]); }
      catch { throw new Error("Backup failed authentication: it was modified, truncated, reordered, or the key is wrong"); }
      await fout.write(plain);
      bytes += plain.length;
      if (last) break;
      if (next.length < TAG_LEN) throw new Error("Backup is truncated or corrupt");
      cur = next;
      counter += 1n;
    }
    await fout.close();
    return { keyId, bytes };
  } catch (e) {
    await fout?.close().catch(() => undefined);
    await rm(dst, { force: true });
    throw e;
  } finally {
    await fin.close();
  }
}
