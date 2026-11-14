import { expect, type Locator, type Page } from "@playwright/test";

export const TENANT = "demo-hospital";
export const PASSWORD = "E2e-Passw0rd-2026!";

/** A real sign-in through the login form. */
/** Reception is asked after signing in which desk it works at (OPD or IPD); `desk` answers that question (OPD unless a test works at the IPD desk). */
export async function loginAs(page: Page, username: string, desk: "OPD" | "IPD" = "OPD"): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Hospital code").fill(TENANT);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  if (username.startsWith("reception")) {
    await expect(page.getByText("Which desk are you working at?")).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^${desk}`) }).click();
    await expect(page.getByRole("button", { name: new RegExp(`${desk} desk`) })).toBeVisible();
  }
}

const LETTERS = "bcdfghjklmnprstvwz";
const VOWELS = "aeiou";
/** Pronounceable synthetic word, unique enough that duplicate detection never fires by accident. */
export function word(len = 8): string {
  return Array.from({ length: len }, (_, i) => (i % 2 === 0 ? LETTERS : VOWELS)[Math.floor(Math.random() * (i % 2 === 0 ? LETTERS.length : VOWELS.length))]).join("").replace(/^./, (c) => c.toUpperCase());
}
export const mobile = (): string => `9${Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join("")}`;

export async function registerPatient(page: Page): Promise<{ first: string; last: string; mrn: string }> {
  const first = word(8);
  const last = word(9);
  await page.goto("/patients");
  await page.getByRole("button", { name: "Register patient" }).click();
  const dialog = page.getByRole("dialog", { name: "Register new patient" });
  await dialog.getByLabel("First name").fill(first);
  await dialog.getByLabel("Last name").fill(last);
  await dialog.getByLabel("Mobile").fill(mobile());
  await dialog.getByLabel("Age in years").fill("37");
  await dialog.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${first} ${last}` })).toBeVisible();
  const mrn = (await page.getByText(/MRN DEMO-\d+/).first().textContent())?.match(/DEMO-\d+/)?.[0] ?? "";
  expect(mrn).toMatch(/^DEMO-\d+$/);
  return { first, last, mrn };
}

/** Picks a doctor the way the screens now ask for it: first the department, then a doctor of that department. With no name, the first doctor found is used. */
export async function chooseDoctor(dialog: Locator, doctor?: string): Promise<string> {
  const dept = dialog.getByLabel("Department");
  const doctors = dialog.getByLabel("Doctor");
  const ids = await dept.locator("option").evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value).filter(Boolean));
  for (const id of ids) {
    await dept.selectOption(id);
    const option = doctor ? doctors.locator("option", { hasText: doctor }) : doctors.locator("option:not([value=''])");
    if ((await option.count()) > 0) {
      const label = ((await option.first().textContent()) ?? "").trim();
      await doctors.selectOption({ label });
      return label;
    }
  }
  throw new Error("No doctor found" + (doctor ? ` named ${doctor}` : ""));
}
