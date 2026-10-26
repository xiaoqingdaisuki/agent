"""验证 test_api_verified_regressions 对应模块的行为与边界条件"""

from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from src.api.main import create_app
from src.config.settings import settings
from src.services import ConversationService, Message, TurnService
from src.services.document_parser import parse_document


@pytest.mark.asyncio
async def test_slow_persistence_does_not_block_other_requests(monkeypatch):
    import asyncio
    import threading
    from types import SimpleNamespace

    monkeypatch.setattr(settings, "agent_api_secret", "test-agent-secret")
    started, release = threading.Event(), threading.Event()
    released_while_reading = []

    def slow_get(_conversation_id):
        started.set()
        released_while_reading.append(release.wait(timeout=0.5))
        return SimpleNamespace(user_id="audit-concurrent", to_dict=lambda: {"id": "slow"})

    monkeypatch.setattr(ConversationService, "get", slow_get)
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test",
                           headers={"Authorization": "Bearer test-agent-secret", "X-Agent-User-Id": "audit-concurrent"}) as client:
        pending = asyncio.create_task(client.get("/v1/conversations/slow"))
        try:
            assert await asyncio.to_thread(started.wait, 1)
            health = await client.get("/v1/health")
            release.set()
            assert health.status_code == 200
            assert (await pending).status_code == 200
            assert released_while_reading == [True]
        finally:
            release.set()
            await pending


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["meta", "text", "error", "complete"])
async def test_stream_closure_never_leaves_the_conversation_busy(monkeypatch, phase):
    from types import SimpleNamespace
    from src.api.routes import v1
    from src.repositories import InMemoryRepositories
    from src.services import BusinessError, BusinessErrorCode

    repository = InMemoryRepositories()
    monkeypatch.setattr(settings, "memory_enabled", False)
    monkeypatch.setattr("src.repositories.get_repositories", lambda: repository)
    route = v1
    monkeypatch.setattr(route, "require_agent_user_id", lambda *args: "closure-user")
    monkeypatch.setattr(route, "get_agent_tool_identity", lambda *args: {})
    monkeypatch.setattr(route, "log_request_error", lambda *args: None)
    monkeypatch.setattr("src.api.stream_coordinator.log_request_error", lambda *args: None)
    monkeypatch.setattr("src.memory.get_default_checkpointer", lambda: SimpleNamespace(restore_from_gateway=AsyncMock()))

    async def events(*args, **kwargs):
        if phase == "error":
            raise BusinessError(BusinessErrorCode.MODEL_RESPONSE_INVALID, "invalid response", 502)
        yield {"type": "text", "text": "answer"}

    monkeypatch.setattr("src.services.AgentService.chat_stream", events)
    conversation = ConversationService.create("closure", "chat", "closure-user")
    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
    payload = SimpleNamespace(content="question", user_id="closure-user", client_message_id="first")
    monkeypatch.setattr(route, "read_send_message_payload", AsyncMock(return_value=(payload, {})))
    monkeypatch.setattr(route, "prepare_attachment_context", AsyncMock(return_value={}))
    response = await route.stream_message(conversation.id, request)
    iterator = response.body_iterator
    assert "event: meta" in await anext(iterator)
    if phase in {"text", "error"}:
        assert f"event: {phase}" in await anext(iterator)
    if phase == "complete":
        async for _event in iterator:
            pass
    else:
        await iterator.aclose()
    previous = next(iter(repository._turns.values()))
    assert previous["status"] == ("completed" if phase == "complete" else "failed" if phase == "error" else "cancelled")
    _turn, created = TurnService.begin(conversation.id, "closure-user", "next question", "second")
    assert created


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["GET", "PATCH", "DELETE"])
async def test_preflight_does_not_require_service_credentials(monkeypatch, method):
    monkeypatch.setattr(settings, "cors_origin", "https://audit.example")
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        response = await client.options("/v1/profile", headers={
            "Origin": "https://audit.example", "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "authorization,x-agent-user-id",
        })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://audit.example"
    assert method in response.headers["access-control-allow-methods"].split(", ")


@pytest.mark.asyncio
async def test_json_attachment_roundtrip_preserves_non_bmp_characters(monkeypatch):
    monkeypatch.setattr(settings, "memory_enabled", False)
    monkeypatch.setattr(settings, "agent_api_secret", "test-agent-secret")
    text = "A" * 19_999 + "😀TAIL"
    document = parse_document(text.encode(), "unicode.txt")
    conversation = ConversationService.create("Unicode document", user_id="audit-unicode")
    chat = AsyncMock(return_value=Message("assistant", "已读取"))
    monkeypatch.setattr("src.services.AgentService.chat", chat)
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test",
                           headers={"Authorization": "Bearer test-agent-secret", "X-Agent-User-Id": "audit-unicode"}) as client:
        response = await client.post(f"/v1/conversations/{conversation.id}/messages", json={
            "content": "请读取附件", "client_message_id": "unicode-one", "session_documents": [document],
        })
    assert response.status_code == 200
    context = chat.call_args.kwargs["attachment_context"]
    assert "".join(part["content"] for part in context["session_documents"][0]["parts"]) == text


@pytest.mark.asyncio
async def test_session_document_parse_endpoint_matches_ts_contract(monkeypatch):
    monkeypatch.setattr(settings, "memory_enabled", False)
    monkeypatch.setattr(settings, "agent_api_secret", "test-agent-secret")
    conversation = ConversationService.create("Temporary document", user_id="audit-document")
    async with AsyncClient(
        transport=ASGITransport(app=create_app()),
        base_url="http://test",
        headers={
            "Authorization": "Bearer test-agent-secret",
            "X-Agent-User-Id": "audit-document",
        },
    ) as client:
        response = await client.post(
            f"/v1/conversations/{conversation.id}/session-documents/parse",
            files={"file": ("rules.md", "第一条规则\n\n第二条规则".encode(), "text/markdown")},
        )

    assert response.status_code == 200
    document = response.json()
    assert document["filename"] == "rules.md"
    assert document["mimeType"] == "text/markdown"
    assert document["parserVersion"] == "session-document-v2"
    assert document["user_id"] == "audit-document"
    assert [part["content"] for part in document["parts"]] == ["第一条规则", "第二条规则"]


@pytest.mark.asyncio
async def test_completed_stream_replay_skips_attachment_upload(monkeypatch):
    monkeypatch.setattr(settings, "agent_api_secret", "test-agent-secret")
    conversation = ConversationService.create("attachment replay", user_id="audit-replay")
    turn, _created = TurnService.begin(conversation.id, "audit-replay", "请解释附件", "replay-one")
    TurnService.complete(turn["id"], "audit-replay", Message("assistant", "已有回答"))
    upload = AsyncMock(side_effect=RuntimeError("duplicate upload must not happen"))
    monkeypatch.setattr("src.services.KnowledgeService.upload_document", upload)
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test",
                           headers={"Authorization": "Bearer test-agent-secret", "X-Agent-User-Id": "audit-replay"}) as client:
        response = await client.post(f"/v1/conversations/{conversation.id}/messages/stream", json={
            "content": "请解释附件", "client_message_id": "replay-one",
            "session_documents": [{"filename": "doc.txt", "parts": [{"content": "已有附件"}]}],
        })
    assert response.status_code == 200
    assert "已有回答" in response.text
    upload.assert_not_called()
