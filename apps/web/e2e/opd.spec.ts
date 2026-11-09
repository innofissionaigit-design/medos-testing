import { expect, test } from "@playwright/test";
import { loginAs, registerPatient } from "./helpers";

/** Mandatory OPD workflow (CLAUDE.md §36) driven through the real browser UI, API and database. */
test("OPD: register → check in → queue → consult → sign → dispense → pay", async ({ page }) => {
  // The doctor we will route the patient to (their name is shown in the top bar).
  await loginAs(page, "doctor1");
  const doctorName = ((await page.locator("header").getByText(/^Dr\./).first().textContent()) ?? "").trim();
  expect(doctorName).toMatch(/^Dr\./);

  // Reception registers the patient and starts a visit.
  await loginAs(page, "reception1");
  const p = await registerPatient(page);
  await page.getByRole("button", { name: "Start OPD visit" }).click();
  const start = page.getByRole("dialog", { name: "Start an OPD visit" });
  const label = (await start.locator("option", { hasText: doctorName }).first().textContent()) ?? "";
  await start.getByLabel("Doctor").selectOption({ label });
  await start.getByRole("button", { name: "Check in and add to queue" }).click();
  await expect(page).toHaveURL(/\/queue/);
  await expect(page.getByRole("row", { name: new RegExp(p.first) })).toBeVisible();

  // Doctor opens the patient from the queue and consults.
  await loginAs(page, "doctor1");
  await page.goto("/queue");
  await page.getByRole("row", { name: new RegExp(p.first) }).getByRole("button", { name: "Start", exact: true }).click();
  await expect(page).toHaveURL(/\/visits\//);
  await expect(page.getByRole("heading", { name: `${p.first} ${p.last}` })).toBeVisible();

  await page.getByLabel("Pulse").fill("88");
  await page.getByLabel("Temperature").fill("38.2");
  await page.getByRole("button", { name: "Record vitals" }).click();
  await expect(page.getByText("88 bpm")).toBeVisible();

  await page.getByLabel("Complaint").fill("Fever and cough for three days");
  await page.getByLabel("Examination").fill("Throat congested, chest clear");
  await page.getByLabel("Diagnosis", { exact: true }).fill("Acute viral fever");
  await page.locator("form", { has: page.getByLabel("Diagnosis", { exact: true }) }).getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("listitem").getByText("Acute viral fever")).toBeVisible();

  await page.getByRole("button", { name: "Add medicine" }).click();
  await page.getByLabel("Medicine", { exact: true }).fill("Paracetamol");
  await page.getByLabel("Quantity").fill("6");
  await page.getByRole("button", { name: "Save prescription" }).click();
  await page.getByRole("button", { name: "Sign consultation" }).click();
  await page.getByRole("button", { name: /^Yes, sign/ }).click();
  await expect(page.getByText(/This consultation is signed/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Print prescription" })).toBeVisible();

  // A signed note is read-only.
  await expect(page.getByLabel("Complaint")).toBeDisabled();

  // Pharmacy receives the signed prescription, dispenses and takes payment.
  await loginAs(page, "pharmacist1");
  await page.goto("/pharmacy");
  const row = page.getByRole("row", { name: new RegExp(p.first) });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Dispense" }).click();
  const dlg = page.getByRole("dialog", { name: /^Dispense —/ });
  await dlg.getByLabel("Medicine").fill("Parac");
  await dlg.getByRole("listitem").getByRole("button").first().click();
  await dlg.getByRole("button", { name: "Dispense", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /^Dispensed —/ })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // The pharmacy does not take payment: the prescription has left its queue and the bill waits at the cashier, who collects it.
  await page.goto("/pharmacy");
  await expect(page.getByRole("row", { name: new RegExp(p.first) })).toHaveCount(0);
  await loginAs(page, "cashier1");
  await page.goto("/billing");
  await page.getByLabel("Status").selectOption("OUTSTANDING");
  await page.getByRole("row", { name: new RegExp(p.first) }).first().getByRole("link").first().click();
  await page.getByRole("button", { name: "Take payment" }).click();
  const pay = page.getByRole("dialog", { name: /^Take payment/ });
  await pay.getByLabel("Mode").selectOption("UPI");
  await pay.getByLabel("Reference").fill("UPI-E2E-0001");
  await pay.getByRole("button", { name: "Receive payment" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.goto("/billing");
  await page.getByLabel("Status").selectOption("PAID");
  await expect(page.getByRole("row", { name: new RegExp(`${p.first}.*paid|paid.*${p.first}`, "i") }).first()).toBeVisible();
});

test("a receptionist cannot reach clinical or administrative screens", async ({ page }) => {
  await loginAs(page, "reception1");
  await page.goto("/pharmacy");
  await expect(page.getByText("You do not have access to this page.")).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByText("You do not have access to this page.")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Patients" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Audit" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Pharmacy" })).toHaveCount(0);
});

test("registering a patient who looks like an existing one shows the possible duplicate", async ({ page }) => {
  await loginAs(page, "reception1");
  const p = await registerPatient(page);
  await page.goto("/patients");
  await page.getByRole("button", { name: "Register patient" }).click();
  const dialog = page.getByRole("dialog", { name: "Register new patient" });
  await dialog.getByLabel("First name").fill(p.first);
  await dialog.getByLabel("Last name").fill(p.last);
  await dialog.getByLabel("Age in years").fill("37");
  await dialog.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "This patient may already be registered" })).toBeVisible();
  await expect(page.getByText(p.mrn)).toBeVisible();
});
