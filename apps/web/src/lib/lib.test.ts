import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, errorText } from "./api";
import { ageText } from "./format";
import { homeFor, visibleNav } from "./nav";

const set = (...p: string[]) => new Set(p);
const ALL_ON = { PHARMACY_ENABLED: true, IPD_ENABLED: true, NURSING_ENABLED: true };

test("age is formatted from the API's { years, estimated } shape", () => {
  assert.equal(ageText({ years: 46, estimated: false }), "46 y");
  assert.equal(ageText({ years: 30, estimated: true }), "30 y (est.)");
  assert.equal(ageText({ years: 0, months: 7 }), "7 mo");
  assert.equal(ageText({ years: 0, months: 0, days: 12 }), "12 d");
  assert.equal(ageText(null), "");
  assert.equal(ageText(undefined), "");
  assert.equal(ageText(41), "41 y");
});

test("navigation shows only what the user's permissions allow", () => {
  const cashier = visibleNav(set("INVOICE_READ", "PATIENT_READ"), ALL_ON, ["CASHIER"]).map((n) => n.href);
  assert.deepEqual(cashier.sort(), ["/billing", "/dashboard", "/patients"].sort());
  assert.ok(!cashier.includes("/pharmacy") && !cashier.includes("/admin") && !cashier.includes("/audit"));
});

test("navigation hides modules a facility has switched off", () => {
  const perms = set("PHARMACY_READ", "ADMISSION_READ", "NURSING_READ", "PATIENT_READ");
  const off = visibleNav(perms, { PHARMACY_ENABLED: false, IPD_ENABLED: false, NURSING_ENABLED: false }, []).map((n) => n.href);
  assert.ok(!off.includes("/pharmacy") && !off.includes("/ipd") && !off.includes("/nursing"));
  const on = visibleNav(perms, ALL_ON, []).map((n) => n.href);
  assert.ok(on.includes("/pharmacy") && on.includes("/ipd") && on.includes("/nursing"));
});

test("role decides order, not access (CLAUDE.md §24)", () => {
  const perms = set("PATIENT_READ", "APPOINTMENT_READ", "QUEUE_READ", "INVOICE_READ", "PHARMACY_READ", "ADMISSION_READ", "NURSING_READ", "REPORT_READ");
  const first = (role: string) => homeFor(visibleNav(perms, ALL_ON, [role]));
  assert.equal(first("PHARMACIST"), "/pharmacy");
  assert.equal(first("CASHIER"), "/billing");
  assert.equal(first("NURSE"), "/nursing");
  assert.equal(first("DOCTOR"), "/queue");
  assert.equal(visibleNav(perms, ALL_ON, ["RECEPTIONIST"]).map((n) => n.href).slice(0, 4).join(), "/dashboard,/patients,/appointments,/queue");
});

test("the Reports menu appears for any report permission, all-reports or one area", () => {
  for (const p of ["REPORT_READ", "REPORT_OPD", "REPORT_FINANCE", "REPORT_IPD", "REPORT_PHARMACY"]) {
    assert.ok(visibleNav(set(p), ALL_ON, []).some((n) => n.href === "/reports"), p);
  }
  assert.ok(!visibleNav(set("INVOICE_READ", "PATIENT_READ"), ALL_ON, []).some((n) => n.href === "/reports"), "no report permission, no Reports menu");
});

test("a user with no permissions still gets a landing page", () => {
  assert.deepEqual(visibleNav(set(), ALL_ON, []).map((n) => n.href), ["/dashboard"]);
});

test("API errors are shown as short sentences", () => {
  assert.equal(errorText(new ApiError(409, "INVOICE_ALREADY_ISSUED", "This bill has been issued")), "This bill has been issued");
  assert.equal(errorText(new ApiError(400, "VALIDATION_FAILED", "Request validation failed", [{ path: "amount", message: "Must be positive" }])), "amount: Must be positive");
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("weird"), "Something went wrong");
});
