import { Inject, Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DomainError } from "@medos/shared";
import { CONFIG, type AppConfig } from "./config";

/**
 * Encrypts secrets that administrators type into the app (for example an OCR service key) before they are stored: AES-256-GCM with a random nonce,
 * stored as `v1.<nonce>.<tag>.<data>` in base64. The key comes from SECRETS_ENCRYPTION_KEY and never from the database, so a copy of the database alone
 * does not reveal the secrets. Callers must never log or return the decrypted value.
 */
@Injectable()
export class SecretsService {
  private readonly key: Buffer | null;
  constructor(@Inject(CONFIG) config: AppConfig) {
    this.key = config.SECRETS_ENCRYPTION_KEY ? Buffer.from(config.SECRETS_ENCRYPTION_KEY, "base64") : null;
  }

  get available(): boolean { return this.key !== null; }

  private need(): Buffer {
    if (!this.key) throw new DomainError("SECRETS_KEY_MISSING", "The server has no secrets encryption key (SECRETS_ENCRYPTION_KEY), so an API key cannot be stored safely. Ask your administrator to set it.", 409);
    return this.key;
  }

  /** Throws the plain-words error when no key is configured. */
  assertAvailable(): void { this.need(); }

  encrypt(plain: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.need(), nonce);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", nonce.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
  }

  decrypt(stored: string): string {
    const [v, nonce, tag, data] = stored.split(".");
    if (v !== "v1" || !nonce || !tag || !data) throw new DomainError("SECRETS_UNREADABLE", "The saved API key cannot be read. Enter it again.", 409);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.need(), Buffer.from(nonce, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw new DomainError("SECRETS_UNREADABLE", "The saved API key cannot be read. Enter it again.", 409);
    }
  }
}
