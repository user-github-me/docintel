from app.layout import Word, build_lines


def test_rows_keep_column_alignment():
    words = [
        Word(50, 100, 120, 110, "Description"), Word(300, 100, 330, 110, "Qty"), Word(450, 100, 500, 110, "Amount"),
        Word(50, 120, 90, 130, "Pens"), Word(310, 120, 318, 130, "2"), Word(455, 120, 495, 130, "10.00"),
    ]
    lines = [l for l in build_lines(words, 600, 800) if l.text]
    assert len(lines) == 2
    header, row = lines[0].text, lines[1].text
    assert "  " in header.strip()  # wide gaps become column separators
    assert abs(header.index("Amount") - row.index("10.00")) <= 2  # amount sits under its header


def test_large_title_does_not_swallow_small_print_line():
    title = [Word(100, 50, 200, 68, "Clearview"), Word(205, 50, 290, 68, "Networks")]
    address = [Word(100, 70, 130, 79, "352"), Word(133, 70, 160, 79, "Roy"), Word(163, 70, 210, 79, "Landing")]
    lines = [l.text.strip() for l in build_lines(title + address, 600, 800) if l.text]
    assert lines == ["Clearview Networks", "352 Roy Landing"]


def test_bbox_is_normalised_and_confidence_weighted():
    lines = build_lines([Word(60, 80, 120, 92, "Total", 0.9), Word(400, 80, 460, 92, "99.00", 0.5)], 600, 800)
    line = lines[0]
    assert 0 <= line.bbox[0] < line.bbox[2] <= 1
    assert 0.6 < line.conf < 0.75
