#!/usr/bin/env python3
"""Generate the DocIntel synthetic, labeled invoice evaluation dataset.

    uv run python generate_dataset.py --profile standard --out data --seed 42
    uv run python generate_dataset.py --profile fixtures --out ../fixtures
    uv run python generate_dataset.py --profile perf --out data-perf            # 1000-page + 100-page PDFs
    uv run python generate_dataset.py --profile perf --out /tmp/p --perf-pages 12 --perf-scanned-pages 4   # quick check
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", category=FutureWarning)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pymupdf  # noqa: E402

from datagen.build import DatasetBuilder  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", choices=["fixtures", "small", "standard", "perf"], default="standard")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--perf-pages", type=int, default=1000)
    ap.add_argument("--perf-scanned-pages", type=int, default=100)
    ap.add_argument("--clean", action="store_true", help="delete the output directory first (not allowed for fixtures)")
    args = ap.parse_args()

    pymupdf.TOOLS.mupdf_display_errors(False)
    out: Path = args.out
    if args.clean and out.exists() and args.profile != "fixtures":
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)
    started = time.time()
    b = DatasetBuilder(out, args.profile, seed=args.seed, perf_pages=args.perf_pages,
                       perf_scanned_pages=args.perf_scanned_pages)
    b.build()
    manifest = b.finalize(started)
    print(json.dumps({k: manifest[k] for k in ("profile", "documents", "invoices", "invoices_with_anomalies",
                                                "by_category", "anomalies", "total_bytes", "generation_seconds")},
                     indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
