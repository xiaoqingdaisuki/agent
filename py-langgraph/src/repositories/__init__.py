"""
Repositories — 数据仓储层

根据 memory_enabled 选择进程内仓储或 Cloudflare Service。
业务层只依赖统一仓储接口，关闭记忆网关时不会创建远端客户端。
"""

from __future__ import annotations

import asyncio
import threading
import uuid
from datetime import datetime
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


# 在同步业务层中安全执行仓储协程，并复用专用事件循环。
def _run_sync(coro) -> Any:
    """在同步上下文中运行异步协程"""
    loop = _get_or_create_event_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result()


# 返回当前配置对应的仓储单例，确保同一进程共享会话与记忆状态。
def get_repositories():
    """按配置创建 Cloudflare 或进程内仓储实例。"""
    global _repositories
    if _repositories is None:
        if settings.memory_enabled:
            from src.clients.memory_gateway import CloudflareMemoryClient

            _repositories = Repositories(CloudflareMemoryClient())
        else:
            _repositories = InMemoryRepositories()
    return _repositories


class InMemoryRepositories:
    """关闭 Cloudflare 记忆模式时使用的进程内仓储。"""

    # 初始化进程内 profile、会话、消息和长期记忆存储
    def __init__(self):
        self._profiles: dict[str, dict] = {}
        self._conversations: dict[str, dict] = {}
        self._messages: dict[str, list[dict]] = {}
        self._memories: dict[str, list[dict]] = {}

    # 获取或创建用户画像
    def get_or_create_profile(self, user_id: str, name: str = "") -> dict:
        profile = self._profiles.get(user_id)
        if profile:
            return dict(profile)
        now = datetime.now().isoformat()
        profile = {
            "user_id": user_id,
            "name": name,
            "preferences_json": "{}",
            "created_at": now,
            "updated_at": now,
        }
        self._profiles[user_id] = profile
        return dict(profile)

    # 获取用户画像
    def get_profile(self, user_id: str) -> dict | None:
        profile = self._profiles.get(user_id)
        return dict(profile) if profile else None

    # 更新用户画像
    def update_profile(self, user_id: str, name: str | None = None, preferences: dict | None = None) -> dict:
        profile = self.get_or_create_profile(user_id, name or "")
        profile["name"] = name if name is not None else profile["name"]
        if preferences is not None:
            import json

            profile["preferences_json"] = json.dumps(preferences, ensure_ascii=False)
        profile["updated_at"] = datetime.now().isoformat()
        self._profiles[user_id] = profile
        return dict(profile)

    # 创建会话
    def create_conversation(self, user_id: str, title: str, mode: str = "chat", conversation_id: str | None = None) -> dict:
        conversation_id = conversation_id or str(uuid.uuid4())
        now = datetime.now().isoformat()
        conversation = {
            "id": conversation_id,
            "user_id": user_id,
            "title": title,
            "mode": mode,
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._conversations[conversation_id] = conversation
        self._messages.setdefault(conversation_id, [])
        return dict(conversation)

    # 获取会话
    def get_conversation(self, conversation_id: str) -> dict | None:
        conversation = self._conversations.get(conversation_id)
        if not conversation or conversation.get("deleted_at"):
            return None
        return dict(conversation)

    # 列出用户会话
    def list_conversations(self, user_id: str, limit: int = 20, offset: int = 0) -> list[dict]:
        conversations = [
            dict(conversation)
            for conversation in self._conversations.values()
            if conversation["user_id"] == user_id and not conversation.get("deleted_at")
        ]
        conversations.sort(key=lambda item: item["created_at"], reverse=True)
        return conversations[offset : offset + limit]

    # 删除会话和消息
    def delete_conversation(self, conversation_id: str) -> bool:
        conversation = self._conversations.get(conversation_id)
        if not conversation or conversation.get("deleted_at"):
            return False
        conversation["deleted_at"] = datetime.now().isoformat()
        self._messages.pop(conversation_id, None)
        return True

    # 批量保存会话消息
    def create_message_batch(self, conversation_id: str, user_id: str, messages: list[dict]) -> None:
        stored = self._messages.setdefault(conversation_id, [])
        by_id = {message["id"]: message for message in stored}
        for message in messages:
            by_id[message["id"]] = {
                "id": message["id"],
                "conversation_id": conversation_id,
                "user_id": user_id,
                "sequence_no": message["sequence_no"],
                "role": message["role"],
                "content_json": message.get("content_json", message.get("content", "")),
                "created_at": message["created_at"],
            }
        self._messages[conversation_id] = sorted(
            by_id.values(), key=lambda item: item["sequence_no"]
        )

    # 获取会话消息
    def get_messages(self, conversation_id: str, limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
        messages = self._messages.get(conversation_id, [])
        return [dict(message) for message in messages[offset : offset + limit]], len(messages)

    # 清空会话消息
    def clear_messages(self, conversation_id: str) -> None:
        self._messages[conversation_id] = []

    # 保存用户长期记忆
    def save_memory(self, user_id: str, content: str, category: str = "fact", importance: int = 3, source: str = "user_explicit", source_conversation_id: str | None = None) -> dict:
        memories = self._memories.setdefault(user_id, [])
        normalized = content.strip().lower()
        for memory in memories:
            if memory["normalized_content"] == normalized and memory["status"] == "active":
                return dict(memory)
        now = datetime.now().isoformat()
        memory = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "content": content.strip(),
            "normalized_content": normalized,
            "content_hash": f"local_{uuid.uuid4().hex}",
            "category": category,
            "importance": importance,
            "source": source,
            "source_conversation_id": source_conversation_id,
            "status": "active",
            "index_status": "ready",
            "embedding_model": "local",
            "embedding_version": 1,
            "created_at": now,
            "updated_at": now,
            "last_accessed_at": None,
            "expires_at": None,
        }
        memories.append(memory)
        return dict(memory)

    # 搜索用户长期记忆
    def search_memories(self, user_id: str, query: str, category: str | None = None, limit: int = 10, min_score: float = 0.65) -> dict:
        words = [word for word in query.lower().split() if word]
        results = []
        for memory in self._memories.get(user_id, []):
            if memory["status"] != "active" or (category and memory["category"] != category):
                continue
            score = sum(word in memory["normalized_content"] for word in words) / len(words) if words else 1.0
            if score >= min_score:
                results.append({
                    "id": memory["id"], "content": memory["content"], "category": memory["category"],
                    "importance": memory["importance"], "semantic_score": score, "final_score": score,
                    "created_at": memory["created_at"], "updated_at": memory["updated_at"],
                    "source_conversation_id": memory["source_conversation_id"],
                })
        results.sort(key=lambda item: (item["final_score"], item["importance"]), reverse=True)
        return {"items": results[:limit], "degraded": False}

    # 列出用户长期记忆
    def list_memories(self, user_id: str, category: str | None = None, limit: int = 50) -> list[dict]:
        memories = [
            dict(memory)
            for memory in self._memories.get(user_id, [])
            if memory["status"] == "active" and (not category or memory["category"] == category)
        ]
        memories.sort(key=lambda item: (item["importance"], item["created_at"]), reverse=True)
        return memories[:limit]

    # 异步读取本地记忆，保持与 Cloudflare 仓储一致的非阻塞调用契约。
    async def list_memories_async(
        self, user_id: str, category: str | None = None, limit: int = 50
    ) -> list[dict]:
        return self.list_memories(user_id, category, limit)

    # 更新用户长期记忆
    def update_memory(self, user_id: str, memory_id: str, **changes) -> dict | None:
        for memory in self._memories.get(user_id, []):
            if memory["id"] != memory_id or memory["status"] != "active":
                continue
            if changes.get("content") is not None:
                memory["content"] = changes["content"].strip()
                memory["normalized_content"] = memory["content"].lower()
            for field in ("category", "importance"):
                if changes.get(field) is not None:
                    memory[field] = changes[field]
            memory["updated_at"] = datetime.now().isoformat()
            return dict(memory)
        return None

    # 删除用户长期记忆
    def delete_memory(self, user_id: str, memory_id: str) -> bool:
        memory = self.update_memory(user_id, memory_id)
        if not memory:
            return False
        for item in self._memories[user_id]:
            if item["id"] == memory_id:
                item["status"] = "deleted"
                item["updated_at"] = datetime.now().isoformat()
        return True

    # 清空用户长期记忆
    def clear_user_memories(self, user_id: str) -> int:
        count = len([memory for memory in self._memories.get(user_id, []) if memory["status"] == "active"])
        self._memories[user_id] = []
        return count


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

    # 直接在请求事件循环中读取记忆，避免同步桥接占用默认线程池。
    async def list_memories_async(
        self, user_id: str, category: str | None = None, limit: int = 50
    ) -> list[dict]:
        return await self._client.list_memories(user_id, category, limit)

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
