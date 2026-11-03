"""Render docs/EVALUATION.md from eval/results/*.json (measured runs only)."""
from __future__ import annotations

import json
import platform
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
OUT = ROOT.parent / "docs" / "EVALUATION.md"
FIELDS = ["invoice_number", "invoice_date", "due_date", "supplier_name", "customer_name", "currency", "subtotal", "tax", "total"]
ORDER = ["rules-only", "hybrid-cascade", "hybrid-always"]
TITLES = {"rules-only": "Rules only (no LLM)", "hybrid-cascade": "Hybrid, cascade (default)", "hybrid-always": "Hybrid, LLM on every invoice"}


def load():
    runs = {}
    for p in sorted(RESULTS.glob("*.json")):
        runs[p.stem] = json.loads(p.read_text())
    return runs


def v(x, suffix="%"):
    return "–" if x is None else f"{x}{suffix}"


def acc(run, group, field="ALL"):
    return run["fields"].get(group, {}).get(field, {}).get("accuracy")


def machine():
    try:
        cpu = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
        mem = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip()) // 2**30
        dock = subprocess.run(["docker", "info", "--format", "{{.NCPU}} CPUs / {{.MemTotal}}"], capture_output=True, text=True).stdout.strip()
        return f"{cpu}, {mem} GB RAM ({platform.system()}); Docker VM: {dock} bytes"
    except Exception:
        return platform.platform()


def main():
    runs = load()
    modes = [m for m in ORDER if m in runs]
    perf = runs.get("perf")
    lines = []
    w = lines.append
    first = runs[modes[0]]
    w("# Evaluation report")
    w("")
    w("All numbers come from running the full system end to end through its REST API:")
    w("upload, background pipeline (queue, OCR/parsing, extraction, validation), then reading back the results.")
    w("The runner is [`eval/run_eval.py`](../eval/run_eval.py); raw results are in [`eval/results/`](../eval/results/).")
    w("Regenerate this file with `cd eval && uv run python make_report.py`.")
    w("")
    w("## Dataset")
    w("")
    d = first["dataset"]
    w(f"- **{d['documents']} documents** containing **{d['invoices']} labelled invoices**, generated with seed 42 by [`eval/generate_dataset.py`](../eval/generate_dataset.py) ([README](../eval/README.md)).")
    w("- Formats: digital PDFs, scanned PDFs, JPG/PNG/TIFF photos and scans (4 quality levels: clean, light, medium and heavy, including 90°/180° rotations and 120–150 DPI scans), multi-invoice batch PDFs, XLSX, XLS and CSV files (registers, invoice forms, multi-sheet workbooks, line-level CSV, EU number formats, cp1252 encoding), and corrupted files.")
    w("- **8 invoice templates.** T1–T6 were used during development (\"dev\"). **T7–T8 are held out**: the extraction rules were never tuned on them, so they measure generalisation to unseen layouts.")
    w("- **Ground truth is what is printed.** Fields that are not printed are `null`, which is how the hallucination rate is measured. 60 invoices carry injected anomalies (wrong totals, line sums that don't match, missing fields, duplicates, negative amounts, future dates) to test validation.")
    w("- **The dataset is synthetic** (company names from Faker). It is varied, but not a substitute for real customer documents; see the caveats below.")
    w("")
    w("## Headline results")
    w("")
    head = "| Metric | " + " | ".join(TITLES[m] for m in modes) + " |"
    w(head)
    w("|---|" + "---|" * len(modes))

    def row(name, fn, suffix="%"):
        w(f"| {name} | " + " | ".join(v(fn(runs[m]), suffix) for m in modes) + " |")

    row("Document success rate (valid files processed)", lambda r: r["documents"]["success_rate"])
    row("Document failure rate (system failures)", lambda r: r["documents"]["failure_rate"])
    row("Corrupted files handled gracefully (typed error, no crash)", lambda r: r["documents"]["corrupted_handled_gracefully"])
    row("Invoices detected (incl. splitting batch PDFs)", lambda r: r["invoice_detection"]["recall"])
    row("**Field accuracy, all fields**", lambda r: acc(r, "overall"))
    row("Field accuracy, dev templates", lambda r: acc(r, "split:dev"))
    row("Field accuracy, held-out templates", lambda r: acc(r, "split:heldout"))
    row("Hallucination rate (value returned where none is printed)", lambda r: r["abstention"]["hallucination_rate"])
    row("Line items F1", lambda r: r["line_items"]["f1"])
    row("Injected anomalies detected by validation", lambda r: r["validation"]["anomaly_recall_overall"])
    row("Invoices with a wrong field that were flagged for review", lambda r: r["review_routing"]["wrong_invoices_caught_by_review"])
    row("Auto-accepted invoices that were fully correct", lambda r: r["review_routing"]["auto_accepted_precision"])
    row("Share of invoices routed to manual review", lambda r: r["review_routing"]["review_rate"])
    row("LLM calls", lambda r: (r.get("llm_usage") or {}).get("calls"), "")
    row("LLM tokens in / out", lambda r: f"{(r.get('llm_usage') or {}).get('input_tokens', 0):,} / {(r.get('llm_usage') or {}).get('output_tokens', 0):,}", "")
    row("Batch throughput (whole dataset uploaded at once)", lambda r: r["timing"]["throughput_docs_per_min"], " docs/min")
    w("")
    w("> **How to read this.** Accuracy is exact match after normalisation: amounts within half a cent, ISO dates, ISO currency codes, invoice numbers ignoring punctuation and case, names ignoring case and spacing. A field the system leaves empty because it is unsure counts as wrong. The review-routing rows measure safety: an invoice that still contains a wrong value should never be auto-accepted.")
    w("")

    w("## Field accuracy by field")
    w("")
    w("| Field | " + " | ".join(TITLES[m] for m in modes) + " |")
    w("|---|" + "---|" * len(modes))
    for f in FIELDS:
        w(f"| `{f}` | " + " | ".join(v(acc(runs[m], "overall", f)) for m in modes) + " |")
    w("")

    w("## Accuracy by document type and scan quality")
    w("")
    groups = [("category:pdf_digital", "Digital PDF"), ("category:multi_invoice_pdf", "Multi-invoice batch PDF"), ("category:pdf_scanned", "Scanned PDF"), ("category:image", "Image (JPG/PNG/TIFF)"),
              ("category:xlsx", "Excel XLSX"), ("category:xls", "Excel XLS"), ("category:csv", "CSV"),
              ("quality:clean", "Scan quality: clean"), ("quality:light", "Scan quality: light"), ("quality:medium", "Scan quality: medium"), ("quality:heavy", "Scan quality: heavy")]
    w("| Group | " + " | ".join(TITLES[m] for m in modes) + " |")
    w("|---|" + "---|" * len(modes))
    for g, name in groups:
        w(f"| {name} | " + " | ".join(v(acc(runs[m], g)) for m in modes) + " |")
    w("")
    w("Heavy scans are deliberately extreme: 120–150 DPI, strong blur and grain, JPEG quality around 45, and some rotated 90° or 180°.")
    w("")

    w("## Validation: injected anomalies detected")
    w("")
    kinds = sorted({k for m in modes for k in runs[m]["validation"]["anomaly_recall"]})
    w("| Anomaly | " + " | ".join(TITLES[m] for m in modes) + " |")
    w("|---|" + "---|" * len(modes))
    for k in kinds:
        cells = []
        for m in modes:
            a = runs[m]["validation"]["anomaly_recall"].get(k)
            cells.append(f"{a['detected']}/{a['total']} ({a['recall']}%)" if a else "–")
        w(f"| `{k}` | " + " | ".join(cells) + " |")
    w("| Error raised on an invoice with no injected anomaly (usually an extraction miss) | " + " | ".join(v(runs[m]["validation"]["false_error_rate_on_clean_invoices"]) for m in modes) + " |")
    w("")
    w("A duplicate is detected when the later copy is flagged `DUPLICATE_INVOICE`. When extraction misses a field, the invoice is still routed to review (`MISSING_FIELD`, `LOW_CONFIDENCE`), even where the specific anomaly code is not raised.")
    w("")

    w("## Review routing (human-in-the-loop safety)")
    w("")
    w("| | " + " | ".join(TITLES[m] for m in modes) + " |")
    w("|---|" + "---|" * len(modes))
    for key, name in [("wrong_and_flagged", "Wrong field and flagged for review"), ("wrong_unflagged", "**Wrong field but auto-accepted**"), ("right_flagged", "Correct but flagged (extra review work)"), ("right_unflagged", "Correct and auto-accepted")]:
        w(f"| {name} | " + " | ".join(str(runs[m]["review_routing"][key]) for m in modes) + " |")
    w("")

    w("## Search quality (recall@5)")
    w("")
    w("40 labelled invoices are sampled; each is queried by its invoice number, and by a natural-language description: \"<first line item> billed by <supplier>\".")
    w("")
    w("| Mode | Query | " + " | ".join(TITLES[m] for m in modes) + " |")
    w("|---|---|" + "---|" * len(modes))
    for mode in ("keyword", "semantic", "hybrid"):
        for key, qname in [("invoice_number_recall_at_k", "invoice number"), ("description_supplier_recall_at_k", "description + supplier")]:
            w(f"| {mode} | {qname} | " + " | ".join(v((runs[m].get("search") or {}).get(mode, {}).get(key)) for m in modes) + " |")
    w("")
    w("Keyword search uses PostgreSQL full-text search, which requires every word to match, so it is precise for identifiers but cannot answer a paraphrase. Semantic search (local bge-small embeddings) handles paraphrases but not identifiers. Hybrid search (reciprocal-rank fusion) gets both. Recall is also capped by extraction: an invoice whose number was not read cannot be found by that number.")
    w("")

    w("## Cross-verification (PDF vs Excel, PDF vs PDF)")
    w("")
    w("| Pair | Mode | Mismatches found | False mismatches | Matches confirmed | Missing in register found | Extra in register found |")
    w("|---|---|---|---|---|---|---|")
    for m in modes:
        for p in runs[m].get("reconciliation") or []:
            w(f"| {p['pair']} ({p['kind']}) | {TITLES[m]} | {p['mismatches_detected']}/{p['expected_mismatches']} | {p['false_mismatches']} | {p['matches_confirmed']}/{p['expected_matches']} | {p['missing_in_right_found']}/{p['expected_missing_in_right']} | {p['missing_in_left_found']}/{p['expected_missing_in_left']} |")
    w("")

    w("## Processing time")
    w("")
    w("**Idle latency.** One document at a time on an idle system. Server-side time from upload to stored result (`processing_ms`), shown as mean and maximum over the sampled documents:")
    w("")
    cats = ["pdf_digital", "multi_invoice_pdf", "pdf_scanned", "image", "xlsx", "xls", "csv"]
    w("| Document type | " + " | ".join(TITLES[m] for m in modes) + " |")
    w("|---|" + "---|" * len(modes))
    for c in cats:
        cells = []
        for m in modes:
            lat = (runs[m].get("latency_idle") or {}).get(c)
            if lat:
                ms = [x["server_ms"] for x in lat["samples"] if x.get("server_ms") is not None]
                fmt = lambda x: f"{x / 1000:.1f} s" if x >= 1000 else f"{x:.0f} ms"
                cells.append(f"{fmt(sum(ms) / len(ms))} (max {fmt(max(ms))})" if ms else "–")
            else:
                cells.append("–")
        w(f"| {c} | " + " | ".join(cells) + " |")
    w("")
    w("**Throughput.** The whole dataset was uploaded in one burst:")
    w("")
    for m in modes:
        t = runs[m]["timing"]
        burst = t.get("per_document_ms_under_burst") or t.get("per_document_ms")
        w(f"- {TITLES[m]}: {t['batch_wall_clock_s']} s for the dataset, **{t['throughput_docs_per_min']} documents/min**. Time from upload to result under the burst: p50 {round(burst['p50'] / 1000, 1)} s, p95 {round(burst['p95'] / 1000, 1)} s (includes queue wait).")
    w("")
    if perf:
        pt = perf["timing"]["by_category"].get("perf", {})
        w("### Large batch PDFs (1,000 pages)")
        w("")
        w(f"- Dataset: `eval/generate_dataset.py --profile perf` produces a 1,000-page digital batch PDF and a 100-page scanned batch PDF ({perf['dataset']['invoices']} labelled invoices in total).")
        w(f"- Result: {perf['documents']['completed']}/{perf['documents']['completed'] + perf['documents']['failed']} processed, {perf['invoice_detection']['recall']}% of invoices detected by segmentation, field accuracy {acc(perf, 'overall')}%.")
        for s in perf.get("perf_details", []):
            w(f"- `{s['file']}`: {s['pages']} pages in {s['seconds']} s ({s['pages_per_s']} pages/s), {s['invoices_found']}/{s['invoices_expected']} invoices.")
        w("")
    w(f"Environment: {machine()}. Processor: 4 uvicorn workers (OCR concurrency 6). API and workers: one Node process (`APP_ROLE=all`, page concurrency 4, analyze concurrency 2). LLM: Azure OpenAI `gpt-6-astra` (reasoning effort low, concurrency 4).")
    w("")
    w("## Methodology details")
    w("")
    w("- **Matching.** Extracted invoices are paired with ground-truth invoices by normalised invoice number, or failing that by the best overlap of total, date, supplier and subtotal. A ground-truth invoice with no match scores every field as wrong.")
    w("- **Hallucination rate.** Among fields that are not printed on the document (ground truth `null`), the share where the system still returned a value.")
    w("- **Line items.** A predicted item matches a labelled item when the amounts are equal; each labelled item can be matched once. The report also gives the share of matched items whose description matches (90% or better similarity).")
    w("- **Corrupted files.** \"Handled\" means a clear, typed outcome: rejected at upload (empty or unsupported), or `failed` with a stable `error_code` and no retries. The one recoverable case (a PNG saved as `.jpg`) must succeed.")
    w("- **Isolation.** Each mode runs against a freshly truncated database on a separate API instance (its own queue prefix), so duplicate detection only sees that run's documents.")
    w("- **No tuning on held-out data.** Extraction rules and OCR parameters were tuned on the dev split only, and the held-out templates were never inspected during development.")
    w("")
    w("## Caveats")
    w("")
    w("- Synthetic documents cannot cover the full variety of real invoices: handwriting, stamps over text, folded paper, multi-currency invoices, non-Latin scripts. The held-out score is the best available estimate of performance on unseen layouts.")
    w("- With the LLM involved, results vary slightly from run to run. Rules-only results are deterministic for a given OCR output.")
    w("- Latencies depend on hardware and on LLM endpoint load. `gpt-6-astra` is a reasoning model, at roughly 15–35 s per call here.")
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
