/**
 * Captures every page with real data for the docs (docs/media/screenshots/).
 *   npx playwright test --project=screenshots
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(__dirname, "../../../docs/media/screenshots");
fs.mkdirSync(OUT, { recursive: true });

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
}

async function json<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as T;
}

type Doc = { id: string; filename: string; fileType: string | null; status: string; invoiceCount: number };
type Inv = { id: string; file_type: string | null; status: string; errors: number; warnings: number; filename: string };

test("capture all pages", async ({ page, request }) => {
  const docs = (await json<{ items: Doc[] }>(request, "/api/proxy/documents?pageSize=200")).items;
  const invoices = (await json<{ items: Inv[] }>(request, "/api/proxy/invoices?pageSize=500")).items;
  const batch = docs.find((d) => d.fileType === "pdf" && d.status === "completed" && d.invoiceCount > 3);
  const sheet = docs.find((d) => ["xlsx", "xls"].includes(d.fileType ?? "") && d.status === "completed");
  const failed = docs.find((d) => d.status === "failed");
  const scanInvoice = invoices.find((i) => i.file_type === "image" && i.status !== "rejected") ?? invoices.find((i) => i.file_type === "pdf");
  const sheetInvoice = invoices.find((i) => ["xlsx", "xls"].includes(i.file_type ?? ""));
  const recs = await json<Array<{ id: string }>>(request, "/api/proxy/reconciliations");

  await page.goto("/");
  await shot(page, "01-overview", true);
  await page.goto("/documents");
  await shot(page, "02-documents");
  if (batch) {
    await page.goto(`/documents/${batch.id}`);
    await shot(page, "03-document-batch-pdf");
    await page.getByRole("tab", { name: /Pages and text/ }).click();
    await shot(page, "04-document-pages-and-text");
  }
  if (sheet) {
    await page.goto(`/documents/${sheet.id}`);
    await shot(page, "05-document-spreadsheet");
  }
  if (failed) {
    await page.goto(`/documents/${failed.id}`);
    await shot(page, "06-document-failed");
  }
  if (scanInvoice) {
    await page.goto(`/invoices/${scanInvoice.id}`);
    await page.locator("#field-supplier_name").click();
    await page.waitForTimeout(900);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "07-invoice-review-scan");
  }
  if (sheetInvoice) {
    await page.goto(`/invoices/${sheetInvoice.id}`);
    await page.locator("#field-total").click();
    await page.waitForTimeout(900);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "08-invoice-review-spreadsheet");
  }
  await page.goto("/review");
  await shot(page, "09-review-queue");
  await page.goto("/search?q=home%20nursing%20visit&mode=hybrid");
  await expect(page.getByTestId("search-results")).toBeVisible();
  await shot(page, "10-search-hybrid");
  await page.goto("/search?q=wheelchair%20hire&mode=semantic");
  await expect(page.getByTestId("search-results")).toBeVisible();
  await shot(page, "11-search-semantic");
  if (recs.length) {
    await page.goto(`/reconcile?id=${recs[0].id}`);
    await expect(page.getByTestId("reconciliation-result")).toBeVisible();
    await shot(page, "12-cross-verify", true);
  }
});
