import asyncio
from contextvars import ContextVar

import pytest

from src.api.sse import SseEventSequencer, encode_sse_heartbeat, with_sse_heartbeats


@pytest.mark.asyncio
async def test_sse_heartbeats_arrive_while_upstream_is_idle():
    async def delayed_events():
        await asyncio.sleep(0.02)
        yield {"type": "text", "text": "done"}

    events = [event async for event in with_sse_heartbeats(delayed_events(), 0.005)]
    assert any(event is None for event in events)
    assert events[-1] == {"type": "text", "text": "done"}
    assert encode_sse_heartbeat() == ": ping\n\n"


@pytest.mark.asyncio
async def test_sse_heartbeats_keep_upstream_context_for_entire_generator():
    active_scope = ContextVar("active_scope", default=None)

    async def scoped_events():
        token = active_scope.set("turn")
        try:
            yield {"type": "text", "text": "one"}
            await asyncio.sleep(0)
            yield {"type": "text", "text": "two"}
        finally:
            active_scope.reset(token)

    events = [event async for event in with_sse_heartbeats(scoped_events(), 0.01)]
    assert [event["text"] for event in events if event is not None] == ["one", "two"]


def test_sse_events_have_monotonic_turn_bound_event_ids():
    sequencer = SseEventSequencer("turn-1")

    first = sequencer.event("meta", {"thread_id": "turn-1"})
    second = sequencer.event("text", {"delta": "hello"})
    done = sequencer.done()

    assert "id: turn-1:1" in first
    assert '"event_id": "turn-1:2"' in second
    assert "id: turn-1:3" in done
