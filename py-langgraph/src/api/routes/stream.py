import asyncio
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from src.api.auth import get_agent_tool_identity, require_agent_user_id
from src.api.request_logging import log_request_error
from src.api.sse import begin_stream_turn
from src.api.stream_coordinator import stream_turn
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

    request_deadline = asyncio.get_running_loop().time() + 270
    trusted_user_id = require_agent_user_id(request, payload.user_id)
    tool_identity = get_agent_tool_identity(request, payload.user_id)
    thread_id = payload.thread_id or str(uuid4())

    # 确保会话存在于当前仓储，并校验传入 thread_id 的用户归属。
    await asyncio.to_thread(ConversationService.ensure, thread_id, trusted_user_id)
    turn, created = await begin_stream_turn(
        thread_id, trusted_user_id, payload.message, payload.client_message_id
    )
    completed = None if created else TurnService.completed_message(turn)
    if not created and not completed:
        error = TurnService.duplicate_error(turn["status"])
        raise HTTPException(status_code=error.status_code, detail=error.to_dict())

    # 延迟创建 Agent 迭代器，已完成轮次直接重放持久化结果。
    def events():
        return AgentService.chat_stream(
            thread_id, payload.message, user_id=trusted_user_id, tool_identity=tool_identity
        )

    return StreamingResponse(
        stream_turn(request, thread_id, trusted_user_id, turn, completed, events, request_deadline),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
