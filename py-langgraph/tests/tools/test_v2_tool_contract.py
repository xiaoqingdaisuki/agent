"""V2 工具注册、路由边界和对话式调用测试。"""

import json

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import MemorySaver

from src.agents import graph_agents
from src.tools import tools
from src.tools.file_search import file_search
from src.tools.memory_user import memory_user_delete, memory_user_list, memory_user_save
from src.tools.registry import get_registry
from src.tools.runtime.executor import create_tool_call_context, tool_call_scope
from src.tools.time import convert_timezone, get_current_time
from src.tools.web_extract import extract_structured_items


V2_DESCRIPTOR_NAMES = {
    "time.current",
    "time.convert",
    "file.search",
    "web.extract",
    "memory.user.list",
    "memory.user.delete",
}


async def test_v2_registers_all_descriptors_but_hides_write_tools_by_default():
    """默认 Agent 只暴露成员可执行的只读工具。"""
    descriptor_names = {descriptor.name for descriptor in get_registry().get_descriptors()}
    assert V2_DESCRIPTOR_NAMES <= descriptor_names
    expected_count = 14 if "knowledge.search" in descriptor_names else 13
    assert "memory_user_save" not in {tool.name for tool in tools}
    assert "memory_user_delete" not in {tool.name for tool in tools}
    assert len(descriptor_names) == expected_count


async def test_current_time_returns_requested_timezone():
    """当前时间工具应返回带偏移的日期时间和英文星期。"""
    result = json.loads(await get_current_time.ainvoke({"timezone": "Asia/Shanghai"}))
    assert result["timezone"] == "Asia/Shanghai"
    assert result["datetime"].endswith("+08:00")
    assert result["weekday"] in {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"}


async def test_timezone_conversion_handles_dst():
    """时区转换应正确处理纽约夏令时。"""
    result = json.loads(await convert_timezone.ainvoke({
        "datetime": "2026-08-21T15:00:00",
        "from_timezone": "Asia/Shanghai",
        "to_timezone": "America/New_York",
    }))
    assert result["datetime"] == "2026-08-21T03:00:00-04:00"


def test_web_extract_parses_repeated_product_cards():
    """网页提取器应能从重复卡片中提取请求字段。"""
    html = (
        '<div class="product"><span class="name">Product A</span>'
        '<span class="price">99</span><span class="rating">4.8</span></div>'
        '<div class="product"><span class="name">Product B</span>'
        '<span class="price">129</span><span class="rating">4.6</span></div>'
    )
    assert extract_structured_items(html, ["name", "price", "rating"]) == [
        {"name": "Product A", "price": "99", "rating": "4.8"},
        {"name": "Product B", "price": "129", "rating": "4.6"},
    ]


async def test_dialogue_routes_current_time_to_the_dedicated_tool(monkeypatch):
    """模拟一轮对话，确认“现在几点”会进入 time.current 工具链。"""

    class ToolCapableFakeModel(FakeMessagesListChatModel):
        bound_tool_names: list[str] = []

        def bind_tools(self, bound_tools, **kwargs):
            self.bound_tool_names = [bound_tool.name for bound_tool in bound_tools]
            return self

    model = ToolCapableFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "get_current_time",
                        "args": {"timezone": "Asia/Shanghai"},
                        "id": "call-time-v2",
                    }
                ],
            ),
            AIMessage(content="现在是北京时间。"),
        ]
    )
    monkeypatch.setattr(graph_agents, "get_llm", lambda provider="openai": model)
    graph_agents.invalidate_tool_agent_cache()
    agent = graph_agents.build_tool_agent(checkpointer=MemorySaver())
    result = await agent.ainvoke(
        {"messages": [HumanMessage(content="北京现在几点？")]},
        config={"configurable": {"thread_id": "time-routing-v2"}},
    )

    assert "get_current_time" in model.bound_tool_names
    assert [message.type for message in result["messages"]] == ["human", "ai", "tool", "ai"]
    assert result["messages"][-1].content == "现在是北京时间。"


async def test_file_search_requires_trusted_user_context():
    """文件搜索不能接受模型伪造的用户身份，必须依赖运行时上下文。"""
    result = await file_search.ainvoke({"query": "违约责任", "file_ids": ["file_123"]})
    assert "可信用户上下文" in json.loads(result)["error"]


async def test_memory_list_delete_dialogue_flow():
    """记忆应通过保存→列表定位 ID→按精确 ID 删除完成闭环。"""
    user_id = "v2-memory-user"
    await memory_user_save.ainvoke({"user_id": user_id, "content": "用户偏好简洁回答", "category": "preference"})
    context = create_tool_call_context(user_id, "v2-memory-conversation", roles=["admin"])
    with tool_call_scope(context):
        listed = json.loads(await memory_user_list.ainvoke({}))
        memory_id = listed["memories"][0]["memory_id"] if listed["memories"] else None
        assert memory_id
        deleted = json.loads(await memory_user_delete.ainvoke({"memory_ids": [memory_id]}))
    assert deleted["deleted"] == [memory_id]
