import { expect, test, type Page } from "@playwright/test";
import { loginAs, registerPatient } from "./helpers";

/** Mandatory IPD workflow (CLAUDE.md §37) driven through the real browser UI, API and database. */
async function clearStep(page: Page, label: RegExp) {
  await page.getByRole("tab", { name: "Discharge" }).click();
  const row = page.locator("div", { has: page.getByText(label) }).filter({ has: page.getByRole("button", { name: "Clear" }) }).last();
  await row.getByRole("button", { name: "Clear" }).click();
}

test("IPD: admit → bed → order → medication given → note → clearances → summary → final bill → payment → discharge", async ({ page }) => {
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
  await expect(page.getByText("current")).toBeVisible();

  // Doctor orders and signs a stat dose.
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
  // Medical fitness must be cleared by the doctor before any other step.
  await page.getByRole("tab", { name: "Discharge" }).click();
  const fitStep = page.locator("div.flex.items-start", { has: page.getByText("Medically fit") });
  await fitStep.getByRole("button", { name: "Clear" }).click();
  await expect(fitStep.getByText("cleared")).toBeVisible();

  // Nurse writes a note, schedules the dose and records that it was given.
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
  const nurseStep = page.locator("div.flex.items-start", { has: page.getByText("Nursing", { exact: true }) });
  await nurseStep.getByRole("button", { name: "Clear" }).click();
  await expect(nurseStep.getByText("cleared")).toBeVisible();

  // Doctor: charge, fitness, charges reviewed, summary.
  await loginAs(page, "doctor1");
  await page.goto(admissionUrl);
  // Doctors charge from the price list; free-price charges need billing permission.
  const service = page.getByLabel("Service");
  await service.selectOption({ label: ((await service.locator("option", { hasText: "Dressing (small)" }).textContent()) ?? "").trim() });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Dressing (small)" })).toBeVisible();
  await page.getByRole("tab", { name: "Discharge" }).click();
  await expect(page.getByText("Before discharge:")).toBeVisible();
  await page.getByRole("row").first().isVisible().catch(() => undefined);
  for (const name of [/Charges reviewed/]) {
    const step = page.locator("div.flex.items-start", { has: page.getByText(name) });
    await step.getByRole("button", { name: "Clear" }).click();
    await expect(step.getByText("cleared")).toBeVisible();
  }
  await page.getByLabel("Final diagnoses (one per line)").fill("Lower respiratory tract infection");
  await page.getByLabel("Hospital course").fill("Treated with IV ceftriaxone; fever settled within 48 hours.");
  await page.getByLabel("Condition at discharge").fill("Stable");
  await page.getByRole("button", { name: "Sign summary" }).click();
  await page.getByRole("button", { name: "Yes, sign" }).click();
  await expect(page.getByText(/signed by/)).toBeVisible();

  // Pharmacy clearance.
  await loginAs(page, "pharmacist1");
  await page.goto(admissionUrl);
  await page.getByRole("tab", { name: "Discharge" }).click();
  const ph = page.locator("div.flex.items-start", { has: page.getByText("Pharmacy") });
  await ph.getByRole("button", { name: "Clear" }).click();
  await expect(ph.getByText("cleared")).toBeVisible();

  // Cashier raises the final bill and takes payment.
  await loginAs(page, "cashier1");
  await page.goto(admissionUrl);
  await page.getByRole("tab", { name: "Discharge" }).click();
  await page.getByRole("button", { name: "Generate final bill" }).click();
  await page.getByRole("link", { name: "Open final bill" }).click();
  await expect(page).toHaveURL(/\/billing\//);
  await expect(page.getByRole("cell", { name: /Dressing \(small\)/ })).toBeVisible();
  await page.getByRole("button", { name: "Take payment" }).click();
  await page.getByRole("button", { name: "Receive payment" }).click();
  await expect(page.getByText("BALANCE DUE").locator("xpath=following-sibling::dd")).toContainText("0.00");

  // Doctor completes the discharge; the bed is released for cleaning.
  await loginAs(page, "doctor1");
  await page.goto(admissionUrl);
  await page.getByRole("tab", { name: "Discharge" }).click();
  await page.getByRole("button", { name: "Discharge patient" }).click();
  await page.getByRole("button", { name: /^Yes, discharge/ }).click();
  await expect(page.getByText(/This admission is discharged/)).toBeVisible();

  await loginAs(page, "reception1");
  await page.goto("/ipd");
  await expect(page.getByText("cleaning", { exact: true }).first()).toBeVisible();
});
