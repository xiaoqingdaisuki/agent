"""Request-scoped deadlines that expand only after the agent chooses a tool."""

from __future__ import annotations

import asyncio
from contextvars import ContextVar, Token
from typing import Self

from src.config.settings import settings


class AgentDeadline:
    """Keep pure chat within its short budget while permitting tool work to finish."""

    def __init__(
        self,
        chat_timeout_ms: int | None = None,
        tool_timeout_ms: int | None = None,
    ) -> None:
        self._chat_timeout_seconds = (chat_timeout_ms or settings.agent_deadline_ms) / 1000
        self._tool_timeout_seconds = (
            tool_timeout_ms or settings.agent_deadline_with_tools_ms
        ) / 1000
        self._timeout: asyncio.Timeout | None = None
        self._started_at = 0.0
        self._token: Token[AgentDeadline | None] | None = None
        self._tool_budget_enabled = False

    async def __aenter__(self) -> Self:
        self._started_at = asyncio.get_running_loop().time()
        self._timeout = asyncio.timeout_at(self._started_at + self._chat_timeout_seconds)
        await self._timeout.__aenter__()
        self._token = _active_deadline.set(self)
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        if self._token is not None:
            _active_deadline.reset(self._token)
            self._token = None
        if self._timeout is None:
            return None
        return await self._timeout.__aexit__(exc_type, exc_value, traceback)

    def enable_tool_budget(self) -> None:
        if self._tool_budget_enabled or self._timeout is None:
            return
        self._tool_budget_enabled = True
        self._timeout.reschedule(self._started_at + self._tool_timeout_seconds)


_active_deadline: ContextVar[AgentDeadline | None] = ContextVar(
    "active_agent_deadline", default=None
)


def enable_tool_budget() -> None:
    deadline = _active_deadline.get()
    if deadline is not None:
        deadline.enable_tool_budget()
