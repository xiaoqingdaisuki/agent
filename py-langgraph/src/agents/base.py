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
        system_prompt = SYSTEM_PROMPT
        user_id = state.get("user_id")
        if user_id:
            try:
                from src.profile.service import MemoryService
                memory_context = MemoryService.build_memory_context(user_id)
                if memory_context:
                    system_prompt = f"{memory_context}\n\n{SYSTEM_PROMPT}"
            except ImportError:
                pass

        response = llm.invoke([SystemMessage(content=system_prompt), *state["messages"]])
        return {"messages": [response]}

    builder = StateGraph(AgentState)
    builder.add_node("agent", agent_node)
    builder.add_edge(START, "agent")
    builder.add_edge("agent", END)

    cp = checkpointer or _get_default_checkpointer()
    return builder.compile(checkpointer=cp)


def _get_default_checkpointer():
    """获取默认 checkpointer，避免循环导入"""
    from src.memory import get_default_checkpointer
    return get_default_checkpointer()


def should_continue(state: AgentState) -> Literal["tools", END]:
    """判断是否需要调用工具"""
    last_message = state["messages"][-1]
    if last_message.tool_calls:
        return "tools"
    return END


def build_tool_agent(checkpointer=None, system_prompt_override=None):
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
    base_prompt = system_prompt_override or TOOL_CALLING_PROMPT

    def agent_node(state: AgentState):
        system_prompt = base_prompt
        user_id = state.get("user_id")
        if user_id:
            try:
                from src.profile.service import MemoryService
                memory_context = MemoryService.build_memory_context(user_id)
                if memory_context:
                    system_prompt = f"{memory_context}\n\n{base_prompt}"
            except ImportError:
                pass

        response = llm.invoke([SystemMessage(content=system_prompt), *state["messages"]])
        return {"messages": [response]}

    builder = StateGraph(AgentState)
    builder.add_node("agent", agent_node)
    builder.add_node("tools", ToolNode(tools))

    # 显式定义图的边
    builder.add_edge(START, "agent")
    # 条件路由：这是 LangGraph 的核心特色 — 你自己定义路由逻辑
    builder.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    builder.add_edge("tools", "agent")

    # 编译时附加 checkpointer
    cp = checkpointer or _get_default_checkpointer()
    return builder.compile(
        checkpointer=cp,
        # interrupt_before=["tools"],  # 关闭：生产环境不需要每次工具调用都人工确认
    )
