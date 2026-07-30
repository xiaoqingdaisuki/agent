"""Tests for API routes"""

import pytest
from httpx import AsyncClient, ASGITransport
from src.api.main import app, create_app
from src.config.settings import settings


@pytest.fixture
async def client():
    """Create test client"""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
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

        thread_id = "api-command-thread"
        clear_agent_command_state(thread_id)
        response = await client.post(
            "/chat",
            json={"message": DARK_MODE_COMMAND, "thread_id": thread_id},
        )

        assert response.status_code == 200
        assert response.json() == {
            "reply": DARK_MODE_ENABLED_REPLY,
            "thread_id": thread_id,
        }
        clear_agent_command_state(thread_id)


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
