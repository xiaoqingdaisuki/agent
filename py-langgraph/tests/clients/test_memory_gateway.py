"""Cloudflare Memory Gateway 客户端契约测试。"""

import httpx
import pytest

from src.clients.memory_gateway import CloudflareMemoryClient
from src.repositories import _run_sync


@pytest.mark.asyncio
async def test_sync_repository_calls_reuse_one_event_loop():
    """同步仓储适配器必须在固定事件循环中复用异步 HTTP 客户端。"""

    async def current_loop_id() -> int:
        import asyncio

        return id(asyncio.get_running_loop())

    assert _run_sync(current_loop_id()) == _run_sync(current_loop_id())


@pytest.mark.asyncio
async def test_preserves_gateway_not_found_codes():
    """404 必须保留网关错误码，供各资源的缺失分支识别。"""
    error_codes = {
        "/internal/v1/users/missing/profile": "MEMORY_USER_NOT_FOUND",
        "/internal/v1/conversations/missing": "MEMORY_CONVERSATION_NOT_FOUND",
        "/internal/v1/documents/missing": "DOCUMENT_NOT_FOUND",
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        code = error_codes[request.url.path]
        return httpx.Response(
            404,
            json={"ok": False, "data": None, "error": {"code": code, "message": "missing"}},
        )

    client = CloudflareMemoryClient("https://gateway.test", "secret")
    client._client = httpx.AsyncClient(
        base_url="https://gateway.test",
        transport=httpx.MockTransport(handler),
    )
    try:
        assert await client.get_profile("missing") is None
        assert await client.get_conversation("missing") is None
        assert await client.get_document("missing") is None
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_encodes_identifiers_as_single_path_segments():
    """用户输入中的斜杠不得改变网关路由结构。"""
    observed_path = ""

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal observed_path
        observed_path = request.url.raw_path.decode()
        return httpx.Response(
            404,
            json={
                "ok": False,
                "data": None,
                "error": {"code": "MEMORY_USER_NOT_FOUND", "message": "missing"},
            },
        )

    client = CloudflareMemoryClient("https://gateway.test", "secret")
    client._client = httpx.AsyncClient(
        base_url="https://gateway.test",
        transport=httpx.MockTransport(handler),
    )
    try:
        assert await client.get_profile("tenant/user") is None
        assert observed_path == "/internal/v1/users/tenant%2Fuser/profile"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_encodes_document_list_query_parameters():
    """文档列表中的用户标识不得注入额外查询参数。"""
    observed_params: httpx.QueryParams | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal observed_params
        observed_params = request.url.params
        return httpx.Response(
            200,
            json={
                "ok": True,
                "data": {"documents": [], "total": 0},
                "error": None,
                "meta": {"request_id": "req-1", "degraded": False, "warnings": []},
            },
        )

    client = CloudflareMemoryClient("https://gateway.test", "secret")
    client._client = httpx.AsyncClient(
        base_url="https://gateway.test",
        transport=httpx.MockTransport(handler),
    )
    try:
        await client.list_documents("tenant&admin=true")
        assert observed_params is not None
        assert observed_params["user_id"] == "tenant&admin=true"
        assert "admin" not in observed_params
    finally:
        await client.close()
