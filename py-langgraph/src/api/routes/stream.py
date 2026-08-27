import asyncio
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from src.api.auth import get_agent_tool_identity, require_agent_user_id
from src.api.request_logging import log_request_error
from src.api.sse import SseEventSequencer, encode_sse_heartbeat, with_sse_heartbeats
from src.services import (
    AgentService,
    BusinessError,
    ConversationService,
    Message,
    TurnService,
    wait_for_conversation_persistence,
)

router = APIRouter()


class StreamRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=16_000)
    thread_id: str | None = None
    user_id: str | None = None
    client_message_id: str | None = Field(default=None, min_length=1, max_length=128)


# 流式对话接口 — 使用 Server-Sent Events 逐字返回 AI 回复
@router.post("")
# 执行 stream 对应的业务逻辑
async def stream(payload: StreamRequest, request: Request):
    """流式对话 — 使用 Server-Sent Events"""
    from fastapi.responses import StreamingResponse

    trusted_user_id = require_agent_user_id(request, payload.user_id)
    tool_identity = get_agent_tool_identity(request, payload.user_id)
    thread_id = payload.thread_id or str(uuid4())

    # 确保会话存在于当前仓储，并校验传入 thread_id 的用户归属。
    ConversationService.ensure(thread_id, trusted_user_id)
    turn, created = TurnService.begin(
        thread_id, trusted_user_id, payload.client_message_id
    )
    completed = None if created else TurnService.completed_message(turn)
    if not created and not completed:
        error = TurnService.duplicate_error(turn["status"])
        raise HTTPException(status_code=error.status_code, detail=error.to_dict())
    if created:
        await wait_for_conversation_persistence(thread_id)
        user_message = ConversationService.append_user_message(
            thread_id, payload.message, trusted_user_id
        )
        TurnService.start(turn["id"], trusted_user_id, user_message.id)

    # 生成 SSE 事件流，复用 V1 的统一 AgentService 编排
    async def event_generator():
        sse_events = SseEventSequencer(turn["id"])
        full_answer = ""
        turn_completed = completed is not None
        yield sse_events.event(
            "meta", {"conversation_id": thread_id, "thread_id": thread_id, "turn_id": turn["id"]}
        )
        try:
            if completed:
                yield sse_events.event(
                    "text",
                    {"delta": completed.content, "text": completed.content, "partial": False, "replayed": True},
                )
                yield sse_events.done()
                return
            events = AgentService.chat_stream(
                thread_id, payload.message, user_id=trusted_user_id, tool_identity=tool_identity
            )
            async for event in with_sse_heartbeats(events):
                if await request.is_disconnected():
                    TurnService.terminate(turn["id"], trusted_user_id, True, "CLIENT_CANCELLED")
                    return
                if event is None:
                    yield encode_sse_heartbeat()
                    continue
                if event["type"] == "text":
                    full_answer += event["text"]
                    response_payload = {
                        "delta": event["text"],
                        "text": event["text"],
                        "partial": event.get("partial", False),
                    }
                    event_name = "text"
                elif event["type"] == "tool":
                    response_payload = {
                        "event": "tool",
                        "tool_name": event["tool_name"],
                        "status": event["status"],
                        "call_id": event["call_id"],
                        "duration_ms": event.get("duration_ms"),
                    }
                    event_name = "tool"
                else:
                    response_payload = {
                        "state": event.get("state"),
                        "stop_reason": event.get("stop_reason"),
                        "react": event.get("react"),
                    }
                    event_name = event.get("event", "agent")
                yield sse_events.event(
                    event_name,
                    response_payload,
                )
            persisted = next(
                (
                    item
                    for item in reversed(ConversationService.get_messages(thread_id))
                    if item["role"] == "assistant"
                ),
                None,
            )
            assistant = (
                Message("assistant", persisted["content"], persisted["id"], persisted["created_at"])
                if persisted
                else Message("assistant", full_answer)
            )
            TurnService.complete(turn["id"], trusted_user_id, assistant)
            turn_completed = True
        except BusinessError as error:
            log_request_error(
                request,
                error,
                {"thread_id": thread_id, "user_id": trusted_user_id, "stream": True},
            )
            yield sse_events.event(
                "error", {"ok": False, "error": error.to_dict().get("error", error.to_dict())}
            )
            if not turn_completed:
                try:
                    TurnService.terminate(turn["id"], trusted_user_id, False, error.code.value)
                except Exception:
                    pass
        except asyncio.CancelledError:
            if not turn_completed:
                try:
                    TurnService.terminate(turn["id"], trusted_user_id, True, "CLIENT_CANCELLED")
                except Exception:
                    pass
            log_request_error(
                request,
                RuntimeError("Client disconnected"),
                {"thread_id": thread_id, "user_id": trusted_user_id, "stream": True},
            )
            raise
        except Exception as error:
            log_request_error(
                request, error, {"thread_id": thread_id, "user_id": trusted_user_id, "stream": True}
            )
            yield sse_events.event(
                "error",
                {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": "处理请求时发生错误"}},
            )
            if not turn_completed:
                try:
                    TurnService.terminate(turn["id"], trusted_user_id, False, "INTERNAL_ERROR")
                except Exception:
                    pass
        yield sse_events.done()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
