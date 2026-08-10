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
_sync_loop: asyncio.AbstractEventLoop | None = None
_sync_loop_thread: threading.Thread | None = None
_sync_loop_ready = threading.Event()
_sync_loop_lock = threading.Lock()


# 在专用线程中启动仓储异步客户端的持久事件循环
def _run_repository_loop() -> None:
    global _sync_loop
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _sync_loop = loop
    _sync_loop_ready.set()
    loop.run_forever()


# 获取或创建仓储专用事件循环，避免跨事件循环复用 AsyncClient
def _get_or_create_event_loop() -> asyncio.AbstractEventLoop:
    global _sync_loop_thread
    if _sync_loop and _sync_loop.is_running():
        return _sync_loop

    with _sync_loop_lock:
        if not _sync_loop or not _sync_loop.is_running():
            _sync_loop_ready.clear()
            _sync_loop_thread = threading.Thread(
                target=_run_repository_loop,
                name="memory-gateway-loop",
                daemon=True,
            )
            _sync_loop_thread.start()
            _sync_loop_ready.wait()

    if not _sync_loop:
        raise RuntimeError("仓储事件循环启动失败")
    return _sync_loop


# 执行 run sync 对应的业务逻辑
def _run_sync(coro) -> Any:
    """在同步上下文中运行异步协程"""
    loop = _get_or_create_event_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result()


# 获取 get repositories 对应的数据
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

    # 初始化当前对象
    def __init__(self, client):
        self._client = client

    # Profile
    # 获取 get or create profile 对应的数据
    def get_or_create_profile(self, user_id: str, name: str = "") -> dict:
        existing = _run_sync(self._client.get_profile(user_id))
        if existing:
            return existing
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
