"""不完整响应处理器 — Python 版

与 TS 版 src/agents/response-handler.ts 功能对等，
统一处理三类响应中断场景的检测与提示生成。
"""

from __future__ import annotations

# ============ 截断检测 ============

# 以这些字符结尾的文本大概率是完整句子
_TERMINAL_PUNCTUATION = frozenset(
    [
        "。",
        "！",
        "？",
        "！",
        ".",
        "!",
        "?",
        "»",
        "…",
        "～",
        "」",
        "』",
        '"',
        "'",
        ")",
        "】",
        "〗",
        "〉",
        "》",
        "]",
        "}",
        "；",
        ";",
        "：",
        ":",
        "，",
        ",",
    ]
)


# 校验并判断 is likely truncated 对应的状态
def is_likely_truncated(text: str, finish_reason: str | None = None) -> bool:
    """检测文本是否可能被 LLM 截断。

    检测策略（按优先级）：
      a) finish_reason == "length" → 确定截断
      b) 文本 < 100 字符 → 不视为截断（短回答正常）
      c) 末字符是终端标点/空白 → 大概率完整
      d) 末字符不是终端标点且文本 > 200 字符 → 可能截断
    """
    if finish_reason in ("length", "MAX_TOKENS"):
        return True
    if finish_reason:
        return False

    if not text or len(text) < 100:
        return False

    trimmed = text.rstrip()
    if not trimmed:
        return False

    last_char = trimmed[-1]

    # 不以终端标点/换行结尾，且文本较长 → 大概率被截断
    return last_char not in _TERMINAL_PUNCTUATION and last_char != "\n"


# 获取 get finish reason 对应的数据
def get_finish_reason(message) -> str | None:
    """从 LangChain AIMessage 中提取 finish_reason。"""
    meta = getattr(message, "response_metadata", None)
    if not meta or not isinstance(meta, dict):
        return None

    # OpenAI 格式: {"finish_reason": "stop" | "length" | ...}
    openai_reason = meta.get("finish_reason")
    if openai_reason:
        return openai_reason

    # Anthropic 格式: {"stop_reason": "end_turn" | "max_tokens" | ...}
    anthropic_reason = meta.get("stop_reason")
    if anthropic_reason == "max_tokens":
        return "length"
    if anthropic_reason:
        return anthropic_reason

    return None


# 从 Agent 输出或消息列表中提取最后一个 AI 消息的结束原因。
def get_finish_reason_from_output(output) -> str | None:
    direct = get_finish_reason(output)
    if direct:
        return direct
    if not isinstance(output, dict):
        return None

    nested = output.get("output")
    if nested is not None and nested is not output:
        nested_reason = get_finish_reason_from_output(nested)
        if nested_reason:
            return nested_reason

    messages = output.get("messages")
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        if isinstance(message, dict):
            message_type = message.get("type") or message.get("role", "")
        else:
            get_type = getattr(message, "_get_type", None)
            message_type = get_type() if callable(get_type) else getattr(message, "type", "")
        if message_type not in {"ai", "assistant"}:
            continue
        reason = get_finish_reason(message)
        if reason:
            return reason
    return None


# ============ 继续提示 ============

_CONTINUATION_PROMPT = "\n\n---\n⚠️ 以上回答尚未完成。如需继续，请回复「继续」。"


# 创建或注册 append continuation hint 所需的数据
def append_continuation_hint(text: str) -> str:
    """为不完整响应追加继续提示。"""
    return text + _CONTINUATION_PROMPT


# 执行 maybe append continuation hint 对应的业务逻辑
def maybe_append_continuation_hint(text: str, finish_reason: str | None = None) -> str:
    """检查响应是否需要附加继续提示，需要则追加。"""
    if text.endswith(_CONTINUATION_PROMPT):
        return text
    if not is_likely_truncated(text, finish_reason):
        return text
    return append_continuation_hint(text)
