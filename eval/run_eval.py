"""End-to-end evaluation of DocIntel through its public REST API.

Uploads the labeled dataset exactly like a client would, waits for the background pipeline,
pulls the extracted invoices and scores them against ground truth:

  * document success / failure rate and graceful handling of corrupted files
  * field-level accuracy (overall, per field, per category, per degradation level, dev vs held-out)
  * hallucination rate: a value returned where the document does not print one
  * line items precision / recall / F1
  * validation: recall of injected anomalies (total mismatch, duplicates, missing fields, ...)
  * review routing safety: wrong values that were NOT flagged for manual review
  * search recall@k (keyword / semantic / hybrid), cross-verification accuracy
  * processing time (server-side per document, pages/s) and batch throughput

Usage (from eval/):
  uv run python run_eval.py --label rules-only --reset
  uv run python run_eval.py --label hybrid-cascade --reset
"""
from __future__ import annotations

import argparse
import json
import random
import re
import statistics
import subprocess
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent
FIELDS = ["invoice_number", "invoice_date", "due_date", "supplier_name", "customer_name", "currency", "subtotal", "tax", "total"]
AMOUNT_FIELDS = {"subtotal", "tax", "total", "discount", "shipping"}
ANOMALY_CODES = {
    "total_mismatch": ("TOTAL_MISMATCH", None),
    "line_sum_mismatch": ("LINE_ITEMS_MISMATCH", None),
    "missing_invoice_number": ("MISSING_FIELD", "invoice_number"),
    "missing_date": ("MISSING_FIELD", "invoice_date"),
    "missing_tax": ("MISSING_FIELD", "tax"),
    "duplicate_invoice": ("DUPLICATE_INVOICE", None),
    "negative_amount": ("NEGATIVE_AMOUNT", None),
    "future_date": ("DATE_IN_FUTURE", None),
}


# ----------------------------------------------------------------------------- helpers

def norm_text(s):
    return re.sub(r"\s+", " ", str(s)).strip().lower() if s is not None else None


def norm_number(s):
    return re.sub(r"[^A-Z0-9]", "", str(s).upper()) if s else None


def dec(s):
    try:
        return Decimal(str(s))
    except (InvalidOperation, TypeError):
        return None


def same(field, pred, gt):
    if gt is None or pred is None:
        return gt is None and pred is None
    if field in AMOUNT_FIELDS:
        a, b = dec(pred), dec(gt)
        return a is not None and b is not None and abs(a - b) < Decimal("0.005")
    if field == "invoice_number":
        return norm_number(pred) == norm_number(gt)
    return norm_text(pred) == norm_text(gt)


def pct(n, d):
    return round(100.0 * n / d, 1) if d else None


def percentile(values, q):
    if not values:
        return None
    values = sorted(values)
    k = (len(values) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return round(values[lo] + (values[hi] - values[lo]) * (k - lo), 1)


class Api:
    def __init__(self, base, key):
        self.base = base.rstrip("/")
        self.client = httpx.Client(timeout=600, headers={"X-API-Key": key})

    def _send(self, method, path, **kw):
        for attempt in range(8):
            r = self.client.request(method, f"{self.base}/api/v1{path}", **kw)
            if r.status_code != 429:
                r.raise_for_status()
                return r.json()
            time.sleep(float(r.headers.get("retry-after", 2 ** attempt)))  # be a polite client
        r.raise_for_status()

    def get(self, path, **params):
        return self._send("GET", path, params=params)

    def post(self, path, **kw):
        return self._send("POST", path, **kw)

    def health(self):
        return self.client.get(f"{self.base}/health").json()


def reset_database(db):
    sql = "TRUNCATE reconciliations, documents RESTART IDENTITY CASCADE;"
    subprocess.run(
        ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "docintel", "-d", db, "-c", sql],
        cwd=ROOT.parent, check=True, capture_output=True,
    )


def upload(api, data_dir, docs, purpose="invoices", batch=8):
    """Upload in multipart batches; returns doc_id -> API document (or rejection)."""
    mapping = {}
    for i in range(0, len(docs), batch):
        chunk = docs[i:i + batch]
        files = [("files", (Path(d["file"]).name, (data_dir / d["file"]).read_bytes())) for d in chunk]
        params = {"purpose": purpose}
        if purpose == "reference":
            params["allowDuplicates"] = "true"
        res = api.post("/documents", files=files, params=params)
        by_name = {x["filename"]: x for x in res["documents"]}
        rejected = {x["filename"]: x for x in res["rejected"]}
        for d in chunk:
            name = Path(d["file"]).name
            mapping[d["doc_id"]] = by_name.get(name) or {"rejected": rejected.get(name, {"code": "unknown"})}
    return mapping


def wait_for(api, ids, timeout_s, label=""):
    pending = set(ids)
    started = time.time()
    last = -1
    while pending and time.time() - started < timeout_s:
        page = 1
        while True:  # one list call per poll instead of one status call per document
            res = api.get("/documents", page=page, pageSize=200)
            for d in res["items"]:
                if d["id"] in pending and d["status"] in ("completed", "failed", "duplicate"):
                    pending.discard(d["id"])
            if page * 200 >= res["total"]:
                break
            page += 1
        if len(pending) != last:
            print(f"  [{label}] waiting: {len(pending)} document(s) still processing ({int(time.time() - started)}s)", flush=True)
            last = len(pending)
        if pending:
            time.sleep(3)
    return time.time() - started, pending


def fetch_invoices(api, doc_id):
    listing = api.get("/invoices", documentId=doc_id, pageSize=500, sort="created_at", order="asc")
    return [api.get(f"/invoices/{row['id']}") for row in listing["items"]]


def match_invoices(gt_list, pred_list):
    """Pair ground-truth with extracted invoices: invoice number first, then best field overlap."""
    pairs, used = [], set()
    for g in gt_list:
        best, best_score = None, -1
        for k, p in enumerate(pred_list):
            if k in used:
                continue
            if g.get("invoice_number") and norm_number(p.get("invoice_number")) == norm_number(g["invoice_number"]):
                best, best_score = k, 100
                break
            score = sum(same(f, p.get(f), g.get(f)) for f in ("total", "invoice_date", "supplier_name", "subtotal") if g.get(f))
            if score > best_score:
                best, best_score = k, score
        if best is not None and (best_score >= 2 or len(gt_list) == 1 or best_score == 100):
            used.add(best)
            pairs.append((g, pred_list[best]))
        else:
            pairs.append((g, None))
    extra = [p for k, p in enumerate(pred_list) if k not in used]
    return pairs, extra


# ----------------------------------------------------------------------------- scoring

class Scores:
    def __init__(self):
        self.field = defaultdict(lambda: [0, 0])  # (group, field) -> [ok, n]
        self.null_ok = [0, 0]  # GT null fields: system abstained
        self.items = {"tp": 0, "gt": 0, "pred": 0, "desc_ok": 0}
        self.anomaly = defaultdict(lambda: [0, 0])
        self.false_alarm = [0, 0]  # clean invoices with an error-severity issue
        self.review = {"wrong_and_flagged": 0, "wrong_unflagged": 0, "right_flagged": 0, "right_unflagged": 0}
        self.invoices = {"gt": 0, "pred": 0, "matched": 0}
        self.unflagged_errors = []  # wrong values that were auto-accepted (safety audit)

    def add_field(self, groups, field, ok):
        for g in groups:
            self.field[(g, field)][1] += 1
            self.field[(g, field)][0] += int(ok)
            self.field[(g, "ALL")][1] += 1
            self.field[(g, "ALL")][0] += int(ok)


def score_invoice(scores, label, gt, pred, groups):
    wrong = False
    wrong_fields = []
    for f in FIELDS:
        p = pred.get(f) if pred else None
        ok = same(f, p, gt.get(f))
        scores.add_field(groups, f, ok)
        if gt.get(f) is None:
            scores.null_ok[1] += 1
            scores.null_ok[0] += int(p is None)
        wrong |= not ok
        if not ok:
            wrong_fields.append({"field": f, "predicted": p, "expected": gt.get(f)})
    gi = gt.get("line_items") or []
    pi = (pred or {}).get("lineItems") or []
    scores.items["gt"] += len(gi)
    scores.items["pred"] += len(pi)
    used = set()
    for g in gi:
        for k, p in enumerate(pi):
            if k not in used and p.get("amount") is not None and same("total", p["amount"], g["amount"]):
                used.add(k)
                scores.items["tp"] += 1
                if SequenceMatcher(None, norm_text(p.get("description") or ""), norm_text(g.get("description") or "")).ratio() >= 0.9:
                    scores.items["desc_ok"] += 1
                break
    issues = (pred or {}).get("issues") or []
    codes = {(i["code"], i.get("field")) for i in issues}
    for anomaly in gt.get("anomalies") or []:
        if anomaly not in ANOMALY_CODES:
            continue
        code, field = ANOMALY_CODES[anomaly]
        found = any(c == code and (field is None or f == field) for c, f in codes)
        scores.anomaly[anomaly][1] += 1
        scores.anomaly[anomaly][0] += int(found)
    if not gt.get("anomalies") and pred:
        scores.false_alarm[1] += 1
        scores.false_alarm[0] += int(any(i["severity"] == "error" for i in issues))
    if pred:
        flagged = pred.get("status") == "needs_review"
        key = ("wrong" if wrong else "right") + ("_and_flagged" if flagged and wrong else "_flagged" if flagged else "_unflagged")
        scores.review[key] += 1
        if wrong and not flagged:
            scores.unflagged_errors.append({"doc_id": label["doc_id"], "invoice_number": gt.get("invoice_number"), "fields": wrong_fields,
                                            "method": pred.get("extraction_method"), "confidence": pred.get("confidence")})
    else:
        scores.review["wrong_and_flagged" if False else "wrong_unflagged"] += 0


def measure_latency(api, data_dir, labels, per_category=3, timeout=900):
    """Idle-system time-to-result: upload one document at a time and wait for it (no queueing)."""
    out = defaultdict(list)
    for cat in ("pdf_digital", "pdf_scanned", "image", "multi_invoice_pdf", "xlsx", "xls", "csv"):
        for label in [l for l in labels if l["category"] == cat and not l["expect_failure"]][:per_category]:
            t0 = time.time()
            doc = upload(api, data_dir, [label], purpose="reference")[label["doc_id"]]
            if "id" not in doc:
                continue
            # allowDuplicates is needed because the same bytes were uploaded by the batch run
            wait_for(api, [doc["id"]], timeout, label=f"latency {cat}")
            d = api.get(f"/documents/{doc['id']}")
            out[cat].append({"seconds": round(time.time() - t0, 2), "pages": d.get("pageCount"), "server_ms": d.get("processingMs")})
    return {cat: {"samples": v, "mean_s": round(statistics.mean(x["seconds"] for x in v), 2), "max_s": max(x["seconds"] for x in v)} for cat, v in out.items() if v}


def evaluate_search(api, labels, mapping, k=5, n=40, seed=7):
    """Recall@k for keyword (invoice number / supplier) and semantic (paraphrase) queries."""
    rng = random.Random(seed)
    pool = [(d, inv) for d in labels if not d["expect_failure"] for inv in d["invoices"] if inv.get("invoice_number") and inv.get("supplier_name") and inv.get("line_items")]
    sample = rng.sample(pool, min(n, len(pool)))
    results = {}
    for mode in ("keyword", "semantic", "hybrid"):
        hits_number = hits_desc = 0
        for _, inv in sample:
            target = norm_number(inv["invoice_number"])
            q1 = inv["invoice_number"] if mode != "semantic" else f"invoice {inv['invoice_number']}"
            r1 = api.get("/search", q=q1, mode=mode, limit=k)
            hits_number += any(norm_number(x["invoice"]["invoice_number"]) == target for x in r1["results"])
            desc = inv["line_items"][0]["description"]
            q2 = f"{desc} billed by {inv['supplier_name']}"
            r2 = api.get("/search", q=q2, mode=mode, limit=k)
            hits_desc += any(norm_number(x["invoice"]["invoice_number"]) == target for x in r2["results"])
        results[mode] = {"invoice_number_recall_at_k": pct(hits_number, len(sample)), "description_supplier_recall_at_k": pct(hits_desc, len(sample)), "queries": 2 * len(sample), "k": k}
    return results


def evaluate_reconciliation(api, data_dir, timeout):
    path = data_dir / "reconciliation" / "reconciliation_labels.json"
    if not path.exists():
        return None
    pairs = json.loads(path.read_text())
    out = []
    for pair in pairs:
        left = upload(api, data_dir, [pair["left"]], purpose="invoices")[pair["left"]["doc_id"]]
        right = upload(api, data_dir, [pair["right"]], purpose="reference")[pair["right"]["doc_id"]]
        wait_for(api, [left["id"], right["id"]], timeout, label=pair["pair_id"])
        rec = api.post("/reconciliations", json={"leftDocumentId": left["id"], "rightDocumentId": right["id"]})
        exp = pair["expected"]
        exp_mismatch = {norm_number(m["invoice_number"]): {d["field"] for d in m["discrepancies"]} for m in exp["matched"] if m["status"] == "mismatch"}
        exp_match = {norm_number(m["invoice_number"]) for m in exp["matched"] if m["status"] != "mismatch"}
        got_mismatch, got_match, got_missing_r, got_missing_l = {}, set(), set(), set()
        for item in rec["items"]:
            num = norm_number((item["left"] or item["right"] or {}).get("invoice_number"))
            if item["status"] == "mismatch":
                got_mismatch[num] = {d["field"] for d in item["discrepancies"]}
            elif item["status"] == "matched":
                got_match.add(num)
            elif item["status"] == "missing_in_right":
                got_missing_r.add(num)
            else:
                got_missing_l.add(num)
        detected = sum(1 for n, fields in exp_mismatch.items() if n in got_mismatch)
        false_mismatch = sum(1 for n in got_mismatch if n not in exp_mismatch)
        out.append({
            "pair": pair["pair_id"], "kind": pair["kind"], "summary": rec["summary"],
            "expected_mismatches": len(exp_mismatch), "mismatches_detected": detected,
            "false_mismatches": false_mismatch, "expected_matches": len(exp_match), "matches_confirmed": len(exp_match & got_match),
            "expected_missing_in_right": len(exp["unmatched_left"]), "missing_in_right_found": len({norm_number(x) for x in exp["unmatched_left"]} & got_missing_r),
            "expected_missing_in_left": len(exp["unmatched_right"]), "missing_in_left_found": len({norm_number(x) for x in exp["unmatched_right"]} & got_missing_l),
        })
    return out


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:4100")
    ap.add_argument("--key", default="dev-admin-key-change-me")
    ap.add_argument("--data", default="data")
    ap.add_argument("--label", required=True, help="run name, e.g. rules-only / hybrid-cascade")
    ap.add_argument("--reset", action="store_true", help="TRUNCATE the database first (local docker compose only)")
    ap.add_argument("--db", default="docintel_eval", help="database name used by --reset")
    ap.add_argument("--timeout", type=int, default=3600)
    ap.add_argument("--skip-search", action="store_true")
    ap.add_argument("--skip-recon", action="store_true")
    ap.add_argument("--latency-sample", type=int, default=3, help="documents per category for idle latency (0 = skip)")
    args = ap.parse_args()

    data_dir = (ROOT / args.data).resolve()
    labels = [json.loads(line) for line in (data_dir / "labels.jsonl").read_text().splitlines() if line.strip()]
    api = Api(args.api, args.key)
    health = api.health()
    print(f"API health: {health['status']} | LLM: {health['llm']}")
    if args.reset:
        reset_database(args.db)
        print("database reset")

    t0 = time.time()
    mapping = upload(api, data_dir, labels)
    upload_s = time.time() - t0
    ids = [m["id"] for m in mapping.values() if "id" in m]
    print(f"uploaded {len(ids)} documents in {upload_s:.1f}s ({len(labels) - len(ids)} rejected at upload)")
    elapsed, pending = wait_for(api, ids, args.timeout, label="dataset")
    wall_s = time.time() - t0

    docs = {doc_id: api.get(f"/documents/{m['id']}") if "id" in m else m for doc_id, m in mapping.items()}
    with ThreadPoolExecutor(8) as ex:
        invoices = dict(zip(docs.keys(), ex.map(lambda d: fetch_invoices(api, d["id"]) if d.get("status") == "completed" else [], docs.values())))

    scores = Scores()
    by_cat = defaultdict(lambda: {"docs": 0, "completed": 0, "failed": 0, "rejected": 0, "ms": [], "pages": 0, "invoices_gt": 0, "invoices_pred": 0})
    corrupted = {"total": 0, "handled": 0, "expected_code": 0, "details": []}
    for label in labels:
        doc = docs[label["doc_id"]]
        cat = label["category"]
        c = by_cat[cat]
        c["docs"] += 1
        status = doc.get("status", "rejected")
        if "rejected" in doc:
            c["rejected"] += 1
        elif status == "completed":
            c["completed"] += 1
            if doc.get("processingMs"):
                c["ms"].append(doc["processingMs"])
            c["pages"] += doc.get("pageCount") or 0
        elif status == "failed":
            c["failed"] += 1
        if label["expect_failure"]:
            corrupted["total"] += 1
            code = doc.get("errorCode") or (doc.get("rejected") or {}).get("code")
            handled = status in ("failed",) or "rejected" in doc
            corrupted["handled"] += int(handled)
            corrupted["expected_code"] += int(code == label.get("expected_error"))
            corrupted["details"].append({"file": label["file"], "expected": label.get("expected_error"), "got_status": status, "got_code": code})
            continue
        preds = invoices.get(label["doc_id"], [])
        pairs, extra = match_invoices(label["invoices"], preds)
        scores.invoices["gt"] += len(label["invoices"])
        scores.invoices["pred"] += len(preds)
        c["invoices_gt"] += len(label["invoices"])
        c["invoices_pred"] += len(preds)
        level = (label.get("degradation") or {}).get("level") or ("digital" if label["file_type"] == "pdf" else "native")
        for gt, pred in pairs:
            scores.invoices["matched"] += int(pred is not None)
            groups = ["overall", f"category:{cat}", f"split:{label['split']}", f"quality:{level}"]
            score_invoice(scores, label, gt, pred, groups)

    valid_docs = [l for l in labels if not l["expect_failure"]]
    completed = sum(1 for l in valid_docs if docs[l["doc_id"]].get("status") == "completed")
    failed = sum(1 for l in valid_docs if docs[l["doc_id"]].get("status") == "failed")
    all_ms = [ms for c in by_cat.values() for ms in c["ms"]]
    stats = api.get("/stats")
    field_table = defaultdict(dict)
    for (group, field), (ok, n) in scores.field.items():
        field_table[group][field] = {"accuracy": pct(ok, n), "n": n}
    rv = scores.review
    result = {
        "run": args.label,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "llm": health["llm"],
        "dataset": {"documents": len(labels), "invoices": sum(len(l["invoices"]) for l in valid_docs), "corrupted": corrupted["total"]},
        "documents": {
            "success_rate": pct(completed, len(valid_docs)),
            "failure_rate": pct(failed, len(valid_docs)),
            "completed": completed, "failed": failed, "still_pending": len(pending),
            "corrupted_handled_gracefully": pct(corrupted["handled"], corrupted["total"]),
            "corrupted_expected_error_code": pct(corrupted["expected_code"], corrupted["total"]),
            "corrupted_details": corrupted["details"],
        },
        "invoice_detection": {**scores.invoices, "recall": pct(scores.invoices["matched"], scores.invoices["gt"])},
        "fields": field_table,
        "abstention": {"gt_null_fields": scores.null_ok[1], "correctly_left_empty": pct(scores.null_ok[0], scores.null_ok[1]), "hallucination_rate": pct(scores.null_ok[1] - scores.null_ok[0], scores.null_ok[1])},
        "line_items": {
            "precision": pct(scores.items["tp"], scores.items["pred"]), "recall": pct(scores.items["tp"], scores.items["gt"]),
            "f1": round(200 * scores.items["tp"] / max(1, scores.items["pred"] + scores.items["gt"]), 1),
            "description_exact_among_matched": pct(scores.items["desc_ok"], scores.items["tp"]), **scores.items,
        },
        "validation": {
            "anomaly_recall": {k: {"detected": v[0], "total": v[1], "recall": pct(v[0], v[1])} for k, v in scores.anomaly.items()},
            "anomaly_recall_overall": pct(sum(v[0] for v in scores.anomaly.values()), sum(v[1] for v in scores.anomaly.values())),
            "false_error_rate_on_clean_invoices": pct(scores.false_alarm[0], scores.false_alarm[1]),
        },
        "review_routing": {
            **rv,
            "invoices_with_any_wrong_field": rv["wrong_and_flagged"] + rv["wrong_unflagged"],
            "wrong_invoices_caught_by_review": pct(rv["wrong_and_flagged"], rv["wrong_and_flagged"] + rv["wrong_unflagged"]),
            "auto_accepted": rv["right_unflagged"] + rv["wrong_unflagged"],
            "auto_accepted_precision": pct(rv["right_unflagged"], rv["right_unflagged"] + rv["wrong_unflagged"]),
            "review_rate": pct(rv["wrong_and_flagged"] + rv["right_flagged"], sum(rv.values())),
            "unflagged_errors": scores.unflagged_errors,
        },
        "timing": {
            "upload_s": round(upload_s, 1), "batch_wall_clock_s": round(wall_s, 1),
            "throughput_docs_per_min": round(60 * len(ids) / wall_s, 1) if wall_s else None,
            "per_document_ms_under_burst": {"p50": percentile(all_ms, 0.5), "p95": percentile(all_ms, 0.95), "mean": round(statistics.mean(all_ms), 1) if all_ms else None, "note": "upload-to-result while the whole dataset was queued at once (includes queue wait)"},
            "by_category": {k: {"docs": v["docs"], "completed": v["completed"], "failed": v["failed"], "rejected": v["rejected"], "p50_ms": percentile(v["ms"], 0.5), "p95_ms": percentile(v["ms"], 0.95), "pages": v["pages"], "invoices_gt": v["invoices_gt"], "invoices_pred": v["invoices_pred"]} for k, v in sorted(by_cat.items())},
        },
        "llm_usage": stats.get("llm"),
    }
    if not args.skip_search:
        print("evaluating search ...")
        time.sleep(5)  # let the async semantic indexer finish the last documents
        result["search"] = evaluate_search(api, labels, mapping)
    if not args.skip_recon:
        print("evaluating cross-verification ...")
        result["reconciliation"] = evaluate_reconciliation(api, data_dir, args.timeout)
    if args.latency_sample:
        print("measuring idle latency per document type ...")
        result["latency_idle"] = measure_latency(api, data_dir, labels, args.latency_sample, args.timeout)

    out_dir = ROOT / "results"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"{args.label}.json"
    out.write_text(json.dumps(result, indent=2, default=str))
    o = field_table["overall"]
    print(f"\n== {args.label} ==")
    print(f"documents: success {result['documents']['success_rate']}%  failure {result['documents']['failure_rate']}%  corrupted handled {result['documents']['corrupted_handled_gracefully']}%")
    print(f"invoices: detected {result['invoice_detection']['recall']}%  | fields overall {o['ALL']['accuracy']}%  | hallucination {result['abstention']['hallucination_rate']}%")
    print("  " + "  ".join(f"{f}={o[f]['accuracy']}" for f in FIELDS))
    print(f"line items F1 {result['line_items']['f1']}%  | anomaly recall {result['validation']['anomaly_recall_overall']}%  | wrong caught by review {result['review_routing']['wrong_invoices_caught_by_review']}%")
    print(f"timing (burst): p50 {result['timing']['per_document_ms_under_burst']['p50']} ms  p95 {result['timing']['per_document_ms_under_burst']['p95']} ms  throughput {result['timing']['throughput_docs_per_min']} docs/min")
    if result.get("latency_idle"):
        print("idle latency: " + "  ".join(f"{k}={v['mean_s']}s" for k, v in result["latency_idle"].items()))
    print(f"saved {out}")


if __name__ == "__main__":
    main()
