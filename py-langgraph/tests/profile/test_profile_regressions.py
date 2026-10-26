"""验证 test_profile_regressions 对应模块的行为与边界条件"""

import pytest

import src.profile.service as profile_module
from src.profile.service import HistoryService, MemoryService
from src.repositories import InMemoryRepositories


@pytest.fixture
def local_repositories(monkeypatch):
    repositories = InMemoryRepositories()
    monkeypatch.setattr(profile_module, "_repositories", repositories)
    return repositories


@pytest.mark.parametrize(
    ("question", "expected"),
    [
        ("我讨厌香菜。", "用户讨厌: 香菜"),
        ("不要添加香菜。", "用户要求不要: 添加香菜"),
        ("别使用表情。", "用户要求不要: 使用表情"),
        ("我喜欢简洁回答。", "用户喜欢/偏好: 简洁回答"),
        ("简洁回答是我喜欢的", "用户喜欢/偏好: 简洁回答"),
    ],
)
def test_extraction_preserves_preference_meaning(question, expected):
    memories = MemoryService._extract_with_regex("extraction-audit", question)
    assert [memory.content for memory in memories] == [expected]
    assert memories[0].category == "preference"


def test_adjacent_positive_and_negative_clauses_stay_separate():
    memories = MemoryService._extract_with_regex(
        "extraction-audit", "我讨厌香菜。简洁回答是我喜欢的"
    )
    assert [memory.content for memory in memories] == [
        "用户讨厌: 香菜", "用户喜欢/偏好: 简洁回答",
    ]


def test_history_over_multiple_pages_allocates_sequences_and_deduplicates(local_repositories):
    latest = None
    for index in range(105):
        latest = HistoryService.record("history-audit", "long-history", f"Q{index}", f"A{index}")
    messages, total = local_repositories.get_messages("long-history", 300)
    assert total == 210
    assert [message["sequence_no"] for message in messages] == list(range(210))
    assert HistoryService.get_history("history-audit", "long-history", 1) == [latest]
    assert len(HistoryService.get_history("history-audit", "long-history", 105)) == 105
    assert HistoryService.record("history-audit", "long-history", "Q104", "A104") == latest
    assert local_repositories.get_messages("long-history")[1] == 210


def test_history_pairs_messages_across_a_page_boundary(local_repositories):
    record = HistoryService.record("history-audit", "page-boundary", "question", "answer")
    local_repositories.create_message_batch(
        "page-boundary",
        "history-audit",
        [
            {
                "id": f"tool-{index}", "role": "tool", "content_json": "tool output",
                "created_at": record["timestamp"],
            }
            for index in range(199)
        ],
    )
    assert HistoryService.get_history("history-audit", "page-boundary", 1) == [record]
