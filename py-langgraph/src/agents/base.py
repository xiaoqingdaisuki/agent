import re
from typing import Literal

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, BaseMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode
from typing_extensions import TypedDict


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


def _convert_xml_tool_calls(message: BaseMessage) -> BaseMessage:
    """Handle XML tool call format for non-OpenAI models.

    Some providers (e.g. StepFun) return tool calls embedded in message.content
    as XML rather than in the standard AIMessage.tool_calls attribute. This
    function detects that format and converts it so the downstream ToolNode
    can execute the call normally.
    """
    content = message.content if hasattr(message, "content") else ""
    if not isinstance(content, str):
        return message
    # Quick check: does content contain XML tool call markers?
    func_tag_start = "<function="
    if func_tag_start not in content:
        return message

    tool_calls = []
    # Build regex patterns from parts
    func_pat = "<function=(\\w+)"  # capture group for func name only
    tag_open = func_pat + ">"
    tag_close = "</function>"
    param_open = "<parameter=(\\w+)>"
    param_close = "</parameter>"

    for func_match in re.finditer(tag_open + "(.*?)" + tag_close, content, re.DOTALL):
        func_name = func_match.group(1)
        params_text = func_match.group(2)
        args = {}
        for param_match in re.finditer(param_open + "(.*?)" + param_close, params_text, re.DOTALL):
            args[param_match.group(1)] = param_match.group(2).strip()
        tool_calls.append({
            "name": func_name,
            "args": args,
            "id": f"call_{func_name}_001",
        })

    if not tool_calls:
        return message

    # Strip XML tool calls from content using non-capturing patterns
    strip_open = "<function=\\w+>"
    strip_close = "</function>"
    clean_content = re.sub(strip_open + ".*?" + strip_close + "\\s*", "", content, flags=re.DOTALL).strip()
    return AIMessage(
        content=clean_content,
        tool_calls=tool_calls,
    )


def should_continue(state: AgentState) -> Literal["tools", END]:
    """判断是否需要调用工具"""
    last_message = state["messages"][-1]
    if last_message.tool_calls:
        return "tools"
    # Also check for XML-format tool calls (e.g. StepFun models)
    content = last_message.content if hasattr(last_message, "content") else ""
    if isinstance(content, str) and "<function=" in content:
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

        # Handle XML-format tool calls (e.g. StepFun step-3.7-flash)
        response = _convert_xml_tool_calls(response)

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
