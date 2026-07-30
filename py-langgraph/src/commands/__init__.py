from collections.abc import Callable
import re
from typing import NamedTuple

from src.prompts.system import DARK_MODE_PROMPT

DARK_MODE_COMMAND = "切换大公鸡模式"
DARK_MODE_ENABLED_REPLY = "已切换至大公鸡模式。"
DARK_MODE_DISABLED_REPLY = "已关闭大公鸡模式。"


class AgentCommandResult(NamedTuple):
    name: str
    reply: str


_dark_mode_threads: set[str] = set()
_transcript_message_pattern = re.compile(
    r"(?:^|\n\n)(user|assistant|system): ([\s\S]*?)(?=\n\n(?:user|assistant|system): |$)"
)


def _get_transcript_user_messages(content: str) -> list[str]:
    return [
        message.strip()
        for role, message in _transcript_message_pattern.findall(content)
        if role == "user"
    ]


def _set_dark_mode(thread_id: str, enabled: bool) -> None:
    if enabled:
        _dark_mode_threads.add(thread_id)
    else:
        _dark_mode_threads.discard(thread_id)


def _toggle_dark_mode(thread_id: str) -> AgentCommandResult:
    if thread_id in _dark_mode_threads:
        _dark_mode_threads.remove(thread_id)
        return AgentCommandResult("toggle_dark_mode", DARK_MODE_DISABLED_REPLY)

    _dark_mode_threads.add(thread_id)
    return AgentCommandResult("toggle_dark_mode", DARK_MODE_ENABLED_REPLY)


_command_handlers: dict[str, Callable[[str], AgentCommandResult]] = {
    DARK_MODE_COMMAND: _toggle_dark_mode,
}


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


def get_agent_prompt_override(thread_id: str, content: str | None = None) -> str | None:
    if content:
        transcript_messages = _get_transcript_user_messages(content)
        command_count = sum(message == DARK_MODE_COMMAND for message in transcript_messages)
        if command_count > 0:
            return DARK_MODE_PROMPT if command_count % 2 == 1 else None

    return DARK_MODE_PROMPT if thread_id in _dark_mode_threads else None


def clear_agent_command_state(thread_id: str) -> None:
    _dark_mode_threads.discard(thread_id)
