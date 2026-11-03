/**
 * Narrated product tour, recorded to video (docs/media/walkthrough.webm).
 * Run against a stack with the eval dataset generated (eval/data) and the cross-verification
 * pair recon-a-left.pdf / recon-a-right.xlsx already processed (uploaded as invoices / reference).
 *
 *   npm run walkthrough
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const DATA = path.join(ROOT, "eval", "data");
const run = Date.now().toString(36).slice(-5).toUpperCase();

async function caption(page: Page, step: string, text: string, holdMs = 2800) {
  await page.evaluate(
    ([s, t]) => {
      let box = document.getElementById("wt-caption");
      if (!box) {
        box = document.createElement("div");
        box.id = "wt-caption";
        Object.assign(box.style, {
          position: "fixed",
          left: "50%",
          bottom: "96px",
          transform: "translateX(-50%)",
          zIndex: "9999",
          maxWidth: "860px",
          padding: "14px 20px",
          borderRadius: "12px",
          background: "rgba(29,43,54,0.94)",
          color: "#fff",
          font: "500 17px/1.45 ui-sans-serif,-apple-system,Segoe UI,sans-serif",
          boxShadow: "0 12px 40px rgba(0,0,0,0.28)",
          display: "flex",
          gap: "14px",
          alignItems: "baseline",
          pointerEvents: "none",
        });
        document.body.appendChild(box);
      }
      box.replaceChildren();
      const n = document.createElement("span");
      n.textContent = s;
      Object.assign(n.style, { color: "#f2c14e", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", fontSize: "14px" });
      const body = document.createElement("span");
      body.textContent = t;
      box.append(n, body);
    },
    [step, text],
  );
  await page.waitForTimeout(holdMs);
}

function file(rel: string, displayName: string, mimeType: string) {
  const buf = fs.readFileSync(path.join(DATA, rel));
  // Unique bytes per run (trailing data is ignored by PDF/PNG readers) so re-runs are not
  // short-circuited by duplicate-upload detection.
  const marker = rel.endsWith(".pdf") ? `\n% walkthrough ${run}\n` : `walkthrough-${run}`;
  return { name: displayName, mimeType, buffer: Buffer.concat([buf, Buffer.from(marker)]) };
}

async function waitForBatch(request: APIRequestContext, names: string[]) {
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/proxy/documents?pageSize=50`);
        const body = (await res.json()) as { items: Array<{ filename: string; status: string }> };
        const mine = body.items.filter((d) => names.includes(d.filename));
        return mine.length === names.length && mine.every((d) => d.status === "completed" || d.status === "failed");
      },
      { timeout: 240_000, intervals: [2000] },
    )
    .toBe(true);
}

async function labelFor(docId: string) {
  const lines = fs.readFileSync(path.join(DATA, "labels.jsonl"), "utf8").trim().split("\n");
  return lines.map((l) => JSON.parse(l)).find((l) => l.doc_id === docId)?.invoices?.[0];
}

test.afterEach(async ({ page }) => {
  const video = page.video();
  await page.close();
  if (video) {
    fs.mkdirSync(path.join(ROOT, "docs", "media"), { recursive: true });
    await video.saveAs(path.join(ROOT, "docs", "media", "walkthrough.webm"));
  }
});

test("DocIntel product walkthrough", async ({ page, request }) => {
  const names = {
    digital: `supplier-invoice-${run}.pdf`,
    photo: `scanned-invoice-${run}.tiff`,
    batch: `batch-13-invoices-${run}.pdf`,
    register: `ap-register-${run}.csv`,
    damaged: `damaged-scan-${run}.pdf`,
  };
  const register = [
    "Invoice No,Invoice Date,Vendor,Customer,Currency,Subtotal,Tax,Total",
    `RG-${run}-1,2026-10-02,Harbour Home Care Ltd,Cottage Care Services,GBP,1250.00,250.00,1500.00`,
    `RG-${run}-2,2026-10-05,Riverside Medical Supplies Ltd,Cottage Care Services,GBP,480.00,96.00,576.00`,
    `RG-${run}-3,2026-10-09,Northgate Physiotherapy LLP,Cottage Care Services,GBP,900.00,180.00,1090.00`,
  ].join("\n");

  // 1. Overview
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await caption(page, "1 / 10", "DocIntel turns invoices in any format into checked, searchable data. Let's upload a mixed batch.", 3500);

  // 2. Upload
  await page.getByTestId("file-input").setInputFiles([
    file("files/pdf_digital-T2-0003.pdf", names.digital, "application/pdf"),
    file("files/image-T1-0003.tiff", names.photo, "image/tiff"),
    file("files/multi_invoice_pdf-mixed-0001.pdf", names.batch, "application/pdf"),
    { name: names.register, mimeType: "text/csv", buffer: Buffer.from(register) },
    { name: names.damaged, mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog"), Buffer.alloc(300, 7)]) },
  ]);
  await expect(page.getByTestId("upload-result")).toContainText(names.batch);
  await caption(page, "2 / 10", "Five files: a digital PDF, a scanned TIFF, a multi-invoice batch PDF, a CSV register and a damaged scan.", 3200);

  // 3. Live progress
  await caption(page, "3 / 10", "Background workers read each file (text layer, or OCR for scans), split batches into invoices, extract fields and validate. Progress updates live.", 4500);
  await page.getByRole("heading", { name: "Recent documents" }).scrollIntoViewIfNeeded();
  await waitForBatch(request, Object.values(names));
  await page.waitForTimeout(1500);
  await caption(page, "3 / 10", "All five finished: four processed, and the damaged file failed cleanly with a reason.", 3000);

  // 4. Documents list and the failed file
  await page.goto("/documents");
  await caption(page, "4 / 10", "Every document with its status, pages, invoices found and processing time.", 3000);
  await page.getByRole("link", { name: names.damaged }).click();
  await expect(page.getByText(/Processing failed/)).toBeVisible();
  await caption(page, "4 / 10", "A corrupt file never breaks the pipeline: it is marked failed with a typed error and a fix-it hint.", 3800);

  // 5. Batch segmentation
  await page.goto("/documents");
  await page.getByRole("link", { name: names.batch }).click();
  await expect(page.getByText("Invoices found")).toBeVisible();
  const listing = await (await request.get(`/api/proxy/documents?q=${encodeURIComponent(names.batch)}`)).json();
  const batchDoc = listing.items?.[0];
  await caption(page, "5 / 10", `The ${batchDoc?.pageCount ?? ""}-page batch PDF was split into ${batchDoc?.invoiceCount ?? "separate"} invoices automatically; each links to its pages.`, 3400);
  const pageButtons = page.getByRole("button", { name: /^Pages? \d/ });
  if ((await pageButtons.count()) > 2) {
    await pageButtons.nth(2).click();
    await page.waitForTimeout(1800);
  }

  // 6. Review the scanned invoice
  await page.goto("/documents");
  await page.getByRole("link", { name: names.photo }).click();
  await page.getByTestId("invoice-link").first().click();
  await expect(page).toHaveURL(/\/invoices\//);
  await caption(page, "6 / 10", "Review: each field shows its confidence, who read it, and the exact evidence. Click a field to see where it was read.", 3800);
  for (const f of ["supplier_name", "invoice_date", "total"]) {
    await page.locator(`#field-${f}`).click();
    await page.waitForTimeout(1600);
  }

  // 7. Correct a value (from the dataset's ground truth) and save
  const truth = await labelFor("image-T1-0003");
  let corrected = false;
  for (const f of ["supplier_name", "customer_name", "invoice_number", "total", "tax", "subtotal"]) {
    const want = truth?.[f];
    if (!want) continue;
    const input = page.locator(`#field-${f}`);
    const current = (await input.inputValue()).trim();
    const same = ["total", "tax", "subtotal"].includes(f) ? Number(current) === Number(want) : current === want;
    if (!same) {
      await input.click();
      await input.fill(want);
      corrected = true;
      break;
    }
  }
  if (!corrected) {
    const input = page.locator("#field-due_date");
    if (!(await input.inputValue())) await input.fill("2026-12-31");
  }
  await caption(page, "7 / 10", "Fix a misread value. The change is audited and validation re-runs as soon as it is saved.", 3000);
  const save = page.getByTestId("save-corrections");
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByText(/Saved\./)).toBeVisible();
    await page.waitForTimeout(1500);
  }

  // 8. Approve (with an override note if blocking errors remain)
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const override = page.getByPlaceholder("Why is it correct as is? (required)");
  if (await override.isVisible({ timeout: 2500 }).catch(() => false)) {
    await override.fill("Checked against the original paper invoice.");
    await page.getByRole("button", { name: "Approve anyway" }).click();
  }
  await expect(page.getByText(/^Approved/).first()).toBeVisible();
  await caption(page, "8 / 10", "Approved. The decision, the reviewer and any note are kept in the invoice history.", 3000);

  // 9. Search: keyword, then semantic
  await page.goto("/search");
  await page.getByLabel("Search query").fill("home nursing visit");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("search-results")).toBeVisible();
  await caption(page, "9 / 10", "Hybrid search ranks exact keyword hits and meaning-based matches together, across fields and page text.", 3500);
  await page.getByLabel("Search query").fill("wheelchair hire");
  await page.getByRole("radio", { name: "Semantic" }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("search-results")).toBeVisible();
  await caption(page, "9 / 10", "Semantic mode finds 'wheelchair rental' invoices from 'wheelchair hire', with no keyword overlap needed.", 3500);

  // 10. Cross-verify PDF vs Excel
  await page.goto("/reconcile");
  const leftOption = page.locator("#left-doc option", { hasText: "recon-a-left.pdf" }).first();
  const rightOption = page.locator("#right-doc option", { hasText: "recon-a-right.xlsx" }).first();
  await page.selectOption("#left-doc", { value: (await leftOption.getAttribute("value")) ?? "" });
  await page.selectOption("#right-doc", { value: (await rightOption.getAttribute("value")) ?? "" });
  await caption(page, "10 / 10", "Cross-verify: compare a batch of invoice PDFs with the accounts-payable register exported from Excel.", 2800);
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.getByTestId("reconciliation-result")).toBeVisible();
  await caption(page, "10 / 10", "Matched, mismatched amounts or names, and invoices missing on either side, field by field.", 4000);
  await page.getByRole("tab", { name: /Mismatched/ }).click();
  await page.waitForTimeout(2200);

  await page.goto("/");
  await caption(page, "Done", "Upload, read, extract, validate, review, search and cross-verify. Every step is also available through the REST API.", 4500);
});
