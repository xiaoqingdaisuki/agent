from collections.abc import Callable
import re
from typing import NamedTuple

from src.prompts.system import DARK_MODE_PROMPT

DARK_MODE_COMMAND = "切换大公鸡模式"
DARK_MODE_ENABLED_REPLY = "已切换至大公鸡模式。"
DARK_MODE_DISABLED_REPLY = "已关闭大公鸡模式。"
DARK_MODE_THREAD_SUFFIX = "__dark_mode"


class AgentCommandResult(NamedTuple):
    name: str
    reply: str


_dark_mode_threads: set[str] = set()
_transcript_message_pattern = re.compile(
    r"(?:^|\n\n)(user|assistant|system): ([\s\S]*?)(?=\n\n(?:user|assistant|system): |$)"
)


# 从内容中提取所有用户消息
def _get_transcript_user_messages(content: str) -> list[str]:
    return [
        message.strip()
        for role, message in _transcript_message_pattern.findall(content)
        if role == "user"
    ]


# 设置指定线程的大公鸡模式开关状态
def _set_dark_mode(thread_id: str, enabled: bool) -> None:
    if enabled:
        _dark_mode_threads.add(thread_id)
    else:
        _dark_mode_threads.discard(thread_id)


# 根据已持久化的用户消息恢复指定线程的大公鸡模式状态
def restore_agent_command_state(thread_id: str, user_messages: list[str]) -> None:
    command_count = sum(
        message.strip() == DARK_MODE_COMMAND for message in user_messages
    )
    _set_dark_mode(thread_id, command_count % 2 == 1)


# 获取指定线程对应的大公鸡独立 Agent 历史标识
def get_dark_mode_thread_id(thread_id: str) -> str:
    return f"{thread_id}{DARK_MODE_THREAD_SUFFIX}"


# 切换指定线程的大公鸡模式，返回切换后的状态结果
def _toggle_dark_mode(thread_id: str) -> AgentCommandResult:
    if thread_id in _dark_mode_threads:
        _dark_mode_threads.remove(thread_id)
        return AgentCommandResult("toggle_dark_mode", DARK_MODE_DISABLED_REPLY)

    _dark_mode_threads.add(thread_id)
    return AgentCommandResult("toggle_dark_mode", DARK_MODE_ENABLED_REPLY)


_command_handlers: dict[str, Callable[[str], AgentCommandResult]] = {
    DARK_MODE_COMMAND: _toggle_dark_mode,
}


# 执行内建 Agent 命令（如大公鸡模式切换），返回结果或 None
def execute_agent_command(content: str, thread_id: str) -> AgentCommandResult | None:
    transcript_messages = _get_transcript_user_messages(content)
    command_content = transcript_messages[-1] if transcript_messages else content.strip()
    handler = _command_handlers.get(command_content)
    if not handler:
        return None

    if not transcript_messages:
        return handler(thread_id)

    command_count = sum(message == DARK_MODE_COMMAND for message in transcript_messages)
    enabled = command_count % 2 == 1
    _set_dark_mode(thread_id, enabled)
    reply = DARK_MODE_ENABLED_REPLY if enabled else DARK_MODE_DISABLED_REPLY
    return AgentCommandResult("toggle_dark_mode", reply)


# 根据线程和内容判断是否需要覆盖系统 prompt
def get_agent_prompt_override(thread_id: str, content: str | None = None) -> str | None:
    if content:
        transcript_messages = _get_transcript_user_messages(content)
        command_count = sum(message == DARK_MODE_COMMAND for message in transcript_messages)
        if command_count > 0:
            return DARK_MODE_PROMPT if command_count % 2 == 1 else None

    return DARK_MODE_PROMPT if thread_id in _dark_mode_threads else None


# 清除指定线程的命令状态（如大公鸡模式）
def clear_agent_command_state(thread_id: str) -> None:
    _dark_mode_threads.discard(thread_id)
