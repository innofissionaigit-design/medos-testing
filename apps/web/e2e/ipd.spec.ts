import { expect, test, type Page } from "@playwright/test";
import { loginAs, registerPatient } from "./helpers";

/**
 * Mandatory IPD workflow (CLAUDE.md §37) driven through the real browser UI, API and database, through every discharge stage
 * (docs/discharge-stages.md): the doctor's decision, nursing, charges, summary, pharmacy, final bill and payment, discharge, physical exit
 * (which frees the bed), bed turnover by housekeeping, and the Medical Records sign-off with ICD-10 coding.
 */
const stage = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name }).first();

async function openDischarge(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("tab", { name: "Discharge" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Discharge decision" }).first()).toBeVisible();
}

test("IPD: admit → medication given → note → every discharge stage → departure frees the bed → housekeeping → MRD sign-off", async ({ page }) => {
  // The consultant we admit under (only the treating consultant can sign the discharge summary).
  await loginAs(page, "doctor1");
  const doctorName = ((await page.locator("header").getByText(/^Dr\./).first().textContent()) ?? "").trim();

  // Reception registers and admits.
  await loginAs(page, "reception1");
  const p = await registerPatient(page);
  await page.goto("/ipd");
  await page.getByRole("button", { name: "Admit patient" }).click();
  const admit = page.getByRole("dialog", { name: "Admit patient" });
  await admit.getByLabel("Patient").fill(p.first);
  await admit.getByText(p.mrn).click();
  const consultant = admit.getByLabel("Consultant");
  await consultant.selectOption({ label: ((await consultant.locator("option", { hasText: doctorName }).first().textContent()) ?? "").trim() });
  await admit.getByLabel("Bed").selectOption({ index: 1 });
  await admit.getByLabel("Reason for admission").fill("Lower respiratory infection needing IV antibiotics");
  await admit.getByRole("button", { name: "Admit", exact: true }).click();
  await expect(page).toHaveURL(/\/ipd\/[0-9a-f-]{36}/);
  const admissionUrl = page.url();
  await expect(page.getByRole("heading", { name: `${p.first} ${p.last}` })).toBeVisible();

  // Doctor orders and signs a stat dose, then records the discharge decision.
  await loginAs(page, "doctor1");
  await page.goto(admissionUrl);
  await page.getByRole("tab", { name: "Medication orders" }).click();
  await page.getByRole("button", { name: "Add medicine" }).click();
  await page.getByLabel("Medicine", { exact: true }).fill("Ceftriaxone");
  await page.getByLabel("Dose").fill("1 vial");
  await page.getByLabel("Route").selectOption("IV");
  await page.getByLabel("Frequency", { exact: true }).selectOption("STAT");
  await page.getByLabel("Quantity").fill("1");
  await page.getByRole("button", { name: "Sign orders" }).click();
  await page.getByRole("button", { name: "Yes, sign" }).click();
  await expect(page.getByText(/^RX-/)).toBeVisible();
  await page.getByRole("tab", { name: "Discharge" }).click();
  await stage(page, "Discharge decision").getByRole("button", { name: "Clear" }).click();
  await expect(stage(page, "Discharge decision")).toContainText("Clinically fit / discharge advised");

  // Nurse writes a note, records the dose as given, and clears nursing with a handover note.
  await loginAs(page, "nurse1");
  await page.goto(admissionUrl);
  await page.getByRole("tab", { name: "Nursing and medication" }).click();
  await page.getByLabel("Note", { exact: true }).fill("Febrile on arrival, IV access secured, first dose due.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("IV access secured")).toBeVisible();
  await page.getByRole("button", { name: /Generate next 24 h/ }).click();
  await page.getByRole("button", { name: "Given", exact: true }).first().click();
  await expect(page.getByText("given", { exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Discharge" }).click();
  await page.getByLabel("Handover note").fill("Handed over to the day in-charge");
  await stage(page, "Nursing clearance").getByRole("button", { name: "Clear" }).click();
  await expect(stage(page, "Nursing clearance")).toContainText("Medication, clinical documentation and handover complete");

  // Doctor: a charge from the price list, charges reviewed, and the discharge summary signed.
  await loginAs(page, "doctor1");
  await page.goto(admissionUrl);
  const service = page.getByLabel("Service");
  await service.selectOption({ label: ((await service.locator("option", { hasText: "Dressing (small)" }).textContent()) ?? "").trim() });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Dressing (small)" })).toBeVisible();
  await page.getByRole("tab", { name: "Discharge" }).click();
  await stage(page, "Charges review").getByRole("button", { name: "Clear" }).click();
  await expect(stage(page, "Charges review")).toContainText("All charges posted and reviewed");
  await page.getByLabel("Final diagnoses (one per line)").fill("Lower respiratory tract infection");
  await page.getByLabel("Hospital course").fill("Treated with IV ceftriaxone; fever settled within 48 hours.");
  await page.getByLabel("Condition at discharge").fill("Stable");
  await page.getByRole("button", { name: "Sign summary" }).click();
  await page.getByRole("button", { name: "Yes, sign" }).click();
  await expect(page.getByText(/signed by/).first()).toBeVisible();

  // Pharmacy clearance.
  await loginAs(page, "pharmacist1");
  await openDischarge(page, admissionUrl);
  const ph = stage(page, "Pharmacy clearance");
  if (await ph.getByRole("button", { name: "Clear" }).isVisible()) await ph.getByRole("button", { name: "Clear" }).click();
  await expect(ph).toContainText("Issues, returns and eligible credits reconciled");

  // Cashier raises the final bill and takes payment.
  await loginAs(page, "cashier1");
  await openDischarge(page, admissionUrl);
  await page.getByRole("button", { name: "Generate final bill" }).click();
  await page.getByRole("link", { name: "Open final bill" }).click();
  await expect(page).toHaveURL(/\/billing\//);
  await expect(page.getByRole("cell", { name: /Dressing \(small\)/ })).toBeVisible();
  await page.getByRole("button", { name: "Take payment" }).click();
  await page.getByRole("button", { name: "Receive payment" }).click();
  await expect(page.getByText("BALANCE DUE").locator("xpath=following-sibling::dd")).toContainText("0.00");

  // Doctor: every stage is settled, and the discharge is completed. The bed stays with the patient until they leave.
  await loginAs(page, "doctor1");
  await openDischarge(page, admissionUrl);
  await expect(stage(page, "Final billing")).toContainText("Final bill, deposits, credits and patient liability reconciled");
  await expect(stage(page, "Financial release")).toContainText("Cleared");
  for (const name of ["Laboratory / radiology", "OT / procedure", "Insurance"]) await expect(stage(page, name)).toContainText("cleared");
  await page.getByRole("button", { name: "Discharge patient" }).click();
  await page.getByRole("button", { name: /^Yes, discharge/ }).click();
  await expect(page.getByText(/This admission is discharged/)).toBeVisible();
  await expect(stage(page, "Bed turnover")).toContainText("Bed kept until the patient leaves");
  await expect(stage(page, "Physical exit")).toContainText("Departure not yet confirmed");

  // Nurse sees the patient out: the departure is confirmed and the bed goes for cleaning.
  await loginAs(page, "nurse1");
  await openDischarge(page, admissionUrl);
  await page.getByLabel("Escorted by").fill("Family");
  await page.getByRole("button", { name: "Confirm departure" }).click();
  await expect(stage(page, "Physical exit")).toContainText("Actual departure confirmed");
  await expect(stage(page, "Bed turnover")).toContainText("Vacated: cleaning not started");

  // Housekeeping turns the bed around (beds only, no patients).
  await loginAs(page, "housekeeping1");
  await page.goto("/housekeeping");
  await page.getByRole("button", { name: "Start cleaning" }).first().click();
  await page.getByRole("button", { name: "Mark ready" }).first().click();
  await expect(page.getByText("Made ready in the last 24 hours")).toBeVisible();

  // Medical Records codes the diagnosis and signs the record off; nothing is owed, so the stay is closed.
  await loginAs(page, "mrd1");
  await openDischarge(page, admissionUrl);
  await expect(stage(page, "Bed turnover")).toContainText("Ready for the next patient");
  await page.getByRole("button", { name: "Mark records complete…" }).click();
  const coding = page.getByTestId("coding-form");
  await expect(coding.getByLabel("Diagnosis 1", { exact: true })).toHaveValue("Lower respiratory tract infection");
  await coding.getByLabel("ICD-10 code 1", { exact: true }).fill("J22");
  await coding.getByRole("button", { name: "Complete the record" }).click();
  await expect(stage(page, "Post-discharge")).toContainText("Records complete; claims and receivables closed");
  await expect(stage(page, "Post-discharge")).toContainText("J22 Lower respiratory tract infection (primary)");
});
