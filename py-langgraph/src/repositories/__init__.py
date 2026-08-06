"""
Repositories — 数据仓储层

统一使用 Cloudflare Service 作为存储后端。
通过 CloudflareMemoryClient 与 Service 通信，所有数据持久化到 D1 数据库。
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any

from src.config.settings import settings

# 模块级缓存（供测试 fixture 重置）
_repositories = None


def _get_or_create_event_loop() -> asyncio.AbstractEventLoop:
    """获取或创建事件循环（线程安全）"""
    try:
        loop = asyncio.get_running_loop()
        # 如果已经在事件循环中（如 pytest-asyncio），返回 None 表示需要特殊处理
        if loop.is_running():
            return None  # type: ignore
        return loop
    except RuntimeError:
        pass

    try:
        loop = asyncio.get_event_loop()
        if not loop.is_closed():
            return loop
    except RuntimeError:
        pass

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    return loop


def _run_sync(coro) -> Any:
    """在同步上下文中运行异步协程"""
    loop = _get_or_create_event_loop()
    if loop is None:
        # 在 pytest-asyncio 等框架中，需要在新的线程中运行
        # 使用 nest_asyncio 的思路：如果 loop 正在运行，创建一个线程
        result = {}
        def run_in_new_loop():
            new_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(new_loop)
            result["value"] = new_loop.run_until_complete(coro)
            new_loop.close()

        thread = threading.Thread(target=run_in_new_loop)
        thread.start()
        thread.join()
        return result["value"]

    return loop.run_until_complete(coro)


def get_repositories():
    """创建 Cloudflare 仓储实例（带模块级缓存）"""
    global _repositories
    if _repositories is None:
        from src.clients.memory_gateway import CloudflareMemoryClient
        client = CloudflareMemoryClient()
        _repositories = Repositories(client)
    return _repositories


# ============ Cloudflare 实现 ============


class Repositories:
    """Cloudflare Service 仓储实现"""

    def __init__(self, client):
        self._client = client

    # Profile
    def get_or_create_profile(self, user_id: str, name: str = "") -> dict:
        return _run_sync(self._client.put_profile(user_id, name))

    def get_profile(self, user_id: str) -> dict | None:
        return _run_sync(self._client.get_profile(user_id))

    def update_profile(self, user_id: str, name: str = "", preferences: dict | None = None) -> dict | None:
        return _run_sync(self._client.put_profile(user_id, name, preferences))

    # Conversation
    def create_conversation(self, user_id: str, title: str, mode: str = "chat") -> dict:
        return _run_sync(self._client.create_conversation(user_id, title, mode))

    def get_conversation(self, conversation_id: str) -> dict | None:
        return _run_sync(self._client.get_conversation(conversation_id))

    def list_conversations(self, user_id: str, limit: int = 20, offset: int = 0) -> list[dict]:
        return _run_sync(self._client.list_conversations(user_id, limit, offset))

    def delete_conversation(self, conversation_id: str) -> bool:
        return _run_sync(self._client.delete_conversation(conversation_id))

    # Message
    def create_message_batch(self, conversation_id: str, user_id: str, messages: list[dict]) -> None:
        return _run_sync(self._client.create_messages_batch(conversation_id, user_id, messages))

    def get_messages(self, conversation_id: str, limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
        return _run_sync(self._client.get_messages(conversation_id, limit, offset))

    def clear_messages(self, conversation_id: str) -> None:
        return _run_sync(self._client.clear_messages(conversation_id))

    # Memory
    def save_memory(self, user_id: str, content: str, category: str = "fact", importance: int = 3, source: str = "user_explicit", source_conversation_id: str | None = None) -> dict:
        import uuid
        return _run_sync(self._client.save_memory(user_id, str(uuid.uuid4()), content, category, importance, source, source_conversation_id))

    def search_memories(self, user_id: str, query: str, category: str | None = None, limit: int = 10, min_score: float = 0.65) -> dict:
        return _run_sync(self._client.search_memories(user_id, query, category, limit, min_score))

    def list_memories(self, user_id: str, category: str | None = None, limit: int = 50) -> list[dict]:
        return _run_sync(self._client.list_memories(user_id, category, limit))

    def update_memory(self, user_id: str, memory_id: str, **changes) -> dict | None:
        return _run_sync(self._client.update_memory(user_id, memory_id, **changes))

    def delete_memory(self, user_id: str, memory_id: str) -> bool:
        return _run_sync(self._client.delete_memory(user_id, memory_id))

    def clear_user_memories(self, user_id: str) -> int:
        memories = _run_sync(self._client.list_user_memories(user_id, limit=100))
        count = 0
        for m in memories:
            if _run_sync(self._client.delete_memory(user_id, m["id"])):
                count += 1
        return count
