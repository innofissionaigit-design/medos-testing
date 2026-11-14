import { test } from "node:test";
import assert from "node:assert/strict";
import { ageProblem, dobProblem, mobileProblem, nameProblem, normalizeMobile, patientFormSchema, postalProblem } from "./patient-form";

const good = { firstName: "Anjali", lastName: "Banerjee", gender: "FEMALE", ageMode: "age", age: "34", mobile: "9830012345", email: "", addressLine: "", city: "", postalCode: "" } as const;
const problems = (v: Record<string, unknown>) => {
  const r = patientFormSchema.safeParse(v);
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [String(i.path[0]), i.message]));
};

test("a complete form is accepted, with the optional fields left empty", () => {
  assert.deepEqual(problems(good), {});
});

test("an empty form shows every required field's problem at once, not just one", () => {
  const p = problems({ firstName: "", lastName: "", gender: "FEMALE", ageMode: "age", age: "", mobile: "", email: "", addressLine: "", city: "", postalCode: "" });
  assert.deepEqual(Object.keys(p).sort(), ["age", "firstName", "mobile"]);
  assert.equal(p["firstName"], "Enter the first name");
  assert.equal(p["mobile"], "Enter the mobile number");
  assert.equal(p["age"], "Enter the age in years");
});

test("with date of birth chosen, the date is required and the age is not", () => {
  const p = problems({ ...good, ageMode: "dob", age: "", dob: "" });
  assert.deepEqual(Object.keys(p), ["dob"]);
  assert.deepEqual(problems({ ...good, ageMode: "dob", age: "", dob: "1990-05-17" }), {});
});

test("several wrong fields are all reported together", () => {
  const p = problems({ ...good, firstName: "A1", lastName: "B@", mobile: "12345", age: "abc", postalCode: "70" });
  assert.deepEqual(Object.keys(p).sort(), ["age", "firstName", "lastName", "mobile", "postalCode"]);
});

test("names: letters, spaces, dots, apostrophes and hyphens only", () => {
  for (const ok of ["Anjali", "Mary Ann", "O'Neil", "Dr. Sen", "Jean-Luc", "অঞ্জলি", "अंजलि"]) assert.equal(nameProblem(ok, "first name", true), null, ok);
  for (const bad of ["A1", "123", "Ra$hi", "-Sen", "A_B", "😀"]) assert.match(nameProblem(bad, "first name", true) ?? "", /only letters/, bad);
  assert.equal(nameProblem("   ", "first name", true), "Enter the first name");
  assert.equal(nameProblem("x".repeat(61), "first name", true), "The first name can have at most 60 letters");
  assert.equal(nameProblem("", "last name", false), null, "a last name may be left empty");
  assert.match(nameProblem("B2", "last name", false) ?? "", /only letters/, "but a last name that is typed must be a name");
});

test("mobile: 10 digits starting with 6 to 9, with +91, 91 or 0 allowed in front", () => {
  for (const ok of ["9830012345", "+91 98300 12345", "919830012345", "09830012345", "98300-12345", "(983) 001 2345", "6000000000"]) assert.equal(mobileProblem(ok), null, ok);
  assert.equal(normalizeMobile("+91 98300 12345"), "9830012345");
  assert.equal(mobileProblem(""), "Enter the mobile number");
  assert.match(mobileProblem("98300") ?? "", /too short/);
  assert.match(mobileProblem("98300123456789") ?? "", /too long/);
  assert.match(mobileProblem("5830012345") ?? "", /starting with 6, 7, 8 or 9/);
  assert.match(mobileProblem("98300abc45") ?? "", /only digits/);
  assert.match(mobileProblem("0000000000") ?? "", /starting with 6, 7, 8 or 9/);
});

test("age: a whole number from 0 to 130", () => {
  for (const ok of ["0", "1", "34", "130"]) assert.equal(ageProblem(ok), null, ok);
  assert.equal(ageProblem(""), "Enter the age in years");
  for (const bad of ["abc", "3.5", "-2", "1e1", "12 3", "+5"]) assert.match(ageProblem(bad) ?? "", /whole number/, bad);
  assert.equal(ageProblem("131"), "The age cannot be more than 130");
  assert.equal(ageProblem("500"), "The age cannot be more than 130");
});

test("date of birth: a real date, not in the future, not before 1900", () => {
  const today = new Date(2026, 10, 13);
  assert.equal(dobProblem("", today), "Enter the date of birth");
  assert.equal(dobProblem("1990-05-17", today), null);
  assert.equal(dobProblem("2026-11-13", today), null, "born today is fine");
  assert.equal(dobProblem("2026-11-14", today), "The date of birth cannot be in the future");
  assert.equal(dobProblem("2027-01-01", today), "The date of birth cannot be in the future");
  assert.equal(dobProblem("2023-02-30", today), "Enter a valid date of birth");
  assert.equal(dobProblem("17-05-1990", today), "Enter a valid date of birth");
  assert.match(dobProblem("1850-01-01", today) ?? "", /too long ago/);
});

test("PIN code and email are optional but must be right when given", () => {
  assert.equal(postalProblem(""), null);
  assert.equal(postalProblem("700001"), null);
  for (const bad of ["7000", "70000a", "7000011"]) assert.equal(postalProblem(bad), "The PIN code must be 6 digits", bad);
  assert.deepEqual(problems({ ...good, email: "name@example.com" }), {});
  assert.match(problems({ ...good, email: "not-an-email" })["email"] ?? "", /valid email/);
});

test("the gender must be one of the choices", () => {
  assert.match(problems({ ...good, gender: "" })["gender"] ?? "", /Choose the gender/);
});
