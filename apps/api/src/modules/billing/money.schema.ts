import { Decimal } from "@medos/shared";
import { z } from "zod";

/**
 * Accepts money as a decimal string ("250.50") or a JS number, rejecting anything with more than
 * `places` decimals so binary-float artefacts (0.1+0.2) can never enter the system. Returns a Decimal.
 */
export function decimalInput(opts: { places: number; min?: Decimal.Value; max?: Decimal.Value; positive?: boolean }) {
  const pattern = new RegExp(`^\\d{1,10}(\\.\\d{1,${opts.places}})?$`);
  return z.union([z.string().trim(), z.number().finite()]).transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v;
    if (!pattern.test(s)) {
      ctx.addIssue({ code: "custom", message: opts.places === 0 ? "Enter a whole number" : `Enter an amount with at most ${opts.places} decimal places` });
      return new Decimal(0);
    }
    const d = new Decimal(s);
    if (opts.positive && !d.gt(0)) ctx.addIssue({ code: "custom", message: "Must be greater than zero" });
    if (opts.min !== undefined && d.lt(opts.min)) ctx.addIssue({ code: "custom", message: `Must be at least ${opts.min}` });
    if (opts.max !== undefined && d.gt(opts.max)) ctx.addIssue({ code: "custom", message: `Must be at most ${opts.max}` });
    return d;
  });
}

export const amount = (o: { positive?: boolean } = {}) => decimalInput({ places: 2, min: 0, max: 99_999_999, positive: o.positive });
export const quantity = decimalInput({ places: 3, positive: true, max: 9_999_999 });
export const percent = decimalInput({ places: 2, min: 0, max: 100 });
