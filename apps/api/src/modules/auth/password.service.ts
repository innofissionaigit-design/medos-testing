import { Inject, Injectable } from "@nestjs/common";
import { Algorithm, hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { CONFIG, type AppConfig } from "../../common/config";

const KEY_LEN = 32;
const ARGON2_PREFIX = "$argon2id$";
/** A stored hash is trusted data, but a corrupted row must not be able to ask for gigabytes or minutes of work. */
const MAX_ARGON2_MEMORY_KIB = 1_048_576;
const MAX_ARGON2_PASSES = 10;

function scryptAsync(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

interface Argon2Params { m: number; t: number; p: number }

/** Reads `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>`; null when it is not a well-formed Argon2id hash. */
function parseArgon2(stored: string): Argon2Params | null {
  const parts = stored.split("$"); // "", "argon2id", "v=19", "m=…,t=…,p=…", salt, hash
  if (parts.length !== 6 || parts[1] !== "argon2id" || parts[2] !== "v=19") return null;
  const m = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parts[3] ?? "");
  if (!m || !/^[A-Za-z0-9+/]{8,}$/.test(parts[4] ?? "") || !/^[A-Za-z0-9+/]{16,}$/.test(parts[5] ?? "")) return null;
  const params = { m: Number(m[1]), t: Number(m[2]), p: Number(m[3]) };
  return params.m >= 8 && params.m <= MAX_ARGON2_MEMORY_KIB && params.t >= 1 && params.t <= MAX_ARGON2_PASSES && params.p >= 1 && params.p <= 16 ? params : null;
}

/**
 * Password hashing with Argon2id (docs/adr/011-argon2id.md), in the standard PHC string format, which carries its own
 * parameters. It runs on a background thread, so a login never stalls other requests.
 *
 * Hashes made before Argon2id (`scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`) still verify, and `needsRehash` tells the login
 * to replace them (or any Argon2id hash with weaker settings than configured) once the correct password has been presented.
 */
@Injectable()
export class PasswordService {
  private dummy?: Promise<string>;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async hash(password: string): Promise<string> {
    return argon2Hash(password.normalize("NFKC"), {
      algorithm: Algorithm.Argon2id, memoryCost: this.config.ARGON2_MEMORY_KIB, timeCost: this.config.ARGON2_PASSES, parallelism: 1, outputLen: KEY_LEN,
    });
  }

  async verify(password: string, stored: string): Promise<boolean> {
    if (stored.startsWith(ARGON2_PREFIX)) {
      if (!parseArgon2(stored)) return false;
      try {
        return await argon2Verify(stored, password.normalize("NFKC"));
      } catch {
        return false;
      }
    }
    return this.verifyScrypt(password, stored);
  }

  /** True for any hash that is not Argon2id with at least the configured memory and passes. */
  needsRehash(stored: string): boolean {
    const p = stored.startsWith(ARGON2_PREFIX) ? parseArgon2(stored) : null;
    return !p || p.m < this.config.ARGON2_MEMORY_KIB || p.t < this.config.ARGON2_PASSES || p.p < 1;
  }

  /** Burn comparable CPU when the account does not exist so response time does not reveal it. */
  async verifyDummy(password: string): Promise<void> {
    this.dummy ??= this.hash("dummy-password-for-timing");
    await this.verify(password, await this.dummy);
  }

  /** Legacy format, kept only so existing accounts can sign in once and be upgraded. */
  private async verifyScrypt(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    const salt = Buffer.from(parts[4] ?? "", "base64");
    const expected = Buffer.from(parts[5] ?? "", "base64");
    const actual = await scryptAsync(password.normalize("NFKC"), salt, { N, r, p, maxmem: 256 * N * r });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
