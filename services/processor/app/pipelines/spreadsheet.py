"""Spreadsheet pipeline: XLSX (openpyxl), XLS (xlrd) and CSV (pandas) -> normalised cell grids.

Each sheet becomes a grid of JSON-safe cells (str | int | float | None; dates as ISO strings) plus
a plain-text rendering used for full-text search and as LLM context. Mapping columns to invoice
fields happens in the API, which owns all field-extraction logic.
"""
from __future__ import annotations

import csv
import io
import math
import zipfile
from datetime import date, datetime, time

import pandas as pd
from charset_normalizer import from_bytes

from ..config import get_settings
from ..errors import CORRUPTED_FILE, FILE_TOO_LARGE, ProcessingError

Cell = str | int | float | None


def normalise_cell(value) -> Cell:
    if value is None:
        return None
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        if value.is_integer() and abs(value) < 1e15:
            return int(value)
        return value
    if isinstance(value, datetime):
        return value.date().isoformat() if value.time() == time(0, 0) else value.isoformat(timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.isoformat(timespec="seconds")
    text = str(value).replace("\r\n", "\n").strip()
    return text or None


def _trim(rows: list[list[Cell]]) -> list[list[Cell]]:
    """Drop trailing empty cells/rows and fully-empty columns on the right."""
    out = []
    for row in rows:
        while row and (row[-1] is None or row[-1] == ""):
            row = row[:-1]
        out.append(row)
    while out and not out[-1]:
        out.pop()
    return out


def render_sheet_text(name: str, rows: list[list[Cell]]) -> str:
    lines = [f"Sheet: {name}"]
    for index, row in enumerate(rows, start=1):
        if any(c not in (None, "") for c in row):
            lines.append(f"R{index}: " + " | ".join("" if c is None else str(c) for c in row))
    return "\n".join(lines)


def _sheet(name: str, index: int, rows: list[list[Cell]], hidden: bool = False, warnings: list[str] | None = None) -> dict:
    rows = _trim(rows)
    return {
        "name": name,
        "index": index,
        "hidden": hidden,
        "n_rows": len(rows),
        "n_cols": max((len(r) for r in rows), default=0),
        "rows": rows,
        "text": render_sheet_text(name, rows),
        "warnings": warnings or [],
    }


# ---------------------------------------------------------------- XLSX

def _check_zip(path) -> None:
    limit = get_settings().max_xlsx_uncompressed_mb * 1024 * 1024
    try:
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            total = sum(i.file_size for i in infos)
            compressed = sum(i.compress_size for i in infos) or 1
            names = {i.filename for i in infos}
    except zipfile.BadZipFile as exc:
        raise ProcessingError(CORRUPTED_FILE, f"The workbook's ZIP container is damaged ({exc}).") from exc
    if "xl/workbook.xml" not in names:
        raise ProcessingError(CORRUPTED_FILE, "The file is not a valid Excel workbook (xl/workbook.xml missing).")
    if total > limit or total / compressed > 200:
        raise ProcessingError(FILE_TOO_LARGE, "The workbook expands to an unsafe size (possible zip bomb).")


def read_xlsx(path) -> list[dict]:
    import openpyxl

    _check_zip(path)
    max_rows = get_settings().max_sheet_rows
    try:
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    except Exception as exc:
        raise ProcessingError(CORRUPTED_FILE, f"The Excel workbook could not be read ({exc}).") from exc
    sheets = []
    try:
        for index, ws in enumerate(wb.worksheets):
            rows: list[list[Cell]] = []
            warnings: list[str] = []
            for r, values in enumerate(ws.iter_rows(values_only=True), start=1):
                if r > max_rows:
                    warnings.append(f"sheet_truncated: more than {max_rows} rows; remaining rows not processed")
                    break
                rows.append([normalise_cell(v) for v in values])
            hidden = getattr(ws, "sheet_state", "visible") != "visible"
            sheets.append(_sheet(ws.title, index, rows, hidden, warnings))
    finally:
        wb.close()
    return sheets


# ---------------------------------------------------------------- XLS

def read_xls(path) -> list[dict]:
    import xlrd

    max_rows = get_settings().max_sheet_rows
    try:
        book = xlrd.open_workbook(path, on_demand=True)
    except Exception as exc:
        raise ProcessingError(CORRUPTED_FILE, f"The legacy Excel (.xls) file could not be read ({exc}).") from exc
    sheets = []
    try:
        for index in range(book.nsheets):
            sh = book.sheet_by_index(index)
            rows: list[list[Cell]] = []
            warnings: list[str] = []
            for r in range(sh.nrows):
                if r >= max_rows:
                    warnings.append(f"sheet_truncated: more than {max_rows} rows; remaining rows not processed")
                    break
                row: list[Cell] = []
                for c in range(sh.ncols):
                    cell = sh.cell(r, c)
                    if cell.ctype == xlrd.XL_CELL_DATE:
                        try:
                            row.append(normalise_cell(xlrd.xldate.xldate_as_datetime(cell.value, book.datemode)))
                        except Exception:
                            row.append(normalise_cell(cell.value))
                    elif cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK, xlrd.XL_CELL_ERROR):
                        row.append(None)
                    elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                        row.append(normalise_cell(bool(cell.value)))
                    else:
                        row.append(normalise_cell(cell.value))
                rows.append(row)
            hidden = getattr(sh, "visibility", 0) != 0
            sheets.append(_sheet(sh.name, index, rows, hidden, warnings))
            book.unload_sheet(index)
    finally:
        book.release_resources()
    return sheets


# ---------------------------------------------------------------- CSV

def decode_text(raw: bytes) -> tuple[str, str, list[str]]:
    warnings: list[str] = []
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8", errors="replace"), "utf-8-sig", warnings
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", errors="replace"), "utf-16", warnings
    try:
        return raw.decode("utf-8"), "utf-8", warnings
    except UnicodeDecodeError:
        pass
    best = from_bytes(raw[:500_000]).best()
    encoding = best.encoding if best else "cp1252"
    if encoding.lower() in ("ascii", "utf_8"):
        encoding = "cp1252"
    warnings.append(f"encoding_detected: {encoding}")
    return raw.decode(encoding, errors="replace"), encoding, warnings


def sniff_delimiter(sample: str) -> str:
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        counts = {d: sample.count(d) for d in (",", ";", "\t", "|")}
        return max(counts, key=counts.get) if any(counts.values()) else ","


def read_csv(path) -> list[dict]:
    limit = get_settings().max_csv_mb * 1024 * 1024
    raw = path.read_bytes()
    if len(raw) > limit:
        raise ProcessingError(FILE_TOO_LARGE, f"CSV larger than {get_settings().max_csv_mb} MB.")
    if b"\x00" in raw[:8192] and not raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise ProcessingError(CORRUPTED_FILE, "The CSV contains binary data and cannot be parsed as text.")
    text, encoding, warnings = decode_text(raw)
    printable = sum(ch.isprintable() or ch in "\r\n\t" for ch in text[:20000])
    if printable / max(len(text[:20000]), 1) < 0.9:
        raise ProcessingError(CORRUPTED_FILE, "The CSV content is not readable text.")
    delimiter = sniff_delimiter(text[:65536])
    try:
        df = pd.read_csv(
            io.StringIO(text), sep=delimiter, header=None, dtype=str, keep_default_na=False,
            skip_blank_lines=False, engine="python", on_bad_lines="warn",
        )
    except Exception as exc:
        raise ProcessingError(CORRUPTED_FILE, f"The CSV could not be parsed ({exc}).") from exc
    max_rows = get_settings().max_sheet_rows
    if len(df) > max_rows:
        warnings.append(f"sheet_truncated: more than {max_rows} rows; remaining rows not processed")
        df = df.head(max_rows)
    rows = [[normalise_cell(v) for v in record] for record in df.itertuples(index=False, name=None)]
    warnings.append(f"csv_dialect: delimiter={delimiter!r}, encoding={encoding}")
    return [_sheet("CSV", 0, rows, False, warnings)]


def extract_spreadsheet(path, file_type: str) -> dict:
    if file_type == "xlsx":
        sheets = read_xlsx(path)
    elif file_type == "xls":
        sheets = read_xls(path)
    else:
        sheets = read_csv(path)
    if not any(s["n_rows"] for s in sheets):
        warnings = ["empty_workbook: no non-empty cells found"]
    else:
        warnings = []
    return {"page_count": len(sheets), "pages": [], "sheets": sheets, "warnings": warnings}


def inspect_spreadsheet(path, file_type: str) -> dict:
    result = extract_spreadsheet(path, file_type)
    return {
        "page_count": len(result["sheets"]),
        "sheets": [{"name": s["name"], "n_rows": s["n_rows"], "n_cols": s["n_cols"], "hidden": s["hidden"]} for s in result["sheets"]],
        "warnings": result["warnings"],
    }
