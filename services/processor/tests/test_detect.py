import pytest

from app.detect import detect_file_type
from app.errors import ProcessingError
from tests.conftest import make_invoice_pdf, render_png, write


def _detect(storage, name, data, original=None):
    key = write(storage, name, data)
    return detect_file_type(storage / key, original or name)


def test_detects_by_content_not_extension(storage):
    assert _detect(storage, "a.pdf", make_invoice_pdf()).file_type == "pdf"
    png = render_png(make_invoice_pdf(), dpi=50)
    detected = _detect(storage, "photo.jpg", png)  # PNG bytes with a .jpg name
    assert detected.file_type == "image" and detected.image_format == "png"
    assert any("extension_mismatch" in w for w in detected.warnings)


def test_csv_and_excel_signatures(storage):
    assert _detect(storage, "r.csv", b"Invoice No,Total\nINV-1,10.00\n").file_type == "csv"
    assert _detect(storage, "old.xls", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 600).file_type == "xls"


@pytest.mark.parametrize(
    "name,data,code",
    [
        ("empty.pdf", b"", "empty_file"),
        ("random.pdf", bytes(range(256)) * 8, "corrupted_file"),
        ("page.pdf", b"<!DOCTYPE html><html><body>not a pdf</body></html>", "corrupted_file"),
        ("broken.xlsx", b"PK\x03\x04" + b"\x00" * 64, "corrupted_file"),
        ("tool.exe", b"MZ\x90\x00" + bytes(range(256)), "unsupported_format"),
    ],
)
def test_rejects_bad_files_with_stable_codes(storage, name, data, code):
    with pytest.raises(ProcessingError) as exc:
        _detect(storage, name, data)
    assert exc.value.code == code
