import asyncio

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import MemorySaver

from src.agents import graph_agents


class ToolCapableFakeModel(FakeMessagesListChatModel):
    bound_tool_names: list[str] = []

    def bind_tools(self, tools, **kwargs):
        self.bound_tool_names = [tool.name for tool in tools]
        return self


async def test_tool_agent_binds_tools_and_preserves_the_full_message_chain(monkeypatch):
    model = ToolCapableFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "calculator",
                        "args": {"expression": "2 + 2"},
                        "id": "call_calc_1",
                    }
                ],
            ),
            AIMessage(content="4"),
        ]
    )
    monkeypatch.setattr(graph_agents, "get_llm", lambda provider="openai": model)

    agent = graph_agents.build_tool_agent(checkpointer=MemorySaver())
    result = await agent.ainvoke(
        {"messages": [HumanMessage(content="2 + 2?")]},
        config={"configurable": {"thread_id": "tool-chain"}},
    )

    assert "calculator" in model.bound_tool_names
    assert [message.type for message in result["messages"]] == [
        "human",
        "ai",
        "tool",
        "ai",
    ]
    assert result["messages"][-1].content == "4"


@pytest.mark.asyncio
async def test_memory_gateway_timeout_does_not_block_agent_node(monkeypatch):
    """记忆网关变慢时，Agent 仍应在短时限内继续请求模型。"""
    from src.profile.service import MemoryService

    async def slow_context(_user_id):
        await asyncio.sleep(0.5)
        return "[记忆] slow"

    monkeypatch.setattr(MemoryService, "build_memory_context_async", slow_context)

    result = await asyncio.wait_for(
        graph_agents._load_memory_context("slow-user"),
        timeout=0.8,
    )

    assert result == ""


@pytest.mark.asyncio
async def test_concurrent_memory_timeouts_cancel_all_gateway_requests(monkeypatch):
    """并发慢 Gateway 必须被取消，不能遗留线程池任务拖慢后续对话。"""
    from src.profile.service import MemoryService

    cancelled = 0

    async def slow_context(_user_id):
        nonlocal cancelled
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled += 1
            raise
        return "[记忆] slow"

    monkeypatch.setattr(MemoryService, "build_memory_context_async", slow_context)

    results = await asyncio.gather(
        *(graph_agents._load_memory_context(f"slow-user-{index}") for index in range(20))
    )

    assert results == [""] * 20
    assert cancelled == 20


def test_direct_chat_routing_skips_tools_only_for_clear_casual_messages():
    """简单闲聊应走快速路径，实时与工具类请求仍需完整 Agent。"""
    assert graph_agents.is_direct_chat_message("你好") is True
    assert graph_agents.is_direct_chat_message("你是谁？") is True
    assert graph_agents.is_direct_chat_message("上海今天的天气") is False
    assert graph_agents.is_direct_chat_message("搜索今天的新闻") is False


async def test_tool_agent_executes_invoke_name_xml_calls(monkeypatch):
    """The provider invoke/name XML format must enter the normal tool graph."""
    model = ToolCapableFakeModel(
        responses=[
            AIMessage(
                content=(
                    '<invoke name="calculator">'
                    '<parameter name="expression">2 + 2</parameter>'
                    "</invoke>"
                )
            ),
            AIMessage(content="4"),
        ]
    )
    monkeypatch.setattr(graph_agents, "get_llm", lambda provider="openai": model)

    agent = graph_agents.build_tool_agent(checkpointer=MemorySaver())
    result = await agent.ainvoke(
        {"messages": [HumanMessage(content="2 + 2?")]},
        config={"configurable": {"thread_id": "invoke-xml-chain"}},
    )

    assert result["messages"][1].tool_calls[0]["name"] == "calculator"
    assert result["messages"][1].tool_calls[0]["args"] == {"expression": "2 + 2"}
    assert result["messages"][-1].content == "4"


def test_agent_graph_is_cached(monkeypatch):
    model = ToolCapableFakeModel(responses=[AIMessage(content="done")])
    monkeypatch.setattr(graph_agents, "get_llm", lambda provider="openai": model)
    graph_agents.invalidate_tool_agent_cache()

    first = graph_agents.build_tool_agent()
    second = graph_agents.build_tool_agent()

    assert second is first
    graph_agents.invalidate_tool_agent_cache()


def test_tool_limit_is_counted_once_per_requested_tool():
    messages = [HumanMessage(content="research this")]
    for index in range(graph_agents.MAX_TOOL_CALLS):
        call_id = f"call_{index}"
        messages.extend(
            [
                AIMessage(
                    content="",
                    tool_calls=[{"name": "web_search", "args": {}, "id": call_id}],
                ),
                ToolMessage(content="result", tool_call_id=call_id),
            ]
        )

    pending_id = "call_pending"
    messages.append(
        AIMessage(
            content="",
            tool_calls=[{"name": "web_search", "args": {}, "id": pending_id}],
        )
    )

    assert graph_agents.should_continue({"messages": messages[:-3] + [messages[-1]]}) == "tools"
    assert graph_agents.should_continue({"messages": messages}) == "limit"


def test_history_trimming_keeps_a_human_turn_boundary():
    messages = []
    for index in range(graph_agents.MAX_HISTORY_MESSAGES):
        messages.extend(
            [
                HumanMessage(content=f"question {index}", id=f"human-{index}"),
                AIMessage(content=f"answer {index}", id=f"ai-{index}"),
            ]
        )

    update = graph_agents.trim_history({"messages": messages})
    removed_ids = {message.id for message in update["messages"]}
    retained = [message for message in messages if message.id not in removed_ids]

    assert len(retained) <= graph_agents.MAX_HISTORY_MESSAGES
    assert retained[0].type == "human"
