"""
Cloudflare Service HTTP Client — Cloudflare 长期存储服务客户端

提供与 Cloudflare Service 通信的 HTTP 客户端。
所有请求通过 Service 进行，Agent 服务不直接持有 Cloudflare API Token。
所有响应经过 Pydantic 运行时校验，确保数据不偏离契约。
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from typing import Any, Optional
from urllib.parse import quote, urlencode

import httpx

from src.config.settings import settings
from src.clients.schemas import (
    GatewayResponse,
    UserProfileData,
    ConversationData,
    MessageData,
    TurnData,
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

    # 初始化当前对象
    def __init__(self, code: str, message: str, status_code: int = 500):
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(f"[{code}] {message}")


# 将不可信标识符编码为单个 URL 路径段
def _path_segment(value: str) -> str:
    return quote(value, safe="")


class CloudflareMemoryClient:
    """Cloudflare Service HTTP 客户端"""

    # 初始化当前对象
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

    # 执行 get client 对应的业务逻辑
    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=httpx.Timeout(self._timeout / 1000.0),
            )
        return self._client

    # 关闭资源并完成清理
    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    # 执行 headers 对应的业务逻辑
    def _headers(self, idempotency_key: str | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._secret}",
            "Content-Type": "application/json",
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    # 执行 request 对应的业务逻辑
    async def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        if not settings.memory_enabled:
            raise MemoryGatewayError(
                "MEMORY_DISABLED",
                "记忆模式已关闭，LLM 直连模式不会调用 Cloudflare Gateway",
                503,
            )
        client = await self._get_client()
        headers = self._headers(idempotency_key)

        request_content = json.dumps(body, ensure_ascii=False) if body is not None else None
        retryable = method in {"GET", "DELETE"} or path.endswith("messages:batch") or bool(idempotency_key)
        attempts = 3 if retryable else 1
        response = None
        for attempt in range(attempts):
            try:
                response = await client.request(method, path, content=request_content, headers=headers)
                break
            except (httpx.TimeoutException, httpx.NetworkError):
                if attempt + 1 >= attempts:
                    raise
                await asyncio.sleep(0.15 * (attempt + 1))

        if response is None:
            raise MemoryGatewayError("MEMORY_REQUEST_FAILED", "记忆网关请求失败", 503)

        if response.status_code in {401, 403, 404, 409}:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            error = payload.get("error") or {}
            fallbacks = {
                401: ("MEMORY_UNAUTHENTICATED", "缺少或无效的认证凭证"),
                403: ("MEMORY_FORBIDDEN", "无权访问该资源"),
                404: ("MEMORY_NOT_FOUND", "资源不存在"),
                409: ("MEMORY_CONFLICT", "数据冲突"),
            }
            fallback_code, fallback_message = fallbacks[response.status_code]
            raise MemoryGatewayError(
                error.get("code", fallback_code),
                error.get("message", fallback_message),
                response.status_code,
            )

        response.raise_for_status()
        data = response.json()
        # 校验响应信封格式
        GatewayResponse.model_validate(data)
        return data

    # ============ Profile ============

    # 获取 get profile 对应的数据
    async def get_profile(self, user_id: str) -> dict | None:
        """获取用户画像"""
        try:
            result = await self._request("GET", f"/internal/v1/users/{_path_segment(user_id)}/profile")
            data = result.get("data")
            return UserProfileData.model_validate(data).model_dump() if data else None
        except MemoryGatewayError as e:
            if e.code == "MEMORY_USER_NOT_FOUND":
                return None
            raise

    # 更新或保存 put profile 对应的数据
    async def put_profile(self, user_id: str, name: str | None = None, preferences: dict | None = None) -> dict:
        """创建或更新用户画像"""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if preferences is not None:
            body["preferences"] = preferences
        result = await self._request("PUT", f"/internal/v1/users/{_path_segment(user_id)}/profile", body)
        return UserProfileData.model_validate(result["data"]).model_dump()

    # ============ Conversation ============

    # 创建或注册 create conversation 所需的数据
    async def create_conversation(
        self,
        user_id: str,
        title: str,
        mode: str = "chat",
        conversation_id: str | None = None,
    ) -> dict:
        """创建会话"""
        body = {
            "user_id": user_id,
            "title": title,
            "mode": mode,
        }
        if conversation_id:
            body["id"] = conversation_id
        result = await self._request("POST", "/internal/v1/conversations", body)
        return ConversationData.model_validate(result["data"]).model_dump()

    # 获取 list conversations 对应的数据
    async def list_conversations(self, user_id: str, limit: int = 20, offset: int = 0) -> list[dict]:
        """列出用户的会话"""
        result = await self._request("GET", f"/internal/v1/users/{_path_segment(user_id)}/conversations?limit={limit}&offset={offset}")
        data = result.get("data", [])
        return [ConversationData.model_validate(item).model_dump() for item in data]

    # 获取 get conversation 对应的数据
    async def get_conversation(self, conversation_id: str) -> dict | None:
        """获取会话详情"""
        try:
            result = await self._request("GET", f"/internal/v1/conversations/{_path_segment(conversation_id)}")
            data = result.get("data")
            return ConversationData.model_validate(data).model_dump() if data else None
        except MemoryGatewayError as e:
            if e.code == "MEMORY_CONVERSATION_NOT_FOUND":
                return None
            raise

    # 删除或清理 delete conversation 对应的数据
    async def delete_conversation(self, conversation_id: str) -> bool:
        """删除会话"""
        try:
            await self._request("DELETE", f"/internal/v1/conversations/{_path_segment(conversation_id)}")
            return True
        except MemoryGatewayError as e:
            if e.code == "MEMORY_CONVERSATION_NOT_FOUND":
                return False
            raise

    # ============ Message ============

    # 创建或注册 create messages batch 所需的数据
    async def create_messages_batch(self, conversation_id: str, user_id: str, messages: list[dict]) -> None:
        """批量写入消息"""
        await self._request("POST", f"/internal/v1/conversations/{_path_segment(conversation_id)}/messages:batch", {
            "user_id": user_id,
            "messages": messages,
        })

    # 获取 get messages 对应的数据
    async def get_messages(
        self, conversation_id: str, limit: int = 50, offset: int = 0, direction: str = "asc"
    ) -> tuple[list[dict], int]:
        """获取会话消息"""
        result = await self._request(
            "GET",
            f"/internal/v1/conversations/{_path_segment(conversation_id)}/messages?limit={limit}&offset={offset}&direction={direction}",
        )
        page = MessagesPageData.model_validate(result.get("data", {}))
        return [msg.model_dump() for msg in page.messages], page.total

    # 删除或清理 clear messages 对应的数据
    async def clear_messages(self, conversation_id: str) -> None:
        """清空会话消息"""
        await self._request("DELETE", f"/internal/v1/conversations/{_path_segment(conversation_id)}/messages")

    # 原子创建或复用客户端消息对应的 Turn。
    async def create_or_get_turn(
        self,
        conversation_id: str,
        user_id: str,
        client_message_id: str,
        turn_id: str,
    ) -> tuple[dict, bool]:
        result = await self._request(
            "POST",
            f"/internal/v1/conversations/{_path_segment(conversation_id)}/turns",
            {"id": turn_id, "user_id": user_id, "client_message_id": client_message_id},
            idempotency_key=client_message_id,
        )
        raw = result["data"]
        return TurnData.model_validate(raw).model_dump(mode="json"), bool(raw.get("created"))

    # 按用户读取指定 Turn。
    async def get_turn(self, turn_id: str, user_id: str) -> dict | None:
        try:
            result = await self._request(
                "GET",
                f"/internal/v1/turns/{_path_segment(turn_id)}?user_id={quote(user_id, safe='')}",
            )
            return TurnData.model_validate(result["data"]).model_dump(mode="json")
        except MemoryGatewayError as error:
            if error.code == "MEMORY_TURN_NOT_FOUND":
                return None
            raise

    # 按合法状态机更新 Turn。
    async def update_turn(self, turn_id: str, user_id: str, **changes) -> dict:
        result = await self._request(
            "PATCH",
            f"/internal/v1/turns/{_path_segment(turn_id)}",
            {"user_id": user_id, **changes},
            idempotency_key=f"{turn_id}:{changes['status']}",
        )
        return TurnData.model_validate(result["data"]).model_dump(mode="json")

    # ============ Memory ============

    # 更新或保存 save memory 对应的数据
    async def save_memory(self, user_id: str, memory_id: str, content: str, category: str = "fact", importance: int = 3, source: str = "user_explicit", source_conversation_id: str | None = None) -> dict:
        """保存记忆（幂等）"""
        idempotency_key = hashlib.sha256(f"{user_id}:{content}".encode()).hexdigest()[:32]
        result = await self._request(
            "PUT",
            f"/internal/v1/users/{_path_segment(user_id)}/memories/{_path_segment(memory_id)}",
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

    # 获取 list memories 对应的数据
    async def list_memories(self, user_id: str, category: str | None = None, limit: int = 50) -> list[dict]:
        """列出用户的长期记忆"""
        params = f"?limit={limit}"
        if category:
            params += f"&category={category}"
        result = await self._request("GET", f"/internal/v1/users/{_path_segment(user_id)}/memories{params}")
        data = result.get("data", [])
        return [MemoryData.model_validate(item).model_dump() for item in data]

    # 更新或保存 update memory 对应的数据
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
            result = await self._request("PATCH", f"/internal/v1/users/{_path_segment(user_id)}/memories/{_path_segment(memory_id)}", body)
            data = result.get("data")
            return MemoryData.model_validate(data).model_dump() if data else None
        except MemoryGatewayError as e:
            if e.code == "MEMORY_NOT_FOUND":
                return None
            raise

    # 查询 search memories 对应的结果
    async def search_memories(self, user_id: str, query: str, category: str | None = None, limit: int = 10, min_score: float = 0.65) -> dict:
        """语义搜索记忆"""
        body: dict[str, Any] = {"query": query, "limit": limit, "min_score": min_score}
        if category:
            body["category"] = category
        result = await self._request("POST", f"/internal/v1/users/{_path_segment(user_id)}/memories:search", body)
        data = result.get("data", {})
        # 兼容旧版 Worker 曾返回的 results 字段。
        if "items" not in data and "results" in data:
            data = {**data, "items": data["results"]}
        return SearchResponseData.model_validate(data).model_dump()

    # ============ Document ============

    # 创建或注册 upload document 所需的数据
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

    # 获取 list documents 对应的数据
    async def list_documents(self, user_id: str, limit: int = 20, offset: int = 0, category: str | None = None) -> dict:
        """列出用户文档"""
        params: dict[str, str | int] = {
            "user_id": user_id,
            "limit": limit,
            "offset": offset,
        }
        if category:
            params["category"] = category
        result = await self._request(
            "GET", f"/internal/v1/documents?{urlencode(params)}"
        )
        data = result.get("data", {})
        return {
            "documents": [DocumentData.model_validate(d).model_dump() for d in data.get("documents", [])],
            "total": data.get("total", 0),
        }

    # 获取 get document 对应的数据
    async def get_document(self, document_id: str) -> dict | None:
        """获取文档详情"""
        try:
            result = await self._request("GET", f"/internal/v1/documents/{_path_segment(document_id)}")
            data = result.get("data", {})
            return {
                "document": DocumentData.model_validate(data.get("document")).model_dump(),
                "chunks": [ChunkData.model_validate(c).model_dump() for c in data.get("chunks", [])],
            }
        except MemoryGatewayError as e:
            if e.code == "DOCUMENT_NOT_FOUND":
                return None
            raise

    # 删除或清理 delete document 对应的数据
    async def delete_document(self, document_id: str) -> bool:
        """删除文档"""
        try:
            await self._request("DELETE", f"/internal/v1/documents/{_path_segment(document_id)}")
            return True
        except MemoryGatewayError as e:
            if e.code == "DOCUMENT_NOT_FOUND":
                return False
            raise

    # 原地重建文档索引并保留文档 ID
    async def reindex_document(self, document_id: str) -> dict:
        """原地重建文档索引"""
        result = await self._request(
            "POST",
            f"/internal/v1/documents/{_path_segment(document_id)}/reindex",
        )
        return result.get("data", {})

    # 查询 search documents 对应的结果
    async def search_documents(
        self,
        user_id: str,
        query: str,
        limit: int = 5,
        min_score: float = 0.6,
        document_ids: list[str] | None = None,
    ) -> dict:
        """语义搜索文档"""
        body: dict[str, Any] = {
            "user_id": user_id,
            "query": query,
            "limit": limit,
            "min_score": min_score,
        }
        if document_ids:
            body["document_ids"] = document_ids
        result = await self._request("POST", "/internal/v1/documents:search", body)
        return DocumentSearchResponseData.model_validate(result.get("data", {})).model_dump()

    # 删除或清理 delete memory 对应的数据
    async def delete_memory(self, user_id: str, memory_id: str) -> bool:
        """删除记忆（软删除）"""
        try:
            await self._request("DELETE", f"/internal/v1/users/{_path_segment(user_id)}/memories/{_path_segment(memory_id)}")
            return True
        except MemoryGatewayError as e:
            if e.code == "MEMORY_NOT_FOUND":
                return False
            raise

    # 更新或保存 write audit logs 对应的数据
    async def write_audit_logs(self, entries: list[dict]) -> None:
        """批量写入审计日志（不阻塞主流程）"""
        try:
            await self._request("POST", "/internal/v1/audit-logs", {"entries": entries})
        except Exception:
            pass  # 审计日志写入失败不影响主流程

    # 更新或保存 write tool metrics 对应的数据
    async def write_tool_metrics(self, entries: list[dict]) -> None:
        """批量写入工具指标（不阻塞主流程）"""
        try:
            await self._request("POST", "/internal/v1/tool-metrics", {"entries": entries})
        except Exception:
            pass  # 指标写入失败不影响主流程

    # 获取 list user memories 对应的数据
    async def list_user_memories(self, user_id: str, limit: int = 100) -> list[dict]:
        """列出用户所有记忆（用于清空）"""
        result = await self._request("GET", f"/internal/v1/users/{_path_segment(user_id)}/memories?limit={limit}")
        data = result.get("data", [])
        return [MemoryData.model_validate(item).model_dump() for item in data]
