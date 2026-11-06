import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";
import { runA11yRules, type A11yIssue } from "./a11y-rules";

/**
 * Automated accessibility self-check of every main screen for each role (see a11y-rules.ts for exactly what is, and is not, checked).
 * This is NOT the independent accessibility audit listed in docs/certification.md.
 */
const SCREENS: { user: string; paths: string[] }[] = [
  { user: "reception1", paths: ["/dashboard", "/patients", "/appointments", "/queue", "/ipd", "/billing"] },
  { user: "doctor1", paths: ["/dashboard", "/queue", "/patients"] },
  { user: "nurse1", paths: ["/nursing", "/ipd"] },
  { user: "pharmacist1", paths: ["/pharmacy"] },
  { user: "cashier1", paths: ["/billing"] },
  { user: "admin", paths: ["/admin", "/audit", "/reports", "/account"] },
];

for (const { user, paths } of SCREENS) {
  test(`accessibility rules: ${user}`, async ({ page }) => {
    await loginAs(page, user);
    const all: string[] = [];
    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const issues: A11yIssue[] = await page.evaluate(`(${runA11yRules.toString()})()`);
      for (const i of issues) all.push(`${path}  [${i.rule}] ${i.where}: ${i.detail}`);
    }
    expect(all, `\n${all.join("\n")}\n`).toEqual([]);
  });
}

test("keyboard: the first Tab stop is a skip link or the navigation, and dialogs trap and restore focus", async ({ page }) => {
  await loginAs(page, "reception1");
  await page.goto("/patients");
  await page.waitForLoadState("networkidle");
  // The patients page puts the cursor in its search box on load; start from a page with nothing focused so the first Tab is the page's first Tab stop.
  // Blurring is not enough (the browser remembers where focus was); a click at the top-left corner resets where Tab starts from.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.click(2, 2);
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => document.activeElement?.tagName ?? "");
  expect(["A", "BUTTON", "INPUT"]).toContain(first);
  await page.getByRole("button", { name: "Register patient" }).click();
  const dialog = page.getByRole("dialog", { name: "Register new patient" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `focus stays inside the dialog after ${i + 1} Tab presses`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
