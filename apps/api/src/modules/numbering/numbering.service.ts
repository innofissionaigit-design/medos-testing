import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

export type SequenceType = "MRN" | "OPD_VISIT" | "ADMISSION" | "INVOICE" | "RECEIPT" | "PRESCRIPTION" | "CREDIT_NOTE" | "REFUND" | "PURCHASE" | "PURCHASE_RETURN" | "PHARMACY_RECEIPT" | "STOCK_TRANSFER" | "DOCTOR_PAYOUT" | "LAB_ACCESSION" | "RAD_ACCESSION" | "CLAIM" | "EMPLOYEE" | "INDENT" | "PURCHASE_ORDER" | "STOCK_REQUEST" | "DEBIT_NOTE" | "STOCK_COUNT" | "COMPLAINT";
export type ResetPolicy = "NEVER" | "YEARLY" | "FINANCIAL_YEAR";

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
  { type: "INDENT", pattern: "IND-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "PURCHASE_ORDER", pattern: "PO-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "STOCK_REQUEST", pattern: "SRQ-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "DEBIT_NOTE", pattern: "SDN-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "STOCK_COUNT", pattern: "SCT-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
  { type: "COMPLAINT", pattern: "CMP-{YEAR}-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
];

const TYPES = DEFAULT_SEQUENCES.map((d) => d.type) as [SequenceType, ...SequenceType[]];

export const sequenceConfigSchema = z.object({
  pattern: z.string().min(5).max(60).regex(/^[A-Za-z0-9{}\-/_.]+$/, "Only letters, digits and - / _ . { } allowed"),
  padding: z.number().int().min(1).max(12),
  resetPolicy: z.enum(["NEVER", "YEARLY", "FINANCIAL_YEAR"]),
  /** Continue from an existing series: the next number issued is at least this. It never moves a counter backwards. */
  nextNumber: z.number().int().min(1).max(999_999_999_999).optional(),
}).strict().superRefine((v, c) => {
  if (v.resetPolicy === "FINANCIAL_YEAR" && !v.pattern.includes("{FY}")) c.addIssue({ code: "custom", path: ["pattern"], message: "Financial-year restart requires {FY} in the pattern" });
  if (v.resetPolicy !== "FINANCIAL_YEAR" && v.pattern.includes("{FY}")) c.addIssue({ code: "custom", path: ["pattern"], message: "{FY} can only be used when the numbers restart every financial year" });
  if (!v.pattern.includes("{SEQ}")) c.addIssue({ code: "custom", path: ["pattern"], message: "Pattern must contain {SEQ}" });
  if (v.resetPolicy === "YEARLY" && !v.pattern.includes("{YEAR}")) {
    c.addIssue({ code: "custom", path: ["pattern"], message: "Yearly reset requires {YEAR} in the pattern" });
  }
  const unknown = v.pattern.match(/\{[^}]*\}/g)?.filter((t) => !["{SEQ}", "{YEAR}", "{FY}", "{FACILITY}"].includes(t));
  if (unknown?.length) c.addIssue({ code: "custom", path: ["pattern"], message: `Unknown token ${unknown[0]}` });
});

export const sequenceTypeSchema = z.enum(TYPES);

function yearIn(tz: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(at);
}

/** The Indian financial year the moment falls in, in the facility's time zone: 1 April 2026 to 31 March 2027 is "2026-27". */
export function financialYearIn(tz: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "numeric" }).formatToParts(at);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** What the counter is keyed by: nothing (never restarts), the calendar year, or the financial year. */
function periodKeyOf(policy: ResetPolicy, tz: string, at: Date): string {
  return policy === "YEARLY" ? yearIn(tz, at) : policy === "FINANCIAL_YEAR" ? financialYearIn(tz, at) : "";
}

/** GST rules for a tax invoice number (rule 46): at most 16 characters, only letters, digits, hyphen and slash. Applied to the bills that carry GST. */
const GST_TYPES: readonly SequenceType[] = ["INVOICE", "CREDIT_NOTE", "PHARMACY_RECEIPT"];
export function assertGstNumberFormat(type: SequenceType, pattern: string, padding: number, facilityCode: string): void {
  if (!GST_TYPES.includes(type)) return;
  if (/[_.]/.test(pattern)) throw new DomainError("VALIDATION_FAILED", "A bill number may use only letters, digits, - and / (GST rule)", 400, [{ path: "pattern", message: "Remove _ and ." }]);
  const longest = pattern.replaceAll("{FACILITY}", facilityCode).replaceAll("{YEAR}", "2026").replaceAll("{FY}", "2026-27").replaceAll("{SEQ}", "9".repeat(padding));
  if (longest.length > 16) {
    throw new DomainError("VALIDATION_FAILED", `A bill number can be at most 16 characters (GST rule); this format gives up to ${longest.length}, for example ${longest}. Shorten the text or use fewer digits.`, 400, [{ path: "pattern", message: "Longer than 16 characters" }]);
  }
}

function render(pattern: string, padding: number, facilityCode: string, year: string, financialYear: string, seq: bigint): string {
  return pattern
    .replaceAll("{FACILITY}", facilityCode)
    .replaceAll("{YEAR}", year)
    .replaceAll("{FY}", financialYear)
    .replaceAll("{SEQ}", seq.toString().padStart(padding, "0"));
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
    const periodKey = periodKeyOf(cfg.resetPolicy, facility.timezone, at);
    const seq = await this.counter(db, tenantId, facilityId, type, periodKey);

    return render(cfg.pattern, cfg.padding, facility.code, year, financialYearIn(facility.timezone, at), seq);
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

  /** The formats of this facility, with the number that would be issued next (what an administrator checks before going live or continuing an old series). */
  async list(ctx: RequestContext) {
    const [stored, facility, counters] = await Promise.all([
      this.prisma.numberSequenceConfig.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { type: true, pattern: true, padding: true, resetPolicy: true } }),
      this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { code: true, timezone: true } }),
      this.prisma.numberSequence.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: { in: DEFAULT_SEQUENCES.map((d) => d.type) } }, select: { type: true, periodKey: true, lastValue: true } }),
    ]);
    const byType = new Map(stored.map((s) => [s.type, s]));
    const now = new Date();
    return DEFAULT_SEQUENCES.map((d) => {
      const cfg = byType.get(d.type) ?? d;
      const key = periodKeyOf(cfg.resetPolicy, facility.timezone, now);
      const last = counters.find((c) => c.type === d.type && c.periodKey === key)?.lastValue ?? 0n;
      const nextNumber = Number(last) + 1;
      return {
        // "default" means the same as the built-in format, even if a copy of it was stored when the hospital was set up.
        ...cfg, isDefault: cfg.pattern === d.pattern && cfg.padding === d.padding && cfg.resetPolicy === d.resetPolicy, nextNumber,
        example: render(cfg.pattern, cfg.padding, facility.code, yearIn(facility.timezone, now), financialYearIn(facility.timezone, now), BigInt(nextNumber)),
      };
    });
  }

  async update(ctx: RequestContext, type: SequenceType, input: z.infer<typeof sequenceConfigSchema>) {
    // MRNs must be unique tenant-wide; the facility code in the pattern guarantees that across facilities.
    if (type === "MRN" && !input.pattern.includes("{FACILITY}")) {
      throw new DomainError("VALIDATION_FAILED", "The MRN pattern must contain {FACILITY} so MRNs stay unique across facilities", 400);
    }
    return this.prisma.$transaction(async (tx) => {
      const facility = await tx.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { code: true, timezone: true } });
      assertGstNumberFormat(type, input.pattern, input.padding, facility.code);
      const where = { tenantId_facilityId_type: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type } };
      const before = (await tx.numberSequenceConfig.findUnique({ where })) ?? DEFAULT_SEQUENCES.find((d) => d.type === type);
      const { nextNumber, ...config } = input;
      const row = await tx.numberSequenceConfig.upsert({
        where,
        create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type, ...config },
        update: config,
        select: { type: true, pattern: true, padding: true, resetPolicy: true },
      });

      // Numbers already issued are never issued again. The counters are kept per period (none, calendar year, financial year), so when the restart rule changes the new
      // counter starts from the highest number used so far rather than from 1 (otherwise "INV-2026-000001" could be issued a second time). A requested starting
      // number can only raise the counter, never lower it.
      const key = periodKeyOf(input.resetPolicy, facility.timezone, new Date());
      const used = await tx.numberSequence.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type }, select: { periodKey: true, lastValue: true } });
      let floor = used.find((u) => u.periodKey === key)?.lastValue ?? 0n;
      if (before && before.resetPolicy !== input.resetPolicy) for (const u of used) if (u.lastValue > floor) floor = u.lastValue;
      if (nextNumber !== undefined && BigInt(nextNumber - 1) > floor) floor = BigInt(nextNumber - 1);
      const current = used.find((u) => u.periodKey === key)?.lastValue ?? 0n;
      if (floor > current) {
        await tx.$executeRaw`
          INSERT INTO "NumberSequence" ("tenantId", "facilityId", "type", "periodKey", "lastValue")
          VALUES (${ctx.tenantId}::uuid, ${ctx.facilityId}::uuid, ${type}, ${key}, ${floor})
          ON CONFLICT ("tenantId", "facilityId", "type", "periodKey")
          DO UPDATE SET "lastValue" = GREATEST("NumberSequence"."lastValue", EXCLUDED."lastValue")`;
      }
      await this.audit.record(tx, actorOf(ctx), {
        action: "NUMBER_SEQUENCE_CONFIG_CHANGED", entityType: "NumberSequenceConfig", entityId: type,
        metadata: {
          type, from: before?.pattern ?? null, to: input.pattern,
          ...(before && before.resetPolicy !== input.resetPolicy ? { restart: [before.resetPolicy, input.resetPolicy] } : {}),
          ...(floor > current ? { nextNumber: Number(floor) + 1 } : {}),
        },
      });
      return { ...row, nextNumber: Number(floor > current ? floor : current) + 1 };
    });
  }
}
