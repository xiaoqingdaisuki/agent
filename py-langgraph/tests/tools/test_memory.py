"""
Tests for memory.session and memory.user Tools
"""

import pytest
from langchain_core.messages import AIMessage
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode

from src.agents.base import AgentState, _scope_memory_tool_call
from src.tools.memory_session import (
    memory_session_search,
    _SESSION_DESCRIPTOR,
)
from src.tools.memory_user import (
    memory_user_search,
    memory_user_save,
    _USER_SEARCH_DESCRIPTOR,
    _USER_SAVE_DESCRIPTOR,
)


class TestSessionMemoryDescriptor:
    def test_name(self):
        assert _SESSION_DESCRIPTOR.name == "memory.session.search"

    def test_category(self):
        assert _SESSION_DESCRIPTOR.category == "MEMORY"

    def test_risk_level(self):
        assert _SESSION_DESCRIPTOR.risk_level == "R1"

    def test_side_effect(self):
        assert _SESSION_DESCRIPTOR.side_effect == "read"

    def test_permissions(self):
        assert "memory.session.read" in _SESSION_DESCRIPTOR.required_permissions


class TestUserMemoryDescriptor:
    def test_search_name(self):
        assert _USER_SEARCH_DESCRIPTOR.name == "memory.user.search"

    def test_save_name(self):
        assert _USER_SAVE_DESCRIPTOR.name == "memory.user.save"

    def test_save_risk_level(self):
        assert _USER_SAVE_DESCRIPTOR.risk_level == "R2"

    def test_save_side_effect(self):
        assert _USER_SAVE_DESCRIPTOR.side_effect == "write"

    def test_save_permissions(self):
        assert "memory.user.write" in _USER_SAVE_DESCRIPTOR.required_permissions

    def test_pii_classification(self):
        assert "pii" in _USER_SEARCH_DESCRIPTOR.data_classification


class TestMemoryTools:
    @pytest.mark.asyncio
    async def test_session_search_returns_string(self):
        result = await memory_session_search.ainvoke({
            "conversation_id": "test-conv",
        })
        assert isinstance(result, str)

    @pytest.mark.asyncio
    async def test_user_search_returns_string(self):
        result = await memory_user_search.ainvoke({
            "user_id": "test_user",
        })
        assert isinstance(result, str)
        assert "未找到" in result or "记忆" in result

    @pytest.mark.asyncio
    async def test_user_save_returns_string(self):
        result = await memory_user_save.ainvoke({
            "user_id": "test_user",
            "content": "Likes coffee",
        })
        assert isinstance(result, str)
        assert "已保存" in result or "已存在" in result

    @pytest.mark.asyncio
    async def test_user_save_dedup(self):
        """保存相同内容应该去重"""
        r1 = await memory_user_save.ainvoke({
            "user_id": "dedup_user",
            "content": "Unique memory 99999",
        })
        r2 = await memory_user_save.ainvoke({
            "user_id": "dedup_user",
            "content": "Unique memory 99999",
        })
        assert "已保存" in r1
        assert "已存在" in r2

    @pytest.mark.asyncio
    async def test_agent_cannot_override_injected_user_id(self):
        owner = "injected_owner"
        victim = "model_supplied_victim"
        builder = StateGraph(AgentState)
        builder.add_node(
            "tools",
            ToolNode([memory_user_save], wrap_tool_call=_scope_memory_tool_call),
        )
        builder.add_edge(START, "tools")
        builder.add_edge("tools", END)
        graph = builder.compile()
        await graph.ainvoke(
            {
                "user_id": owner,
                "messages": [AIMessage(content="", tool_calls=[{
                    "name": "memory_user_save",
                    "args": {"user_id": victim, "content": "scoped secret"},
                    "id": "call-scope-test",
                    "type": "tool_call",
                }])],
            },
            config={"configurable": {"thread_id": "scope-test"}},
        )
        # 验证：应该保存在 owner 下，而非 victim
        from src.repositories import get_repositories
        repos = get_repositories()
        victim_memories = repos.list_memories(victim)
        assert not any("scoped secret" in m["content"] for m in victim_memories)
        owner_memories = repos.list_memories(owner)
        assert any("scoped secret" in m["content"] for m in owner_memories)
