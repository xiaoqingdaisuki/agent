"""
memory.session — 会话记忆管理

提供当前会话/对话的上下文检索能力。
基于 LangGraph checkpoint 或内存存储。
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


# ============ Tool Descriptor ============

_SESSION_DESCRIPTOR = ToolDescriptor(
    name="memory.session.search",
    version="1.0.0",
    title="会话记忆搜索",
    description="在当前会话中搜索之前的对话内容。当需要回顾用户之前说过的话、或查找之前的回答时使用。返回匹配的对话片段。",
    category="MEMORY",
    risk_level="R1",
    side_effect="read",
    timeout_ms=5000,
    required_permissions=["memory.session.read"],
    data_classification=["internal"],
    owner="memory",
    tags=["memory", "session", "conversation"],
)


# ============ 会话记忆存储（内存） ============

class SessionMemoryStore:
    """会话记忆存储 — 基于内存 Map（生产环境可替换为 Redis/数据库）"""

    # 初始化会话记忆存储
    def __init__(self):
        self._sessions: dict[str, list[dict]] = {}

    def get(self, conversation_id: str) -> list[dict]:
        return self._sessions.get(conversation_id, [])

    def add(self, conversation_id: str, role: str, content: str) -> None:
        if conversation_id not in self._sessions:
            self._sessions[conversation_id] = []
        self._sessions[conversation_id].append({
            "role": role,
            "content": content,
        })

    def search(self, conversation_id: str, query: str, max_results: int = 5) -> list[dict]:
        """简单关键词搜索（后续可替换为向量搜索）"""
        messages = self._sessions.get(conversation_id, [])
        if not query:
            return messages[-max_results:]

        query_lower = query.lower()
        results = []
        for msg in messages:
            if query_lower in msg["content"].lower():
                results.append(msg)
                if len(results) >= max_results:
                    break
        return results


_session_store = SessionMemoryStore()


# 获取全局会话存储实例
def get_session_store() -> SessionMemoryStore:
    return _session_store


# ============ LangChain Tool ============

class SessionSearchInput(BaseModel):
    conversation_id: str = Field(description="会话 ID，用于标识当前对话")
    query: str = Field(default="", description="搜索关键词，留空则返回最近的对话")
    max_results: int = Field(default=5, description="最多返回几条结果", ge=1, le=20)


# 在当前会话中搜索之前的对话内容
@tool(args_schema=SessionSearchInput)
def memory_session_search(
    conversation_id: str,
    query: str = "",
    max_results: int = 5,
    runtime: ToolRuntime = None,
) -> str:
    """在当前会话中搜索之前的对话内容。当需要回顾用户之前说过的话或查找之前的回答时使用。"""
    scoped_conversation_id = (
        runtime.config.get("configurable", {}).get("thread_id")
        if runtime is not None
        else conversation_id
    )
    if not scoped_conversation_id:
        return "📝 未提供当前会话上下文，无法读取会话记忆。"
    if runtime is not None:
        messages = runtime.state.get("messages", [])
        normalized = [
            {
                "role": "user" if message.type == "human" else "assistant",
                "content": message.content if isinstance(message.content, str) else str(message.content),
            }
            for message in messages
            if message.type in {"human", "ai"}
        ]
        query_lower = query.lower()
        results = [
            message
            for message in normalized
            if not query or query_lower in message["content"].lower()
        ][-max_results:]
    else:
        store = get_session_store()
        results = store.search(scoped_conversation_id, query, max_results)

    if not results:
        return "📝 当前会话中未找到相关内容。"

    lines = [f"📝 会话记忆（{scoped_conversation_id}）— 找到 {len(results)} 条：\n"]
    for i, msg in enumerate(results, 1):
        role = "用户" if msg["role"] == "user" else "助手"
        lines.append(f"[{i}] {role}：{msg['content'][:200]}")
        lines.append("")

    return "\n".join(lines)


# ============ 导出 ============

__all__ = ["_SESSION_DESCRIPTOR", "SessionMemoryStore", "SessionSearchInput", "get_session_store", "memory_session_search"]
