import { Decimal } from "@medos/shared";

/**
 * Pay calculation for one employee for one month (docs/payroll.md). Everything is decimal, never floating point.
 * The statutory rates below are the usual Indian defaults. They are the starting values of the hospital setting PAYROLL_STATUTORY_RATES, which the hospital's
 * accountant can change (Administration → Settings) without a code change; the defaults have not been checked against current law.
 */
export const PF_WAGE_CEILING = new Decimal(15000);
export const PF_RATE = new Decimal("0.12");
export const ESI_GROSS_CEILING = new Decimal(21000);
export const ESI_EMPLOYEE_RATE = new Decimal("0.0075");
export const ESI_EMPLOYER_RATE = new Decimal("0.0325");

/** Professional tax per month by monthly gross, West Bengal slabs: [upTo (inclusive), tax]. */
export const PT_SLABS_WB: [Decimal, Decimal][] = [
  [new Decimal(10000), new Decimal(0)], [new Decimal(15000), new Decimal(110)], [new Decimal(25000), new Decimal(130)], [new Decimal(40000), new Decimal(150)],
];
export const PT_TOP_WB = new Decimal(200);

/** The rates a calculation uses. */
export interface StatutoryRates {
  pfWageCeiling: Decimal; pfRate: Decimal; esiGrossCeiling: Decimal; esiEmployeeRate: Decimal; esiEmployerRate: Decimal;
  ptSlabs: [Decimal, Decimal][]; ptTop: Decimal;
}
export const DEFAULT_RATES: StatutoryRates = {
  pfWageCeiling: PF_WAGE_CEILING, pfRate: PF_RATE, esiGrossCeiling: ESI_GROSS_CEILING, esiEmployeeRate: ESI_EMPLOYEE_RATE, esiEmployerRate: ESI_EMPLOYER_RATE, ptSlabs: PT_SLABS_WB, ptTop: PT_TOP_WB,
};
/** The same rates as stored in the hospital setting (plain numbers). */
export interface RatesSetting { pfWageCeiling: number; pfRate: number; esiGrossCeiling: number; esiEmployeeRate: number; esiEmployerRate: number; ptSlabs: { upTo: number; tax: number }[]; ptTop: number }
export const DEFAULT_RATES_SETTING: RatesSetting = {
  pfWageCeiling: 15000, pfRate: 0.12, esiGrossCeiling: 21000, esiEmployeeRate: 0.0075, esiEmployerRate: 0.0325,
  ptSlabs: [{ upTo: 10000, tax: 0 }, { upTo: 15000, tax: 110 }, { upTo: 25000, tax: 130 }, { upTo: 40000, tax: 150 }], ptTop: 200,
};
export const ratesFromSetting = (s: RatesSetting): StatutoryRates => ({
  pfWageCeiling: new Decimal(String(s.pfWageCeiling)), pfRate: new Decimal(String(s.pfRate)), esiGrossCeiling: new Decimal(String(s.esiGrossCeiling)),
  esiEmployeeRate: new Decimal(String(s.esiEmployeeRate)), esiEmployerRate: new Decimal(String(s.esiEmployerRate)),
  ptSlabs: s.ptSlabs.map((x) => [new Decimal(String(x.upTo)), new Decimal(String(x.tax))] as [Decimal, Decimal]), ptTop: new Decimal(String(s.ptTop)),
});

export interface StructureFacts { basic: Decimal.Value; hra: Decimal.Value; otherAllowance: Decimal.Value; pfApplicable: boolean; esiApplicable: boolean; ptApplicable: boolean }
export interface PayInput { daysInMonth: number; lopDays: Decimal.Value; bonus?: Decimal.Value; arrears?: Decimal.Value; tds?: Decimal.Value; otherDeduction?: Decimal.Value }
export interface Computed {
  basic: Decimal; hra: Decimal; otherAllowance: Decimal; bonus: Decimal; arrears: Decimal; gross: Decimal;
  pfEmployee: Decimal; esiEmployee: Decimal; professionalTax: Decimal; tds: Decimal; otherDeduction: Decimal; totalDeductions: Decimal; net: Decimal; pfEmployer: Decimal; esiEmployer: Decimal;
}

const rupee = (v: Decimal) => v.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
const paise = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const professionalTax = (monthlyGross: Decimal, rates: StatutoryRates = DEFAULT_RATES): Decimal => {
  for (const [upTo, tax] of rates.ptSlabs) if (monthlyGross.lte(upTo)) return tax;
  return rates.ptTop;
};

/**
 * Salary for the days worked: each component is scaled by (days in month − days of loss of pay) / days in month. Arrears (pay owed for earlier months) are added to
 * gross after the statutory amounts are worked out on this month's regular pay: they do not change provident fund, ESI or professional tax (the accountant should confirm this).
 */
export function computePay(s: StructureFacts, i: PayInput, rates: StatutoryRates = DEFAULT_RATES): Computed {
  const lop = new Decimal(i.lopDays);
  if (lop.lt(0) || lop.gt(i.daysInMonth)) throw new RangeError("Days of loss of pay must be between 0 and the days in the month");
  const ratio = new Decimal(i.daysInMonth).minus(lop).div(i.daysInMonth);
  const basic = paise(new Decimal(s.basic).times(ratio));
  const hra = paise(new Decimal(s.hra).times(ratio));
  const otherAllowance = paise(new Decimal(s.otherAllowance).times(ratio));
  const bonus = paise(new Decimal(i.bonus ?? 0));
  const arrears = paise(new Decimal(i.arrears ?? 0));
  const regularGross = basic.plus(hra).plus(otherAllowance).plus(bonus);
  const gross = regularGross.plus(arrears);
  const tds = paise(new Decimal(i.tds ?? 0));
  const otherDeduction = paise(new Decimal(i.otherDeduction ?? 0));
  const pfBase = Decimal.min(basic, rates.pfWageCeiling);
  const pfEmployee = s.pfApplicable ? rupee(pfBase.times(rates.pfRate)) : new Decimal(0);
  const pfEmployer = pfEmployee;
  const esiOn = s.esiApplicable && regularGross.gt(0) && regularGross.lte(rates.esiGrossCeiling);
  // ESI is rounded up to the next rupee.
  const esiEmployee = esiOn ? regularGross.times(rates.esiEmployeeRate).toDecimalPlaces(0, Decimal.ROUND_UP) : new Decimal(0);
  const esiEmployer = esiOn ? regularGross.times(rates.esiEmployerRate).toDecimalPlaces(0, Decimal.ROUND_UP) : new Decimal(0);
  const pt = s.ptApplicable ? professionalTax(regularGross, rates) : new Decimal(0);
  const totalDeductions = pfEmployee.plus(esiEmployee).plus(pt).plus(tds).plus(otherDeduction);
  return { basic, hra, otherAllowance, bonus, arrears, gross, pfEmployee, esiEmployee, professionalTax: pt, tds, otherDeduction, totalDeductions, net: gross.minus(totalDeductions), pfEmployer, esiEmployer };
}

export const daysIn = (month: Date): number => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();

export type AttendanceKind = "PRESENT" | "ABSENT" | "HALF_DAY" | "ON_LEAVE" | "WEEKLY_OFF" | "HOLIDAY";
export interface AttendanceFact { status: AttendanceKind; /** Only meaningful for ON_LEAVE: the leave type is not paid. */ unpaidLeave?: boolean; /** Only meaningful for ON_LEAVE: half a day of leave, the other half worked. */ halfLeave?: boolean }
export interface AttendanceSummary { present: number; absent: number; halfDay: number; paidLeave: number; unpaidLeave: number; weeklyOff: number; holiday: number; lossOfPay: Decimal }

/**
 * Counts a month's marked days and works out the days of loss of pay they cost: a full absence or a day of unpaid leave is one day, a half day or half a day of
 * unpaid leave is a half. Paid leave, weekly offs, holidays and presence cost nothing. Days nobody marked cost nothing either (the run reports them so the
 * officer can complete the sheet).
 */
export function summariseAttendance(days: readonly AttendanceFact[]): AttendanceSummary {
  const s: AttendanceSummary = { present: 0, absent: 0, halfDay: 0, paidLeave: 0, unpaidLeave: 0, weeklyOff: 0, holiday: 0, lossOfPay: new Decimal(0) };
  let unpaid = new Decimal(0);
  for (const d of days) {
    if (d.status === "PRESENT") s.present++;
    else if (d.status === "ABSENT") s.absent++;
    else if (d.status === "HALF_DAY") s.halfDay++;
    else if (d.status === "ON_LEAVE") {
      const part = d.halfLeave ? 0.5 : 1;
      if (d.unpaidLeave) { s.unpaidLeave += part; unpaid = unpaid.plus(part); } else s.paidLeave += part;
    } else if (d.status === "WEEKLY_OFF") s.weeklyOff++;
    else s.holiday++;
  }
  s.lossOfPay = new Decimal(s.absent).plus(unpaid).plus(new Decimal(s.halfDay).div(2));
  return s;
}

/**
 * What a time-clock row means for the day: the hours between the first punch in and the last punch out (a shift that ends after midnight counts to the next
 * morning). At least the full-day hours is a present day, at least the half-day hours a half day, anything less an absence.
 */
export function statusFromPunches(inTime: string, outTime: string, fullDayHours: number, halfDayHours: number): { status: "PRESENT" | "HALF_DAY" | "ABSENT"; hours: number } {
  const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let minutes = toMinutes(outTime) - toMinutes(inTime);
  if (minutes < 0) minutes += 24 * 60;
  const hours = minutes / 60;
  return { status: hours >= fullDayHours ? "PRESENT" : hours >= halfDayHours ? "HALF_DAY" : "ABSENT", hours };
}
