import logging
import re
import time
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
from src.agents.deadline import enable_tool_budget
from src.agents.response_handler import maybe_append_continuation_hint
from src.tools.runtime.data_redaction import redact_text_content
from src.tools.runtime.executor import (
    create_tool_call_context,
    get_tool_call_context,
    tool_call_scope,
)
from src.agents.react_policy import (
    is_clarification,
    observation_from_tool_message,
    tool_call_signature,
)

MAX_REACT_STEPS = settings.react_max_steps
MAX_TOOL_CALLS = settings.react_max_tool_calls
MAX_SAME_TOOL_CALLS = settings.react_max_same_tool_calls
MAX_TOTAL_TIME_MS = settings.react_max_total_time_ms
AGENT_RECURSION_LIMIT = MAX_REACT_STEPS * 3 + 4
MAX_HISTORY_MESSAGES = 50


class AgentState(TypedDict, total=False):
    """LangGraph Agent 状态 — 显式定义，与 TS 版隐式状态形成对比"""

    messages: Annotated[list[BaseMessage], add_messages]
    user_id: str | None
    react_state: str
    stop_reason: str
    react_steps: int
    react_tool_calls: int
    react_tool_names: list[str]
    react_call_signatures: dict[str, int]
    react_failed_signatures: dict[str, int]
    observations: list[dict]
    tool_errors: int
    model_calls: int
    reason_code: str | None
    started_at: float
    total_latency_ms: int


# 修剪对话历史，限制消息数量并保持用户轮次边界
def trim_history(state: AgentState) -> dict:
    """Bound checkpoint growth while keeping a complete user turn boundary."""
    messages = state["messages"]
    react_reset = {
        "react_state": "IDLE",
        "stop_reason": "",
        "react_steps": 0,
        "react_tool_calls": 0,
        "react_tool_names": [],
        "react_call_signatures": {},
        "react_failed_signatures": {},
        "observations": [],
        "tool_errors": 0,
        "model_calls": 0,
        "reason_code": None,
        "started_at": time.monotonic(),
        "total_latency_ms": 0,
    }
    if len(messages) <= MAX_HISTORY_MESSAGES:
        return react_reset

    keep_from = len(messages) - MAX_HISTORY_MESSAGES
    while keep_from < len(messages) and messages[keep_from].type != "human":
        keep_from += 1
    removals = [
        RemoveMessage(id=message.id) for message in messages[:keep_from] if message.id is not None
    ]
    return {**react_reset, "messages": removals} if removals else react_reset


# 根据配置获取 LLM 实例（OpenAI 或 Anthropic）
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


# 创建或注册 build chat agent 所需的数据
def build_chat_agent(checkpointer=None):
    """
    对话 Agent — 最简单的 StateGraph

    TS 版对应: createAgent({ model, systemPrompt })
    Python 版: 显式定义图结构
    """
    from src.prompts.system import SYSTEM_PROMPT

    llm = get_llm()

    # 执行 agent node 对应的业务逻辑
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

        response = await llm.ainvoke([SystemMessage(content=system_prompt), *state["messages"]])
        return {"messages": [response]}

    builder = StateGraph(AgentState)
    builder.add_node("trim_history", trim_history)
    builder.add_node("agent", agent_node)
    builder.add_edge(START, "trim_history")
    builder.add_edge("trim_history", "agent")
    builder.add_edge("agent", END)

    cp = checkpointer if checkpointer is not None else _get_default_checkpointer()
    return builder.compile(checkpointer=cp)


# 获取默认 checkpointer 实例，避免循环导入
def _get_default_checkpointer():
    """获取默认 checkpointer，避免循环导入"""
    from src.memory import get_default_checkpointer

    return get_default_checkpointer()


# 将 XML 格式工具调用转换为 LangGraph 可识别的标准格式
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
        tool_calls.append(
            {
                "name": func_name,
                "args": args,
                "id": f"call_{func_name}_{index}",
            }
        )

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


# 计算当前轮次（自最近一条用户消息以来）的工具调用总数
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


# 将模型提供的参数替换为服务端注入的 ownership ID（user_id, conversation_id）
async def _scope_memory_tool_call(request: ToolCallRequest, execute):
    """Replace model-supplied ownership IDs with server-side graph context."""
    name = request.tool_call["name"]
    args = dict(request.tool_call.get("args", {}))
    if name in {"memory_user_search", "memory_user_save"}:
        state = request.state if isinstance(request.state, dict) else {}
        args["user_id"] = state.get("user_id") or ""
    elif name == "memory_session_search":
        args["conversation_id"] = request.runtime.config.get("configurable", {}).get(
            "thread_id", ""
        )

    scoped_call = {**request.tool_call, "args": args}
    scoped_request = request.override(tool_call=scoped_call)
    if get_tool_call_context() is not None:
        return await execute(scoped_request)

    state = request.state if isinstance(request.state, dict) else {}
    user_id = state.get("user_id") or ""
    conversation_id = request.runtime.config.get("configurable", {}).get(
        "thread_id", ""
    )
    runtime_context = create_tool_call_context(user_id, conversation_id)
    with tool_call_scope(runtime_context):
        return await execute(scoped_request)


# 读取 LangChain 工具调用中的规范化名称和参数。
def _tool_call_parts(tool_call: dict) -> tuple[str, object]:
    """兼容 OpenAI function 格式和 LangChain 简化格式。"""
    function = tool_call.get("function", {})
    name = function.get("name") or tool_call.get("name", "")
    args = function.get("arguments", tool_call.get("args", {}))
    if isinstance(args, str):
        try:
            import json

            args = json.loads(args)
        except Exception:
            args = {"raw": args}
    return str(name), args


# 记录本轮模型请求的工具签名，用于步数、总调用数和重复调用防护。
def _track_react_tool_calls(state: AgentState, response: BaseMessage) -> dict:
    """只记录结构化计数，不记录模型内部思维文本。"""
    signatures = dict(state.get("react_call_signatures", {}))
    names = list(state.get("react_tool_names", []))
    calls = list(getattr(response, "tool_calls", []) or [])
    for tool_call in calls:
        name, args = _tool_call_parts(tool_call)
        signature = tool_call_signature(name, args)
        signatures[signature] = signatures.get(signature, 0) + 1
        names.append(name)
    return {
        "react_tool_calls": int(state.get("react_tool_calls", 0)) + len(calls),
        "react_tool_names": names,
        "react_call_signatures": signatures,
    }


# 将工具节点输出转为 Observation，并把状态推进到 OBSERVING。
def observe_node(state: AgentState) -> dict:
    """统一处理工具成功和工具错误，确保错误也能回到下一轮 Reason。"""
    messages = state["messages"]
    new_observations = list(state.get("observations", []))
    tool_errors = int(state.get("tool_errors", 0))
    failed_signatures = dict(state.get("react_failed_signatures", {}))
    call_signatures: dict[str, str] = {}
    tool_messages: list[BaseMessage] = []
    for message in reversed(messages):
        if message.type == "ai":
            for tool_call in getattr(message, "tool_calls", []) or []:
                name, args = _tool_call_parts(tool_call)
                call_signatures[str(tool_call.get("id", ""))] = tool_call_signature(name, args)
            break
        if message.type != "tool":
            continue
        tool_messages.append(message)
    for message in tool_messages:
        observation = observation_from_tool_message(message)
        new_observations.append(observation.__dict__)
        if observation.status == "error":
            tool_errors += 1
            signature = call_signatures.get(observation.tool_call_id)
            if signature:
                failed_signatures[signature] = failed_signatures.get(signature, 0) + 1
    return {
        "react_state": "OBSERVING",
        "observations": new_observations,
        "tool_errors": tool_errors,
        "react_failed_signatures": failed_signatures,
    }


# 判断 Agent 是否需要调用工具，或已达到调用上限
def should_continue(state: AgentState) -> Literal["tools", "limit", END]:
    """根据 ReAct 状态和硬限制选择工具节点、限制节点或结束。"""
    last_message = state["messages"][-1]
    tool_calls = getattr(last_message, "tool_calls", None)
    if tool_calls:
        elapsed_ms = int((time.monotonic() - state.get("started_at", time.monotonic())) * 1000)
        signatures = state.get("react_call_signatures", {})
        repeated = any(count > MAX_SAME_TOOL_CALLS for count in signatures.values())
        if state.get("react_steps", 0) >= MAX_REACT_STEPS:
            state["stop_reason"] = "MAX_STEPS"
            state["reason_code"] = "MAX_REACT_STEPS"
            return "limit"
        if (
            state.get("react_tool_calls", 0) > MAX_TOOL_CALLS
            or _current_turn_tool_call_count(state["messages"]) > MAX_TOOL_CALLS
        ):
            state["stop_reason"] = "MAX_STEPS"
            state["reason_code"] = "MAX_TOOL_CALLS"
            return "limit"
        if repeated:
            state["stop_reason"] = "TOOL_FAILURE"
            state["reason_code"] = "REPEATED_TOOL_CALL"
            return "limit"
        if elapsed_ms >= MAX_TOTAL_TIME_MS:
            state["stop_reason"] = "TIMEOUT"
            state["reason_code"] = "TOTAL_TIME_LIMIT"
            return "limit"
        enable_tool_budget()
        return "tools"
    # Also check for XML-format tool calls (e.g. StepFun models)
    content = last_message.content if hasattr(last_message, "content") else ""
    if isinstance(content, str) and "<function=" in content:
        enable_tool_budget()
        return "tools"
    return END


# 执行 compile tool agent 对应的业务逻辑
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

    # 执行 agent node 对应的业务逻辑
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

        response = None
        async for chunk in llm_with_tools.astream(
            [SystemMessage(content=system_prompt), *state["messages"]]
        ):
            response = chunk if response is None else response + chunk
        if response is None:
            raise RuntimeError("模型未返回任何流式响应")

        # Handle XML-format tool calls (e.g. StepFun step-3.7-flash)
        response = _convert_xml_tool_calls(response)

        # 去重：同一轮中 memory_user_save 只保留第一次调用，防止 LLM 并行重复保存
        if hasattr(response, "tool_calls") and response.tool_calls:
            seen_save_calls = set()
            deduped_calls = []
            had_duplicate_save = False
            for tc in response.tool_calls:
                tc_name = tc.get("function", {}).get("name", tc.get("name", ""))
                if tc_name == "memory_user_save":
                    tc_content = tc.get("function", {}).get("arguments", tc.get("args", ""))
                    tc_key = (tc_name, tc_content)
                    if tc_key in seen_save_calls:
                        had_duplicate_save = True
                        continue
                    seen_save_calls.add(tc_key)
                deduped_calls.append(tc)
            if had_duplicate_save:
                response = response.model_copy(
                    update={"tool_calls": deduped_calls}
                )
                logging.getLogger("agent").warning(
                    "Deduped duplicate memory_user_save calls in same turn"
                )

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

        tool_calls = list(getattr(response, "tool_calls", []) or [])
        started_at = float(state.get("started_at", time.monotonic()))
        react_steps = int(state.get("react_steps", 0)) + 1
        react_update = {
            "react_state": "TOOL_CALLING" if tool_calls else "COMPLETED",
            "react_steps": react_steps,
            "started_at": started_at,
            "model_calls": int(state.get("model_calls", 0)) + 1,
            "total_latency_ms": int((time.monotonic() - started_at) * 1000),
        }
        if tool_calls:
            react_update.update(_track_react_tool_calls(state, response))
            failed_signatures = state.get("react_failed_signatures", {})
            current_signatures = set()
            for tool_call in tool_calls:
                name, args = _tool_call_parts(tool_call)
                current_signatures.add(tool_call_signature(name, args))
            if react_steps >= MAX_REACT_STEPS:
                react_update.update(
                    {"stop_reason": "MAX_STEPS", "reason_code": "MAX_REACT_STEPS"}
                )
            elif react_update["react_tool_calls"] > MAX_TOOL_CALLS:
                react_update.update(
                    {"stop_reason": "MAX_STEPS", "reason_code": "MAX_TOOL_CALLS"}
                )
            elif int((time.monotonic() - started_at) * 1000) >= MAX_TOTAL_TIME_MS:
                react_update.update(
                    {"stop_reason": "TIMEOUT", "reason_code": "TOTAL_TIME_LIMIT"}
                )
            elif any(
                count > MAX_SAME_TOOL_CALLS
                for count in react_update["react_call_signatures"].values()
            ):
                react_update.update(
                    {"stop_reason": "TOOL_FAILURE", "reason_code": "REPEATED_TOOL_CALL"}
                )
            elif any(failed_signatures.get(signature, 0) >= 2 for signature in current_signatures):
                react_update.update(
                    {"stop_reason": "TOOL_FAILURE", "reason_code": "TOOL_RETRY_EXHAUSTED"}
                )
        else:
            content = response.content if isinstance(response.content, str) else ""
            react_update.update(
                {
                    "stop_reason": (
                        "CLARIFICATION_REQUIRED"
                        if is_clarification(content)
                        else "ANSWER_COMPLETE"
                    ),
                    "reason_code": "MISSING_REQUIRED_INPUT" if is_clarification(content) else None,
                }
            )
        return {"messages": [response], **react_update}

    # 执行 limit node 对应的业务逻辑
    async def limit_node(state: AgentState):
        # Drop the unexecuted tool-call message so providers do not reject a
        # dangling assistant tool request without matching ToolMessages.
        messages = state["messages"]
        if getattr(messages[-1], "tool_calls", None):
            messages = messages[:-1]
        response = await llm.ainvoke(
            [
                SystemMessage(content=base_prompt),
                *messages,
                SystemMessage(
                    content=(
                        "The tool-call safety limit has been reached. Give the best final "
                        "answer using results already available; do not request another tool."
                    )
                ),
            ]
        )
        # 内容级脱敏：limit_node 的回答基于工具结果生成，可能包含敏感数据
        response.content = redact_text_content(response.content or "")
        # 检测 limit_node 生成的最终回答是否也被截断
        response.content = maybe_append_continuation_hint(
            response.content,
            getattr(response, "response_metadata", {}).get("finish_reason"),
        )
        stop_reason = state.get("stop_reason", "MAX_STEPS")
        final_state = {
            "TIMEOUT": "TIMEOUT",
            "TOOL_FAILURE": "TOOL_ERROR",
        }.get(stop_reason, "MAX_STEPS_REACHED")
        pending_message = state["messages"][-1]
        return {
            "messages": [RemoveMessage(id=pending_message.id), response],
            "react_state": final_state,
            "stop_reason": stop_reason,
            "total_latency_ms": int(
                (time.monotonic() - state.get("started_at", time.monotonic())) * 1000
            ),
        }

    builder = StateGraph(AgentState)
    builder.add_node("trim_history", trim_history)
    builder.add_node("agent", agent_node)
    builder.add_node("tools", ToolNode(tools, awrap_tool_call=_scope_memory_tool_call))
    builder.add_node("observe", observe_node)
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
    builder.add_edge("tools", "observe")
    builder.add_edge("observe", "agent")
    builder.add_edge("limit", END)

    # 编译时附加 checkpointer
    # 递归限制在调用时通过 config={"recursion_limit": N} 传入
    return builder.compile(
        checkpointer=checkpointer,
        # interrupt_before=["tools"],  # 关闭：生产环境不需要每次工具调用都人工确认
    )


# 生成缓存键，确保不同 checkpointer 实例不共享编译图
def _get_cache_key(base_prompt: str, checkpointer) -> tuple:
    """生成缓存键，确保不同 checkpointer 实例不共享同一个编译图。"""
    if checkpointer is None:
        return (base_prompt, None)
    return (base_prompt, id(checkpointer))


# 使用 checkpointer 的 id 作为缓存键的一部分，编译并缓存工具调用图
@lru_cache(maxsize=10)
# 执行 build cached tool agent 对应的业务逻辑
def _build_cached_tool_agent(base_prompt: str, checkpointer_id: int | None):
    """使用 checkpointer 的 id 作为缓存键的一部分。"""
    cp = None if checkpointer_id is None else _resolve_checkpointer(checkpointer_id)
    return _compile_tool_agent(cp, base_prompt)


# 根据 checkpointer 的 id 获取实例，用于缓存重建
def _resolve_checkpointer(checkpointer_id: int):
    """根据 id 从当前默认 checkpointer 获取实例（用于缓存重建）。"""
    return _get_default_checkpointer()


# 构建工具调用 Agent，复用已编译图以提升性能
def build_tool_agent(checkpointer=None, system_prompt_override=None):
    """Build a tool agent, reusing compiled graphs for the common checkpointer."""
    from src.prompts.system import TOOL_CALLING_PROMPT

    base_prompt = system_prompt_override or TOOL_CALLING_PROMPT
    if checkpointer is None:
        checkpointer = _get_default_checkpointer()
        return _build_cached_tool_agent(base_prompt, id(checkpointer))
    return _compile_tool_agent(checkpointer, base_prompt)


# 清空工具调用 Agent 的 LRU 缓存
def invalidate_tool_agent_cache() -> None:
    _build_cached_tool_agent.cache_clear()
