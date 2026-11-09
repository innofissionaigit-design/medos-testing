import { Decimal } from "@medos/shared";

export type FeeStatus = "NOT_REQUIRED" | "PENDING" | "PAID" | "SKIPPED";

const D = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? 0);

/** What has been paid towards an appointment's booking fee: its advance(s), less anything given back. */
export function feePaid(deposits: { amount: { toString(): string }; refunds: { amount: { toString(): string } }[] }[]): Decimal {
  return deposits.reduce((sum, d) => sum.plus(D(d.amount)).minus(d.refunds.reduce((r, x) => r.plus(D(x.amount)), new Decimal(0))), new Decimal(0));
}

/**
 * The fee position of an appointment (docs/booking-fee.md). `bookingFee` is the amount asked for when it was booked, so a later change of
 * the setting never alters an appointment that already exists. A skip counts as settled; so does a fee that has been paid in full.
 */
export function feeState(a: { bookingFee: { toString(): string } | null; feeSkippedAt: Date | null }, paid: Decimal): { status: FeeStatus; fee: string | null; paid: string; due: string } {
  if (a.bookingFee === null) return { status: "NOT_REQUIRED", fee: null, paid: paid.toFixed(2), due: "0.00" };
  const fee = D(a.bookingFee);
  const due = Decimal.max(0, fee.minus(paid));
  const status: FeeStatus = a.feeSkippedAt ? "SKIPPED" : due.lte(0) ? "PAID" : "PENDING";
  return { status, fee: fee.toFixed(2), paid: paid.toFixed(2), due: status === "PENDING" ? due.toFixed(2) : "0.00" };
}

/** Booking-fee money still held for the patient: received, less what paid a bill, plus what came back from a refunded bill, less what was given back. */
export function feeHeld(deposits: { id: string; amount: { toString(): string }; refunds: { amount: { toString(): string } }[]; uses: { amount: { toString(): string } }[]; returns: { amount: { toString(): string } }[] }[]): { amount: string; depositId: string | null } {
  const sum = (xs: { amount: { toString(): string } }[]) => xs.reduce((a, x) => a.plus(D(x.amount)), new Decimal(0));
  let total = new Decimal(0);
  let largest: { id: string; left: Decimal } | null = null;
  for (const d of deposits) {
    const left = D(d.amount).minus(sum(d.uses)).plus(sum(d.returns)).minus(sum(d.refunds));
    total = total.plus(left);
    if (left.gt(0) && (!largest || left.gt(largest.left))) largest = { id: d.id, left };
  }
  return { amount: total.toFixed(2), depositId: largest?.id ?? null };
}
