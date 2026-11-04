import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { createHash } from "node:crypto";
import { PrismaService, type Db } from "./prisma.service";

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,64}$/;

export function parseIdempotencyKey(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !KEY_FORMAT.test(raw)) {
    throw new DomainError("VALIDATION_FAILED", "Idempotency-Key must be 8-64 characters (letters, digits, - or _)", 400);
  }
  return raw;
}

function stableStringify(v: unknown): string {
  // A Date has no enumerable fields, so without this two requests that differ only in a date (a date of birth, an appointment time) compared as equal.
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Makes an operation safe against double-submit and client retries.
 * The key row is inserted inside the SAME transaction as the work, so it exists iff the work committed.
 * A concurrent request with the same key blocks on the unique index until the first one finishes, then
 * replays its stored response. Reusing a key with a different request body is rejected.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    tenantId: string, scope: string, key: string | undefined, request: unknown,
    work: (tx: Db) => Promise<T>,
  ): Promise<{ result: T; replayed: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      if (!key) return { result: await work(tx), replayed: false };
      const requestHash = createHash("sha256").update(stableStringify(request)).digest("hex");
      const inserted = await tx.$executeRaw`
        INSERT INTO "IdempotencyKey" ("tenantId", "scope", "key", "requestHash")
        VALUES (${tenantId}::uuid, ${scope}, ${key}, ${requestHash})
        ON CONFLICT DO NOTHING`;
      if (inserted === 0) {
        const row = await tx.idempotencyKey.findUniqueOrThrow({ where: { tenantId_scope_key: { tenantId, scope, key } } });
        if (row.requestHash !== requestHash) {
          throw new DomainError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used with a different request", 422);
        }
        return { result: row.responseBody as T, replayed: true };
      }
      const result = await work(tx);
      const stored = JSON.parse(JSON.stringify(result ?? null)) as Prisma.InputJsonValue;
      await tx.idempotencyKey.update({ where: { tenantId_scope_key: { tenantId, scope, key } }, data: { responseBody: stored } });
      return { result, replayed: false };
    }, TX_OPTIONS);
  }
}
