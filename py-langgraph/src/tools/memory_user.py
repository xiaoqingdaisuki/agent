"""
memory.user — 用户长期记忆管理

提供用户记忆的搜索和保存能力。
统一通过 Repository 层访问当前配置的存储后端。
"""

from __future__ import annotations

from datetime import datetime
import json
from typing import Annotated, Any

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState
from pydantic import BaseModel, Field

from src.tools.contracts import (
    ToolCategory,
    ToolDescriptor,
    SideEffect,
)
from src.repositories import get_repositories
from src.tools.runtime.executor import get_tool_call_context


# ============ Tool Descriptor ==========

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

_USER_LIST_DESCRIPTOR = ToolDescriptor(
    name="memory.user.list",
    version="1.0.0",
    title="查看用户记忆",
    description="列出当前用户已保存的长期记忆，返回记忆 ID、内容和类别。",
    category="MEMORY",
    risk_level="R1",
    side_effect="read",
    timeout_ms=5000,
    required_permissions=["memory.user.read"],
    data_classification=["pii"],
    owner="memory",
    tags=["memory", "user", "list"],
)

_USER_DELETE_DESCRIPTOR = ToolDescriptor(
    name="memory.user.delete",
    version="1.0.0",
    title="删除用户记忆",
    description="按精确 memory_id 删除当前用户的长期记忆。禁止根据模糊语义直接批量删除。",
    category="MEMORY",
    risk_level="R2",
    side_effect="write",
    timeout_ms=10000,
    required_permissions=["memory.user.write"],
    data_classification=["pii"],
    owner="memory",
    tags=["memory", "user", "delete"],
)


# ============ LangChain Tool: memory.user.search ==========


class UserSearchInput(BaseModel):
    user_id: str = Field(description="用户 ID")
    query: str = Field(default="", description="搜索关键词，留空则返回所有记忆")
    category: str = Field(
        default="", description="记忆类别过滤：preference / fact / decision / context"
    )
    max_results: int = Field(default=10, description="最多返回条数", ge=1, le=50)


# 搜索当前用户的长期记忆
@tool(args_schema=UserSearchInput)
# 执行 memory user search 对应的业务逻辑
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

    repos = get_repositories()

    try:
        if category:
            # 按类别精确查询
            items = repos.list_memories(scoped_user_id, category=category, limit=max_results)
        else:
            # 语义搜索
            result = repos.search_memories(scoped_user_id, query or " ", category=None, limit=max_results)
            items = result.get("items", [])

        if not items:
            return "🧠 未找到相关记忆。"

        lines = [f"🧠 用户记忆（{scoped_user_id}）— {len(items)} 条：\n"]
        for i, m in enumerate(items, 1):
            lines.append(f"[{i}] [{m.get('category', '')}] {m.get('content', '')}")
            lines.append(f"    重要性：{m.get('importance', 0)}")
            lines.append("")
        return "\n".join(lines)
    except Exception as e:
        return f"🧠 记忆搜索失败：{e}"


# ============ LangChain Tool: memory.user.save ==========


class UserSaveInput(BaseModel):
    user_id: str = Field(description="用户 ID")
    content: str = Field(description="要保存的记忆内容，简洁明确", max_length=200)
    category: str = Field(
        default="fact", description="记忆类别：preference / fact / decision / context"
    )
    importance: int = Field(default=3, description="重要性 1-5，越高越重要", ge=1, le=5)


class UserListInput(BaseModel):
    """列出用户记忆的输入模型。"""

    category: str = Field(default="", description="可选的记忆类别过滤")
    max_results: int = Field(default=50, description="最多返回条数", ge=1, le=100)


class UserDeleteInput(BaseModel):
    """删除用户记忆的输入模型。"""

    memory_ids: list[str] = Field(min_length=1, max_length=20, description="要删除的精确记忆 ID 列表")


# 保存一条关于用户的重要信息到长期记忆
@tool(args_schema=UserSaveInput)
# 执行 memory user save 对应的业务逻辑
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

    repos = get_repositories()

    try:
        data = repos.save_memory(scoped_user_id, content.strip(), category, importance)
        if data is None:
            return "🧠 记忆已存在（内容重复），未重复保存。"
        return f"🧠 已保存记忆（ID: {data.get('id', '')}）：{content}"
    except Exception as e:
        return f"🧠 记忆保存失败：{e}"


# 获取当前工具调用的可信用户 ID。
def _scoped_user_id() -> str | None:
    context = get_tool_call_context()
    return context.user_id if context is not None and context.user_id else None


# 将长期记忆转换为面向对话的最小公开字段。
def _public_memory(memory: dict[str, Any]) -> dict[str, str]:
    return {
        "memory_id": str(memory.get("id", "")),
        "content": str(memory.get("content", "")),
        "category": str(memory.get("category", "")),
    }


# 列出当前可信用户的长期记忆。
@tool(args_schema=UserListInput)
# 执行 memory user list 对应的业务逻辑
def memory_user_list(category: str = "", max_results: int = 50) -> str:
    """查看当前用户保存了哪些长期记忆。"""
    user_id = _scoped_user_id()
    if not user_id:
        return json.dumps({"memories": [], "error": "缺少可信用户上下文"}, ensure_ascii=False)
    try:
        memories = get_repositories().list_memories(
            user_id,
            category=category or None,
            limit=max_results,
        )
        return json.dumps({"memories": [_public_memory(memory) for memory in memories]}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"memories": [], "error": f"长期记忆读取失败：{exc!s}"}, ensure_ascii=False)


# 按精确 ID 删除当前可信用户的长期记忆。
@tool(args_schema=UserDeleteInput)
# 执行 memory user delete 对应的业务逻辑
def memory_user_delete(memory_ids: list[str]) -> str:
    """按精确 memory_id 删除当前用户的长期记忆。"""
    user_id = _scoped_user_id()
    if not user_id:
        return json.dumps({"deleted": [], "error": "缺少可信用户上下文"}, ensure_ascii=False)
    if len(set(memory_ids)) != len(memory_ids):
        return json.dumps({"deleted": [], "error": "memory_ids 不能重复"}, ensure_ascii=False)
    try:
        deleted = [
            memory_id
            for memory_id in memory_ids
            if get_repositories().delete_memory(user_id, memory_id)
        ]
        return json.dumps({"deleted": deleted}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"deleted": [], "error": f"长期记忆删除失败：{exc!s}"}, ensure_ascii=False)


# ============ 导出 ==========

__all__ = [
    "_USER_SAVE_DESCRIPTOR",
    "_USER_SEARCH_DESCRIPTOR",
    "UserDeleteInput",
    "UserListInput",
    "UserSaveInput",
    "UserSearchInput",
    "memory_user_delete",
    "memory_user_list",
    "memory_user_save",
    "memory_user_search",
]
