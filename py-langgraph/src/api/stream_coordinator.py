import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing

from fastapi import Request

from src.api.request_logging import log_request_error
from src.api.sse import (
    SseEventSequencer,
    encode_sse_heartbeat,
    terminate_stream_turn,
    with_sse_heartbeats,
)
from src.services import BusinessError, Message, TurnService


# 统一转换 Agent 事件，避免两个外部路由维护重复协议分支。
def encode_agent_event(sequencer: SseEventSequencer, event: dict) -> str:
    if event["type"] == "text":
        return sequencer.event(
            "text",
            {
                "delta": event["text"],
                "text": event["text"],
                "partial": event.get("partial", False),
                "delivery": event.get("delivery", "delta"),
            },
        )
    if event["type"] == "tool":
        return sequencer.event(
            "tool",
            {
                "event": "tool",
                "tool_name": event["tool_name"],
                "status": event["status"],
                "call_id": event["call_id"],
                "duration_ms": event.get("duration_ms"),
                **({"output": event["output"]} if event.get("output") else {}),
            },
        )
    return sequencer.event(
        event.get("event", "agent"),
        {
            "state": event.get("state"),
            "stop_reason": event.get("stop_reason"),
            "react": event.get("react"),
        },
    )


# 集中管理流式轮次的重放、超时、取消和终态写入。
async def stream_turn(
    request: Request,
    conversation_id: str,
    user_id: str,
    turn: dict,
    completed: Message | None,
    events: Callable[[], AsyncIterator[dict]],
    deadline: float,
) -> AsyncIterator[str]:
    sequencer = SseEventSequencer(turn["id"])
    settled = completed is not None
    settlement_requested = False
    full_answer = ""
    context = {"conversation_id": conversation_id, "user_id": user_id, "stream": True}
    try:
        yield sequencer.event(
            "meta",
            {
                "conversation_id": conversation_id,
                "thread_id": conversation_id,
                "turn_id": turn["id"],
            },
        )
        if completed:
            yield sequencer.event(
                "text",
                {
                    "delta": completed.content,
                    "text": completed.content,
                    "partial": False,
                    "replayed": True,
                    "delivery": "immediate",
                },
            )
        else:
            remaining = max(0.001, deadline - asyncio.get_running_loop().time())
            async with aclosing(
                with_sse_heartbeats(events(), timeout_seconds=remaining)
            ) as stream_events:
                async for event in stream_events:
                    if await request.is_disconnected():
                        settlement_requested = True
                        settled = await terminate_stream_turn(
                            turn["id"], user_id, True, "CLIENT_CANCELLED"
                        )
                        return
                    if event is None:
                        yield encode_sse_heartbeat()
                    else:
                        if event["type"] == "text":
                            full_answer += event["text"]
                        yield encode_agent_event(sequencer, event)
            await asyncio.to_thread(
                TurnService.complete, turn["id"], user_id, Message("assistant", full_answer)
            )
            settled = True
    except (asyncio.CancelledError, GeneratorExit):
        log_request_error(request, RuntimeError("Client disconnected"), context)
        raise
    except Exception as error:
        log_request_error(request, error, context)
        if isinstance(error, BusinessError):
            code = error.code.value
            payload = error.to_dict().get("error", error.to_dict())
        elif isinstance(error, TimeoutError):
            code = "AGENT_TIMEOUT"
            payload = {"code": code, "message": "AI助手响应超时，请稍后重试。"}
        else:
            code = "INTERNAL_ERROR"
            payload = {"code": code, "message": "处理请求时发生错误"}
        if not settled:
            settlement_requested = True
            settled = await terminate_stream_turn(turn["id"], user_id, False, code)
        yield sequencer.event("error", {"ok": False, "error": payload})
    finally:
        if not settled and not settlement_requested:
            await terminate_stream_turn(turn["id"], user_id, True, "CLIENT_CANCELLED")
    yield sequencer.done()
