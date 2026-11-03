"""Large-document performance test: the 1,000-page digital batch PDF and the 100-page scanned batch PDF.

Measures time-to-result and pages/second through the real pipeline (page-chunk fan-out across workers),
plus segmentation (invoices found) and field accuracy on the batch. Run against an API in rules-only mode
to measure the document pipeline itself; LLM cost/latency scales with the number of invoices sent to the model.

  uv run python run_perf.py --reset
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from run_eval import Api, ROOT, Scores, fetch_invoices, match_invoices, pct, reset_database, score_invoice, upload, wait_for


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:4100")
    ap.add_argument("--key", default="dev-admin-key-change-me")
    ap.add_argument("--data", default="data-perf")
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--db", default="docintel_eval")
    args = ap.parse_args()
    data_dir = (ROOT / args.data).resolve()
    labels = [json.loads(l) for l in (data_dir / "labels.jsonl").read_text().splitlines() if l.strip()]
    api = Api(args.api, args.key)
    health = api.health()
    print("LLM:", health["llm"])
    if args.reset:
        reset_database(args.db)
    details, scores = [], Scores()
    completed = failed = 0
    for label in labels:  # one at a time: each document gets the whole cluster
        t0 = time.time()
        doc = upload(api, data_dir, [label])[label["doc_id"]]
        elapsed, pending = wait_for(api, [doc["id"]], 7200, label=label["doc_id"])
        d = api.get(f"/documents/{doc['id']}")
        completed += int(d["status"] == "completed")
        failed += int(d["status"] == "failed")
        preds = fetch_invoices(api, doc["id"]) if d["status"] == "completed" else []
        pairs, _ = match_invoices(label["invoices"], preds)
        for gt, pred in pairs:
            scores.invoices["matched"] += int(pred is not None)
            score_invoice(scores, label, gt, pred, ["overall"])
        scores.invoices["gt"] += len(label["invoices"])
        scores.invoices["pred"] += len(preds)
        seconds = round(time.time() - t0, 1)
        details.append({"file": Path(label["file"]).name, "pages": d.get("pageCount"), "ocr_pages": d.get("ocrPages"), "seconds": seconds,
                        "pages_per_s": round((d.get("pageCount") or 0) / seconds, 2), "invoices_expected": len(label["invoices"]), "invoices_found": len(preds),
                        "server_ms": d.get("processingMs")})
        print(details[-1], flush=True)
    fields = {}
    for (group, field), (ok, n) in scores.field.items():
        fields.setdefault(group, {})[field] = {"accuracy": pct(ok, n), "n": n}
    result = {
        "run": "perf", "llm": health["llm"], "dataset": {"documents": len(labels), "invoices": sum(len(l["invoices"]) for l in labels)},
        "documents": {"completed": completed, "failed": failed},
        "invoice_detection": {**scores.invoices, "recall": pct(scores.invoices["matched"], scores.invoices["gt"])},
        "fields": fields, "line_items": scores.items, "timing": {"by_category": {"perf": {}}}, "perf_details": details,
    }
    (ROOT / "results" / "perf.json").write_text(json.dumps(result, indent=2))
    print("saved results/perf.json", result["invoice_detection"], fields.get("overall", {}).get("ALL"))


if __name__ == "__main__":
    main()
