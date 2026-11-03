import pymupdf
import pytest

from app.errors import ProcessingError
from app.pipelines import pdf as pdf_pipeline
from tests.conftest import make_invoice_pdf, write


def test_digital_pdf_uses_text_layer(storage):
    key = write(storage, "digital.pdf", make_invoice_pdf())
    result = pdf_pipeline.extract_pdf(storage / key, 1, None, "auto")
    page = result["pages"][0]
    assert page["method"] == "text"
    assert "INV-1001" in page["text"] and "230.00" in page["text"]
    assert page["lines"] and all(0 <= v <= 1 for v in page["lines"][0]["bbox"])


def test_page_ranges_for_large_documents(storage):
    key = write(storage, "multi.pdf", make_invoice_pdf(pages=7))
    result = pdf_pipeline.extract_pdf(storage / key, 3, 5, "auto")
    assert result["page_count"] == 7
    assert [p["page_number"] for p in result["pages"]] == [3, 4, 5]
    with pytest.raises(ProcessingError):
        pdf_pipeline.extract_pdf(storage / key, 9, 12, "auto")


def test_encrypted_pdf_is_reported(storage):
    doc = pymupdf.open(stream=make_invoice_pdf(), filetype="pdf")
    data = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")
    key = write(storage, "locked.pdf", data)
    with pytest.raises(ProcessingError) as exc:
        pdf_pipeline.inspect_pdf(storage / key)
    assert exc.value.code == "encrypted_pdf"


def test_truncated_pdf_fails_cleanly_or_is_repaired(storage):
    data = make_invoice_pdf(pages=3)
    key = write(storage, "truncated.pdf", data[: len(data) // 4])
    try:
        result = pdf_pipeline.extract_pdf(storage / key, 1, None, "off")
    except ProcessingError as exc:
        assert exc.code == "corrupted_file"
    else:  # MuPDF rebuilt the xref: we must say so, never pretend the file was fine
        assert any(w.startswith("pdf_repaired") for w in result["warnings"])


def test_repo_fixture_corrupted_pdf(storage):
    with pytest.raises(ProcessingError) as exc:
        pdf_pipeline.extract_pdf(storage / "fixtures/corrupted.pdf", 1, None, "auto")
    assert exc.value.code == "corrupted_file"


def test_repo_fixture_multi_invoice_pdf(storage):
    result = pdf_pipeline.extract_pdf(storage / "fixtures/invoice_multi.pdf", 1, None, "auto")
    assert result["page_count"] == 4
    assert all(p["method"] == "text" for p in result["pages"])


def test_text_layer_quality_flags_garbage():
    assert pdf_pipeline.text_layer_quality("Invoice No: INV-1001 Total 230.00") > 0.9
    assert pdf_pipeline.text_layer_quality("(cid:12)(cid:44)(cid:91) ��") < 0.3


def test_render_page_returns_jpeg(storage):
    key = write(storage, "render.pdf", make_invoice_pdf())
    data = pdf_pipeline.render_pdf_page(storage / key, 1, 72, 800)
    assert data[:3] == b"\xff\xd8\xff"
