import asyncio
from uuid import uuid4

from fastapi import APIRouter, Request
from pydantic import BaseModel

from src.api.auth import require_agent_user_id
from src.api.request_logging import log_request_error
from src.api.sse import encode_sse_done, encode_sse_event
from src.services import AgentService, BusinessError, ConversationService

router = APIRouter()


class StreamRequest(BaseModel):
    message: str
    thread_id: str | None = None
    user_id: str | None = None


# 流式对话接口 — 使用 Server-Sent Events 逐字返回 AI 回复
@router.post("")
# 执行 stream 对应的业务逻辑
async def stream(payload: StreamRequest, request: Request):
    """流式对话 — 使用 Server-Sent Events"""
    from fastapi.responses import StreamingResponse

    trusted_user_id = require_agent_user_id(request, payload.user_id)
    thread_id = payload.thread_id or str(uuid4())

    # 确保会话记录存在于 D1（前端传入的 thread_id 需关联 conversations 表）
    ConversationService.ensure(thread_id, trusted_user_id)
    ConversationService.append_user_message(
        thread_id, payload.message, trusted_user_id
    )

    # 生成 SSE 事件流，复用 V1 的统一 AgentService 编排
    async def event_generator():
        yield encode_sse_event("meta", {"thread_id": thread_id})
        try:
            async for event in AgentService.chat_stream(
                thread_id, payload.message, user_id=trusted_user_id
            ):
                if await request.is_disconnected():
                    return
                response_payload = (
                    {"text": event["text"], "partial": event.get("partial")}
                    if event["type"] == "text"
                    else {
                        "event": "tool",
                        "tool_name": event["tool_name"],
                        "status": event["status"],
                        "call_id": event["call_id"],
                    }
                )
                yield encode_sse_event(
                    "text" if event["type"] == "text" else "tool",
                    response_payload,
                )
        except BusinessError as error:
            log_request_error(
                request,
                error,
                {"thread_id": thread_id, "user_id": trusted_user_id, "stream": True},
            )
            yield encode_sse_event(
                "error", {"ok": False, "error": error.to_dict().get("error", error.to_dict())}
            )
        except asyncio.CancelledError:
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
            yield encode_sse_event(
                "error",
                {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": "处理请求时发生错误"}},
            )
        yield encode_sse_done()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
