/** Pure patient rules: normalisation, age, duplicate scoring. No I/O so it is cheap to unit test. */

const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "smt", "shri", "sri", "master"]);

export function normalizeName(first: string, last?: string | null): string {
  const cleaned = `${first} ${last ?? ""}`
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  while (cleaned.length > 1 && TITLES.has(cleaned[0] as string)) cleaned.shift();
  return cleaned.join(" ");
}

/** Normalise common Indian mobile notations to 10 digits; returns null if it is not a valid mobile. */
export function normalizeMobile(raw: string): string | null {
  let d = raw.replace(/[\s().-]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (!/^\d+$/.test(d)) return null;
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

export function ageYears(dob: Date, today: Date): number {
  let years = today.getUTCFullYear() - dob.getUTCFullYear();
  const m = today.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < dob.getUTCDate())) years--;
  return Math.max(0, years);
}

export interface AgeSource { dateOfBirth: Date | null; estimatedAgeYears: number | null; ageRecordedOn: Date | null }

export function currentAge(p: AgeSource, today: Date = new Date()): { years: number; estimated: boolean } {
  if (p.dateOfBirth) return { years: ageYears(p.dateOfBirth, today), estimated: false };
  const base = p.estimatedAgeYears ?? 0;
  const elapsed = p.ageRecordedOn ? ageYears(p.ageRecordedOn, today) : 0;
  return { years: base + elapsed, estimated: true };
}

export type DuplicateSeverity = "HIGH" | "MEDIUM" | "LOW";
export type DuplicateReason = "MOBILE_AND_NAME" | "NAME_AND_DOB" | "NAME_AND_AGE" | "SAME_MOBILE";

export interface DuplicateProbe {
  mobile: string | null;
  gender: string;
  dateOfBirth: Date | null;
  age: { years: number; estimated: boolean };
}
export interface DuplicateRow {
  mobile: string | null;
  gender: string;
  dateOfBirth: Date | null;
  age: { years: number; estimated: boolean };
  similarity: number;
}

const RANK: Record<DuplicateSeverity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/** Score one existing patient against the probe. Returns null when it is not a plausible duplicate. */
export function scoreDuplicate(probe: DuplicateProbe, row: DuplicateRow): { severity: DuplicateSeverity; reasons: DuplicateReason[] } | null {
  const reasons: DuplicateReason[] = [];
  const sameMobile = !!probe.mobile && probe.mobile === row.mobile;
  const sameDob = !!probe.dateOfBirth && !!row.dateOfBirth && probe.dateOfBirth.getTime() === row.dateOfBirth.getTime();
  const genderOk = probe.gender === row.gender || probe.gender === "UNKNOWN" || row.gender === "UNKNOWN";
  const approx = !probe.dateOfBirth || !row.dateOfBirth;
  const ageClose = approx && Math.abs(probe.age.years - row.age.years) <= 2;

  if (sameMobile && row.similarity >= 0.4) reasons.push("MOBILE_AND_NAME");
  if (sameDob && row.similarity >= 0.6) reasons.push("NAME_AND_DOB");
  if (ageClose && genderOk && row.similarity >= 0.7) reasons.push("NAME_AND_AGE");
  if (sameMobile && !reasons.includes("MOBILE_AND_NAME")) reasons.push("SAME_MOBILE");
  if (reasons.length === 0) return null;

  const severity: DuplicateSeverity = reasons.some((r) => r === "MOBILE_AND_NAME" || r === "NAME_AND_DOB")
    ? "HIGH" : reasons.includes("NAME_AND_AGE") ? "MEDIUM" : "LOW";
  return { severity, reasons };
}

export function compareSeverity(a: DuplicateSeverity, b: DuplicateSeverity): number {
  return RANK[b] - RANK[a];
}
