"""
Internal API — 给 QQ Bot 和其他内部消费者使用
"""

from fastapi import APIRouter
from pydantic import BaseModel, Field
from src.services import AgentService, BusinessError

router = APIRouter()


class InternalChatRequest(BaseModel):
    content: str = Field(..., min_length=1)
    channel_id: str = Field(...)


@router.post("/agent/chat")
async def internal_chat(req: InternalChatRequest):
    try:
        reply = await AgentService.chat(req.channel_id, req.content)
        return {"reply": reply.content, "channel_id": req.channel_id}
    except BusinessError as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=e.status_code, detail=e.to_dict())
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": str(e)},
        )


class StreamRequest(BaseModel):
    content: str = Field(..., min_length=1)
    channel_id: str = Field(...)


@router.post("/agent/chat/stream")
async def internal_chat_stream(req: StreamRequest):
    from fastapi.responses import StreamingResponse

    async def generate():
        try:
            async for chunk in AgentService.chat_stream(req.channel_id, req.content):
                yield f"data: {chunk}\n\n"
        except BusinessError as e:
            yield f"data: [ERROR] {e.message}\n\n"
        except Exception as e:
            yield f"data: [ERROR] {str(e)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
