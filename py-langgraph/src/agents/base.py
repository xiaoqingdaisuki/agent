import logging
import re
from functools import lru_cache
from typing import Annotated, Literal

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, BaseMessage, RemoveMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.prebuilt.tool_node import ToolCallRequest
from typing_extensions import TypedDict

from src.config.settings import settings

MAX_TOOL_CALLS = settings.max_agent_iterations
AGENT_RECURSION_LIMIT = MAX_TOOL_CALLS * 2 + 4
MAX_HISTORY_MESSAGES = 50


class AgentState(TypedDict, total=False):
    """LangGraph Agent 状态 — 显式定义，与 TS 版隐式状态形成对比"""
    messages: Annotated[list[BaseMessage], add_messages]
    user_id: str | None


def trim_history(state: AgentState) -> dict[str, list[RemoveMessage]]:
    """Bound checkpoint growth while keeping a complete user turn boundary."""
    messages = state["messages"]
    if len(messages) <= MAX_HISTORY_MESSAGES:
        return {}

    keep_from = len(messages) - MAX_HISTORY_MESSAGES
    while keep_from < len(messages) and messages[keep_from].type != "human":
        keep_from += 1
    removals = [
        RemoveMessage(id=message.id)
        for message in messages[:keep_from]
        if message.id is not None
    ]
    return {"messages": removals} if removals else {}


def get_llm(provider: str = "openai"):
    """根据配置获取 LLM"""
    if provider == "anthropic":
        return ChatAnthropic(
            model=settings.anthropic_model,
            timeout=settings.llm_timeout_ms / 1000,
            max_retries=settings.llm_max_retries,
        )
    return ChatOpenAI(
        model=settings.openai_model,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        timeout=settings.llm_timeout_ms / 1000,
        max_retries=settings.llm_max_retries,
    )


def build_chat_agent(checkpointer=None):
    """
    对话 Agent — 最简单的 StateGraph

    TS 版对应: createAgent({ model, systemPrompt })
    Python 版: 显式定义图结构
    """
    from src.prompts.system import SYSTEM_PROMPT

    llm = get_llm()

    async def agent_node(state: AgentState):
        system_prompt = SYSTEM_PROMPT
        user_id = state.get("user_id")
        if user_id:
            try:
                from src.profile.service import MemoryService
                memory_context = MemoryService.build_memory_context(user_id)
                if memory_context:
                    system_prompt = f"{memory_context}\n\n{SYSTEM_PROMPT}"
            except Exception:
                pass

        response = await llm.ainvoke(
            [SystemMessage(content=system_prompt), *state["messages"]]
        )
        return {"messages": [response]}

    builder = StateGraph(AgentState)
    builder.add_node("trim_history", trim_history)
    builder.add_node("agent", agent_node)
    builder.add_edge(START, "trim_history")
    builder.add_edge("trim_history", "agent")
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

    for index, func_match in enumerate(
        re.finditer(tag_open + "(.*?)" + tag_close, content, re.DOTALL),
        start=1,
    ):
        func_name = func_match.group(1)
        params_text = func_match.group(2)
        args: dict[str, str] = {}
        for param_match in re.finditer(
            param_open + "(.*?)" + param_close,
            params_text,
            re.DOTALL,
        ):
            args[param_match.group(1)] = param_match.group(2).strip()
        tool_calls.append({
            "name": func_name,
            "args": args,
            "id": f"call_{func_name}_{index}",
        })

    if not tool_calls:
        return message

    # Strip XML tool calls from content using non-capturing patterns
    strip_open = "<function=\\w+>"
    strip_close = "</function>"
    clean_content = re.sub(
        strip_open + ".*?" + strip_close + "\\s*",
        "",
        content,
        flags=re.DOTALL,
    ).strip()
    return AIMessage(
        content=clean_content,
        tool_calls=tool_calls,
        id=message.id,
        response_metadata=message.response_metadata,
    )


def _current_turn_tool_call_count(messages: list[BaseMessage]) -> int:
    """Count requested tools since the most recent user message."""
    count = 0
    for message in reversed(messages):
        if message.type == "human":
            break
        tool_calls = getattr(message, "tool_calls", None)
        if tool_calls:
            count += len(tool_calls)
    return count


def _scope_memory_tool_call(request: ToolCallRequest, execute):
    """Replace model-supplied ownership IDs with server-side graph context."""
    name = request.tool_call["name"]
    args = dict(request.tool_call.get("args", {}))
    if name in {"memory_user_search", "memory_user_save"}:
        state = request.state if isinstance(request.state, dict) else {}
        args["user_id"] = state.get("user_id") or ""
    elif name == "memory_session_search":
        args["conversation_id"] = (
            request.runtime.config.get("configurable", {}).get("thread_id", "")
        )

    scoped_call = {**request.tool_call, "args": args}
    return execute(request.override(tool_call=scoped_call))


def should_continue(state: AgentState) -> Literal["tools", "limit", END]:
    """判断是否需要调用工具"""
    last_message = state["messages"][-1]
    tool_calls = getattr(last_message, "tool_calls", None)
    if tool_calls:
        if _current_turn_tool_call_count(state["messages"]) > MAX_TOOL_CALLS:
            return "limit"
        return "tools"
    # Also check for XML-format tool calls (e.g. StepFun models)
    content = last_message.content if hasattr(last_message, "content") else ""
    if isinstance(content, str) and "<function=" in content:
        return "tools"
    return END


def _compile_tool_agent(checkpointer, base_prompt: str):
    """
    工具调用 Agent — 带条件路由的 StateGraph

    TS 版对应: createAgent({ model, tools, systemPrompt })
      框架内部隐式处理: agent → 判断是否需要工具 → 调用工具 → 继续

    Python 版: 显式定义每一步
      agent → conditional_edges(should_continue) → tools 或 END
      tools → agent
    """
    from src.tools import tools

    llm = get_llm()
    llm_with_tools = llm.bind_tools(tools)

    async def agent_node(state: AgentState):
        system_prompt = base_prompt
        user_id = state.get("user_id")
        if user_id:
            try:
                from src.profile.service import MemoryService
                memory_context = MemoryService.build_memory_context(user_id)
                if memory_context:
                    system_prompt = f"{memory_context}\n\n{base_prompt}"
            except Exception:
                pass

        response = await llm_with_tools.ainvoke(
            [SystemMessage(content=system_prompt), *state["messages"]]
        )

        # Handle XML-format tool calls (e.g. StepFun step-3.7-flash)
        response = _convert_xml_tool_calls(response)

        if hasattr(response, "tool_calls") and response.tool_calls:
            tool_names = [
                tc.get("function", {}).get("name", tc.get("name", "?"))
                for tc in response.tool_calls
            ]
            call_count = _current_turn_tool_call_count([*state["messages"], response])
            logging.getLogger("agent").info(
                "[tool_call #%s] tools: %s | content: %s",
                call_count,
                tool_names,
                (response.content or "")[:80],
            )

        return {"messages": [response]}

    async def limit_node(state: AgentState):
        # Drop the unexecuted tool-call message so providers do not reject a
        # dangling assistant tool request without matching ToolMessages.
        messages = state["messages"]
        if getattr(messages[-1], "tool_calls", None):
            messages = messages[:-1]
        response = await llm.ainvoke([
            SystemMessage(content=base_prompt),
            *messages,
            SystemMessage(
                content=(
                    "The tool-call safety limit has been reached. Give the best final "
                    "answer using results already available; do not request another tool."
                )
            ),
        ])
        pending_message = state["messages"][-1]
        return {
            "messages": [RemoveMessage(id=pending_message.id), response],
        }

    builder = StateGraph(AgentState)
    builder.add_node("trim_history", trim_history)
    builder.add_node("agent", agent_node)
    builder.add_node("tools", ToolNode(tools, wrap_tool_call=_scope_memory_tool_call))
    builder.add_node("limit", limit_node)

    # 显式定义图的边
    builder.add_edge(START, "trim_history")
    builder.add_edge("trim_history", "agent")
    # 条件路由：这是 LangGraph 的核心特色 — 你自己定义路由逻辑
    builder.add_conditional_edges(
        "agent",
        should_continue,
        {"tools": "tools", "limit": "limit", END: END},
    )
    builder.add_edge("tools", "agent")
    builder.add_edge("limit", END)

    # 编译时附加 checkpointer
    # 递归限制在调用时通过 config={"recursion_limit": N} 传入
    return builder.compile(
        checkpointer=checkpointer,
        # interrupt_before=["tools"],  # 关闭：生产环境不需要每次工具调用都人工确认
    )


def _get_cache_key(base_prompt: str, checkpointer) -> tuple:
    """生成缓存键，确保不同 checkpointer 实例不共享同一个编译图。"""
    if checkpointer is None:
        return (base_prompt, None)
    return (base_prompt, id(checkpointer))


@lru_cache(maxsize=10)
def _build_cached_tool_agent(base_prompt: str, checkpointer_id: int | None):
    """使用 checkpointer 的 id 作为缓存键的一部分。"""
    cp = None if checkpointer_id is None else _resolve_checkpointer(checkpointer_id)
    return _compile_tool_agent(cp, base_prompt)


def _resolve_checkpointer(checkpointer_id: int):
    """根据 id 从当前默认 checkpointer 获取实例（用于缓存重建）。"""
    return _get_default_checkpointer()


def build_tool_agent(checkpointer=None, system_prompt_override=None):
    """Build a tool agent, reusing compiled graphs for the common checkpointer."""
    from src.prompts.system import TOOL_CALLING_PROMPT

    base_prompt = system_prompt_override or TOOL_CALLING_PROMPT
    if checkpointer is None:
        return _build_cached_tool_agent(base_prompt, None)
    return _compile_tool_agent(checkpointer, base_prompt)


def invalidate_tool_agent_cache() -> None:
    _build_cached_tool_agent.cache_clear()
