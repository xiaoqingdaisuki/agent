"""
memory.session — 会话记忆管理

提供当前会话/对话的上下文检索能力。
统一通过 Repository 层访问当前配置的存储后端。
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool
from langgraph.prebuilt.tool_node import ToolRuntime
from pydantic import BaseModel, Field

from src.tools.contracts import (
    ToolCategory,
    ToolDescriptor,
    SideEffect,
)
from src.repositories import get_repositories


# ============ Tool Descriptor ==========

_SESSION_DESCRIPTOR = ToolDescriptor(
    name="memory.session.search",
    version="1.0.0",
    title="会话记忆搜索",
    description="在当前会话中搜索之前的对话内容。当需要回顾用户之前说过的话、或查找之前的回答时使用。返回匹配的对话片段。",
    category="MEMORY",
    risk_level="R1",
    side_effect="read",
    timeout_ms=15000,
    required_permissions=["memory.session.read"],
    data_classification=["internal"],
    owner="memory",
    tags=["memory", "session", "conversation"],
)


# ============ LangChain Tool ==========


class SessionSearchInput(BaseModel):
    conversation_id: str = Field(description="会话 ID，用于标识当前对话")
    query: str = Field(default="", description="搜索关键词，留空则返回最近的对话")
    max_results: int = Field(default=5, description="最多返回几条结果", ge=1, le=20)


# 在当前会话中搜索之前的对话内容
@tool(args_schema=SessionSearchInput)
# 执行 memory session search 对应的业务逻辑
def memory_session_search(
    conversation_id: str,
    query: str = "",
    max_results: int = 5,
    runtime: Any = None,
) -> str:
    """在当前会话中搜索之前的对话内容。当需要回顾用户之前说过的话或查找之前的回答时使用。"""
    scoped_conversation_id = conversation_id
    if runtime is not None:
        thread_id = runtime.config.get("configurable", {}).get("thread_id")
        if thread_id:
            scoped_conversation_id = thread_id

    if not scoped_conversation_id:
        return "📝 未提供当前会话上下文，无法读取会话记忆。"

    repos = get_repositories()

    try:
        messages_data, _ = repos.get_messages(scoped_conversation_id, limit=max_results * 5)
        query_lower = query.lower()
        results = [
            {"role": m.get("role", "user"), "content": m.get("content_json", "")}
            for m in messages_data
            if not query or query_lower in m.get("content_json", "").lower()
        ][-max_results:]
    except Exception:
        return "📝 会话记忆查询失败。"

    if not results:
        return "📝 当前会话中未找到相关内容。"

    lines = [f"📝 会话记忆（{scoped_conversation_id}）— 找到 {len(results)} 条：\n"]
    for i, msg in enumerate(results, 1):
        role = "用户" if msg["role"] == "user" else "助手"
        content = msg["content"][:200] if len(msg["content"]) > 200 else msg["content"]
        lines.append(f"[{i}] {role}：{content}")
        lines.append("")

    return "\n".join(lines)


# ============ 导出 ==========

__all__ = [
    "_SESSION_DESCRIPTOR",
    "SessionSearchInput",
    "memory_session_search",
]
