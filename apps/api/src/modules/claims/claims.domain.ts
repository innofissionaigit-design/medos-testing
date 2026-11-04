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
