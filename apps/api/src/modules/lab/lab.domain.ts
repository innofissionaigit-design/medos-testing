import { Decimal } from "@medos/shared";

export type LabFlag = "NORMAL" | "LOW" | "HIGH" | "CRITICAL_LOW" | "CRITICAL_HIGH";
export type ParamType = "NUMERIC" | "TEXT" | "CHOICE";

type Num = { toString(): string } | null | undefined;
export interface ParamFacts {
  type: ParamType; choices: string[]; decimals: number;
  low: Num; high: Num; lowMale: Num; highMale: Num; lowFemale: Num; highFemale: Num; criticalLow: Num; criticalHigh: Num;
}

const D = (v: Num): Decimal | null => (v === null || v === undefined ? null : new Decimal(v.toString()));

/** The reference range that applies to this patient: the range for their sex when the test has one, otherwise the general range. */
export function rangeFor(p: ParamFacts, gender: string | null | undefined): { low: Decimal | null; high: Decimal | null } {
  const male = gender === "MALE" && (p.lowMale !== null || p.highMale !== null);
  const female = gender === "FEMALE" && (p.lowFemale !== null || p.highFemale !== null);
  if (male) return { low: D(p.lowMale), high: D(p.highMale) };
  if (female) return { low: D(p.lowFemale), high: D(p.highFemale) };
  return { low: D(p.low), high: D(p.high) };
}

/** "12.0 - 16.0", "at least 4", "up to 200", or empty when the test has no range. */
export function rangeText(low: Decimal | null, high: Decimal | null, decimals: number): string {
  const f = (d: Decimal) => d.toFixed(decimals);
  if (low && high) return `${f(low)} - ${f(high)}`;
  if (low) return `at least ${f(low)}`;
  if (high) return `up to ${f(high)}`;
  return "";
}

/** A typed number: digits with an optional minus sign and decimals, at most three decimals. Returns null when it is not one. */
export function parseNumber(raw: string): Decimal | null {
  const s = raw.trim();
  return /^-?\d{1,9}(\.\d{1,3})?$/.test(s) ? new Decimal(s) : null;
}

/**
 * Whether a number is normal, low, high or critical for this patient. A critical value is at or beyond the critical limit, and is always reported as critical
 * even if it is also outside the normal range. A test with no range is reported as normal (there is nothing to compare with).
 */
export function flagNumber(p: ParamFacts, gender: string | null | undefined, value: Decimal): LabFlag {
  const cl = D(p.criticalLow), ch = D(p.criticalHigh);
  if (cl && value.lte(cl)) return "CRITICAL_LOW";
  if (ch && value.gte(ch)) return "CRITICAL_HIGH";
  const { low, high } = rangeFor(p, gender);
  if (low && value.lt(low)) return "LOW";
  if (high && value.gt(high)) return "HIGH";
  return "NORMAL";
}

export const isCritical = (f: LabFlag): boolean => f === "CRITICAL_LOW" || f === "CRITICAL_HIGH";
