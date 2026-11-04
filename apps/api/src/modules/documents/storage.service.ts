import { Inject, Injectable } from "@nestjs/common";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { DomainError } from "@medos/shared";
import { CONFIG, type AppConfig } from "../../common/config";

const SAFE_SEGMENT = /^[0-9a-f-]{36}$/;

/** What a storage back end must do. Keys are already validated by StorageService before a driver sees them. */
export interface StorageDriver {
  /** Stores new bytes; never overwrites an existing object. */
  put(key: string, data: Buffer): Promise<void>;
  /** Returns the bytes, or throws NOT_FOUND. */
  get(key: string): Promise<Buffer>;
}

/** Files on this machine's disk under STORAGE_DIR. Fine for a single API instance. */
export class LocalStorageDriver implements StorageDriver {
  private readonly root: string;

  constructor(storageDir: string) {
    this.root = resolve(storageDir);
  }

  private pathFor(key: string): string {
    const full = resolve(join(this.root, ...key.split("/")));
    if (!full.startsWith(this.root + sep)) throw new DomainError("INTERNAL_ERROR", "Invalid storage key", 500);
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: "wx", mode: 0o600 }); // never overwrite an existing object
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new DomainError("NOT_FOUND", "Resource not found", 404);
      throw e;
    }
  }
}

/**
 * Any S3-compatible object store (AWS S3, Cloudflare R2, Ceph, SeaweedFS…), so every API instance sees the same files.
 * Objects are written once (`If-None-Match: *`), optionally encrypted by the store (S3_SSE), and kept under S3_PREFIX.
 * The client asks for checksums only where the protocol requires them: the newer default is rejected by several
 * S3-compatible stores.
 */
export class S3StorageDriver implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly sse: AppConfig["S3_SSE"];
  private readonly kmsKeyId: string | undefined;

  constructor(config: AppConfig, client?: S3Client) {
    this.bucket = config.S3_BUCKET as string;
    this.prefix = config.S3_PREFIX;
    this.sse = config.S3_SSE;
    this.kmsKeyId = config.S3_KMS_KEY_ID;
    this.client = client ?? new S3Client({
      region: config.S3_REGION as string,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY ? { credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY } } : {}),
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
    });
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: this.prefix + key, Body: data, ContentLength: data.length, ContentType: "application/octet-stream",
      IfNoneMatch: "*",
      ...(this.sse ? { ServerSideEncryption: this.sse } : {}),
      ...(this.sse === "aws:kms" && this.kmsKeyId ? { SSEKMSKeyId: this.kmsKeyId } : {}),
    }));
  }

  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
      if (!res.Body) throw new Error("The object store returned no body");
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      throw e;
    }
  }
}

/**
 * File byte storage behind one small interface (CLAUDE.md §42). STORAGE_DRIVER picks the back end. Keys are
 * `<tenantId>/<fileId>`: both are server-generated UUIDs, never user input, and every key is checked here whatever the driver.
 */
@Injectable()
export class StorageService {
  private readonly driver: StorageDriver;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.driver = config.STORAGE_DRIVER === "s3" ? new S3StorageDriver(config) : new LocalStorageDriver(config.STORAGE_DIR);
  }

  static keyFor(tenantId: string, fileId: string): string {
    return `${tenantId}/${fileId}`;
  }

  private checked(key: string): string {
    const parts = key.split("/");
    if (parts.length !== 2 || !parts.every((p) => SAFE_SEGMENT.test(p))) throw new DomainError("INTERNAL_ERROR", "Invalid storage key", 500);
    return key;
  }

  async put(key: string, data: Buffer): Promise<void> {
    return this.driver.put(this.checked(key), data);
  }

  async get(key: string): Promise<Buffer> {
    return this.driver.get(this.checked(key));
  }
}
