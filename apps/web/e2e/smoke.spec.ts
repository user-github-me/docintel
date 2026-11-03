import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

// A unique register per run, so duplicate-upload detection never short-circuits the test.
const run = Date.now().toString(36).toUpperCase();
const SUPPLIER = `Smoke Test Supplies ${run} Ltd`;
const csv = [
  "Invoice No,Invoice Date,Vendor,Customer,Currency,Subtotal,Tax,Total",
  `SMOKE-${run},2026-03-14,${SUPPLIER},Care Guide QA,USD,100.00,10.00,110.00`,
].join("\n");

let documentUrl = "";
let invoiceUrl = "";

test("dashboard loads with metrics, upload and system status", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Drop invoices here, or choose files")).toBeVisible();
  await expect(page.getByText("Processed successfully")).toBeVisible();
  await expect(page.getByText("API & database")).toBeVisible();
});

test("uploading through the UI processes the file", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles({ name: `smoke-${run}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) });
  const result = page.getByTestId("upload-result");
  await expect(result).toContainText(`smoke-${run}.csv`);
  await result.getByRole("link", { name: `smoke-${run}.csv` }).click();
  await expect(page.getByRole("heading", { name: `smoke-${run}.csv` })).toBeVisible();
  await expect(page.getByText(/Completed|Needs review/).first()).toBeVisible({ timeout: 60_000 });
  documentUrl = page.url();
  const link = page.getByTestId("invoice-link").first();
  await expect(link).toHaveText(`SMOKE-${run}`);
  await link.click();
  await expect(page).toHaveURL(/\/invoices\//);
  invoiceUrl = page.url();
});

test("correcting the total re-runs validation", async ({ page }) => {
  test.skip(!invoiceUrl, "upload test did not produce an invoice");
  await page.goto(invoiceUrl);
  const total = page.locator("#field-total");
  await expect(total).toHaveValue("110.00");
  await total.fill("111.00");
  await expect(page.getByText("Edited, not saved").first()).toBeVisible();
  await page.getByTestId("save-corrections").click();
  await expect(page.getByText(/Saved\./)).toBeVisible();
  await expect(page.getByTestId("issues-panel")).toContainText("Total mismatch");
  // put it back: validation passes again
  await page.locator("#field-total").fill("110.00");
  await page.getByTestId("save-corrections").click();
  await expect(page.getByText("Saved. Validation re-ran and passed.")).toBeVisible();
  await page.getByRole("tab", { name: /History/ }).click();
  await expect(page.getByRole("heading", { name: "Corrections" })).toBeVisible();
});

test("keyword search finds the uploaded invoice", async ({ page }) => {
  await page.goto(`/search?q=${encodeURIComponent(`SMOKE-${run}`)}&mode=keyword`);
  await expect(page.getByTestId("search-results")).toContainText(SUPPLIER);
});

test("cross-verify page renders", async ({ page }) => {
  await page.goto("/reconcile");
  await expect(page.getByRole("heading", { name: "Cross-verify" })).toBeVisible();
  await expect(page.getByLabel("Left document")).toBeVisible();
  await expect(page.getByLabel("Right document")).toBeVisible();
});

test("documents page lists the upload and the proxy hides the API key", async ({ page, request }) => {
  await page.goto("/documents");
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await expect(page.getByTestId("document-row").first()).toBeVisible();
  const res = await request.get("/api/proxy/documents?pageSize=1");
  expect(res.ok()).toBeTruthy();
  const html = await (await request.get("/")).text();
  expect(html).not.toContain("dev-admin-key-change-me");
  expect(documentUrl).toContain("/documents/");
});
