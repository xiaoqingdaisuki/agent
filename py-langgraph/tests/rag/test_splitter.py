"""验证 test_splitter 对应模块的行为与边界条件"""

import pytest

from src.rag.splitter import TextSplitter


def test_large_document_does_not_exhaust_call_stack():
    chunks = TextSplitter().split("A" * 8_000_000, "test.txt", "test")

    assert len(chunks) == 10_000
    assert chunks[0].metadata["total_chunks"] == len(chunks)
    assert all(len(chunk.text) <= 1000 for chunk in chunks)


def test_large_overlap_retains_middle_after_early_paragraph_break():
    content = "A" * 400 + "\n\n" + "B" * 1000 + "MIDDLE_MARKER" + "C" * 1000
    chunks = TextSplitter(1000, 900).split(content, "test.txt", "test")

    assert any("MIDDLE_MARKER" in chunk.text for chunk in chunks)
    assert all(len(chunk.text) <= 1000 for chunk in chunks)


def test_complete_separator_stays_inside_size_bound():
    chunks = TextSplitter(10, 0).split("123456789\n\nabcdef", "test.txt", "test")

    assert [chunk.text for chunk in chunks] == ["123456789", "\nabcdef"]
    assert all(len(chunk.text) <= 10 for chunk in chunks)


@pytest.mark.parametrize("size,overlap", [(0, 0), (10, -1), (10, 10), (1.5, 0), (10, 0.5)])
def test_invalid_size_or_overlap_is_rejected(size, overlap):
    with pytest.raises(ValueError):
        TextSplitter(size, overlap)
