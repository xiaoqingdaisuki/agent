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
    SessionMemoryStore,
    get_session_store,
)
from src.tools.memory_user import (
    memory_user_search,
    memory_user_save,
    _USER_SEARCH_DESCRIPTOR,
    _USER_SAVE_DESCRIPTOR,
    UserMemoryStore,
    get_user_memory_store,
)


@pytest.fixture(autouse=True)
def reset_stores():
    """每个测试前清空存储"""
    get_session_store()
    # SessionMemoryStore 没有 clear 方法，但我们用新实例
    yield


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


class TestSessionMemoryStore:
    def test_add_and_get(self):
        store = SessionMemoryStore()
        store.add("conv1", "user", "Hello")
        store.add("conv1", "assistant", "Hi there!")
        msgs = store.get("conv1")
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"
        assert msgs[0]["content"] == "Hello"

    def test_search_by_query(self):
        store = SessionMemoryStore()
        store.add("conv1", "user", "What is Python?")
        store.add("conv1", "assistant", "Python is a programming language.")
        store.add("conv1", "user", "What is TypeScript?")
        results = store.search("conv1", "Python")
        assert len(results) >= 1  # 包含Python的结果
        assert all("Python" in r["content"] for r in results)

    def test_empty_search_returns_recent(self):
        store = SessionMemoryStore()
        store.add("conv1", "user", "msg1")
        store.add("conv1", "user", "msg2")
        store.add("conv1", "user", "msg3")
        results = store.search("conv1", "", 2)
        assert len(results) == 2
        assert results[0]["content"] == "msg2"  # 最近2条

    def test_nonexistent_conversation(self):
        store = SessionMemoryStore()
        assert store.get("nonexistent") == []
        assert store.search("nonexistent", "query") == []


class TestUserMemoryStore:
    def test_add_memory(self):
        store = UserMemoryStore()
        mem = store.add("user1", "Likes pizza", "preference", 4)
        assert mem["content"] == "Likes pizza"
        assert mem["category"] == "preference"
        assert mem["importance"] == 4
        assert mem["source"] == "user_explicit"
        assert "id" in mem

    def test_search_memories(self):
        store = UserMemoryStore()
        store.add("user1", "Likes pizza", "preference")
        store.add("user1", "Likes coding", "preference")
        store.add("user1", "Is a developer", "fact")
        results = store.search("user1", "likes")
        assert len(results) == 2

    def test_search_by_category(self):
        store = UserMemoryStore()
        store.add("user1", "Likes pizza", "preference")
        store.add("user1", "Is a developer", "fact")
        results = store.search("user1", "", category="fact")
        assert len(results) == 1
        assert results[0]["category"] == "fact"

    def test_delete_memory(self):
        store = UserMemoryStore()
        mem = store.add("user1", "Temp info", "fact")
        assert store.delete("user1", mem["id"]) is True
        assert store.delete("user1", mem["id"]) is False  # already deleted

    def test_list_all(self):
        store = UserMemoryStore()
        store.add("user1", "Info A", "fact", 1)
        store.add("user1", "Info B", "fact", 5)
        store.add("user1", "Pref C", "preference", 3)
        all_mems = store.list_all("user1")
        # 应该按重要性排序
        assert all_mems[0]["importance"] >= all_mems[-1]["importance"]


class TestMemoryTools:
    @pytest.mark.asyncio
    async def test_session_search_returns_string(self):
        result = await memory_session_search.ainvoke({"conversation_id": "test"})
        assert isinstance(result, str)

    @pytest.mark.asyncio
    async def test_user_search_returns_string(self):
        result = await memory_user_search.ainvoke({"user_id": "test_user"})
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
            "content": "Unique test memory 12345",
        })
        r2 = await memory_user_save.ainvoke({
            "user_id": "dedup_user",
            "content": "Unique test memory 12345",
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
        store = get_user_memory_store()
        assert store.search(victim, "scoped secret") == []
        assert len(store.search(owner, "scoped secret")) == 1
