import { z } from "zod";

/**
 * The checks on the "Register new patient" form. They mirror what the server accepts (apps/api/src/modules/patients/patients.service.ts), so a problem is
 * shown next to its field instead of coming back as one error after the form is sent. The server still checks everything again.
 *
 * Every field is checked on its own, and the age or date of birth check is part of the same union, so one wrong field never hides the others.
 */

/** Letters (any language), spaces, dots, apostrophes and hyphens; starts with a letter. The same rule as the server. */
export const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
export const MAX_AGE = 130;
export const MIN_BIRTH_YEAR = 1900;

/** The 10 digits of an Indian mobile number, or null when it is not one. Takes +91, 91 and a leading 0, and ignores spaces, dots, dashes and brackets. */
export function normalizeMobile(raw: string): string | null {
  let d = raw.replace(/[\s().-]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (!/^\d+$/.test(d)) return null;
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

export function nameProblem(value: string, what: string, required: boolean): string | null {
  const v = value.trim();
  if (v === "") return required ? `Enter the ${what}` : null;
  if (v.length > 60) return `The ${what} can have at most 60 letters`;
  if (!NAME_RE.test(v)) return `The ${what} can have only letters, spaces, dots, apostrophes and hyphens (no digits or symbols)`;
  return null;
}

export function mobileProblem(value: string): string | null {
  const v = value.trim();
  if (v === "") return "Enter the mobile number";
  if (/[^\d\s+().-]/.test(v)) return "The mobile number can have only digits";
  if (normalizeMobile(v)) return null;
  const digits = v.replace(/\D/g, "");
  if (digits.length < 10) return "The mobile number is too short: it needs 10 digits";
  if (digits.length > 10 && !(digits.length === 12 && digits.startsWith("91")) && !(digits.length === 11 && digits.startsWith("0"))) return "The mobile number is too long: it needs 10 digits";
  return "Enter a valid mobile number: 10 digits starting with 6, 7, 8 or 9";
}

export function ageProblem(value: string): string | null {
  const v = value.trim();
  if (v === "") return "Enter the age in years";
  if (!/^\d+$/.test(v)) return "The age must be a whole number, like 34";
  if (Number(v) > MAX_AGE) return `The age cannot be more than ${MAX_AGE}`;
  return null;
}

export function dobProblem(value: string, today = new Date()): string | null {
  const v = value.trim();
  if (v === "") return "Enter the date of birth";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.toISOString().slice(0, 10) !== v) return "Enter a valid date of birth";
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (v > todayStr) return "The date of birth cannot be in the future";
  if (Number(m[1]) < MIN_BIRTH_YEAR) return "Check the date of birth: it is too long ago";
  return null;
}

export function postalProblem(value: string): string | null {
  const v = value.trim();
  return v === "" || /^\d{6}$/.test(v) ? null : "The PIN code must be 6 digits";
}

export function emailProblem(value: string): string | null {
  const v = value.trim();
  return v === "" || (v.length <= 254 && /^[^@\s]+@[^@\s]+[.][^@\s]+$/.test(v)) ? null : "Enter a valid email address, like name@example.com";
}

const check = (fn: (v: string) => string | null) => z.string().superRefine((v, ctx) => { const m = fn(v); if (m) ctx.addIssue({ code: "custom", message: m }); });
const tooLong = (what: string, max: number) => z.string().max(max, `The ${what} can have at most ${max} characters`);

const common = {
  firstName: check((v) => nameProblem(v, "first name", true)),
  lastName: check((v) => nameProblem(v, "last name", false)),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNKNOWN"], { message: "Choose the gender" }),
  mobile: check(mobileProblem),
  email: check(emailProblem),
  addressLine: tooLong("address", 200).optional(),
  city: tooLong("city", 80).optional(),
  postalCode: check(postalProblem).optional(),
};

/** Age or date of birth: only the one chosen is checked, in the same pass as every other field. */
export const patientFormSchema = z.discriminatedUnion("ageMode", [
  z.object({ ...common, ageMode: z.literal("age"), age: check(ageProblem), dob: z.string().optional() }),
  z.object({ ...common, ageMode: z.literal("dob"), dob: check((v) => dobProblem(v)), age: z.string().optional() }),
]);
export type PatientForm = z.infer<typeof patientFormSchema>;
