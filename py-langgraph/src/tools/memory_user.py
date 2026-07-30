"""
memory.user — 用户长期记忆管理

提供用户记忆的搜索和保存能力。
基于 Profile/Memory 服务。
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState
from pydantic import BaseModel, Field

from src.tools.contracts import (
    ToolCategory,
    ToolDescriptor,
    SideEffect,
)


# ============ Tool Descriptor ============

_USER_SEARCH_DESCRIPTOR = ToolDescriptor(
    name="memory.user.search",
    version="1.0.0",
    title="用户记忆搜索",
    description="搜索当前用户的长期记忆。当需要了解用户的偏好、习惯、个人信息等持久化记忆时使用。返回匹配的记忆条目。",
    category="MEMORY",
    risk_level="R1",
    side_effect="read",
    timeout_ms=5000,
    required_permissions=["memory.user.read"],
    data_classification=["pii"],
    owner="memory",
    tags=["memory", "user", "profile"],
)

_USER_SAVE_DESCRIPTOR = ToolDescriptor(
    name="memory.user.save",
    version="1.0.0",
    title="保存用户记忆",
    description="保存一条关于用户的重要信息到长期记忆。只有用户明确表达或有长期价值的信息才应该保存。自动去重和合并相似记忆。",
    category="MEMORY",
    risk_level="R2",
    side_effect="write",
    timeout_ms=5000,
    required_permissions=["memory.user.write"],
    data_classification=["pii"],
    owner="memory",
    tags=["memory", "user", "profile"],
)


# ============ 用户记忆存储 ============

class UserMemoryStore:
    """用户记忆存储 — 基于内存（生产环境可替换为数据库）"""

    def __init__(self):
        self._memories: dict[str, list[dict]] = {}

    def add(self, user_id: str, content: str, category: str = "fact", importance: int = 3) -> dict:
        """添加一条记忆"""
        memory = {
            "id": f"mem_{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
            "user_id": user_id,
            "content": content,
            "category": category,
            "importance": importance,
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
            "source": "user_explicit",
        }
        if user_id not in self._memories:
            self._memories[user_id] = []
        self._memories[user_id].append(memory)
        return memory

    def search(self, user_id: str, query: str = "", category: str = "", max_results: int = 10) -> list[dict]:
        """搜索用户记忆"""
        memories = self._memories.get(user_id, [])

        # 按类别过滤
        if category:
            memories = [m for m in memories if m["category"] == category]

        # 按重要性排序
        memories = sorted(memories, key=lambda m: -m["importance"])

        # 关键词过滤
        if query:
            query_lower = query.lower()
            memories = [m for m in memories if query_lower in m["content"].lower()]

        return memories[:max_results]

    def delete(self, user_id: str, memory_id: str) -> bool:
        """删除一条记忆"""
        memories = self._memories.get(user_id, [])
        for i, m in enumerate(memories):
            if m["id"] == memory_id:
                memories.pop(i)
                return True
        return False

    def list_all(self, user_id: str, category: str = "") -> list[dict]:
        """列出用户所有记忆"""
        memories = self._memories.get(user_id, [])
        if category:
            memories = [m for m in memories if m["category"] == category]
        return sorted(memories, key=lambda m: -m["importance"])


_user_memory_store = UserMemoryStore()


def get_user_memory_store() -> UserMemoryStore:
    return _user_memory_store


# ============ LangChain Tool: memory.user.search ============

class UserSearchInput(BaseModel):
    user_id: str = Field(description="用户 ID")
    query: str = Field(default="", description="搜索关键词，留空则返回所有记忆")
    category: str = Field(default="", description="记忆类别过滤：preference / fact / decision / context")
    max_results: int = Field(default=10, description="最多返回条数", ge=1, le=50)


@tool(args_schema=UserSearchInput)
def memory_user_search(
    user_id: str,
    query: str = "",
    category: str = "",
    max_results: int = 10,
    state: Annotated[dict, InjectedState()] = None,
) -> str:
    """搜索当前用户的长期记忆。当需要了解用户的偏好、习惯、个人信息等持久化记忆时使用。"""
    scoped_user_id = state.get("user_id") if state is not None else user_id
    if not scoped_user_id:
        return "🧠 未提供已认证的用户上下文，无法读取长期记忆。"
    store = get_user_memory_store()
    results = store.search(scoped_user_id, query, category, max_results)

    if not results:
        return "🧠 未找到相关记忆。"

    lines = [f"🧠 用户记忆（{scoped_user_id}）— {len(results)} 条：\n"]
    for i, m in enumerate(results, 1):
        lines.append(f"[{i}] [{m['category']}] {m['content']}")
        lines.append(f"    重要性：{m['importance']} | 来源：{m.get('source', 'unknown')}")
        lines.append("")

    return "\n".join(lines)


# ============ LangChain Tool: memory.user.save ============

class UserSaveInput(BaseModel):
    user_id: str = Field(description="用户 ID")
    content: str = Field(description="要保存的记忆内容，简洁明确", max_length=200)
    category: str = Field(default="fact", description="记忆类别：preference / fact / decision / context")
    importance: int = Field(default=3, description="重要性 1-5，越高越重要", ge=1, le=5)


@tool(args_schema=UserSaveInput)
def memory_user_save(
    user_id: str,
    content: str,
    category: str = "fact",
    importance: int = 3,
    state: Annotated[dict, InjectedState()] = None,
) -> str:
    """保存一条关于用户的重要信息到长期记忆。只有用户明确表达或有长期价值的信息才应该保存。"""
    scoped_user_id = state.get("user_id") if state is not None else user_id
    if not scoped_user_id:
        return "🧠 未提供已认证的用户上下文，无法保存长期记忆。"
    store = get_user_memory_store()

    # 检查是否已有相似记忆（用完整内容精确匹配）
    existing = store.search(scoped_user_id, "", max_results=100)
    content_lower = content.strip().lower()
    for m in existing:
        if content_lower == m["content"].lower().strip():
            return f"🧠 记忆已存在（ID: {m['id']}），未重复保存。"

    memory = store.add(scoped_user_id, content, category, importance)
    return f"🧠 已保存记忆（ID: {memory['id']}）：{content}"


# ============ 导出 ============

__all__ = [
    "_USER_SAVE_DESCRIPTOR",
    "_USER_SEARCH_DESCRIPTOR",
    "UserMemoryStore",
    "UserSaveInput",
    "UserSearchInput",
    "get_user_memory_store",
    "memory_user_save",
    "memory_user_search",
]
