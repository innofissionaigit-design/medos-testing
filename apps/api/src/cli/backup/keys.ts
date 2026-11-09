import { readFileSync } from "node:fs";
import { keyIdOf, parseKey, type Keyring } from "./crypto";

export interface KeyConfig {
  /** The key new backups are encrypted with, or null when none is configured. */
  current: { id: string; key: Buffer } | null;
  /** Every key a backup might need to be opened (the current one and older ones kept for restores). */
  ring: Keyring;
}

/**
 * Keys come from the environment, never from the command line or from git:
 *   BACKUP_ENCRYPTION_KEY    one base64 32-byte key (generate with `db-backup keygen`)
 *   BACKUP_KEYRING_FILE      JSON { "current": "<label>", "keys": { "<label>": "<base64 key>", ... } } for key rotation:
 *                            new backups use `current`; older backups stay restorable while their key stays in the file.
 * If both are set the single key is the current one. Store the key in your secrets manager, and keep a copy somewhere other than
 * the place the backups live: a backup is only as recoverable as its key.
 */
export function loadKeys(env: NodeJS.ProcessEnv = process.env): KeyConfig {
  const ring: Keyring = new Map();
  let current: KeyConfig["current"] = null;
  if (env["BACKUP_KEYRING_FILE"]) {
    const j = JSON.parse(readFileSync(env["BACKUP_KEYRING_FILE"], "utf8")) as { current?: string; keys?: Record<string, string> };
    for (const [label, b64] of Object.entries(j.keys ?? {})) {
      let key: Buffer;
      try { key = parseKey(b64); } catch { throw new Error(`Key "${label}" in the keyring file is not a valid 32-byte base64 key`); }
      ring.set(keyIdOf(key), key);
      if (j.current === label) current = { id: keyIdOf(key), key };
    }
    if (j.current && !current) throw new Error(`The keyring's current key "${j.current}" is not among its keys`);
  }
  if (env["BACKUP_ENCRYPTION_KEY"]) {
    const key = parseKey(env["BACKUP_ENCRYPTION_KEY"]);
    ring.set(keyIdOf(key), key);
    current = { id: keyIdOf(key), key };
  }
  return { current, ring };
}
