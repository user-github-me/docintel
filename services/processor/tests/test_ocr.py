"""OCR tests run where the tesseract binary exists (the Docker image)."""
import io

import cv2
import numpy as np
import pytest
from PIL import Image

from app.ocr import preprocess as pp
from app.ocr.engine import ocr_image, tesseract_version
from app.pipelines import image as image_pipeline
from tests.conftest import make_invoice_pdf, render_png, write

needs_tesseract = pytest.mark.skipif(tesseract_version() is None, reason="tesseract not installed")


def _png_array(**kw) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(render_png(make_invoice_pdf(), **kw))).convert("L"))


@pytest.mark.ocr
@needs_tesseract
def test_ocr_reads_invoice_number_and_amounts():
    result = ocr_image(_png_array(dpi=200))
    text = " ".join(w.text for w in result.words)
    assert "INV-1001" in text and "230.00" in text
    assert result.mean_conf > 0.8


@pytest.mark.ocr
@needs_tesseract
def test_ocr_recovers_sideways_scan():
    rotated = cv2.rotate(_png_array(dpi=200), cv2.ROTATE_90_CLOCKWISE)
    result = ocr_image(rotated)
    assert "INV-1001" in " ".join(w.text for w in result.words)
    assert any(step.startswith("rotate") for step in result.steps)


@pytest.mark.ocr
@needs_tesseract
def test_ocr_noisy_low_contrast_scan():
    rng = np.random.default_rng(7)
    img = _png_array(dpi=150).astype(np.float32)
    img = 90 + img * 0.6 + rng.normal(0, 12, img.shape)  # washed out + grain
    img[rng.random(img.shape) < 0.002] = 0  # salt-and-pepper specks
    result = ocr_image(np.clip(img, 0, 255).astype(np.uint8))
    assert "INV-1001" in " ".join(w.text for w in result.words)


@pytest.mark.ocr
@needs_tesseract
def test_image_pipeline_on_repo_fixture(storage):
    result = image_pipeline.extract_image(storage / "fixtures/invoice_scanned.png", 1, None)
    assert result["pages"][0]["method"] == "ocr"
    assert result["pages"][0]["char_count"] > 100


def test_truncated_image_is_corrupted(storage):
    png = render_png(make_invoice_pdf(), dpi=60)
    key = write(storage, "cut.png", png[:40])
    with pytest.raises(Exception) as exc:
        image_pipeline.extract_image(storage / key, 1, None)
    assert getattr(exc.value, "code", None) == "corrupted_file"


def test_speck_removal_keeps_decimal_points():
    img = np.full((120, 400), 255, np.uint8)
    cv2.putText(img, "12.50", (20, 80), cv2.FONT_HERSHEY_SIMPLEX, 2.0, 0, 4)
    noisy = img.copy()
    noisy[10:13, 300:303] = 0  # isolated speck in white space
    cleaned, removed = pp.remove_isolated_specks(noisy, 45)
    assert removed >= 1
    assert cleaned[10:13, 300:303].min() == 255
    # decimal point region (between "12" and "50") still has ink
    assert (cleaned[60:85, 120:150] < 128).any()


def test_ruling_lines_are_removed():
    img = np.full((600, 800), 255, np.uint8)
    cv2.line(img, (20, 100), (780, 100), 0, 2)
    cv2.line(img, (400, 20), (400, 580), 0, 2)
    cleaned, fraction = pp.remove_ruling_lines(img)
    assert fraction > 0 and cleaned[100, 50] == 255 and cleaned[300, 400] == 255


def test_skew_estimate_recovers_rotation():
    img = np.full((800, 800), 255, np.uint8)
    for y in range(100, 700, 40):
        cv2.putText(img, "Invoice total 1234.56 paid", (60, y), cv2.FONT_HERSHEY_SIMPLEX, 0.9, 0, 2)
    m = cv2.getRotationMatrix2D((400, 400), 3.0, 1.0)
    skewed = cv2.warpAffine(img, m, (800, 800), borderValue=255)
    assert abs(pp.estimate_skew(skewed) + 3.0) < 0.6
