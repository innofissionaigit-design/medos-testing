import { Decimal } from "@medos/shared";
import { calculateCopay, hasCopayRule, type CopayRule } from "./claims.domain";

// Pure rules of insurance money (docs/insurance-money.md): the running ledger of a claim, the split of a bill between the main insurer, a top-up insurer and the
// patient, what is inside a package, the family's estimate, and how old a claim is. Exact decimals throughout; nothing here touches the database.

const D = (v: { toString(): string } | null | undefined): Decimal => new Decimal(v?.toString() ?? 0);
const ZERO = new Decimal(0);

// ───── the ledger ─────

export interface LedgerInput {
  status: string;
  claimed: { toString(): string } | null;
  approved: { toString(): string } | null;
  /** Cash and tax deducted at source received so far (both settle the claim). */
  cash: { toString(): string };
  tds: { toString(): string };
  /** Cuts the desk has explained, and write-offs a manager approved. */
  explainedCuts: { toString(): string }[];
  writtenOff: { toString(): string }[];
  overpaid?: { toString(): string }[];
  refunded?: { toString(): string }[];
}

export interface Ledger {
  claimed: Decimal;
  approved: Decimal | null;
  /** What the insurer cut: claimed less approved. */
  cut: Decimal;
  cutExplained: Decimal;
  cutUnexplained: Decimal;
  received: Decimal;
  receivedCash: Decimal;
  tds: Decimal;
  writtenOff: Decimal;
  /** Approved, not yet received and not written off. */
  owed: Decimal;
  /** Claimed and waiting for the insurer's decision. */
  awaitingDecision: Decimal;
  overpaid: Decimal;
  refunded: Decimal;
  /** Overpaid money the insurer has not yet been refunded. */
  refundDue: Decimal;
}

const SUM = (xs: { toString(): string }[]): Decimal => xs.reduce<Decimal>((a, x) => a.plus(D(x)), ZERO);

/** The running record of one claim: claimed, approved, received, cut, written off and still owed. Always reconstructable from the records. */
export function ledgerOf(i: LedgerInput): Ledger {
  const claimed = D(i.claimed);
  const approved = i.approved === null ? null : D(i.approved);
  const cash = D(i.cash); const tds = D(i.tds);
  const received = cash.plus(tds);
  const writtenOff = SUM(i.writtenOff);
  const cut = approved === null ? ZERO : Decimal.max(0, claimed.minus(approved));
  const explained = Decimal.min(cut, SUM(i.explainedCuts));
  const owed = approved === null ? ZERO : Decimal.max(0, approved.minus(received).minus(writtenOff));
  const awaiting = approved === null && (i.status === "SUBMITTED" || i.status === "QUERY") ? claimed : ZERO;
  const overpaid = SUM(i.overpaid ?? []); const refunded = SUM(i.refunded ?? []);
  return { claimed, approved, cut, cutExplained: explained, cutUnexplained: cut.minus(explained), received, receivedCash: cash, tds, writtenOff, owed, awaitingDecision: awaiting, overpaid, refunded, refundDue: Decimal.max(0, overpaid.minus(refunded)) };
}

/** Adds the ledgers of several claims (an insurer's running record). */
export function addLedgers(ls: Ledger[]): Ledger {
  const sum = (f: (l: Ledger) => Decimal) => ls.reduce<Decimal>((a, l) => a.plus(f(l)), ZERO);
  return {
    claimed: sum((l) => l.claimed), approved: ls.some((l) => l.approved !== null) ? sum((l) => l.approved ?? ZERO) : null, cut: sum((l) => l.cut), cutExplained: sum((l) => l.cutExplained), cutUnexplained: sum((l) => l.cutUnexplained),
    received: sum((l) => l.received), receivedCash: sum((l) => l.receivedCash), tds: sum((l) => l.tds), writtenOff: sum((l) => l.writtenOff), owed: sum((l) => l.owed), awaitingDecision: sum((l) => l.awaitingDecision),
    overpaid: sum((l) => l.overpaid), refunded: sum((l) => l.refunded), refundDue: sum((l) => l.refundDue),
  };
}

// ───── paying a claim ─────

export interface Allocation { claimId: string; amount: Decimal; tds: Decimal; final: boolean; owed: Decimal; approved: Decimal; received: Decimal }
export interface PaymentPlan {
  /** What goes against each claim (never more than it is owed): the cash, and the tax deducted at source. */
  applied: { claimId: string; amount: Decimal; tds: Decimal }[];
  /** What each claim was still short after this payment, when the insurer said the line was its final word on the claim. */
  shortfalls: { claimId: string; amount: Decimal }[];
  /** Cash put against a claim beyond what it is owed, per claim. */
  excess: { claimId: string; amount: Decimal }[];
  /** Money paid that no claim is owed (cash over a claim's balance, and cash not matched to any claim): an overpayment, to be refunded. */
  overpayment: Decimal;
}

/**
 * One insurer payment, matched to claims. Each line is capped at what the claim is owed (cash first, then tax deducted at source). Cash over a claim's balance, and
 * cash not matched to any claim, is an overpayment. A line marked final that leaves a claim short of its approved amount raises a follow-up.
 */
export function planPayment(total: Decimal, lines: Allocation[]): PaymentPlan {
  const applied: PaymentPlan["applied"] = []; const shortfalls: PaymentPlan["shortfalls"] = []; const excess: PaymentPlan["excess"] = [];
  let matched = ZERO;
  for (const l of lines) {
    const take = Decimal.min(l.amount.plus(l.tds), l.owed);
    const cash = Decimal.min(l.amount, take);
    const tds = Decimal.min(l.tds, take.minus(cash));
    if (take.gt(0)) applied.push({ claimId: l.claimId, amount: cash, tds });
    if (l.amount.gt(cash)) excess.push({ claimId: l.claimId, amount: l.amount.minus(cash) });
    matched = matched.plus(l.amount);
    if (l.final && l.received.plus(take).lt(l.approved)) shortfalls.push({ claimId: l.claimId, amount: l.approved.minus(l.received).minus(take) });
  }
  const overpayment = Decimal.max(0, total.minus(matched)).plus(excess.reduce<Decimal>((a, e) => a.plus(e.amount), ZERO));
  return { applied, shortfalls, excess, overpayment };
}

// ───── top-up and the three-way split ─────

export interface PolicyRule extends CopayRule { tier: "PRIMARY" | "TOPUP" }

/**
 * What a top-up insurer is asked for: it covers what the main insurer leaves. `remainder` is the bill less what the main insurer pays (its approved amount once
 * approved, otherwise what it was asked for) and less the items nobody covers. The top-up's own co-pay rule and sum insured then apply.
 */
export function topupClaim(remainder: Decimal, rule: CopayRule): { claim: Decimal; patientShare: Decimal } {
  const base = Decimal.max(0, remainder);
  if (!hasCopayRule(rule) && rule.sumInsured === null) return { claim: base, patientShare: ZERO };
  const r = calculateCopay(base, rule);
  return { claim: r.claim, patientShare: r.patientShare };
}

export interface Split { primary: Decimal; topup: Decimal; patient: Decimal; total: Decimal }

/** The bill split three ways: the main insurer, the top-up insurer, and the patient. The three always add up to the bill. */
export function splitBill(total: Decimal, primaryPays: Decimal, topupPays: Decimal): Split {
  const primary = Decimal.min(total, Decimal.max(0, primaryPays));
  const topup = Decimal.min(total.minus(primary), Decimal.max(0, topupPays));
  return { primary, topup, patient: total.minus(primary).minus(topup), total };
}

// ───── packages ─────

export type LineKind = "SERVICE" | "PROCEDURE" | "MEDICINE" | "BED" | "DOCTOR_VISIT" | "IMPLANT" | "CONSUMABLE" | "OTHER";
export interface PackageTerms { includesImplants: boolean; includesConsumables: boolean; exclusions: string[]; inclusions: string[] }
export type PackageScope = "INSIDE_PACKAGE" | "EXTRA";

/**
 * Whether a charge is inside the package price or extra. Implants and consumables are inside by default; a package that leaves them out says so, and then they are
 * extra. A line whose words match a listed exclusion is extra too. Everything else is inside.
 */
export function packageScope(line: { kind: LineKind; description: string }, pkg: PackageTerms): { scope: PackageScope; why: string } {
  if (line.kind === "IMPLANT" && !pkg.includesImplants) return { scope: "EXTRA", why: "Implants are not included in this package" };
  if (line.kind === "CONSUMABLE" && !pkg.includesConsumables) return { scope: "EXTRA", why: "Consumables are not included in this package" };
  const d = line.description.toLowerCase();
  const hit = pkg.exclusions.find((x) => x.trim().length > 1 && d.includes(x.trim().toLowerCase()));
  if (hit) return { scope: "EXTRA", why: `Excluded by the package: ${hit}` };
  return { scope: "INSIDE_PACKAGE", why: pkg.inclusions.some((x) => x.trim().length > 1 && d.includes(x.trim().toLowerCase())) ? "Listed in the package" : "Inside the package price" };
}

/** A package that leaves implants or consumables out must say so openly. Returns the problem, or null. */
export function packageOpenness(p: { includesImplants: boolean; includesConsumables: boolean; exclusionNote?: string | null }): string | null {
  if ((!p.includesImplants || !p.includesConsumables) && (p.exclusionNote ?? "").trim().length < 10) return "Say openly what the package leaves out (at least 10 characters), because it does not include implants or consumables";
  return null;
}

// ───── the family's estimate ─────

export interface EstimateLine { description: string; kind: LineKind; amount: Decimal; /** A line no insurer pays (for example a luxury item). */ notCovered?: boolean; /** Billed above the insurer's rate: the excess is the patient's. */ overRate?: Decimal }
export interface EstimateInput {
  lines: EstimateLine[];
  days: number;
  roomRatePerDay: Decimal;
  primary: (PolicyRule & { roomRentLimit: Decimal | null }) | null;
  topup: (PolicyRule & { roomRentLimit: Decimal | null }) | null;
  /** When the primary insurer pays a package, the price it pays; the lines marked extra are billed on top. */
  packagePrice: Decimal | null;
  pkg: PackageTerms | null;
}
export interface Estimate {
  total: Decimal; roomTotal: Decimal; roomRentExcess: Decimal; notCovered: Decimal; overRate: Decimal; packageExtras: Decimal;
  primary: { pays: Decimal; copay: Decimal; deductible: Decimal; capped: boolean } | null;
  topup: { pays: Decimal; capped: boolean } | null;
  split: Split;
  notes: string[];
  lines: { description: string; amount: Decimal; scope: PackageScope | null; why: string | null; notCovered: boolean }[];
}

/**
 * What the family should expect, before admission: what each insurer pays and what the family pays. A room above the main policy's rent limit, items nobody covers
 * and amounts above the insurer's rate are the patient's. With a package, the insurer pays the package price (less co-pay) and the lines marked extra are on top.
 * It is an estimate: the insurer's own rules and the final bill decide.
 */
export function estimate(i: EstimateInput): Estimate {
  const notes: string[] = [];
  const roomTotal = i.roomRatePerDay.times(i.days);
  const limit = i.primary?.roomRentLimit ?? null;
  const roomRentExcess = limit !== null && i.roomRatePerDay.gt(limit) ? i.roomRatePerDay.minus(limit).times(i.days) : ZERO;
  if (roomRentExcess.gt(0)) notes.push(`The room is above the policy's rent limit: ${roomRentExcess.toFixed(2)} of the room charge is the patient's`);
  const marked = i.lines.map((l) => {
    const sc = i.pkg ? packageScope({ kind: l.kind, description: l.description }, i.pkg) : null;
    return { description: l.description, amount: l.amount, scope: sc?.scope ?? null, why: sc?.why ?? null, notCovered: !!l.notCovered };
  });
  const linesTotal = i.lines.reduce<Decimal>((a, l) => a.plus(l.amount), ZERO);
  const notCovered = i.lines.reduce<Decimal>((a, l) => a.plus(l.notCovered ? l.amount : ZERO), ZERO);
  const overRate = i.lines.reduce<Decimal>((a, l) => a.plus(l.overRate ?? ZERO), ZERO);
  const packageExtras = i.pkg ? marked.reduce<Decimal>((a, l, n) => a.plus(l.scope === "EXTRA" && !i.lines[n]!.notCovered ? l.amount : ZERO), ZERO) : ZERO;
  // With a package the insurer pays against the package price; the in-package lines are covered by it and the extras are on top.
  const insideLines = i.pkg ? marked.reduce<Decimal>((a, l) => a.plus(l.scope === "INSIDE_PACKAGE" ? l.amount : ZERO), ZERO) : ZERO;
  const total = i.packagePrice !== null && i.pkg ? i.packagePrice.plus(linesTotal.minus(insideLines)).plus(roomTotal) : linesTotal.plus(roomTotal);

  // The part the main insurer can be asked for: everything less what nobody covers, the room above the limit, the rate excess and (with a package) the extras.
  const coverable = Decimal.max(0, total.minus(notCovered).minus(roomRentExcess).minus(overRate).minus(packageExtras));
  let primary: Estimate["primary"] = null; let primaryPays = ZERO;
  if (i.primary) {
    const r = hasCopayRule(i.primary) || i.primary.sumInsured !== null ? calculateCopay(coverable, i.primary) : null;
    primaryPays = r ? r.claim : coverable;
    primary = { pays: primaryPays, copay: r?.copayAmount ?? ZERO, deductible: r?.deductibleApplied ?? ZERO, capped: r?.cappedBySumInsured ?? false };
    if (r?.cappedBySumInsured) notes.push("The main policy's sum insured is lower than the bill: the rest goes to the top-up or the family");
  } else notes.push("No valid main policy: the whole bill is the family's");
  let topup: Estimate["topup"] = null; let topupPays = ZERO;
  if (i.topup && i.primary) {
    // The top-up covers what the main insurer leaves, except the items nobody covers.
    const remainder = Decimal.max(0, coverable.minus(primaryPays));
    const t = topupClaim(remainder, i.topup);
    topupPays = t.claim; topup = { pays: topupPays, capped: i.topup.sumInsured !== null && t.claim.eq(i.topup.sumInsured) && remainder.gt(t.claim) };
  }
  const split = splitBill(total, primaryPays, topupPays);
  notes.push("This is an estimate. The insurers' own rules and the final bill decide what is paid.");
  return { total, roomTotal, roomRentExcess, notCovered, overRate, packageExtras, primary, topup, split, notes, lines: marked };
}

// ───── ageing ─────

export const AGE_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export function ageBucket(days: number): AgeBucket { return days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+"; }

export const daysBetween = (from: Date, to: Date): number => Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
