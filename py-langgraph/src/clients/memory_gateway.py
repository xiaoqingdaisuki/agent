"""
Cloudflare Service HTTP Client — Cloudflare 长期存储服务客户端

提供与 Cloudflare Service 通信的 HTTP 客户端。
所有请求通过 Service 进行，Agent 服务不直接持有 Cloudflare API Token。
所有响应经过 Pydantic 运行时校验，确保数据不偏离契约。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Optional

import httpx

from src.config.settings import settings
from src.clients.schemas import (
    GatewayResponse,
    UserProfileData,
    ConversationData,
    MessageData,
    MemoryData,
    MemorySearchResultData,
    MessagesPageData,
    SearchResponseData,
    DocumentData,
    ChunkData,
    DocumentSearchResultData,
    DocumentSearchResponseData,
)


class MemoryGatewayError(Exception):
    """Gateway 请求失败"""

    def __init__(self, code: str, message: str, status_code: int = 500):
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(f"[{code}] {message}")


class CloudflareMemoryClient:
    """Cloudflare Service HTTP 客户端"""

    def __init__(
        self,
        base_url: str = "",
        secret: str = "",
        timeout_ms: int = 5000,
    ):
        self._base_url = base_url or settings.memory_gateway_base_url
        self._secret = secret or settings.memory_gateway_secret
        self._timeout = timeout_ms or settings.memory_request_timeout_ms
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=httpx.Timeout(self._timeout / 1000.0),
            )
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    def _headers(self, idempotency_key: str | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._secret}",
            "Content-Type": "application/json",
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        client = await self._get_client()
        headers = self._headers(idempotency_key)

        response = await client.request(method, path, content=json.dumps(body, ensure_ascii=False) if body is not None else None, headers=headers)

        if response.status_code == 401:
            raise MemoryGatewayError("MEMORY_UNAUTHENTICATED", "缺少或无效的认证凭证", 401)
        if response.status_code == 403:
            raise MemoryGatewayError("MEMORY_FORBIDDEN", "无权访问该资源", 403)
        if response.status_code == 404:
            raise MemoryGatewayError("MEMORY_NOT_FOUND", "资源不存在", 404)
        if response.status_code == 409:
            raise MemoryGatewayError("MEMORY_CONFLICT", "数据冲突", 409)

        response.raise_for_status()
        data = response.json()
        # 校验响应信封格式
        GatewayResponse.model_validate(data)
        return data

    # ============ Profile ============

    async def get_profile(self, user_id: str) -> dict | None:
        """获取用户画像"""
        try:
            result = await self._request("GET", f"/internal/v1/users/{user_id}/profile")
            data = result.get("data")
            return UserProfileData.model_validate(data).model_dump() if data else None
        except MemoryGatewayError as e:
            if e.code == "MEMORY_USER_NOT_FOUND":
                return None
            raise

    async def put_profile(self, user_id: str, name: str = "", preferences: dict | None = None) -> dict:
        """创建或更新用户画像"""
        body: dict[str, Any] = {"name": name}
        if preferences is not None:
            body["preferences"] = preferences
        result = await self._request("PUT", f"/internal/v1/users/{user_id}/profile", body)
        return UserProfileData.model_validate(result["data"]).model_dump()

    # ============ Conversation ============

    async def create_conversation(self, user_id: str, title: str, mode: str = "chat") -> dict:
        """创建会话"""
        result = await self._request("POST", "/internal/v1/conversations", {
            "user_id": user_id,
            "title": title,
            "mode": mode,
        })
        return ConversationData.model_validate(result["data"]).model_dump()

    async def list_conversations(self, user_id: str, limit: int = 20, offset: int = 0) -> list[dict]:
        """列出用户的会话"""
        result = await self._request("GET", f"/internal/v1/users/{user_id}/conversations?limit={limit}&offset={offset}")
        data = result.get("data", [])
        return [ConversationData.model_validate(item).model_dump() for item in data]

    async def get_conversation(self, conversation_id: str) -> dict | None:
        """获取会话详情"""
        try:
            result = await self._request("GET", f"/internal/v1/conversations/{conversation_id}")
            data = result.get("data")
            return ConversationData.model_validate(data).model_dump() if data else None
        except MemoryGatewayError as e:
            if e.code == "MEMORY_CONVERSATION_NOT_FOUND":
                return None
            raise

    async def delete_conversation(self, conversation_id: str) -> bool:
        """删除会话"""
        try:
            await self._request("DELETE", f"/internal/v1/conversations/{conversation_id}")
            return True
        except MemoryGatewayError as e:
            if e.code == "MEMORY_CONVERSATION_NOT_FOUND":
                return False
            raise

    # ============ Message ============

    async def create_messages_batch(self, conversation_id: str, user_id: str, messages: list[dict]) -> None:
        """批量写入消息"""
        await self._request("POST", f"/internal/v1/conversations/{conversation_id}/messages:batch", {
            "user_id": user_id,
            "messages": messages,
        })

    async def get_messages(self, conversation_id: str, limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
        """获取会话消息"""
        result = await self._request("GET", f"/internal/v1/conversations/{conversation_id}/messages?limit={limit}&offset={offset}")
        page = MessagesPageData.model_validate(result.get("data", {}))
        return [msg.model_dump() for msg in page.messages], page.total

    async def clear_messages(self, conversation_id: str) -> None:
        """清空会话消息"""
        await self._request("DELETE", f"/internal/v1/conversations/{conversation_id}/messages")

    # ============ Memory ============

    async def save_memory(self, user_id: str, memory_id: str, content: str, category: str = "fact", importance: int = 3, source: str = "user_explicit", source_conversation_id: str | None = None) -> dict:
        """保存记忆（幂等）"""
        idempotency_key = hashlib.sha256(f"{user_id}:{content}".encode()).hexdigest()[:32]
        result = await self._request(
            "PUT",
            f"/internal/v1/users/{user_id}/memories/{memory_id}",
            {
                "content": content,
                "category": category,
                "importance": importance,
                "source": source,
                "source_conversation_id": source_conversation_id,
            },
            idempotency_key=idempotency_key,
        )
        return MemoryData.model_validate(result["data"]).model_dump()

    async def list_memories(self, user_id: str, category: str | None = None, limit: int = 50) -> list[dict]:
        """列出用户的长期记忆"""
        params = f"?limit={limit}"
        if category:
            params += f"&category={category}"
        result = await self._request("GET", f"/internal/v1/users/{user_id}/memories{params}")
        data = result.get("data", [])
        return [MemoryData.model_validate(item).model_dump() for item in data]

    async def update_memory(self, user_id: str, memory_id: str, content: str | None = None, category: str | None = None, importance: int | None = None) -> dict | None:
        """更新记忆"""
        body: dict[str, Any] = {}
        if content is not None:
            body["content"] = content
        if category is not None:
            body["category"] = category
        if importance is not None:
            body["importance"] = importance

        try:
            result = await self._request("PATCH", f"/internal/v1/users/{user_id}/memories/{memory_id}", body)
            data = result.get("data")
            return MemoryData.model_validate(data).model_dump() if data else None
        except MemoryGatewayError as e:
            if e.code == "MEMORY_NOT_FOUND":
                return None
            raise

    async def search_memories(self, user_id: str, query: str, category: str | None = None, limit: int = 10, min_score: float = 0.65) -> dict:
        """语义搜索记忆"""
        body: dict[str, Any] = {"query": query, "limit": limit, "min_score": min_score}
        if category:
            body["category"] = category
        result = await self._request("POST", f"/internal/v1/users/{user_id}/memories:search", body)
        return SearchResponseData.model_validate(result.get("data", {})).model_dump()

    # ============ Document ============

    async def upload_document(self, user_id: str, filename: str, content: str, file_type: str | None = None, category: str = "general") -> dict:
        """上传文档（content 为 base64 编码）"""
        body: dict[str, Any] = {
            "user_id": user_id,
            "filename": filename,
            "content": content,
            "category": category,
        }
        if file_type:
            body["file_type"] = file_type
        result = await self._request("POST", "/internal/v1/documents", body)
        return DocumentData.model_validate(result.get("data", {}).get("document")).model_dump()

    async def list_documents(self, user_id: str, limit: int = 20, offset: int = 0, category: str | None = None) -> dict:
        """列出用户文档"""
        params = f"?user_id={user_id}&limit={limit}&offset={offset}"
        if category:
            params += f"&category={category}"
        result = await self._request("GET", f"/internal/v1/documents{params}")
        data = result.get("data", {})
        return {
            "documents": [DocumentData.model_validate(d).model_dump() for d in data.get("documents", [])],
            "total": data.get("total", 0),
        }

    async def get_document(self, document_id: str) -> dict | None:
        """获取文档详情"""
        try:
            result = await self._request("GET", f"/internal/v1/documents/{document_id}")
            data = result.get("data", {})
            return {
                "document": DocumentData.model_validate(data.get("document")).model_dump(),
                "chunks": [ChunkData.model_validate(c).model_dump() for c in data.get("chunks", [])],
            }
        except MemoryGatewayError as e:
            if e.code == "DOCUMENT_NOT_FOUND":
                return None
            raise

    async def delete_document(self, document_id: str) -> bool:
        """删除文档"""
        try:
            await self._request("DELETE", f"/internal/v1/documents/{document_id}")
            return True
        except MemoryGatewayError as e:
            if e.code == "DOCUMENT_NOT_FOUND":
                return False
            raise

    async def search_documents(self, user_id: str, query: str, limit: int = 5, min_score: float = 0.6) -> dict:
        """语义搜索文档"""
        body: dict[str, Any] = {
            "user_id": user_id,
            "query": query,
            "limit": limit,
            "min_score": min_score,
        }
        result = await self._request("POST", "/internal/v1/documents:search", body)
        return DocumentSearchResponseData.model_validate(result.get("data", {})).model_dump()

    async def delete_memory(self, user_id: str, memory_id: str) -> bool:
        """删除记忆（软删除）"""
        try:
            await self._request("DELETE", f"/internal/v1/users/{user_id}/memories/{memory_id}")
            return True
        except MemoryGatewayError as e:
            if e.code == "MEMORY_NOT_FOUND":
                return False
            raise

    async def list_user_memories(self, user_id: str, limit: int = 100) -> list[dict]:
        """列出用户所有记忆（用于清空）"""
        result = await self._request("GET", f"/internal/v1/users/{user_id}/memories?limit={limit}")
        data = result.get("data", [])
        return [MemoryData.model_validate(item).model_dump() for item in data]
