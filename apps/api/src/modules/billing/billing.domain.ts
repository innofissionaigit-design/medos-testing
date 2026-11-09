import { Decimal } from "@medos/shared";

/** Pure billing arithmetic. All money is Decimal (never JS floats); rounding is half-up to 2 decimal places. */

const D = (v: Decimal.Value) => new Decimal(v);
export const round2 = (v: Decimal.Value): Decimal => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export interface LineInput { quantity: Decimal.Value; unitPrice: Decimal.Value; discountAmount?: Decimal.Value; taxPercent: Decimal.Value }
export interface LineAmounts { gross: Decimal; discount: Decimal; net: Decimal; tax: Decimal; total: Decimal; cgst: Decimal; sgst: Decimal }
export interface LineOptions {
  /** Tax is charged as two equal halves, CGST and SGST, each worked out and rounded on its own, so the line's tax is always exactly twice a half. */
  split?: boolean;
}

export function computeLine(l: LineInput, opts: LineOptions = {}): LineAmounts {
  const gross = round2(D(l.quantity).times(D(l.unitPrice)));
  const discount = round2(l.discountAmount ?? 0);
  if (discount.isNegative()) throw new RangeError("Discount cannot be negative");
  if (discount.gt(gross)) throw new RangeError("Discount cannot exceed the line amount");
  const net = gross.minus(discount);
  if (opts.split) {
    const half = round2(net.times(D(l.taxPercent)).div(200));
    return { gross, discount, net, tax: half.times(2), total: net.plus(half.times(2)), cgst: half, sgst: half };
  }
  const tax = round2(net.times(D(l.taxPercent)).div(100));
  return { gross, discount, net, tax, total: net.plus(tax), cgst: D(0), sgst: D(0) };
}

export interface Totals { subtotal: Decimal; discountTotal: Decimal; taxTotal: Decimal; /** Added to reach a whole-rupee total (between -0.50 and 0.50); zero when the invoice does not round. */ roundOff: Decimal; total: Decimal }
export interface TotalsOptions {
  /** Round the total to the nearest whole rupee (half a rupee rounds up); the difference is kept as the round-off. */
  roundToRupee?: boolean;
}

export function computeTotals(lines: LineAmounts[], opts: TotalsOptions = {}): Totals {
  let subtotal = D(0);
  let discountTotal = D(0);
  let taxTotal = D(0);
  for (const l of lines) {
    subtotal = subtotal.plus(l.gross);
    discountTotal = discountTotal.plus(l.discount);
    taxTotal = taxTotal.plus(l.tax);
  }
  const exact = subtotal.minus(discountTotal).plus(taxTotal);
  if (!opts.roundToRupee) return { subtotal, discountTotal, taxTotal, roundOff: D(0), total: exact };
  const whole = exact.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return { subtotal, discountTotal, taxTotal, roundOff: whole.minus(exact), total: whole };
}

export interface MoneyState { total: Decimal.Value; paidTotal: Decimal.Value; refundedTotal: Decimal.Value; creditedTotal: Decimal.Value }

/** What the invoice is worth after credit notes. */
export const effectiveTotal = (s: MoneyState): Decimal => D(s.total).minus(D(s.creditedTotal));
/** Money actually retained (received minus refunded). */
export const netReceived = (s: MoneyState): Decimal => D(s.paidTotal).minus(D(s.refundedTotal));
/** Amount still owed; never negative. */
export const balanceDue = (s: MoneyState): Decimal => Decimal.max(0, effectiveTotal(s).minus(netReceived(s)));
/** Overpayment that may be refunded (credit notes can make an invoice worth less than what was paid). */
export const refundable = (s: MoneyState): Decimal => Decimal.max(0, netReceived(s).minus(effectiveTotal(s)));

export type LiveStatus = "ISSUED" | "PARTIALLY_PAID" | "PAID";

export function deriveStatus(s: MoneyState): LiveStatus {
  const net = netReceived(s);
  // Fully credited (e.g. every item returned): nothing is owed, so the invoice is settled.
  if (effectiveTotal(s).lte(0)) return "PAID";
  if (net.lte(0)) return "ISSUED";
  return net.lt(effectiveTotal(s)) ? "PARTIALLY_PAID" : "PAID";
}

export const fmt = (v: Decimal.Value): string => D(v).toFixed(2);
