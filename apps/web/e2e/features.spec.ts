import { expect, test, type Page } from "@playwright/test";
import { loginAs, PASSWORD, registerPatient, TENANT } from "./helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const futureDay = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function doctorName(page: Page, user: string): Promise<string> {
  await loginAs(page, user);
  return ((await page.locator("header").getByText(/^Dr\./).first().textContent()) ?? "").trim();
}

test("patient: edit details, upload a photo and a document, remove the document", async ({ page }) => {
  await loginAs(page, "reception1");
  const p = await registerPatient(page);
  await page.getByRole("button", { name: "Edit details" }).click();
  const dlg = page.getByRole("dialog", { name: "Edit patient details" });
  await expect(dlg.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await dlg.getByLabel("City").fill("Howrah");
  await dlg.getByLabel("Blood group").selectOption("O_POS");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Howrah")).toBeVisible();
  await expect(page.getByText("O+")).toBeVisible();

  const card = page.locator("section", { has: page.getByRole("heading", { name: "Photo and documents" }) });
  await card.getByLabel("Upload type").selectOption("PHOTO");
  await card.getByLabel("Choose file").setInputFiles({ name: "face.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByAltText("Patient photo")).toBeVisible();

  await card.getByLabel("Upload type").selectOption("DOCUMENT");
  await card.getByLabel("Document title").fill("Blood report");
  await card.getByLabel("Choose file").setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(card.getByRole("link", { name: "Blood report" })).toBeVisible();

  // a wrong file type is refused before it is sent
  await card.getByLabel("Choose file").setInputFiles({ name: "run.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ") });
  await expect(card.getByText("Choose a PNG or JPEG image, or a PDF.")).toBeVisible();

  await card.getByRole("button", { name: "remove" }).last().click();
  const rm = page.getByRole("dialog");
  await rm.getByLabel("Reason").fill("Uploaded to the wrong patient");
  await rm.getByRole("button", { name: "Remove" }).click();
  await expect(card.getByRole("link", { name: "Blood report" })).toHaveCount(0);
  expect(p.mrn).toBeTruthy();
});

test("language: the whole shell switches to Bengali and Hindi, and back", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("radio", { name: "বাংলা" }).click();
  await expect(page.getByRole("button", { name: "সাইন ইন" })).toBeVisible();
  await page.getByLabel("হাসপাতালের কোড").fill(TENANT);
  await page.getByLabel("ইউজারনেম বা ইমেল").fill("reception1");
  await page.getByLabel("পাসওয়ার্ড").fill(PASSWORD);
  await page.getByRole("button", { name: "সাইন ইন" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "রোগী" })).toBeVisible();
  await page.goto("/account");
  await page.getByRole("radio", { name: "हिन्दी" }).click();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "मरीज़" })).toBeVisible();
  await page.getByRole("radio", { name: "English" }).click();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Patients" })).toBeVisible();
});

test("billing: edit a draft bill, issue it, and download it as a PDF", async ({ page }) => {
  await loginAs(page, "reception1");
  const p = await registerPatient(page);
  await loginAs(page, "cashier1");
  await page.goto("/billing");
  await page.getByRole("button", { name: "New bill" }).click();
  const nb = page.getByRole("dialog", { name: "New bill" });
  await nb.getByLabel("Patient").fill(p.first);
  await nb.getByText(p.mrn).click();
  await nb.getByRole("button", { name: /^OPD consultation/ }).click();
  await nb.getByRole("button", { name: "Create bill" }).click();
  await expect(page).toHaveURL(/\/billing\/[0-9a-f-]{36}/);
  await expect(page.getByText("Draft bill")).toBeVisible();

  await page.getByRole("button", { name: "Edit items" }).click();
  const ed = page.getByRole("dialog", { name: "Edit draft bill" });
  await ed.getByRole("button", { name: /^ECG/ }).click();
  await ed.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("cell", { name: "ECG" })).toBeVisible();
  await expect(page.getByText("₹800.00").first()).toBeVisible();

  await page.getByRole("button", { name: "Issue bill" }).click();
  await expect(page.getByText("INV-")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit items" })).toHaveCount(0);
  const pdf = page.getByRole("link", { name: "PDF" });
  const href = (await pdf.getAttribute("href")) ?? "";
  expect(href).toContain("format=pdf");
  const res = await page.request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  expect((await res.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
});

test("consultation: a signed note is amended with a reason and the history shows both versions", async ({ page }) => {
  const doc = await doctorName(page, "doctor2");
  await loginAs(page, "reception1");
  const p = await registerPatient(page);
  await page.getByRole("button", { name: "Start OPD visit" }).click();
  const start = page.getByRole("dialog", { name: "Start an OPD visit" });
  await start.getByLabel("Doctor").selectOption({ label: ((await start.locator("option", { hasText: doc }).first().textContent()) ?? "").trim() });
  await start.getByRole("button", { name: "Check in and add to queue" }).click();
  await expect(page).toHaveURL(/\/queue/);

  await loginAs(page, "doctor2");
  await page.goto("/queue");
  await page.getByRole("row", { name: new RegExp(p.first) }).getByRole("button", { name: "Start", exact: true }).click();
  await page.getByLabel("Complaint").fill("Cough for two days");
  await page.getByLabel("Diagnosis", { exact: true }).fill("Upper respiratory infection");
  await page.locator("form", { has: page.getByLabel("Diagnosis", { exact: true }) }).getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("listitem").getByText("Upper respiratory infection")).toBeVisible();
  await page.getByRole("button", { name: "Sign consultation" }).click();
  await page.getByRole("button", { name: /^Yes, sign/ }).click();
  await expect(page.getByText(/This consultation is signed/)).toBeVisible();

  await page.getByRole("button", { name: "Amend…" }).click();
  const am = page.getByRole("dialog", { name: "Amend signed consultation" });
  await expect(am.getByRole("button", { name: "Save as new version" })).toBeDisabled();
  await am.getByLabel("Complaint").fill("Cough and mild fever for two days");
  await am.getByLabel("Why is this being amended?").fill("Fever was missed in the first note");
  await am.getByRole("button", { name: "Save as new version" }).click();
  await expect(am).toBeHidden();
  const history = page.locator("section", { has: page.getByRole("heading", { name: "Version history" }) });
  await expect(history.getByText("v2 amended")).toBeVisible();
  await expect(history.getByText("v1 signed")).toBeVisible();
  await expect(history.getByText("Fever was missed in the first note")).toBeVisible();
  await page.getByRole("link", { name: "PDF", exact: true }).isVisible();
});

test("appointments: book then reschedule to another time", async ({ page }) => {
  await loginAs(page, "reception1");
  const p = await registerPatient(page);
  await page.goto("/appointments");
  await page.getByRole("button", { name: "Book appointment" }).click();
  const book = page.getByRole("dialog", { name: "Book appointment" });
  await book.getByLabel("Patient").fill(p.first);
  await book.getByText(p.mrn).click();
  await book.getByLabel("Doctor").selectOption({ index: 1 });
  await book.getByLabel("Date").fill(futureDay(2));
  await book.locator("button:not([disabled])").filter({ hasText: /\d:\d\d/ }).first().click();
  await book.getByRole("button", { name: "Book", exact: true }).click();
  await expect(book).toBeHidden();

  await page.getByLabel("Date").first().fill(futureDay(2));
  const row = page.getByRole("row", { name: new RegExp(p.first) });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Reschedule" }).click();
  const mv = page.getByRole("dialog", { name: /^Reschedule/ });
  await mv.getByLabel("Date").fill(futureDay(3));
  await mv.locator("button:not([disabled])").filter({ hasText: /\d:\d\d/ }).nth(2).click();
  await mv.getByRole("button", { name: "Move appointment" }).click();
  await expect(mv).toBeHidden();
  await page.getByLabel("Date").first().fill(futureDay(3));
  await expect(page.getByRole("row", { name: new RegExp(p.first) })).toBeVisible();
});

test("pharmacy: add a supplier, receive a purchase, return part of it and adjust stock", async ({ page }) => {
  await loginAs(page, "pharmacist1");
  await page.goto("/pharmacy");
  await page.getByRole("tab", { name: "Suppliers" }).click();
  const supplier = `Sunrise Distributors ${Date.now() % 10000}`;
  await page.getByLabel("Supplier name").fill(supplier);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(supplier)).toBeVisible();

  await page.getByRole("tab", { name: "Purchases" }).click();
  await page.getByRole("button", { name: "Receive purchase" }).click();
  const buy = page.getByRole("dialog", { name: "Receive a purchase" });
  await buy.getByRole("combobox", { name: "Supplier", exact: true }).selectOption({ label: supplier });
  await buy.getByLabel("Supplier invoice no.").fill(`SI-${Date.now() % 100000}`);
  await buy.getByLabel("Medicine").fill("Parac");
  await buy.getByRole("listitem").first().click();
  await buy.getByLabel("Batch number").fill("E2E-PUR-1");
  await buy.getByLabel("Expiry date").fill(futureDay(400));
  await buy.getByLabel("Quantity").fill("40");
  await buy.getByLabel("MRP").fill("5");
  await buy.getByLabel("Purchase price").fill("3");
  await buy.getByLabel("Selling price").fill("4.5");
  await buy.getByRole("button", { name: "Receive stock" }).click();
  await expect(buy).toBeHidden();
  const row = page.getByRole("row", { name: new RegExp(supplier) });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Return…" }).click();
  const ret = page.getByRole("dialog", { name: /^Return to supplier/ });
  await ret.getByLabel(/^Return quantity/).fill("10");
  await ret.getByLabel("Reason").fill("Damaged cartons on arrival");
  await ret.getByRole("button", { name: "Return stock" }).click();
  await expect(ret).toBeHidden();

  await page.getByRole("tab", { name: "Stock" }).click();
  await page.getByLabel("Search medicine").fill("Parac");
  const adjust = page.getByRole("button", { name: "adjust" }).first();
  await adjust.click();
  const adj = page.getByRole("dialog", { name: /^Adjust stock/ });
  await adj.getByLabel("Quantity").fill("2");
  await adj.getByLabel("Reason").fill("Two strips damaged in storage");
  await adj.getByRole("button", { name: "Record adjustment" }).click();
  await expect(adj).toBeHidden();
});

test("admin: set a doctor's weekly schedule and create a custom role", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/admin");
  await page.getByRole("tab", { name: "Doctors and departments" }).click();
  const sched = page.locator("section", { has: page.getByRole("heading", { name: "Weekly schedule" }) });
  await sched.getByLabel("Doctor").selectOption({ index: 1 });
  await sched.getByRole("button", { name: "Mon–Sat mornings" }).click();
  await sched.getByRole("button", { name: "Save schedule" }).click();
  await expect(sched.getByText("Saved")).toBeVisible();

  await page.getByRole("tab", { name: "Staff" }).click();
  await page.getByRole("button", { name: "New role" }).click();
  const role = page.getByRole("dialog", { name: "New role" });
  const name = `Lab desk ${Date.now() % 10000}`;
  await role.getByLabel("Role name").fill(name);
  await role.getByLabel("patient read").check();
  await role.getByRole("button", { name: "Save role" }).click();
  await role.getByRole("button", { name: "Yes, change access" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: name.toLowerCase() })).toBeVisible();
});

test("account: change password, get signed out, and sign in with the new one", async ({ page }) => {
  await loginAs(page, "manager1");
  await page.goto("/account");
  const fresh = page.locator('input[autocomplete="new-password"]');
  await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await fresh.nth(0).fill("New-Passw0rd-2027!");
  await fresh.nth(1).fill("Different-Passw0rd!");
  await expect(page.getByText("The passwords do not match")).toBeVisible();
  await fresh.nth(1).fill("New-Passw0rd-2027!");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });
  await page.getByLabel("Hospital code").fill(TENANT);
  await page.getByLabel("Username or email").fill("manager1");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /invalid/i })).toBeVisible();
  await page.getByLabel("Password").fill("New-Passw0rd-2027!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test("reports: a report downloads as a CSV file", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/reports");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
});
