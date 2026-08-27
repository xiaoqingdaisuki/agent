"""
Pytest fixtures — 全局测试配置

所有测试自动注入 FakeCloudflareMemoryClient，避免真实 HTTP 请求。
"""

import time
import uuid
import pytest
from unittest.mock import patch

import sys
import os

# 保证测试使用 Cloudflare 客户端替身而不是禁用记忆模式的进程内实现。
os.environ["MEMORY_ENABLED"] = "true"

# Ensure the project root is importable so `src` remains a top-level package.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class FakeProfileRepository:
    """模拟 Profile 仓储"""

    def __init__(self):
        self._profiles: dict[str, dict] = {}

    def get_or_create(self, user_id: str, name: str = ""):
        now = time.time()
        iso_now = __import__("datetime").datetime.fromtimestamp(now).isoformat()
        if user_id not in self._profiles:
            self._profiles[user_id] = {
                "user_id": user_id,
                "name": name,
                "preferences_json": "{}",
                "created_at": iso_now,
                "updated_at": iso_now,
            }
        else:
            self._profiles[user_id]["updated_at"] = iso_now
        return dict(self._profiles[user_id])

    def get(self, user_id: str):
        data = self._profiles.get(user_id)
        return dict(data) if data else None

    def update(self, user_id: str, name: str = "", preferences=None):
        if user_id not in self._profiles:
            return None
        now = time.time()
        iso_now = __import__("datetime").datetime.fromtimestamp(now).isoformat()
        if name:
            self._profiles[user_id]["name"] = name
        if preferences is not None:
            import json
            self._profiles[user_id]["preferences_json"] = json.dumps(preferences)
        self._profiles[user_id]["updated_at"] = iso_now
        return dict(self._profiles[user_id])


class FakeConversationRepository:
    """模拟 Conversation 仓储"""

    def __init__(self):
        self._conversations: dict[str, dict] = {}

    def create(self, user_id: str, title: str, mode: str = "chat"):
        conv_id = str(uuid.uuid4())
        now = __import__("datetime").datetime.now().isoformat()
        conv = {
            "id": conv_id,
            "user_id": user_id,
            "title": title,
            "mode": mode,
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._conversations[conv_id] = conv
        return dict(conv)

    def get(self, conversation_id: str):
        data = self._conversations.get(conversation_id)
        return dict(data) if data and data["deleted_at"] is None else None

    def list(self, user_id: str, limit: int = 20, offset: int = 0):
        all_convs = [
            dict(c) for c in self._conversations.values()
            if c["user_id"] == user_id and c["deleted_at"] is None
        ]
        all_convs.sort(key=lambda x: x["updated_at"], reverse=True)
        return all_convs[offset:offset + limit]

    def delete(self, conversation_id: str):
        conv = self._conversations.get(conversation_id)
        if not conv or conv["deleted_at"] is not None:
            return False
        conv["deleted_at"] = __import__("datetime").datetime.now().isoformat()
        return True


class FakeMessageRepository:
    """模拟 Message 仓储"""

    def __init__(self):
        self._messages: dict[str, list[dict]] = {}

    def create_batch(self, conversation_id: str, user_id: str, messages: list[dict]):
        if conversation_id not in self._messages:
            self._messages[conversation_id] = []
        existing_keys = {m["sequence_no"] for m in self._messages[conversation_id]}
        next_sequence = max(existing_keys, default=-1) + 1
        for msg in messages:
            sequence_no = msg.get("sequence_no", next_sequence)
            if sequence_no not in existing_keys:
                self._messages[conversation_id].append({**msg, "sequence_no": sequence_no})
                existing_keys.add(sequence_no)
                next_sequence = max(next_sequence, sequence_no + 1)

    def get_messages(
        self, conversation_id: str, limit: int = 50, offset: int = 0, direction: str = "asc"
    ):
        all_msgs = self._messages.get(conversation_id, [])
        all_msgs = sorted(all_msgs, key=lambda m: m["sequence_no"])
        ordered = list(reversed(all_msgs)) if direction == "desc" else all_msgs
        return ordered[offset:offset + limit], len(all_msgs)

    def clear(self, conversation_id: str):
        self._messages.pop(conversation_id, None)


class FakeTurnRepository:
    """模拟 Turn 仓储"""

    def __init__(self):
        self._turns = {}
        self._keys = {}

    def create_or_get(self, conversation_id, user_id, client_message_id, turn_id):
        key = (conversation_id, client_message_id)
        if key in self._keys:
            return dict(self._turns[self._keys[key]]), False
        now = __import__("datetime").datetime.now().isoformat()
        turn = {
            "id": turn_id, "conversation_id": conversation_id, "user_id": user_id,
            "client_message_id": client_message_id, "status": "pending",
            "user_message_id": None, "assistant_message_id": None,
            "assistant_content_json": None, "error_code": None,
            "created_at": now, "updated_at": now, "completed_at": None,
        }
        self._keys[key] = turn_id
        self._turns[turn_id] = turn
        return dict(turn), True

    def begin(self, conversation_id, user_id, client_message_id, content, turn_id, user_message_id, message_repository):
        key = (conversation_id, client_message_id)
        if key in self._keys:
            turn = self._turns[self._keys[key]]
            messages, _ = message_repository.get_messages(conversation_id, 1000, 0)
            message = next(item for item in messages if item["id"] == turn["user_message_id"])
            return dict(turn), message, False
        now = __import__("datetime").datetime.now().isoformat()
        messages, total = message_repository.get_messages(conversation_id, 1000, 0)
        message = {
            "id": user_message_id, "conversation_id": conversation_id, "user_id": user_id,
            "sequence_no": total, "role": "user", "content_json": content, "created_at": now,
        }
        turn = {
            "id": turn_id, "conversation_id": conversation_id, "user_id": user_id,
            "client_message_id": client_message_id, "status": "streaming",
            "user_message_id": user_message_id, "assistant_message_id": None,
            "assistant_content_json": None, "error_code": None,
            "created_at": now, "updated_at": now, "completed_at": None,
        }
        message_repository.create_batch(conversation_id, user_id, [message])
        self._keys[key] = turn_id
        self._turns[turn_id] = turn
        return dict(turn), dict(message), True

    def complete(self, turn_id, user_id, message, assistant_content_json, message_repository):
        turn = self._turns[turn_id]
        if turn["status"] == "completed":
            return dict(turn)
        _, total = message_repository.get_messages(turn["conversation_id"], 1000, 0)
        message_repository.create_batch(
            turn["conversation_id"],
            user_id,
            [{**message, "conversation_id": turn["conversation_id"], "sequence_no": total}],
        )
        turn.update(
            {
                "status": "completed", "assistant_message_id": message["id"],
                "assistant_content_json": assistant_content_json,
                "updated_at": __import__("datetime").datetime.now().isoformat(),
                "completed_at": __import__("datetime").datetime.now().isoformat(),
            }
        )
        return dict(turn)

    def get(self, turn_id, user_id):
        turn = self._turns.get(turn_id)
        return dict(turn) if turn and turn["user_id"] == user_id else None

    def update(self, turn_id, user_id, **changes):
        turn = self._turns[turn_id]
        assert turn["user_id"] == user_id
        turn.update({key: value for key, value in changes.items() if value is not None})
        turn["updated_at"] = __import__("datetime").datetime.now().isoformat()
        if changes["status"] in {"completed", "failed", "cancelled"}:
            turn["completed_at"] = turn["updated_at"]
        return dict(turn)


class FakeMemoryRepository:
    """模拟 Memory 仓储"""

    def __init__(self):
        self._memories: dict[str, list[dict]] = {}
        self._saved_contents: dict[str, set[str]] = {}

    def _get_active(self, user_id: str):
        return [m for m in self._memories.get(user_id, []) if m["status"] != "deleted"]

    def save(self, user_id: str, memory_id: str, content: str,
             category: str = "fact", importance: int = 3,
             source: str = "user_explicit",
             source_conversation_id: str = None,
             idempotency_key: str = None):
        now = __import__("datetime").datetime.now().isoformat()
        normalized = content.strip().lower()

        saved = self._saved_contents.get(user_id, set())
        if normalized in saved:
            return None

        memory = {
            "id": memory_id or str(uuid.uuid4()),
            "user_id": user_id,
            "content": content.strip(),
            "normalized_content": normalized,
            "content_hash": f"test_{memory_id}",
            "category": category,
            "importance": importance,
            "source": source,
            "source_conversation_id": source_conversation_id,
            "status": "active",
            "index_status": "ready",
            "embedding_model": "",
            "embedding_version": 1,
            "created_at": now,
            "updated_at": now,
            "last_accessed_at": now,
            "expires_at": None,
        }
        if user_id not in self._memories:
            self._memories[user_id] = []
        self._memories[user_id].append(memory)
        saved.add(normalized)
        self._saved_contents[user_id] = saved
        return dict(memory)

    def search(self, user_id: str, query: str = "", options: dict = None):
        options = options or {}
        memories = self._get_active(user_id)

        if query and query.strip():
            query_lower = query.lower()
            memories = [m for m in memories if query_lower in m["content"].lower()]

        if options.get("category"):
            memories = [m for m in memories if m["category"] == options["category"]]

        memories = sorted(memories, key=lambda m: -m["importance"])
        limit = options.get("limit", 10)
        items = memories[:limit]
        search_items = [
            {
                "id": m["id"],
                "user_id": m["user_id"],
                "content": m["content"],
                "category": m["category"],
                "importance": m["importance"],
                "semantic_score": 0.0,
                "final_score": m["importance"] / 5,
                "created_at": m["created_at"],
                "updated_at": m["updated_at"],
                "source_conversation_id": m.get("source_conversation_id"),
            }
            for m in items
        ]
        return {"items": search_items, "degraded": True}

    def list(self, user_id: str, options: dict = None):
        options = options or {}
        memories = self._get_active(user_id)
        if options.get("category"):
            memories = [m for m in memories if m["category"] == options["category"]]
        memories = sorted(memories, key=lambda m: -m["importance"])
        return [dict(m) for m in memories[: options.get("limit", 50)]]

    def update(self, memory_id: str, changes: dict):
        for memories in self._memories.values():
            for m in memories:
                if m["id"] == memory_id and m["status"] != "deleted":
                    for key in ("content", "category", "importance"):
                        if key in changes:
                            m[key] = changes[key]
                    m["updated_at"] = __import__("datetime").datetime.now().isoformat()
                    if "content" in changes:
                        m["normalized_content"] = changes["content"].strip().lower()
                    return dict(m)
        return None

    def delete(self, memory_id: str):
        for memories in self._memories.values():
            for m in memories:
                if m["id"] == memory_id:
                    m["status"] = "deleted"
                    m["updated_at"] = __import__("datetime").datetime.now().isoformat()
                    return True
        return False

    def clear_user(self, user_id: str):
        memories = self._get_active(user_id)
        count = len(memories)
        for m in memories:
            m["status"] = "deleted"
            m["updated_at"] = __import__("datetime").datetime.now().isoformat()
        return count


class FakeRepositories:
    """完整的 Mock 仓储"""

    def __init__(self):
        self.profile = FakeProfileRepository()
        self.conversation = FakeConversationRepository()
        self.message = FakeMessageRepository()
        self.turn = FakeTurnRepository()
        self.memory = FakeMemoryRepository()


class FakeCloudflareMemoryClient:
    """模拟 CloudflareMemoryClient，将调用委托给 FakeRepositories"""

    def __init__(self):
        self._repos = FakeRepositories()

    def reset(self):
        """重置所有状态"""
        self._repos = FakeRepositories()

    # Profile
    async def get_profile(self, user_id: str):
        return self._repos.profile.get(user_id)

    async def put_profile(self, user_id: str, name: str = "", preferences=None):
        import json
        now = time.time()
        iso_now = __import__("datetime").datetime.fromtimestamp(now).isoformat()
        if user_id not in self._repos.profile._profiles:
            # Create new profile
            self._repos.profile._profiles[user_id] = {
                "user_id": user_id,
                "name": name,
                "preferences_json": json.dumps(preferences or {}),
                "created_at": iso_now,
                "updated_at": iso_now,
            }
        else:
            # Update existing profile (put = upsert)
            if name:
                self._repos.profile._profiles[user_id]["name"] = name
            if preferences is not None:
                self._repos.profile._profiles[user_id]["preferences_json"] = json.dumps(preferences)
            # Always update timestamp
            self._repos.profile._profiles[user_id]["updated_at"] = iso_now
        return dict(self._repos.profile._profiles[user_id])

    async def update_profile(self, user_id: str, name: str = "", preferences=None):
        return self._repos.profile.update(user_id, name, preferences)

    # Conversation
    async def create_conversation(
        self,
        user_id: str,
        title: str,
        mode: str = "chat",
        conversation_id: str = None,
    ):
        conversation = self._repos.conversation.create(user_id, title, mode)
        if conversation_id and conversation["id"] != conversation_id:
            self._repos.conversation._conversations.pop(conversation["id"], None)
            conversation["id"] = conversation_id
            self._repos.conversation._conversations[conversation_id] = conversation
        return conversation

    async def list_conversations(self, user_id: str, limit: int = 20, offset: int = 0):
        return self._repos.conversation.list(user_id, limit, offset)

    async def get_conversation(self, conversation_id: str):
        return self._repos.conversation.get(conversation_id)

    async def delete_conversation(self, conversation_id: str):
        return self._repos.conversation.delete(conversation_id)

    # Message
    async def create_messages_batch(self, conversation_id: str, user_id: str, messages: list[dict]):
        formatted = [
            {
                **message,
                "conversation_id": conversation_id,
                "user_id": user_id,
                "content_json": message.get("content_json", message.get("content", "")),
            }
            for message in messages
        ]
        return self._repos.message.create_batch(conversation_id, user_id, formatted)

    async def get_messages(
        self, conversation_id: str, limit: int = 50, offset: int = 0, direction: str = "asc"
    ):
        return self._repos.message.get_messages(conversation_id, limit, offset, direction)

    async def clear_messages(self, conversation_id: str):
        return self._repos.message.clear(conversation_id)

    async def create_or_get_turn(self, conversation_id, user_id, client_message_id, turn_id):
        return self._repos.turn.create_or_get(conversation_id, user_id, client_message_id, turn_id)

    async def begin_turn(self, conversation_id, user_id, client_message_id, content, turn_id, user_message_id):
        return self._repos.turn.begin(
            conversation_id, user_id, client_message_id, content, turn_id,
            user_message_id, self._repos.message,
        )

    async def complete_turn(self, turn_id, user_id, message, assistant_content_json):
        return self._repos.turn.complete(
            turn_id, user_id, message, assistant_content_json, self._repos.message
        )

    async def get_turn(self, turn_id, user_id):
        return self._repos.turn.get(turn_id, user_id)

    async def update_turn(self, turn_id, user_id, **changes):
        return self._repos.turn.update(turn_id, user_id, **changes)

    # Memory
    async def save_memory(self, user_id: str, memory_id: str, content: str,
                          category: str = "fact", importance: int = 3,
                          source: str = "user_explicit",
                          source_conversation_id: str = None,
                          idempotency_key: str = None):
        return self._repos.memory.save(user_id, memory_id, content, category, importance,
                                        source, source_conversation_id, idempotency_key)

    async def search_memories(self, user_id: str, query: str = "", category: str = None,
                               limit: int = 10, min_score: float = 0.65):
        options = {"limit": limit}
        if category:
            options["category"] = category
        return self._repos.memory.search(user_id, query, options)

    async def list_memories(self, user_id: str, category: str = None, limit: int = 50):
        options = {"limit": limit}
        if category:
            options["category"] = category
        return self._repos.memory.list(user_id, options)

    async def update_memory(self, user_id: str, memory_id: str, content: str = None, category: str = None,
                            importance: int = None):
        changes = {}
        if content is not None:
            changes["content"] = content
        if category is not None:
            changes["category"] = category
        if importance is not None:
            changes["importance"] = importance
        return self._repos.memory.update(memory_id, changes)

    async def delete_memory(self, user_id: str, memory_id: str):
        return self._repos.memory.delete(memory_id)

    async def clear_user_memories(self, user_id: str):
        return self._repos.memory.clear_user(user_id)

    # Document
    async def upload_document(self, user_id: str, filename: str, content: str, file_type: str = None, category: str = "general") -> dict:
        doc_id = f"doc_{hash(filename) % 10**8}"
        return {
            "id": doc_id,
            "user_id": user_id,
            "name": filename,
            "filename": filename,
            "file_type": file_type,
            "size": len(content),
            "category": category,
            "status": "indexed",
            "chunk_count": 3,
            "created_at": __import__("datetime").datetime.now().isoformat(),
            "updated_at": __import__("datetime").datetime.now().isoformat(),
            "deleted_at": None,
        }

    async def list_documents(self, user_id: str, limit: int = 20, offset: int = 0, category: str = None) -> dict:
        return {"documents": [], "total": 0}

    async def get_document(self, document_id: str) -> dict | None:
        return None

    async def delete_document(self, document_id: str) -> bool:
        return True

    async def reindex_document(self, document_id: str) -> dict:
        return {"chunk_count": 3, "degraded": False}

    async def search_documents(self, user_id: str, query: str, limit: int = 5, min_score: float = 0.6, document_ids: list[str] = None) -> dict:
        return {"results": [], "degraded": False}


# ============ 全局 fake 实例 ============

_fake_client = FakeCloudflareMemoryClient()


class _FakeClientClass:
    """伪装成 CloudflareMemoryClient 的工厂类"""
    def __new__(cls, *args, **kwargs):
        return _fake_client


@pytest.fixture
def mock_settings(monkeypatch):
    """Mock settings to avoid requiring real API keys"""
    import src.config.settings as settings_module
    monkeypatch.setattr(settings_module, "settings", settings_module.Settings(
        openai_api_key="test-key",
        openai_model="gpt-4o-mini",
        openai_base_url="https://api.openai.com/v1",
        image_api_key="test-image-key",
        image_base_url="https://api.cloudflare.com/client/v4/accounts/test-account/ai/run",
        image_model="@cf/black-forest-labs/flux-2-klein-9b",
        anthropic_api_key="test-anthropic-key",
        anthropic_model="claude-3-5-haiku-20241022",
        host="0.0.0.0",
        port=6002,
    ))


@pytest.fixture(autouse=True)
def mock_repositories(monkeypatch):
    """Mock CloudflareMemoryClient 返回 FakeCloudflareMemoryClient"""
    from src.config.settings import settings

    # 重置 fake client 状态，确保测试隔离
    _fake_client.reset()
    # 绝大多数服务测试验证的是已 mock 的 Cloudflare 持久化路径，不能受本地 .env 影响。
    monkeypatch.setattr(settings, "memory_enabled", True)

    # Patch CloudflareMemoryClient at its source module.
    # get_repositories() does late import: from src.clients.memory_gateway import CloudflareMemoryClient
    monkeypatch.setattr("src.clients.memory_gateway.CloudflareMemoryClient", _FakeClientClass)
    # 重置模块级缓存，确保下次调用使用 patched client
    monkeypatch.setattr("src.repositories._repositories", None, raising=False)
    monkeypatch.setattr("src.services._conversations", {}, raising=False)
    monkeypatch.setattr("src.memory._checkpointer", None, raising=False)
    monkeypatch.setattr("src.memory._memory_saver", None, raising=False)

    from src.agents.graph_agents import invalidate_tool_agent_cache

    invalidate_tool_agent_cache()

    return _fake_client
