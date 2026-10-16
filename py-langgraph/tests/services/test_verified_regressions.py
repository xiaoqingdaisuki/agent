from src.config.settings import settings
from src.repositories import InMemoryRepositories
from src.services import AgentService, ConversationService, KnowledgeService, Message, TurnService, flush_background_tasks
from src.services.document_parser import DocumentParseError, parse_document
import pytest


def test_orphan_recovery_preserves_active_turn_protection():
    from datetime import UTC, datetime, timedelta
    from src.clients.memory_gateway import MemoryGatewayError

    repository = InMemoryRepositories()
    repository.create_conversation("user-1", "orphan", conversation_id="orphan-conv")
    first, _, _ = repository.begin_turn("orphan-conv", "user-1", "message-1", "first")
    with pytest.raises(MemoryGatewayError):
        repository.begin_turn("orphan-conv", "user-1", "message-2", "second")
    repository._turns[first["id"]]["updated_at"] = (datetime.now(UTC) - timedelta(seconds=331)).isoformat()
    _, _, created = repository.begin_turn("orphan-conv", "user-1", "message-2", "second")
    assert created
    assert repository.get_turn(first["id"], "user-1")["status"] == "failed"
    assert repository.get_turn(first["id"], "user-1")["error_code"] == "AGENT_RESTART_RECOVERY"


def test_new_message_timestamps_always_include_a_timezone():
    from datetime import datetime
    assert datetime.fromisoformat(Message("assistant", "answer").created_at).utcoffset() is not None


def test_long_document_retains_every_character():
    text = "A" * 40_003 + "TAIL_MARKER"
    document = parse_document(text.encode(), "long.txt")
    assert "".join(part["content"] for part in document["parts"]) == text
    assert all(len(part["content"]) <= 20_000 for part in document["parts"])
    assert [part["partIndex"] for part in document["parts"]] == [0, 1, 2]


def test_full_extracted_text_above_1mb_is_rejected():
    with pytest.raises(DocumentParseError) as error:
        parse_document(b"A" * 1_000_001, "oversized.txt")
    assert error.value.code == "SESSION_DOCUMENT_TEXT_TOO_LARGE"


def test_document_part_boundary_preserves_non_bmp_characters():
    text = "A" * 19_999 + "😀TAIL"
    document = parse_document(text.encode(), "unicode.txt")
    assert [part["content"] for part in document["parts"]] == ["A" * 19_999 + "😀", "TAIL"]
    assert all(part["content"].encode().decode() == part["content"] for part in document["parts"])


@pytest.mark.asyncio
async def test_local_knowledge_chat_and_stream_never_build_gateway_rag(monkeypatch):
    monkeypatch.setattr(settings, "memory_enabled", False)
    monkeypatch.setattr("src.rag.rag_agent.build_rag_agent", lambda: pytest.fail("local mode contacted gateway RAG"))
    await KnowledgeService.upload_document("退款截止为三十天".encode(), "rules.txt", user_id="audit-knowledge")
    conversation = ConversationService.create("local knowledge", "knowledge", "audit-knowledge")
    reply = await AgentService.chat(conversation.id, "退款截止", user_id="audit-knowledge")
    events = [event async for event in AgentService.chat_stream(conversation.id, "退款截止", user_id="audit-knowledge")]
    assert "退款截止为三十天" in reply.content
    assert events == [{"type": "text", "text": reply.content}]
    await flush_background_tasks()


def test_cold_service_reads_real_repository_history_and_counts(monkeypatch):
    repository = InMemoryRepositories()
    monkeypatch.setattr("src.repositories.get_repositories", lambda: repository)
    monkeypatch.setattr(settings, "memory_enabled", False)
    conversation_id = "audit-cold-history"
    repository.create_conversation("audit-history", "cold history", conversation_id=conversation_id)
    repository.create_message_batch(conversation_id, "audit-history", [
        {"id": f"message-{index}", "role": "user" if index % 2 == 0 else "assistant",
         "content_json": f"message-{index}", "created_at": "2026-09-30T00:00:00Z"}
        for index in range(204)
    ])
    ConversationService.ensure(conversation_id, "audit-history")
    turn, _created = TurnService.begin(conversation_id, "audit-history", "current-question", "new-turn")
    history = ConversationService.get_agent_conversation_history(conversation_id, "current-question")
    assert history[-1]["content"] == "message-203"
    assert all(item["content"] != "current-question" for item in history)
    assert len(ConversationService.get_messages(conversation_id)) == 205
    TurnService.complete(turn["id"], "audit-history", Message("assistant", "current-answer"))
    assert ConversationService.get(conversation_id).message_count == 206
    assert next(item for item in ConversationService.list("audit-history") if item["id"] == conversation_id)["message_count"] == 206
