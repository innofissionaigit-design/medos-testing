import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

export type SequenceType = "MRN" | "OPD_VISIT" | "ADMISSION" | "INVOICE" | "RECEIPT" | "PRESCRIPTION" | "CREDIT_NOTE" | "REFUND" | "PURCHASE" | "PURCHASE_RETURN" | "PHARMACY_RECEIPT" | "STOCK_TRANSFER" | "DOCTOR_PAYOUT" | "LAB_ACCESSION" | "RAD_ACCESSION" | "CLAIM" | "EMPLOYEE";
export type ResetPolicy = "NEVER" | "YEARLY";

export interface SequenceDefault { type: SequenceType; pattern: string; padding: number; resetPolicy: ResetPolicy }

export const DEFAULT_SEQUENCES: readonly SequenceDefault[] = [
  { type: "MRN", pattern: "{FACILITY}-{SEQ}", padding: 6, resetPolicy: "NEVER" },
  { type: "OPD_VISIT", pattern: "OPD-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "ADMISSION", pattern: "ADM-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "INVOICE", pattern: "INV-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "RECEIPT", pattern: "RCT-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "PRESCRIPTION", pattern: "RX-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "CREDIT_NOTE", pattern: "CN-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "REFUND", pattern: "RF-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "PURCHASE", pattern: "PUR-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "PURCHASE_RETURN", pattern: "PRN-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "PHARMACY_RECEIPT", pattern: "PH-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "STOCK_TRANSFER", pattern: "TRF-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "DOCTOR_PAYOUT", pattern: "DPV-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "LAB_ACCESSION", pattern: "LAB-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "RAD_ACCESSION", pattern: "RAD-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "CLAIM", pattern: "CLM-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "EMPLOYEE", pattern: "EMP-{SEQ}", padding: 4, resetPolicy: "NEVER" },
];

const TYPES = DEFAULT_SEQUENCES.map((d) => d.type) as [SequenceType, ...SequenceType[]];

export const sequenceConfigSchema = z.object({
  pattern: z.string().min(5).max(60).regex(/^[A-Za-z0-9{}\-/_.]+$/, "Only letters, digits and - / _ . { } allowed"),
  padding: z.number().int().min(1).max(12),
  resetPolicy: z.enum(["NEVER", "YEARLY"]),
}).strict().superRefine((v, c) => {
  if (!v.pattern.includes("{SEQ}")) c.addIssue({ code: "custom", path: ["pattern"], message: "Pattern must contain {SEQ}" });
  if (v.resetPolicy === "YEARLY" && !v.pattern.includes("{YEAR}")) {
    c.addIssue({ code: "custom", path: ["pattern"], message: "Yearly reset requires {YEAR} in the pattern" });
  }
  const unknown = v.pattern.match(/\{[^}]*\}/g)?.filter((t) => !["{SEQ}", "{YEAR}", "{FACILITY}"].includes(t));
  if (unknown?.length) c.addIssue({ code: "custom", path: ["pattern"], message: `Unknown token ${unknown[0]}` });
});

export const sequenceTypeSchema = z.enum(TYPES);

function yearIn(tz: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(at);
}

@Injectable()
export class NumberingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /**
   * Allocate the next business number. MUST be called with the caller's transaction client so the
   * counter increment commits (or rolls back) atomically with the record that uses the number.
   * Concurrency: a single atomic upsert-increment; concurrent callers serialise on the row lock.
   */
  async next(db: Db, tenantId: string, facilityId: string, type: SequenceType, at: Date = new Date()): Promise<string> {
    const facility = await db.facility.findFirst({ where: { id: facilityId, tenantId }, select: { code: true, timezone: true } });
    if (!facility) throw new DomainError("FACILITY_NOT_FOUND", "Facility not found", 404);

    const cfg = (await db.numberSequenceConfig.findUnique({ where: { tenantId_facilityId_type: { tenantId, facilityId, type } } }))
      ?? DEFAULT_SEQUENCES.find((d) => d.type === type);
    if (!cfg) throw new DomainError("INTERNAL_ERROR", "Unknown sequence type", 500);

    const year = yearIn(facility.timezone, at);
    const periodKey = cfg.resetPolicy === "YEARLY" ? year : "";
    const seq = await this.counter(db, tenantId, facilityId, type, periodKey);

    return cfg.pattern
      .replaceAll("{FACILITY}", facility.code)
      .replaceAll("{YEAR}", year)
      .replaceAll("{SEQ}", seq.toString().padStart(cfg.padding, "0"));
  }

  /**
   * Raw atomic counter for (tenant, facility, type, periodKey), e.g. daily queue tokens per practitioner.
   * Same concurrency guarantees and transaction requirements as next().
   */
  async counter(db: Db, tenantId: string, facilityId: string, type: string, periodKey: string): Promise<bigint> {
    const rows = await db.$queryRaw<{ lastValue: bigint }[]>`
      INSERT INTO "NumberSequence" ("tenantId", "facilityId", "type", "periodKey", "lastValue")
      VALUES (${tenantId}::uuid, ${facilityId}::uuid, ${type}, ${periodKey}, 1)
      ON CONFLICT ("tenantId", "facilityId", "type", "periodKey")
      DO UPDATE SET "lastValue" = "NumberSequence"."lastValue" + 1
      RETURNING "lastValue"`;
    const seq = rows[0]?.lastValue;
    if (seq === undefined) throw new DomainError("INTERNAL_ERROR", "Sequence allocation failed", 500);
    return seq;
  }

  async list(ctx: RequestContext) {
    const stored = await this.prisma.numberSequenceConfig.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      select: { type: true, pattern: true, padding: true, resetPolicy: true },
    });
    const byType = new Map(stored.map((s) => [s.type, s]));
    return DEFAULT_SEQUENCES.map((d) => ({ ...(byType.get(d.type) ?? d), isDefault: !byType.has(d.type) }));
  }

  async update(ctx: RequestContext, type: SequenceType, input: z.infer<typeof sequenceConfigSchema>) {
    // MRNs must be unique tenant-wide; the facility code in the pattern guarantees that across facilities.
    if (type === "MRN" && !input.pattern.includes("{FACILITY}")) {
      throw new DomainError("VALIDATION_FAILED", "The MRN pattern must contain {FACILITY} so MRNs stay unique across facilities", 400);
    }
    return this.prisma.$transaction(async (tx) => {
      const where = { tenantId_facilityId_type: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type } };
      const before = await tx.numberSequenceConfig.findUnique({ where });
      const row = await tx.numberSequenceConfig.upsert({
        where,
        create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type, ...input },
        update: input,
        select: { type: true, pattern: true, padding: true, resetPolicy: true },
      });
      await this.audit.record(tx, actorOf(ctx), {
        action: "NUMBER_SEQUENCE_CONFIG_CHANGED", entityType: "NumberSequenceConfig", entityId: type,
        metadata: { type, from: before?.pattern ?? null, to: input.pattern },
      });
      return row;
    });
  }
}
