// Pure rules of the discharge flow (docs/discharge-flow.md): the clocks, the reminder levels, the delay reasons and the management figures.
// Nothing here touches the database, so it is tested on its own.

export type FlowAlertLevel = "REMINDER" | "ESCALATION_DEPARTMENT" | "ESCALATION_ADMINISTRATOR";
export type ClockState = "ON_TIME" | "REMINDER_DUE" | "OVERDUE";

export interface ClockTargets { reminderMinutes: number; targetMinutes: number }

export const DELAY_REASONS = [
  "WAITING_FOR_INSURANCE", "FAMILY_ARRANGING_MONEY", "SUMMARY_NOT_WRITTEN", "WAITING_FOR_LAB_OR_REPORT", "WAITING_FOR_MEDICINES",
  "WAITING_FOR_DOCTOR", "WAITING_FOR_TRANSPORT", "PATIENT_OR_FAMILY_NOT_READY", "OTHER",
] as const;
export type DelayReasonCode = (typeof DELAY_REASONS)[number];

/** Plain words for each reason (the screen translates them; these are the English defaults). */
export const DELAY_REASON_LABEL: Record<DelayReasonCode, string> = {
  WAITING_FOR_INSURANCE: "Waiting for insurance", FAMILY_ARRANGING_MONEY: "Family arranging money", SUMMARY_NOT_WRITTEN: "Summary not written",
  WAITING_FOR_LAB_OR_REPORT: "Waiting for a test or report", WAITING_FOR_MEDICINES: "Waiting for medicines", WAITING_FOR_DOCTOR: "Waiting for the doctor",
  WAITING_FOR_TRANSPORT: "Waiting for transport", PATIENT_OR_FAMILY_NOT_READY: "Patient or family not ready", OTHER: "Other reason",
};

/** Whole minutes between two instants, never negative. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
}

/** Where a clock stands: on time, past the reminder point, or past the target. Reminder must be below the target; if a hospital sets them the wrong way round the reminder is pulled below it. */
export function clockState(elapsed: number, t: ClockTargets): ClockState {
  if (elapsed >= t.targetMinutes) return "OVERDUE";
  if (elapsed >= Math.min(t.reminderMinutes, t.targetMinutes - 1)) return "REMINDER_DUE";
  return "ON_TIME";
}

/**
 * Every alert level a clock has reached, lowest first. The reminder goes to whoever is pending; the target breach goes to the department head;
 * the administrator hears only when the department head has had a further interval to act (the gap between reminder and target, at least 15 minutes:
 * with the defaults, 90 / 120 / 150 minutes for the ward and 60 / 120 / 180 for the insurer).
 */
export function levelsReached(elapsed: number, t: ClockTargets): FlowAlertLevel[] {
  const out: FlowAlertLevel[] = [];
  const reminderAt = Math.min(t.reminderMinutes, t.targetMinutes - 1);
  if (elapsed >= reminderAt) out.push("REMINDER");
  if (elapsed >= t.targetMinutes) out.push("ESCALATION_DEPARTMENT");
  if (elapsed >= t.targetMinutes + Math.max(15, t.targetMinutes - reminderAt)) out.push("ESCALATION_ADMINISTRATOR");
  return out;
}

export const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

/** Local calendar date (YYYY-MM-DD) in the facility's timezone. */
export function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Local hour (0-23) in the facility's timezone. */
export function localHour(d: Date, tz: string): number {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(d));
  return h === 24 ? 0 : h;
}

/** Left before noon, local time. */
export const leftBeforeNoon = (departedAt: Date, tz: string) => localHour(departedAt, tz) < 12;

export function average(xs: number[]): number | null { return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null; }

export interface TurnaroundRow { minutes: number; beforeNoon: boolean }
export interface TurnaroundSummary { stays: number; averageMinutes: number | null; withinTarget: number; withinTargetPercent: number | null; beforeNoon: number; beforeNoonPercent: number | null }

/** The management headline: average time to go home, the share who leave before noon, the share inside the target. */
export function summariseTurnaround(rows: TurnaroundRow[], targetMinutes: number): TurnaroundSummary {
  const n = rows.length;
  const within = rows.filter((r) => r.minutes <= targetMinutes).length;
  const noon = rows.filter((r) => r.beforeNoon).length;
  const pct = (x: number) => (n ? Math.round((x / n) * 1000) / 10 : null);
  return { stays: n, averageMinutes: average(rows.map((r) => r.minutes)), withinTarget: within, withinTargetPercent: pct(within), beforeNoon: noon, beforeNoonPercent: pct(noon) };
}

/** The newest delay reason for each stage (rows are append-only; the last one stands). */
export function currentReasons<T extends { stage: string; at: Date }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())) out.set(r.stage, r);
  return out;
}
