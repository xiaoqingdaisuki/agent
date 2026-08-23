"""Tests for API routes"""

import pytest
from httpx import AsyncClient, ASGITransport
from src.api.main import app, create_app
from src.config.settings import settings


@pytest.fixture
async def client():
    """Create test client"""
    settings.agent_api_secret = "test-agent-secret"
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={
            "Authorization": "Bearer test-agent-secret",
            "X-Agent-User-Id": "test-user",
        },
    ) as ac:
        yield ac


class TestHealthEndpoint:
    @pytest.mark.asyncio
    async def test_health_returns_ok(self, client: AsyncClient):
        """Health endpoint should return ok status"""
        response = await client.get("/api/v1/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"

    @pytest.mark.asyncio
    async def test_health_includes_version(self, client: AsyncClient):
        """Health endpoint should include version"""
        response = await client.get("/api/v1/health")
        data = response.json()
        assert "version" in data

    @pytest.mark.asyncio
    async def test_legacy_health_route(self, client: AsyncClient):
        response = await client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"


class TestCors:
    @pytest.mark.asyncio
    async def test_configured_frontend_origin_is_allowed(self, monkeypatch):
        monkeypatch.setattr(settings, "cors_origin", "https://app.example.com")
        cors_app = create_app()
        transport = ASGITransport(app=cors_app)

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.options(
                "/api/v1/health",
                headers={
                    "Origin": "https://app.example.com",
                    "Access-Control-Request-Method": "GET",
                },
            )

        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "https://app.example.com"


class TestChatEndpoint:
    @pytest.mark.asyncio
    async def test_chat_requires_message(self, client: AsyncClient):
        """Chat endpoint should reject empty message"""
        response = await client.post("/chat", json={})
        assert response.status_code == 422  # Validation error

    @pytest.mark.asyncio
    async def test_chat_handles_dark_mode_command_without_calling_model(
        self, client: AsyncClient
    ):
        from src.commands import (
            DARK_MODE_COMMAND,
            DARK_MODE_ENABLED_REPLY,
            clear_agent_command_state,
        )

        response = await client.post(
            "/chat",
            json={"message": f"user: {DARK_MODE_COMMAND}"},
        )

        assert response.status_code == 200
        assert response.json()["reply"] == DARK_MODE_ENABLED_REPLY
        assert response.json()["thread_id"]
        clear_agent_command_state(response.json()["thread_id"])

    @pytest.mark.asyncio
    async def test_chat_uses_local_fast_answer_for_greeting(self, client: AsyncClient):
        response = await client.post("/chat", json={"message": "你好"})

        assert response.status_code == 200
        assert response.json()["reply"] == "你好！我是 AI 老情，很高兴为你服务。"

    @pytest.mark.asyncio
    async def test_stream_text_includes_text_and_delta_fields(self, client: AsyncClient):
        """流式文本同时提供新旧字段，避免客户端因协议差异误判空回复。"""
        conversation = await client.post(
            "/api/v1/conversations",
            json={"title": "sse compatibility", "user_id": "test-user"},
        )
        assert conversation.status_code == 201
        conversation_id = conversation.json()["id"]

        response = await client.post(
            f"/api/v1/conversations/{conversation_id}/messages/stream",
            json={"content": "你好", "user_id": "test-user"},
        )

        assert response.status_code == 200
        assert '"delta":' in response.text
        assert '"text":' in response.text


class TestToolsEndpoint:
    @pytest.mark.asyncio
    async def test_list_tools(self, client: AsyncClient):
        """Tools endpoint should list available tools"""
        response = await client.get("/tools")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        tool_names = [t["name"] for t in data]
        assert "weather.current" in tool_names
        assert "math.calculate" in tool_names


class TestCapabilitiesEndpoint:
    @pytest.mark.asyncio
    async def test_capabilities(self, client: AsyncClient):
        """Capabilities endpoint should return available features"""
        response = await client.get("/api/v1/capabilities")
        assert response.status_code == 200
        data = response.json()
        assert "modes" in data
        assert "knowledge" in data
        assert "tools" in data


class TestConversationEndpoints:
    @pytest.mark.asyncio
    async def test_rejects_missing_auth_and_user_spoofing(self):
        """Protected routes require service auth and bind inputs to trusted identity."""
        settings.agent_api_secret = "test-agent-secret"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as raw_client:
            unauthenticated = await raw_client.get("/api/v1/conversations")
            missing_identity = await raw_client.post(
                "/api/v1/conversations",
                headers={"Authorization": "Bearer test-agent-secret"},
                json={"title": "missing identity"},
            )
            spoofed = await raw_client.post(
                "/api/v1/conversations",
                headers={
                    "Authorization": "Bearer test-agent-secret",
                    "X-Agent-User-Id": "owner-a",
                },
                json={"title": "spoof", "user_id": "owner-b"},
            )
            owner_headers = {
                "Authorization": "Bearer test-agent-secret",
                "X-Agent-User-Id": "owner-a",
            }
            created = await raw_client.post(
                "/api/v1/conversations",
                headers=owner_headers,
                json={"title": "private", "user_id": "owner-a"},
            )
            conversation_id = created.json()["id"]
            other_user_headers = {
                "Authorization": "Bearer test-agent-secret",
                "X-Agent-User-Id": "owner-b",
            }
            cross_user_read = await raw_client.get(
                f"/api/v1/conversations/{conversation_id}",
                headers=other_user_headers,
            )
            from src.commands import DARK_MODE_COMMAND

            cross_user_chat = await raw_client.post(
                "/chat",
                headers=other_user_headers,
                json={
                    "message": DARK_MODE_COMMAND,
                    "thread_id": conversation_id,
                    "user_id": "owner-b",
                },
            )

        assert unauthenticated.status_code == 401
        assert missing_identity.status_code == 401
        assert spoofed.status_code == 403
        assert cross_user_read.status_code == 403
        assert cross_user_chat.status_code == 403

    @pytest.mark.asyncio
    async def test_create_conversation(self, client: AsyncClient):
        """Should create a new conversation"""
        response = await client.post("/api/v1/conversations", json={"title": "Test"})
        assert response.status_code == 201
        data = response.json()
        assert data["title"] == "Test"
        assert data["mode"] == "chat"

    @pytest.mark.asyncio
    async def test_create_conversation_requires_title(self, client: AsyncClient):
        """Should reject conversation without title"""
        response = await client.post("/api/v1/conversations", json={})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_list_conversations(self, client: AsyncClient):
        """Should list conversations"""
        response = await client.get("/api/v1/conversations")
        assert response.status_code == 200
        assert isinstance(response.json(), list)

    @pytest.mark.asyncio
    async def test_get_nonexistent_conversation(self, client: AsyncClient):
        """Should return 404 for non-existent conversation"""
        response = await client.get("/api/v1/conversations/nonexistent_id")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_nonexistent_conversation(self, client: AsyncClient):
        """Should return 404 when deleting non-existent conversation"""
        response = await client.delete("/api/v1/conversations/nonexistent_id")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_stream_message_uses_v1_conversation_protocol(self, client: AsyncClient):
        from src.commands import DARK_MODE_COMMAND, DARK_MODE_ENABLED_REPLY

        created = await client.post("/api/v1/conversations", json={"title": "stream test"})
        conversation_id = created.json()["id"]
        response = await client.post(
            f"/api/v1/conversations/{conversation_id}/messages/stream",
            json={"content": DARK_MODE_COMMAND},
        )

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert DARK_MODE_ENABLED_REPLY in response.text
        assert "data: [DONE]" in response.text


class TestKnowledgeEndpoints:
    @pytest.mark.asyncio
    async def test_upload_accepts_multipart(self, client: AsyncClient, monkeypatch):
        from src.services import Document, KnowledgeService

        async def fake_upload(buffer: bytes, filename: str, category: str | None = None):
            assert buffer == b"hello"
            assert filename == "note.txt"
            return Document(filename, len(buffer), chunks=1, category=category)

        monkeypatch.setattr(KnowledgeService, "upload_document", fake_upload)
        response = await client.post(
            "/api/v1/knowledge/documents",
            files={"file": ("note.txt", b"hello", "text/plain")},
        )
        assert response.status_code == 201
        assert response.json()["name"] == "note.txt"


class TestCompleteApiContract:
    @pytest.mark.asyncio
    async def test_legacy_and_v1_business_routes(self, client: AsyncClient, monkeypatch):
        from src.commands import DARK_MODE_COMMAND, DARK_MODE_ENABLED_REPLY
        from src.services import Document, KnowledgeService

        document = Document(
            "contract.txt",
            8,
            chunks=1,
            category="tech",
            document_id="doc_contract",
        )

        async def fake_list_documents():
            return [document.to_dict()]

        async def fake_get_document(_doc_id: str):
            return document

        async def fake_reindex_document(_doc_id: str):
            return document

        async def fake_delete_document(_doc_id: str):
            return True

        async def fake_search(_query: str, _top_k: int = 5):
            return [{"document_id": document.id, "content": "契约内容", "score": 0.9}]

        monkeypatch.setattr(KnowledgeService, "list_documents", fake_list_documents)
        monkeypatch.setattr(KnowledgeService, "get_document", fake_get_document)
        monkeypatch.setattr(KnowledgeService, "reindex_document", fake_reindex_document)
        monkeypatch.setattr(KnowledgeService, "delete_document", fake_delete_document)
        monkeypatch.setattr(KnowledgeService, "search", fake_search)

        user_id = "contract_user"
        client.headers["X-Agent-User-Id"] = user_id
        legacy_chat = await client.post(
            "/chat",
            json={"message": DARK_MODE_COMMAND, "user_id": user_id},
        )
        assert legacy_chat.status_code == 200
        assert legacy_chat.json()["reply"] == DARK_MODE_ENABLED_REPLY

        legacy_stream = await client.post(
            "/stream",
            json={"message": DARK_MODE_COMMAND, "user_id": user_id},
        )
        assert legacy_stream.status_code == 200
        assert DARK_MODE_ENABLED_REPLY in legacy_stream.text
        assert "data: [DONE]" in legacy_stream.text

        created = await client.post(
            "/api/v1/conversations",
            json={"title": "契约会话", "mode": "chat", "user_id": user_id},
        )
        assert created.status_code == 201
        conversation_id = created.json()["id"]

        listed = await client.get(f"/api/v1/conversations?user_id={user_id}")
        assert any(item["id"] == conversation_id for item in listed.json())
        assert (await client.get(f"/api/v1/conversations/{conversation_id}")).status_code == 200

        stream = await client.post(
            f"/api/v1/conversations/{conversation_id}/messages/stream",
            json={"content": DARK_MODE_COMMAND, "user_id": user_id},
        )
        assert stream.status_code == 200
        assert DARK_MODE_ENABLED_REPLY in stream.text
        assert "data: [DONE]" in stream.text

        messages = await client.get(f"/api/v1/conversations/{conversation_id}/messages")
        assert [(item["role"], item["content"]) for item in messages.json()] == [
            ("user", DARK_MODE_COMMAND),
            ("assistant", DARK_MODE_ENABLED_REPLY),
        ]
        cleared = await client.delete(f"/api/v1/conversations/{conversation_id}/messages")
        assert cleared.json() == {"success": True}

        profile = await client.get(f"/api/v1/profile?user_id={user_id}")
        assert profile.status_code == 200
        assert profile.json()["id"] == user_id
        updated_profile = await client.patch(
            f"/api/v1/profile?user_id={user_id}",
            json={"name": "契约用户", "preferences": {"theme": "dark"}},
        )
        assert updated_profile.json()["name"] == "契约用户"
        assert updated_profile.json()["preferences"] == {"theme": "dark"}

        created_memory = await client.post(
            f"/api/v1/memory?user_id={user_id}",
            json={"content": "喜欢契约测试", "category": "preference", "importance": 4},
        )
        assert created_memory.status_code == 201
        memory_id = created_memory.json()["id"]
        memories = await client.get(f"/api/v1/memory?user_id={user_id}")
        assert any(item["id"] == memory_id for item in memories.json()["memories"])
        deleted_memory = await client.delete(
            f"/api/v1/memory?user_id={user_id}&memory_id={memory_id}"
        )
        assert deleted_memory.json() == {"success": True}
        history = await client.get(f"/api/v1/history?user_id={user_id}")
        assert history.status_code == 200
        assert isinstance(history.json()["history"], list)

        documents = await client.get("/api/v1/knowledge/documents")
        assert documents.json()[0]["id"] == document.id
        assert (
            await client.get(f"/api/v1/knowledge/documents/{document.id}")
        ).json()["id"] == document.id
        assert (
            await client.post(f"/api/v1/knowledge/documents/{document.id}/reindex")
        ).json()["id"] == document.id
        search = await client.post(
            "/api/v1/knowledge/search",
            json={"query": "契约", "top_k": 3},
        )
        assert search.json()["results"][0]["document_id"] == document.id
        assert (
            await client.delete(f"/api/v1/knowledge/documents/{document.id}")
        ).json() == {"success": True}

        assert (await client.post("/images/generations", json={})).status_code == 422
        assert (
            await client.delete(f"/api/v1/conversations/{conversation_id}")
        ).json() == {"success": True}
