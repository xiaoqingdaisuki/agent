import json
import logging
from uuid import uuid4

from fastapi import APIRouter
from pydantic import BaseModel

from src.agents.base import AGENT_RECURSION_LIMIT, build_tool_agent
from src.agents.deadline import AgentDeadline
from src.commands import execute_agent_command, get_agent_prompt_override

router = APIRouter()


class StreamRequest(BaseModel):
    message: str
    thread_id: str | None = None
    user_id: str | None = None


@router.post("")
async def stream(request: StreamRequest):
    """流式对话 — 使用 Server-Sent Events"""
    from fastapi.responses import StreamingResponse

    thread_id = request.thread_id or str(uuid4())
    command = execute_agent_command(request.message, thread_id)

    if command:

        async def command_event_generator():
            payload = json.dumps({"text": command.reply}, ensure_ascii=False)
            yield f"data: {payload}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(command_event_generator(), media_type="text/event-stream")

    agent = build_tool_agent(
        system_prompt_override=get_agent_prompt_override(thread_id, request.message)
    )
    config = {
        "configurable": {"thread_id": thread_id},
        "recursion_limit": AGENT_RECURSION_LIMIT,
    }
    if request.user_id:
        config["configurable"]["user_id"] = request.user_id
        try:
            from src.profile.service import ProfileService

            ProfileService.get_or_create(request.user_id)
        except Exception:
            pass

    input_data = {
        "messages": [{"role": "user", "content": request.message}],
        "user_id": request.user_id,
    }

    async def event_generator():
        metadata = json.dumps({"thread_id": thread_id}, ensure_ascii=False)
        yield f"data: {metadata}\n\n"
        try:
            async with AgentDeadline():
                async for event in agent.astream_events(
                    input_data,
                    config=config,
                    version="v2",
                ):
                    kind = event.get("event")
                    if kind == "on_tool_start":
                        payload = json.dumps(
                            {
                                "event": "tool",
                                "tool_name": event.get("name", "tool"),
                                "status": "started",
                            },
                            ensure_ascii=False,
                        )
                        yield f"data: {payload}\n\n"
                    elif kind == "on_tool_end":
                        payload = json.dumps(
                            {
                                "event": "tool",
                                "tool_name": event.get("name", "tool"),
                                "status": "completed",
                            },
                            ensure_ascii=False,
                        )
                        yield f"data: {payload}\n\n"
                    elif kind == "on_tool_error":
                        payload = json.dumps(
                            {
                                "event": "tool",
                                "tool_name": event.get("name", "tool"),
                                "status": "failed",
                            },
                            ensure_ascii=False,
                        )
                        yield f"data: {payload}\n\n"
                    elif kind == "on_chat_model_stream":
                        chunk = event["data"]["chunk"]
                        if isinstance(chunk.content, str) and chunk.content:
                            payload = json.dumps({"text": chunk.content}, ensure_ascii=False)
                            yield f"data: {payload}\n\n"
        except TimeoutError:
            payload = json.dumps(
                {"error": {"code": "AGENT_TIMEOUT", "message": "AI助手响应超时，请稍后重试。"}},
                ensure_ascii=False,
            )
            yield f"data: {payload}\n\n"
        except Exception:
            logging.getLogger("agent.stream").exception("Stream failed")
            payload = json.dumps({"error": "Internal server error"}, ensure_ascii=False)
            yield f"data: {payload}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
