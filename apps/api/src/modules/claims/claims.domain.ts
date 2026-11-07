import { Decimal } from "@medos/shared";

/** The steps a claim can take (docs/claims.md). Nothing else is allowed, and a finished claim goes nowhere. */
export type ClaimStatus = "DRAFT" | "PREAUTH_PENDING" | "PREAUTH_APPROVED" | "SUBMITTED" | "QUERY" | "APPROVED" | "REJECTED" | "SETTLED" | "CLOSED";
export type ClaimStep = "REQUEST_PREAUTH" | "DECIDE_PREAUTH" | "SUBMIT" | "RAISE_QUERY" | "RESUBMIT" | "DECIDE" | "SETTLE" | "CLOSE";

const NEXT: Record<ClaimStatus, Partial<Record<ClaimStep, ClaimStatus[]>>> = {
  DRAFT: { REQUEST_PREAUTH: ["PREAUTH_PENDING"], SUBMIT: ["SUBMITTED"], CLOSE: ["CLOSED"] },
  PREAUTH_PENDING: { DECIDE_PREAUTH: ["PREAUTH_APPROVED", "REJECTED"], CLOSE: ["CLOSED"] },
  PREAUTH_APPROVED: { SUBMIT: ["SUBMITTED"], CLOSE: ["CLOSED"] },
  SUBMITTED: { RAISE_QUERY: ["QUERY"], DECIDE: ["APPROVED", "REJECTED"], CLOSE: ["CLOSED"] },
  QUERY: { RESUBMIT: ["SUBMITTED"], DECIDE: ["REJECTED"], CLOSE: ["CLOSED"] },
  APPROVED: { SETTLE: ["APPROVED", "SETTLED"], CLOSE: ["CLOSED"] },
  REJECTED: {},
  SETTLED: {},
  CLOSED: {},
};

export const FINISHED: ClaimStatus[] = ["REJECTED", "SETTLED", "CLOSED"];

/** The status a step leads to from a status, or null when the step is not allowed there. `to` picks between the possible outcomes. */
export function nextStatus(from: ClaimStatus, step: ClaimStep, to?: ClaimStatus): ClaimStatus | null {
  const options = NEXT[from][step];
  if (!options) return null;
  if (to === undefined) return options.length === 1 ? options[0]! : null;
  return options.includes(to) ? to : null;
}

/** What a person may do next, for the screens: the steps open from this status. */
export const stepsFrom = (from: ClaimStatus): ClaimStep[] => Object.keys(NEXT[from]) as ClaimStep[];

/** Cashless claims need the insurer's pre-authorisation step available; reimbursement claims go straight to submission. */
export const stepAllowedForType = (step: ClaimStep, type: "CASHLESS" | "REIMBURSEMENT"): boolean => (step === "REQUEST_PREAUTH" || step === "DECIDE_PREAUTH" ? type === "CASHLESS" : true);

/** A policy's co-pay rule. A policy with no percentage and no deductible has no rule: the claimed amount is then entered by hand. */
export interface CopayRule { copayPercent: Decimal | null; deductible: Decimal; deductibleUsed: Decimal; sumInsured: Decimal | null }
export interface CopayResult {
  /** What the invoice is worth (after credit notes) before any policy rule. */
  base: Decimal;
  deductibleApplied: Decimal;
  copayPercentApplied: Decimal;
  /** The part of the covered amount the patient pays as co-pay. */
  copayAmount: Decimal;
  /** What to ask the insurer for. */
  claim: Decimal;
  /** Everything the patient bears: deductible, co-pay, and anything above the sum insured. */
  patientShare: Decimal;
  cappedBySumInsured: boolean;
}

export const hasCopayRule = (r: CopayRule): boolean => r.copayPercent !== null || r.deductible.gt(0);

/**
 * The amount to claim from the insurer and the patient's share (docs/claims.md). The deductible still to be met comes off first, the co-pay percentage applies to
 * what is left (rounded to the paisa, half up), and the claim never exceeds the sum insured. All amounts are exact decimals; the patient's share is whatever the
 * insurer is not asked for, so the two always add up to the invoice.
 */
export function calculateCopay(base: Decimal, rule: CopayRule): CopayResult {
  const stillToMeet = Decimal.max(0, rule.deductible.minus(rule.deductibleUsed));
  const deductibleApplied = Decimal.min(stillToMeet, base);
  const afterDeductible = base.minus(deductibleApplied);
  const copayPercentApplied = rule.copayPercent ?? new Decimal(0);
  const copayAmount = afterDeductible.times(copayPercentApplied).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  let claim = afterDeductible.minus(copayAmount);
  const capped = rule.sumInsured !== null && claim.gt(rule.sumInsured);
  if (capped) claim = rule.sumInsured!;
  return { base, deductibleApplied, copayPercentApplied, copayAmount, claim, patientShare: base.minus(claim), cappedBySumInsured: capped };
}
