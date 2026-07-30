from collections.abc import Callable
from typing import NamedTuple

from src.prompts.system import DARK_MODE_PROMPT

DARK_MODE_COMMAND = "切换黑暗模式"
DARK_MODE_ENABLED_REPLY = "已切换至黑暗模式。"
DARK_MODE_DISABLED_REPLY = "已关闭黑暗模式。"


class AgentCommandResult(NamedTuple):
    name: str
    reply: str


_dark_mode_threads: set[str] = set()


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
    handler = _command_handlers.get(content.strip())
    return handler(thread_id) if handler else None


def get_agent_prompt_override(thread_id: str) -> str | None:
    return DARK_MODE_PROMPT if thread_id in _dark_mode_threads else None


def clear_agent_command_state(thread_id: str) -> None:
    _dark_mode_threads.discard(thread_id)
