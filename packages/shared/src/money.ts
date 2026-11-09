import Decimal from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type MoneyInput = string | number | Decimal;

/** Parse an amount into a 2dp Decimal. Numbers are accepted only if they are finite. */
export function money(v: MoneyInput): Decimal {
  const d = new Decimal(v);
  if (!d.isFinite()) throw new Error("Invalid amount");
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function sum(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(money(v)), new Decimal(0));
}

export interface LineInput { quantity: MoneyInput; unitPrice: MoneyInput; taxPercent: MoneyInput; discount?: MoneyInput }
export interface LineTotals { net: Decimal; tax: Decimal; total: Decimal }

/** Server-side authoritative line maths: net = qty*price - discount; tax = net*pct/100 (half-up, 2dp). */
export function lineTotals(l: LineInput): LineTotals {
  const gross = new Decimal(l.quantity).times(new Decimal(l.unitPrice));
  const net = money(gross.minus(new Decimal(l.discount ?? 0)));
  if (net.isNegative()) throw new Error("Line total cannot be negative");
  const tax = money(net.times(new Decimal(l.taxPercent)).div(100));
  return { net, tax, total: net.plus(tax) };
}

export { Decimal };
