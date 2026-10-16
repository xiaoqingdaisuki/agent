import asyncio
from contextvars import ContextVar

import pytest

from src.api.sse import SseEventSequencer, encode_sse_heartbeat, with_sse_heartbeats


@pytest.mark.asyncio
async def test_failed_terminal_write_retains_retry_and_preserves_error(monkeypatch):
    from unittest.mock import Mock
    from src.api.sse import _pending_settlements, terminate_stream_turn

    terminate = Mock(side_effect=[RuntimeError("gateway unavailable"), {}])
    monkeypatch.setattr("src.services.TurnService.terminate", terminate)
    assert await terminate_stream_turn("turn", "user", False, "MODEL_RESPONSE_INVALID") is False
    await asyncio.wait_for(asyncio.gather(*list(_pending_settlements)), timeout=1)
    assert terminate.call_count == 2
    terminate.assert_called_with("turn", "user", False, "MODEL_RESPONSE_INVALID")


@pytest.mark.asyncio
async def test_terminal_retry_exhaustion_is_bounded_and_observable(monkeypatch, caplog):
    from unittest.mock import Mock
    from src.api.sse import _pending_settlements, terminate_stream_turn

    terminate = Mock(side_effect=RuntimeError("gateway unavailable"))
    monkeypatch.setattr("src.services.TurnService.terminate", terminate)
    assert await terminate_stream_turn("turn", "user", True, "CLIENT_CANCELLED") is False
    await asyncio.wait_for(asyncio.gather(*list(_pending_settlements)), timeout=2)
    assert terminate.call_count == 3
    assert "Turn settlement retries exhausted" in caplog.text


@pytest.mark.asyncio
async def test_cancelling_request_during_settlement_keeps_retry_alive(monkeypatch):
    import threading
    from unittest.mock import Mock
    from src.api.sse import flush_stream_settlements, terminate_stream_turn

    started, release = threading.Event(), threading.Event()

    def transient_failure(*args):
        started.set()
        release.wait(timeout=1)
        raise RuntimeError("gateway unavailable")

    terminate = Mock(side_effect=[None, {}])
    terminate.side_effect = lambda *args: transient_failure(*args) if terminate.call_count == 1 else {}
    monkeypatch.setattr("src.services.TurnService.terminate", terminate)
    request = asyncio.create_task(terminate_stream_turn("turn", "user", True, "CLIENT_CANCELLED"))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
    finally:
        release.set()
    await asyncio.wait_for(flush_stream_settlements(), timeout=2)
    assert terminate.call_count == 2


@pytest.mark.asyncio
async def test_heartbeats_cannot_extend_the_request_deadline():
    closed = asyncio.Event()
    async def stalled():
        try:
            await asyncio.sleep(10)
            yield {"type": "text", "text": "late"}
        finally:
            closed.set()
    with pytest.raises(TimeoutError):
        async for _event in with_sse_heartbeats(stalled(), 0.002, timeout_seconds=0.02):
            pass
    assert closed.is_set()


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


@pytest.mark.asyncio
async def test_closing_backpressured_stream_cancels_producer_without_hanging():
    closed = asyncio.Event()

    async def events():
        try:
            for index in range(10):
                yield {"type": "text", "text": str(index)}
        finally:
            closed.set()

    stream = with_sse_heartbeats(events())
    await anext(stream)
    await asyncio.sleep(0.01)
    await asyncio.wait_for(stream.aclose(), timeout=0.2)
    assert closed.is_set()


@pytest.mark.asyncio
async def test_upstream_cancellation_reaches_consumer_instead_of_infinite_heartbeats():
    async def events():
        yield {"type": "text", "text": "one"}
        raise asyncio.CancelledError("upstream cancelled")

    stream = with_sse_heartbeats(events(), 0.01)
    assert await anext(stream) == {"type": "text", "text": "one"}
    with pytest.raises(asyncio.CancelledError, match="upstream cancelled"):
        await asyncio.wait_for(anext(stream), timeout=0.2)
