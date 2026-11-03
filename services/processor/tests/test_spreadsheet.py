import io
import zipfile
from datetime import datetime

import openpyxl
import pytest

from app.errors import ProcessingError
from app.pipelines import spreadsheet as sheets
from tests.conftest import write


def test_xlsx_multiple_sheets_and_types(storage):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Invoices"
    ws.append(["Purchase register Q3"])
    ws.append([])
    ws.append(["Invoice No", "Date", "Vendor", "Net", "VAT", "Gross"])
    ws.append(["INV-1", datetime(2026, 3, 14), "Acme Ltd", 100.5, 15.08, 115.58])
    wb.create_sheet("Summary").append(["Total", 115.58])
    buf = io.BytesIO()
    wb.save(buf)
    key = write(storage, "book.xlsx", buf.getvalue())
    result = sheets.extract_spreadsheet(storage / key, "xlsx")
    assert [s["name"] for s in result["sheets"]] == ["Invoices", "Summary"]
    rows = result["sheets"][0]["rows"]
    assert rows[3] == ["INV-1", "2026-03-14", "Acme Ltd", 100.5, 15.08, 115.58]
    assert "R4: INV-1 | 2026-03-14" in result["sheets"][0]["text"]


def test_repo_fixtures_parse(storage):
    for name, ftype in (("register.xlsx", "xlsx"), ("register.xls", "xls"), ("register.csv", "csv")):
        result = sheets.extract_spreadsheet(storage / f"fixtures/{name}", ftype)
        assert result["sheets"] and result["sheets"][0]["n_rows"] >= 3, name


def test_csv_semicolon_cp1252(storage):
    data = "Rechnung;Datum;Lieferant;Betrag\nR-1;14.03.2026;Café Délices SARL;1.234,56\n".encode("cp1252")
    key = write(storage, "eu.csv", data)
    sheet = sheets.extract_spreadsheet(storage / key, "csv")["sheets"][0]
    assert sheet["rows"][1] == ["R-1", "14.03.2026", "Café Délices SARL", "1.234,56"]
    assert any("delimiter=';'" in w for w in sheet["warnings"])


def test_corrupted_spreadsheets(storage):
    with pytest.raises(ProcessingError) as exc:
        sheets.extract_spreadsheet(storage / write(storage, "bad.xlsx", b"PK\x03\x04garbage"), "xlsx")
    assert exc.value.code == "corrupted_file"
    with pytest.raises(ProcessingError):
        sheets.extract_spreadsheet(storage / write(storage, "bad.csv", b"\x00\x01\x02binary\x00"), "csv")


def test_zip_without_workbook_is_rejected(storage):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", "<doc/>")
    with pytest.raises(ProcessingError):
        sheets.extract_spreadsheet(storage / write(storage, "doc.xlsx", buf.getvalue()), "xlsx")


def test_normalise_cell():
    assert sheets.normalise_cell(3.0) == 3
    assert sheets.normalise_cell(float("nan")) is None
    assert sheets.normalise_cell(datetime(2026, 1, 2)) == "2026-01-02"
    assert sheets.normalise_cell("  ") is None
