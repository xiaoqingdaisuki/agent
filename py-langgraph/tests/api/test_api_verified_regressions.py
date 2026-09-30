from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from src.api.main import create_app
from src.config.settings import settings
from src.services import ConversationService, Message, TurnService
from src.services.document_parser import parse_document


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["GET", "PATCH", "DELETE"])
async def test_preflight_does_not_require_service_credentials(monkeypatch, method):
    monkeypatch.setattr(settings, "cors_origin", "https://audit.example")
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        response = await client.options("/api/v1/profile", headers={
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
        response = await client.post(f"/api/v1/conversations/{conversation.id}/messages", json={
            "content": "请读取附件", "client_message_id": "unicode-one", "session_documents": [document],
        })
    assert response.status_code == 200
    context = chat.call_args.kwargs["attachment_context"]
    assert "".join(part["content"] for part in context["session_documents"][0]["parts"]) == text


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
        response = await client.post(f"/api/v1/conversations/{conversation.id}/messages/stream", json={
            "content": "请解释附件", "client_message_id": "replay-one",
            "session_documents": [{"filename": "doc.txt", "parts": [{"content": "已有附件"}]}],
        })
    assert response.status_code == 200
    assert "已有回答" in response.text
    upload.assert_not_called()
