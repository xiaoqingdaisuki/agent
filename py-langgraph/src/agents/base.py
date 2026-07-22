from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from langgraph.graph import StateGraph, START, END
from langgraph.prebuilt import ToolNode
from typing import Literal
from typing_extensions import TypedDict
from langchain_core.messages import BaseMessage, SystemMessage
import operator


class AgentState(TypedDict):
    """LangGraph Agent 状态 — 显式定义，与 TS 版隐式状态形成对比"""
    messages: list[BaseMessage]


def get_llm(provider: str = "openai"):
    """根据配置获取 LLM"""
    if provider == "anthropic":
        from src.config.settings import settings
        return ChatAnthropic(model=settings.anthropic_model)
    from src.config.settings import settings
    return ChatOpenAI(
        model=settings.openai_model,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
    )


def build_chat_agent(checkpointer=None):
    """
    对话 Agent — 最简单的 StateGraph

    TS 版对应: createAgent({ model, systemPrompt })
    Python 版: 显式定义图结构
    """
    from src.prompts.system import SYSTEM_PROMPT

    llm = get_llm()

    def agent_node(state: AgentState):
        response = llm.invoke([SystemMessage(content=SYSTEM_PROMPT), *state["messages"]])
        return {"messages": [response]}

    builder = StateGraph(AgentState)
    builder.add_node("agent", agent_node)
    builder.add_edge(START, "agent")
    builder.add_edge("agent", END)

    return builder.compile(checkpointer=checkpointer)


def should_continue(state: AgentState) -> Literal["tools", END]:
    """判断是否需要调用工具"""
    last_message = state["messages"][-1]
    if last_message.tool_calls:
        return "tools"
    return END


def build_tool_agent(checkpointer=None):
    """
    工具调用 Agent — 带条件路由的 StateGraph

    TS 版对应: createAgent({ model, tools, systemPrompt })
      框架内部隐式处理: agent → 判断是否需要工具 → 调用工具 → 继续

    Python 版: 显式定义每一步
      agent → conditional_edges(should_continue) → tools 或 END
      tools → agent
    """
    from src.prompts.system import TOOL_CALLING_PROMPT
    from src.tools import tools

    llm = get_llm()

    def agent_node(state: AgentState):
        response = llm.invoke([SystemMessage(content=TOOL_CALLING_PROMPT), *state["messages"]])
        return {"messages": [response]}

    builder = StateGraph(AgentState)
    builder.add_node("agent", agent_node)
    builder.add_node("tools", ToolNode(tools))

    # 显式定义图的边
    builder.add_edge(START, "agent")
    # 条件路由：这是 LangGraph 的核心特色 — 你自己定义路由逻辑
    builder.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    builder.add_edge("tools", "agent")

    # 编译时附加 checkpointer 和中断点（人机协同）
    return builder.compile(
        checkpointer=checkpointer,
        interrupt_before=["tools"],  # 工具调用前暂停，人工确认
    )
