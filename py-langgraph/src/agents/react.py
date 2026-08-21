"""ReAct V1 的语言无关状态、Observation 和停止原因定义。"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any

REACT_STATES = (
    "IDLE",
    "REASONING",
    "TOOL_CALLING",
    "OBSERVING",
    "ANSWERING",
    "COMPLETED",
    "FAILED",
    "TIMEOUT",
    "TOOL_ERROR",
    "MAX_STEPS_REACHED",
)

STOP_REASONS = (
    "ANSWER_COMPLETE",
    "CLARIFICATION_REQUIRED",
    "MAX_STEPS",
    "TIMEOUT",
    "TOOL_FAILURE",
    "ERROR",
)

DEFAULT_REACT_LIMITS = {
    "max_steps": 8,
    "max_tool_calls": 6,
    "max_same_tool_calls": 3,
    "max_total_time_ms": 30_000,
    "max_retries_per_call": 1,
}


@dataclass
class ReActObservation:
    """统一的工具 Observation 信封。"""

    tool_call_id: str
    tool: str
    status: str
    data: Any
    error: dict[str, Any] | None
    latency_ms: int


@dataclass
class ReActRunSummary:
    """一次 ReAct 请求的可观测摘要，不保存内部思维链。"""

    state: str
    stop_reason: str
    react_steps: int
    tool_calls: int
    tool_names: list[str]
    tool_errors: int
    model_calls: int
    observations: list[dict[str, Any]]
    reason_code: str | None
    total_latency_ms: int


# 生成稳定的工具与参数签名，用于重复调用检测。
def tool_call_signature(tool_name: str, args: Any) -> str:
    """生成稳定签名，避免同一工具和参数在循环中无限重复。"""
    try:
        normalized = json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)
    except Exception:
        normalized = repr(args)
    return f"{tool_name}:{normalized}"


# 判断一段模型文本是否是在向用户请求缺失参数。
def is_clarification(text: str) -> bool:
    """识别澄清问题，供最终 stop_reason 分类使用。"""
    return bool(
        text
        and text.strip().endswith(("？", "?"))
        and any(marker in text for marker in ("请问", "请补充", "哪个城市", "需要提供", "能否提供"))
    )


# 将 LangChain ToolMessage 转换为统一 Observation。
def observation_from_tool_message(message: Any) -> ReActObservation:
    """解析工具消息，解析失败时保留原始返回文本。"""
    content = getattr(message, "content", "")
    parsed: Any = content
    if isinstance(content, str):
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            parsed = content
    status = "success"
    error: dict[str, Any] | None = None
    data = parsed
    if isinstance(parsed, dict) and {"status", "data", "error"}.issubset(parsed):
        status = str(parsed.get("status"))
        data = parsed.get("data")
        error = parsed.get("error")
    elif getattr(message, "status", "success") == "error" or (
        isinstance(content, str) and content.startswith("Error")
    ):
        status = "error"
        error = {"code": "INTERNAL_ERROR", "message": str(content)}
        data = None
    return ReActObservation(
        tool_call_id=str(getattr(message, "tool_call_id", "")),
        tool=str(getattr(message, "name", "tool") or "tool"),
        status=status,
        data=data,
        error=error,
        latency_ms=0,
    )


# 从 LangGraph 状态构造可序列化的 ReAct 摘要。
def summarize_react_state(state: dict[str, Any]) -> dict[str, Any]:
    """统一 API 和日志使用的 ReAct 摘要格式。"""
    summary = ReActRunSummary(
        state=str(state.get("react_state", "COMPLETED")),
        stop_reason=str(state.get("stop_reason", "ANSWER_COMPLETE")),
        react_steps=int(state.get("react_steps", 0)),
        tool_calls=int(state.get("react_tool_calls", 0)),
        tool_names=list(state.get("react_tool_names", [])),
        tool_errors=int(state.get("tool_errors", 0)),
        model_calls=int(state.get("model_calls", 0)),
        observations=[
            asdict(item) if isinstance(item, ReActObservation) else dict(item)
            for item in state.get("observations", [])
        ],
        reason_code=state.get("reason_code"),
        total_latency_ms=int(state.get("total_latency_ms", 0)),
    )
    return asdict(summary)


__all__ = [
    "DEFAULT_REACT_LIMITS",
    "REACT_STATES",
    "STOP_REASONS",
    "ReActObservation",
    "ReActRunSummary",
    "is_clarification",
    "observation_from_tool_message",
    "summarize_react_state",
    "tool_call_signature",
]
