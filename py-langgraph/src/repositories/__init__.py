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


# 执行 get or create event loop 对应的业务逻辑
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


# 执行 run sync 对应的业务逻辑
def _run_sync(coro) -> Any:
    """在同步上下文中运行异步协程"""
    loop = _get_or_create_event_loop()
    if loop is None:
        # 在 pytest-asyncio 等框架中，需要在新的线程中运行
        # 使用 nest_asyncio 的思路：如果 loop 正在运行，创建一个线程
        result: dict[str, Any] = {}
        failure: dict[str, BaseException] = {}

        # 在独立线程事件循环中执行协程并保留异常
        def run_in_new_loop():
            new_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(new_loop)
            try:
                result["value"] = new_loop.run_until_complete(coro)
            except BaseException as exc:
                failure["error"] = exc
            finally:
                new_loop.close()

        thread = threading.Thread(target=run_in_new_loop)
        thread.start()
        thread.join()
        if "error" in failure:
            raise failure["error"]
        return result["value"]

    return loop.run_until_complete(coro)


# ============ 无持久化占位实现 ==========

class NoopRepositories:
    """持久化已禁用时的占位仓储，所有操作静默跳过或返回空值"""

    # Profile
    def get_or_create_profile(self, user_id: str, name: str = "") -> dict:
        return {"user_id": user_id, "name": name, "preferences_json": "{}", "created_at": "", "updated_at": ""}

    def get_profile(self, user_id: str) -> dict | None:
        return None

    def update_profile(self, user_id: str, name: str | None = None, preferences: dict | None = None) -> dict | None:
        return None

    # Conversation
    def create_conversation(self, user_id: str, title: str, mode: str = "chat", conversation_id: str | None = None) -> dict:
        return {
            "id": conversation_id or "",
            "user_id": user_id,
            "title": title,
            "mode": mode,
            "created_at": "",
            "updated_at": "",
            "deleted_at": None,
        }

    def get_conversation(self, conversation_id: str) -> dict | None:
        return None

    def list_conversations(self, user_id: str, limit: int = 20, offset: int = 0) -> list[dict]:
        return []

    def delete_conversation(self, conversation_id: str) -> bool:
        return False

    # Message
    def create_message_batch(self, conversation_id: str, user_id: str, messages: list[dict]) -> None:
        pass

    def get_messages(self, conversation_id: str, limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
        return [], 0

    def clear_messages(self, conversation_id: str) -> None:
        pass

    # Memory
    def save_memory(self, user_id: str, content: str, category: str = "fact", importance: int = 3, source: str = "user_explicit", source_conversation_id: str | None = None) -> dict:
        import uuid
        return {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "content": content,
            "normalized_content": content,
            "content_hash": "0" * 64,
            "category": category,
            "importance": importance,
            "source": source,
            "source_conversation_id": source_conversation_id,
            "status": "active",
            "index_status": "pending",
            "embedding_model": "",
            "embedding_version": 1,
            "created_at": "",
            "updated_at": "",
            "last_accessed_at": None,
            "expires_at": None,
        }

    def search_memories(self, user_id: str, query: str, category: str | None = None, limit: int = 10, min_score: float = 0.65) -> dict:
        return {"items": [], "degraded": True}

    def list_memories(self, user_id: str, category: str | None = None, limit: int = 50) -> list[dict]:
        return []

    def update_memory(self, user_id: str, memory_id: str, **changes) -> dict | None:
        return None

    def delete_memory(self, user_id: str, memory_id: str) -> bool:
        return False

    def clear_user_memories(self, user_id: str) -> int:
        return 0


# ============ 工厂函数 ============


# 获取 get repositories 对应的数据
def get_repositories():
    """创建 Cloudflare 仓储实例（带模块级缓存）
    PERSISTENCE_ENABLED=false 时返回无操作占位实例
    """
    global _repositories
    if _repositories is None:
        if not settings.persistence_enabled:
            _repositories = NoopRepositories()
        else:
            from src.clients.memory_gateway import CloudflareMemoryClient
            client = CloudflareMemoryClient()
            _repositories = Repositories(client)
    return _repositories


def reset_repositories():
    """重置仓储缓存（测试用）"""
    global _repositories
    _repositories = None


# ============ Cloudflare 实现 ============


class Repositories:
    """Cloudflare Service 仓储实现"""

    # 初始化当前对象
    def __init__(self, client):
        self._client = client

    # Profile
    # 获取 get or create profile 对应的数据
    def get_or_create_profile(self, user_id: str, name: str = "") -> dict:
        return _run_sync(self._client.put_profile(user_id, name))

    # 获取 get profile 对应的数据
    def get_profile(self, user_id: str) -> dict | None:
        return _run_sync(self._client.get_profile(user_id))

    # 更新或保存 update profile 对应的数据
    def update_profile(self, user_id: str, name: str | None = None, preferences: dict | None = None) -> dict | None:
        return _run_sync(self._client.put_profile(user_id, name, preferences))

    # Conversation
    # 创建或注册 create conversation 所需的数据
    def create_conversation(
        self,
        user_id: str,
        title: str,
        mode: str = "chat",
        conversation_id: str | None = None,
    ) -> dict:
        return _run_sync(
            self._client.create_conversation(user_id, title, mode, conversation_id)
        )

    # 获取 get conversation 对应的数据
    def get_conversation(self, conversation_id: str) -> dict | None:
        return _run_sync(self._client.get_conversation(conversation_id))

    # 获取 list conversations 对应的数据
    def list_conversations(self, user_id: str, limit: int = 20, offset: int = 0) -> list[dict]:
        return _run_sync(self._client.list_conversations(user_id, limit, offset))

    # 删除或清理 delete conversation 对应的数据
    def delete_conversation(self, conversation_id: str) -> bool:
        return _run_sync(self._client.delete_conversation(conversation_id))

    # Message
    # 创建或注册 create message batch 所需的数据
    def create_message_batch(self, conversation_id: str, user_id: str, messages: list[dict]) -> None:
        return _run_sync(self._client.create_messages_batch(conversation_id, user_id, messages))

    # 获取 get messages 对应的数据
    def get_messages(self, conversation_id: str, limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
        return _run_sync(self._client.get_messages(conversation_id, limit, offset))

    # 删除或清理 clear messages 对应的数据
    def clear_messages(self, conversation_id: str) -> None:
        return _run_sync(self._client.clear_messages(conversation_id))

    # Memory
    # 更新或保存 save memory 对应的数据
    def save_memory(self, user_id: str, content: str, category: str = "fact", importance: int = 3, source: str = "user_explicit", source_conversation_id: str | None = None) -> dict:
        import uuid
        return _run_sync(self._client.save_memory(user_id, str(uuid.uuid4()), content, category, importance, source, source_conversation_id))

    # 查询 search memories 对应的结果
    def search_memories(self, user_id: str, query: str, category: str | None = None, limit: int = 10, min_score: float = 0.65) -> dict:
        return _run_sync(self._client.search_memories(user_id, query, category, limit, min_score))

    # 获取 list memories 对应的数据
    def list_memories(self, user_id: str, category: str | None = None, limit: int = 50) -> list[dict]:
        return _run_sync(self._client.list_memories(user_id, category, limit))

    # 更新或保存 update memory 对应的数据
    def update_memory(self, user_id: str, memory_id: str, **changes) -> dict | None:
        return _run_sync(self._client.update_memory(user_id, memory_id, **changes))

    # 删除或清理 delete memory 对应的数据
    def delete_memory(self, user_id: str, memory_id: str) -> bool:
        return _run_sync(self._client.delete_memory(user_id, memory_id))

    # 删除或清理 clear user memories 对应的数据
    def clear_user_memories(self, user_id: str) -> int:
        memories = _run_sync(self._client.list_memories(user_id, limit=100))
        count = 0
        for m in memories:
            if _run_sync(self._client.delete_memory(user_id, m["id"])):
                count += 1
        return count
