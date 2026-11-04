/**
 * How many tablets (or other countable units) a prescription line comes to, when the doctor wrote the dose, how often and for how many days
 * but left the quantity blank. The doctor's screen fills it in (and the doctor can change it); the pharmacy and the Cashier show the same figure
 * when no quantity was written, so nobody has to guess or give a default of one.
 *
 * Only countable doses are worked out: "1 tablet", "2 capsules", "1/2 tab", "1". Anything else ("5 ml", "10 drops", "as directed") and frequencies that
 * cannot be turned into a count (SOS, OTHER) give no figure: the pharmacy must then be told the quantity.
 */

/** Doses in a day for each frequency. STAT is a single dose; SOS and OTHER depend on the patient. */
const PER_DAY: Record<string, number> = { OD: 1, BD: 2, TDS: 3, QID: 4, HS: 1 };

const COUNTABLE = new Set(["tablet", "tablets", "tab", "tabs", "capsule", "capsules", "cap", "caps", "pill", "pills", "sachet", "sachets", "ampoule", "ampoules", "amp", "vial", "vials", "puff", "puffs", "suppository", "suppositories"]);

/** The number of units in one dose ("1", "2", "0.5", "1/2" followed by an optional countable word), or null when it cannot be counted. */
export function unitsPerDose(dosage: string): number | null {
  // A half sign on its own is 1/2; after a digit ("1½") it is a mixed fraction, which is left for the doctor to enter rather than misread.
  if (/\d½/.test(dosage)) return null;
  const m = /^\s*(\d+(?:\.\d+)?|\d+\s*\/\s*\d+)\s*(?:x\s*)?([a-zA-Z]+)?\s*$/.exec(dosage.replace(/½/g, "1/2"));
  if (!m) return null;
  const raw = m[1] as string;
  const n = raw.includes("/") ? Number(raw.split("/")[0]) / Number(raw.split("/")[1]) : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 20) return null;
  const word = m[2]?.toLowerCase();
  if (word !== undefined && !COUNTABLE.has(word)) return null;
  return n;
}

/** The quantity to give for the whole course: units per dose x doses per day x days, rounded up; null when it cannot be worked out. */
export function calculateQuantity(dosage: string, frequency: string, days: number | null | undefined): number | null {
  const units = unitsPerDose(dosage);
  if (units === null) return null;
  let total: number;
  if (frequency === "STAT") total = units;
  else {
    const perDay = PER_DAY[frequency];
    if (perDay === undefined || !days || !Number.isInteger(days) || days < 1 || days > 365) return null;
    total = units * perDay * days;
  }
  const qty = Math.ceil(total - 1e-9);
  return qty >= 1 && qty <= 5000 ? qty : null;
}
