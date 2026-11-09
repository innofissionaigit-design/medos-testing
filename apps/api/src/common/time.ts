/** Facility-timezone helpers. Instants are stored in UTC; calendar logic always uses the facility's zone. */

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number; dateStr: string }

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(at: Date, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(at)) p[part.type] = part.value;
  const year = Number(p["year"]);
  const month = Number(p["month"]);
  const day = Number(p["day"]);
  return {
    year, month, day, hour: Number(p["hour"]), minute: Number(p["minute"]),
    weekday: WEEKDAYS[p["weekday"] ?? "Sun"] ?? 0,
    dateStr: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export const localDateStr = (at: Date, tz: string): string => localParts(at, tz).dateStr;

/** A `date` column value (UTC midnight) for a YYYY-MM-DD string. */
export function dateOnly(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

/** The UTC instant at which the given local wall-clock time occurs in `tz`. */
export function zonedToUtc(dateStr: string, minutesAfterMidnight: number, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, 0, minutesAfterMidnight);
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const lp = localParts(new Date(guess), tz);
    const asUtc = Date.UTC(lp.year, lp.month - 1, lp.day, lp.hour, lp.minute);
    guess += naive - asUtc;
  }
  return new Date(guess);
}

export function localMinutes(at: Date, tz: string): number {
  const p = localParts(at, tz);
  return p.hour * 60 + p.minute;
}

export const startOfLocalDay = (dateStr: string, tz: string): Date => zonedToUtc(dateStr, 0, tz);

export function endOfLocalDay(dateStr: string, tz: string): Date {
  const next = new Date(dateOnly(dateStr).getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  return startOfLocalDay(next, tz);
}

export function formatHm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function parseHm(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : s === "24:00" ? 1440 : null;
}
