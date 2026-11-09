import { expect, type Page } from "@playwright/test";

export const TENANT = "demo-hospital";
export const PASSWORD = "E2e-Passw0rd-2026!";

/** A real sign-in through the login form. */
export async function loginAs(page: Page, username: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Hospital code").fill(TENANT);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
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
