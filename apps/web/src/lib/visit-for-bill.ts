/**
 * Which OPD visit a new bill belongs to (docs/earnings-and-reports.md). The booking and earnings reports and the doctor share ledger only count money on
 * bills that are tied to a visit, so a bill made for a patient who is being seen today is attached to that visit.
 *
 * Rule: the patient's most recent OPD visit that started today (in the facility's time zone) and was not cancelled, whether the doctor is still with them
 * or has already finished (the Cashier often bills after the consultation). No such visit: the bill stays a stand-alone bill, as before.
 */
export interface BillableVisit { id: string; encounterNumber: string; type: string; status: string; startedAt: string; practitionerName?: string | null }

const dayIn = (iso: string, tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

export function visitForBill<T extends BillableVisit>(visits: readonly T[], today: string, tz: string): T | null {
  const todays = visits.filter((v) => v.type === "OPD" && (v.status === "ACTIVE" || v.status === "COMPLETED") && dayIn(v.startedAt, tz) === today);
  todays.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return todays[0] ?? null;
}
