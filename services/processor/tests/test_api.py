from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import make_invoice_pdf, write

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["status"] == "ok" and "embedding" in body


def test_inspect_and_extract_pdf(storage):
    key = write(storage, "api.pdf", make_invoice_pdf(pages=2))
    info = client.post("/v1/inspect", json={"storage_key": key}).json()
    assert info["file_type"] == "pdf" and info["page_count"] == 2
    out = client.post("/v1/extract", json={"storage_key": key, "page_start": 2, "page_end": 2}).json()
    assert [p["page_number"] for p in out["pages"]] == [2]


def test_extract_spreadsheet_fixture():
    out = client.post("/v1/extract", json={"storage_key": "fixtures/register.xlsx"}).json()
    assert out["file_type"] == "xlsx" and out["sheets"]


def test_path_traversal_is_blocked():
    for key in ("../etc/passwd", "/etc/passwd", "fixtures/../../x"):
        r = client.post("/v1/inspect", json={"storage_key": key})
        assert r.status_code == 400 and r.json()["error_code"] == "invalid_path"


def test_missing_and_corrupted_files_return_typed_errors():
    r = client.post("/v1/extract", json={"storage_key": "nope.pdf"})
    assert r.status_code == 404 and r.json()["error_code"] == "file_not_found"
    r = client.post("/v1/extract", json={"storage_key": "fixtures/corrupted.pdf"})
    assert r.status_code == 422 and r.json() == {
        "error_code": "corrupted_file", "message": r.json()["message"], "retryable": False,
    }


def test_embed_returns_unit_vectors():
    out = client.post("/v1/embed", json={"texts": ["home nursing invoice", "office supplies"]}).json()
    assert out["dim"] == 384 and len(out["vectors"]) == 2
    norm = sum(v * v for v in out["vectors"][0]) ** 0.5
    assert abs(norm - 1) < 1e-3
