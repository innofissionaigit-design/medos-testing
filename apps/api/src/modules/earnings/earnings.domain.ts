import { Decimal } from "@medos/shared";

export type ShareMode = "PERCENT" | "FIXED" | "MIXED";
export interface ShareRule { practitionerId: string | null; mode: ShareMode; percent: { toString(): string } | null; fixedAmount: { toString(): string } | null; effectiveFrom: Date; createdAt: Date }
/** What the money was for: a consultation that took place, or a cancellation charge kept for a booking that did not. */
export type EarningKind = "CONSULTED" | "CANCELLATION_CHARGE";

const D = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? 0);
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The rule in force for a doctor on a day (docs/earnings-and-reports.md): the doctor's own newest rule that had started by then, otherwise the facility
 * default's, otherwise none (the hospital keeps everything). A later rule never changes what an earlier visit earned.
 */
export function pickRule<R extends ShareRule>(rules: R[], practitionerId: string, visitDay: string): R | null {
  const newest = (xs: R[]) => xs.filter((r) => day(r.effectiveFrom) <= visitDay).sort((a, b) => day(b.effectiveFrom).localeCompare(day(a.effectiveFrom)) || b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  return newest(rules.filter((r) => r.practitionerId === practitionerId)) ?? newest(rules.filter((r) => r.practitionerId === null));
}

/**
 * The doctor's part of the amount collected, to the paisa, never more than was collected and never negative.
 *  - PERCENT: that percentage of the amount collected.
 *  - FIXED: a fixed amount for each consulted visit (nothing for a cancellation charge), capped at what was collected.
 *  - MIXED: the fixed amount plus the percentage, capped at what was collected.
 * The hospital's part is what is left: collected minus this.
 */
export function doctorShare(rule: ShareRule | null, collected: Decimal.Value, kind: EarningKind): Decimal {
  const amount = Decimal.max(0, D({ toString: () => new Decimal(collected).toString() }));
  if (!rule || amount.lte(0)) return new Decimal(0);
  const percentPart = amount.times(D(rule.percent)).div(100);
  const fixedPart = kind === "CONSULTED" ? D(rule.fixedAmount) : new Decimal(0);
  const raw = rule.mode === "PERCENT" ? percentPart : rule.mode === "FIXED" ? fixedPart : fixedPart.plus(percentPart);
  return Decimal.min(amount, raw).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
