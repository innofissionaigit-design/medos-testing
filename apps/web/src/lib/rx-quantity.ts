/**
 * How many tablets a prescription line comes to when the doctor gave the dose, how often and the days: the doctor's screen fills the quantity in with it.
 * The same calculation lives in packages/shared/src/prescription-quantity.ts (used by the API for the pharmacy and the Cashier); rx-quantity.test.ts checks
 * that the two always agree.
 */
const PER_DAY: Record<string, number> = { OD: 1, BD: 2, TDS: 3, QID: 4, HS: 1 };
const COUNTABLE = new Set(["tablet", "tablets", "tab", "tabs", "capsule", "capsules", "cap", "caps", "pill", "pills", "sachet", "sachets", "ampoule", "ampoules", "amp", "vial", "vials", "puff", "puffs", "suppository", "suppositories"]);

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
