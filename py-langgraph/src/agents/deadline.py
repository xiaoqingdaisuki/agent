"""Request-scoped deadlines that expand only after the agent chooses a tool."""

from __future__ import annotations

import asyncio
from contextvars import ContextVar, Token
from typing import Self

from src.config.settings import settings


class AgentDeadline:
    """Keep pure chat within its short budget while permitting tool work to finish."""

    # 初始化当前对象
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
        self._loop: asyncio.AbstractEventLoop | None = None
        self._started_at = 0.0
        self._token: Token[AgentDeadline | None] | None = None
        self._tool_budget_enabled = False

    # 进入当前上下文
    async def __aenter__(self) -> Self:
        self._loop = asyncio.get_running_loop()
        self._started_at = self._loop.time()
        self._timeout = asyncio.timeout_at(self._started_at + self._chat_timeout_seconds)
        await self._timeout.__aenter__()
        self._token = _active_deadline.set(self)
        return self

    # 退出当前上下文并释放资源
    async def __aexit__(self, exc_type, exc_value, traceback):
        if self._token is not None:
            _active_deadline.reset(self._token)
            self._token = None
        if self._timeout is None:
            return None
        return await self._timeout.__aexit__(exc_type, exc_value, traceback)

    # 执行 enable tool budget 对应的业务逻辑
    def enable_tool_budget(self) -> None:
        if self._tool_budget_enabled or self._timeout is None:
            return
        self._tool_budget_enabled = True
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        if self._loop is not None and current_loop is not self._loop:
            try:
                self._loop.call_soon_threadsafe(self._reschedule_tool_timeout)
            except RuntimeError:
                # 事件循环已关闭时，保持原有截止时间并让调用自然结束。
                return
            return
        self._reschedule_tool_timeout()

    # 在创建 Timeout 的事件循环中安全调整工具阶段截止时间。
    def _reschedule_tool_timeout(self) -> None:
        if self._timeout is None or self._loop is None or self._loop.is_closed():
            return
        try:
            self._timeout.reschedule(self._started_at + self._tool_timeout_seconds)
        except (RuntimeError, ValueError):
            # 请求已退出或 Timeout 已失效时无需再次调整预算。
            return


_active_deadline: ContextVar[AgentDeadline | None] = ContextVar(
    "active_agent_deadline", default=None
)


# 执行 enable tool budget 对应的业务逻辑
def enable_tool_budget() -> None:
    deadline = _active_deadline.get()
    if deadline is not None:
        deadline.enable_tool_budget()
