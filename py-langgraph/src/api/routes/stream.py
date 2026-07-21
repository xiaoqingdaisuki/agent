from fastapi import APIRouter
from pydantic import BaseModel
from src.agents.base import build_tool_agent
from src.config.settings import settings


router = APIRouter()


class StreamRequest(BaseModel):
    message: str
    thread_id: str | None = None


@router.post("")
async def stream(request: StreamRequest):
    """流式对话 — 使用 Server-Sent Events"""
    from fastapi.responses import StreamingResponse

    agent = build_tool_agent()
    thread_id = request.thread_id or "default"
    config = {"configurable": {"thread_id": thread_id}}

    async def event_generator():
        try:
            async for event in agent.astream_events(
                {"messages": [{"role": "user", "content": request.message}]},
                config=config,
                version="v2",
            ):
                kind = event.get("event")
                if kind == "on_chat_model_stream":
                    chunk = event["data"]["chunk"]
                    if chunk.content:
                        yield f"data: {chunk.content}\n\n"
                elif kind == "on_tool_start":
                    yield f"data: [tool:{event['name']}]\n\n"
        except Exception as e:
            yield f"data: [error:{str(e)}]\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
