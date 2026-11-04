import { Decimal } from "@medos/shared";

/**
 * Pay calculation for one employee for one month (docs/payroll.md). Everything is decimal, never floating point.
 * The statutory rates below are the usual Indian defaults and are written down in one place so a change in law is a one-line change; they should be
 * confirmed by the hospital's accountant before the first real payroll.
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

export interface StructureFacts { basic: Decimal.Value; hra: Decimal.Value; otherAllowance: Decimal.Value; pfApplicable: boolean; esiApplicable: boolean; ptApplicable: boolean }
export interface PayInput { daysInMonth: number; lopDays: Decimal.Value; bonus?: Decimal.Value; tds?: Decimal.Value; otherDeduction?: Decimal.Value }
export interface Computed {
  basic: Decimal; hra: Decimal; otherAllowance: Decimal; bonus: Decimal; gross: Decimal;
  pfEmployee: Decimal; esiEmployee: Decimal; professionalTax: Decimal; tds: Decimal; otherDeduction: Decimal; totalDeductions: Decimal; net: Decimal; pfEmployer: Decimal; esiEmployer: Decimal;
}

const rupee = (v: Decimal) => v.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
const paise = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const professionalTax = (monthlyGross: Decimal): Decimal => {
  for (const [upTo, tax] of PT_SLABS_WB) if (monthlyGross.lte(upTo)) return tax;
  return PT_TOP_WB;
};

/** Salary for the days worked: each component is scaled by (days in month − days of loss of pay) / days in month. */
export function computePay(s: StructureFacts, i: PayInput): Computed {
  const lop = new Decimal(i.lopDays);
  if (lop.lt(0) || lop.gt(i.daysInMonth)) throw new RangeError("Days of loss of pay must be between 0 and the days in the month");
  const ratio = new Decimal(i.daysInMonth).minus(lop).div(i.daysInMonth);
  const basic = paise(new Decimal(s.basic).times(ratio));
  const hra = paise(new Decimal(s.hra).times(ratio));
  const otherAllowance = paise(new Decimal(s.otherAllowance).times(ratio));
  const bonus = paise(new Decimal(i.bonus ?? 0));
  const gross = basic.plus(hra).plus(otherAllowance).plus(bonus);
  const tds = paise(new Decimal(i.tds ?? 0));
  const otherDeduction = paise(new Decimal(i.otherDeduction ?? 0));
  const pfBase = Decimal.min(basic, PF_WAGE_CEILING);
  const pfEmployee = s.pfApplicable ? rupee(pfBase.times(PF_RATE)) : new Decimal(0);
  const pfEmployer = pfEmployee;
  const esiOn = s.esiApplicable && gross.gt(0) && gross.lte(ESI_GROSS_CEILING);
  // ESI is rounded up to the next rupee.
  const esiEmployee = esiOn ? gross.times(ESI_EMPLOYEE_RATE).toDecimalPlaces(0, Decimal.ROUND_UP) : new Decimal(0);
  const esiEmployer = esiOn ? gross.times(ESI_EMPLOYER_RATE).toDecimalPlaces(0, Decimal.ROUND_UP) : new Decimal(0);
  const pt = s.ptApplicable ? professionalTax(gross) : new Decimal(0);
  const totalDeductions = pfEmployee.plus(esiEmployee).plus(pt).plus(tds).plus(otherDeduction);
  return { basic, hra, otherAllowance, bonus, gross, pfEmployee, esiEmployee, professionalTax: pt, tds, otherDeduction, totalDeductions, net: gross.minus(totalDeductions), pfEmployer, esiEmployer };
}

export const daysIn = (month: Date): number => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
