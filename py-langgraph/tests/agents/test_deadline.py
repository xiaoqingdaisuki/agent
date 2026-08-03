import asyncio

import pytest

from src.agents.deadline import AgentDeadline, enable_tool_budget


async def test_pure_chat_keeps_the_short_deadline():
    with pytest.raises(TimeoutError):
        async with AgentDeadline(chat_timeout_ms=10, tool_timeout_ms=50):
            await asyncio.sleep(0.02)


async def test_tool_call_extends_the_active_request_deadline():
    async with AgentDeadline(chat_timeout_ms=10, tool_timeout_ms=50):
        enable_tool_budget()
        await asyncio.sleep(0.02)
