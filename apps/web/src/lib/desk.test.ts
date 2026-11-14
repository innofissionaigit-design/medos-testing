import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDesk } from "./desk";
import { visibleNav } from "./nav";

const reception = new Set(["PATIENT_READ", "APPOINTMENT_READ", "QUEUE_READ", "INVOICE_READ", "ADMISSION_READ", "TELE_READ", "NURSING_READ"]);
const features = { IPD_ENABLED: true, NURSING_ENABLED: true, PHARMACY_ENABLED: true };
const hrefs = (desk: "OPD" | "IPD" | null) => visibleNav(reception, features, ["RECEPTIONIST"], desk).map((n) => n.href);

test("only the receptionist chooses a desk, and only where inpatient care is on", () => {
  assert.equal(needsDesk(["RECEPTIONIST"], { IPD_ENABLED: true }), true);
  assert.equal(needsDesk(["RECEPTIONIST", "CASHIER"], {}), true, "an unset feature flag counts as on");
  assert.equal(needsDesk(["RECEPTIONIST"], { IPD_ENABLED: false }), false, "no inpatient care: only one desk exists");
  for (const role of ["DOCTOR", "NURSE", "CASHIER", "ADMINISTRATOR", "MANAGER"]) assert.equal(needsDesk([role], { IPD_ENABLED: true }), false, role);
});

test("the OPD desk shows outpatient screens and none of the inpatient ones", () => {
  const nav = hrefs("OPD");
  for (const h of ["/dashboard", "/patients", "/appointments", "/queue", "/billing", "/teleconsult"]) assert.ok(nav.includes(h), h);
  for (const h of ["/ipd", "/discharge-board", "/nursing"]) assert.ok(!nav.includes(h), `${h} belongs to the IPD desk`);
});

test("the IPD desk shows inpatient screens and none of the outpatient ones", () => {
  const nav = hrefs("IPD");
  for (const h of ["/dashboard", "/patients", "/ipd", "/discharge-board", "/billing"]) assert.ok(nav.includes(h), h);
  for (const h of ["/appointments", "/queue", "/teleconsult"]) assert.ok(!nav.includes(h), `${h} belongs to the OPD desk`);
});

test("with no desk (everyone but reception) nothing is hidden", () => {
  const nav = hrefs(null);
  for (const h of ["/appointments", "/queue", "/ipd", "/discharge-board"]) assert.ok(nav.includes(h), h);
});
