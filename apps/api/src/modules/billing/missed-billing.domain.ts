import { Decimal } from "@medos/shared";

// "Done but not billed" (docs/missed-billing.md): what the flags are called, how a flag is named, and the rules that need no database. A flag only points at a gap for a
// person to look at; some will turn out to be fine, so nothing here says money was lost.

export const FLAG_TYPES = ["TEST_NOT_BILLED", "TEST_BILL_CANCELLED", "MEDICINE_NOT_BILLED", "BED_NIGHT_NOT_CHARGED", "CONSULTATION_NO_FEE", "PACKAGE_ITEM_BILLED_AGAIN", "LATE_CHARGE_NOT_BILLED"] as const;
export type FlagType = (typeof FLAG_TYPES)[number];

/** What each flag means, in the words of the billing desk. */
export const FLAG_LABELS: Record<FlagType, string> = {
  TEST_NOT_BILLED: "Test advised but not billed",
  TEST_BILL_CANCELLED: "Test done but its bill was cancelled",
  MEDICINE_NOT_BILLED: "Medicine given out but not on a bill",
  BED_NIGHT_NOT_CHARGED: "Bed night not charged",
  CONSULTATION_NO_FEE: "Consultation completed with no fee",
  PACKAGE_ITEM_BILLED_AGAIN: "Package item billed again outside the package",
  LATE_CHARGE_NOT_BILLED: "Charge added after the final bill, still unbilled",
};

export const DECISIONS = ["NOT_A_GAP", "BILLED", "WAIVED"] as const;
export type Decision = (typeof DECISIONS)[number];
/** A decision not to bill needs a real reason. */
export const MIN_REASON = 5;
export const MIN_WAIVER_REASON = 10;

export const reasonProblem = (decision: Decision, reason: string): string | null => {
  const r = reason.trim();
  if (decision === "WAIVED" && r.length < MIN_WAIVER_REASON) return `Say why it is not being billed (at least ${MIN_WAIVER_REASON} characters)`;
  if (r.length < MIN_REASON) return `Give a short reason (at least ${MIN_REASON} characters)`;
  return null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `TYPE:<record id>` (a bed night also carries the day: `BED_NIGHT_NOT_CHARGED:<admission id>:<yyyy-mm-dd>`). */
export const flagKey = (type: FlagType, recordId: string, day?: string): string => (day ? `${type}:${recordId}:${day}` : `${type}:${recordId}`);

export function parseFlagKey(key: string): { type: FlagType; recordId: string; day: string | null } | null {
  const [type, recordId, day, ...rest] = key.split(":");
  if (!type || !recordId || rest.length > 0 || !(FLAG_TYPES as readonly string[]).includes(type) || !UUID.test(recordId)) return null;
  if (type === "BED_NIGHT_NOT_CHARGED") return day && DAY.test(day) ? { type: type as FlagType, recordId, day } : null;
  return day === undefined ? { type: type as FlagType, recordId, day: null } : null;
}

/** The calendar days (local dates) covered by a stay in one bed, first and last day included. */
export function stayDays(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${fromDay}T00:00:00Z`); d.toISOString().slice(0, 10) <= toDay; d = new Date(d.getTime() + 86_400_000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

/**
 * The nights of a stay that have no bed charge. `stays` are the bed assignments (local first and last day, and the daily rate); `charged` holds the days that already have a bed
 * charge (a voided one counts: someone chose to remove it). For a patient still in the ward, today is not yet due, so it is left out. Days outside `from`..`to` are not asked about.
 */
export function unchargedNights(stays: { fromDay: string; toDay: string; dailyRate: Decimal.Value; bed: string }[], charged: Set<string>, today: string, inWard: boolean, from: string, to: string): { day: string; rate: Decimal; bed: string }[] {
  const seen = new Set<string>();
  const out: { day: string; rate: Decimal; bed: string }[] = [];
  for (const s of stays) {
    for (const day of stayDays(s.fromDay, s.toDay)) {
      if (seen.has(day) || charged.has(day) || day < from || day > to || (inWard && day >= today)) continue;
      seen.add(day);
      out.push({ day, rate: new Decimal(s.dailyRate), bed: s.bed });
    }
  }
  return out;
}

/** Is a line on another bill one the package already covers? Implants and consumables when the package includes them, or anything the package lists by name. */
export function coveredByPackage(line: { kind: string | null; description: string }, pkg: { includesImplants: boolean; includesConsumables: boolean; inclusions: string[] }): string | null {
  if (line.kind === "IMPLANT" && pkg.includesImplants) return "an implant, which this package includes";
  if (line.kind === "CONSUMABLE" && pkg.includesConsumables) return "a consumable, which this package includes";
  const d = line.description.toLowerCase();
  const hit = pkg.inclusions.find((x) => x.trim().length > 1 && d.includes(x.trim().toLowerCase()));
  return hit ? `listed in the package: ${hit.trim()}` : null;
}

/** The report's totals: what is open, with the amount only where the flag knows one. Money in Decimal, never floating point. */
export function summarise(flags: { type: FlagType; amount: Decimal | null; reviewed: boolean }[]): { type: FlagType; label: string; open: number; reviewed: number; openAmount: string; unpriced: number }[] {
  return FLAG_TYPES.map((type) => {
    const own = flags.filter((f) => f.type === type);
    const open = own.filter((f) => !f.reviewed);
    return {
      type, label: FLAG_LABELS[type], open: open.length, reviewed: own.length - open.length,
      openAmount: open.reduce((a, f) => a.plus(f.amount ?? 0), new Decimal(0)).toFixed(2), unpriced: open.filter((f) => f.amount === null).length,
    };
  });
}
