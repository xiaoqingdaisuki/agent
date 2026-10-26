"""验证 test_memory_recent 对应模块的行为与边界条件"""

import importlib

from src.repositories import InMemoryRepositories


async def test_reads_latest_messages_in_chronological_order_beyond_first_page(monkeypatch):
    memory_module = importlib.import_module("src.tools.memory_session")
    repos = InMemoryRepositories()
    monkeypatch.setattr(memory_module, "get_repositories", lambda: repos)
    conversation_id = "recent-session-audit"
    repos.create_message_batch(
        conversation_id,
        "audit-user",
        [
            {
                "id": f"{conversation_id}-{index}",
                "role": "user",
                "content_json": f"message-{index + 1:02d}",
                "created_at": "2026-09-30T00:00:00Z",
            }
            for index in range(40)
        ],
    )
    result = await memory_module.memory_session_search.ainvoke(
        {
            "conversation_id": conversation_id,
            "max_results": 5,
        }
    )
    assert "message-36" in result
    assert "message-40" in result
    assert "message-21" not in result
    assert result.index("message-36") < result.index("message-40")
    filtered = await memory_module.memory_session_search.ainvoke(
        {
            "conversation_id": conversation_id,
            "query": "message-40",
            "max_results": 5,
        }
    )
    assert "message-40" in filtered
