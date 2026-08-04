import json
import logging
from uuid import uuid4

from fastapi import APIRouter
from pydantic import BaseModel

from src.agents.base import AGENT_RECURSION_LIMIT, build_tool_agent
from src.agents.deadline import AgentDeadline
from src.agents.response_handler import maybe_append_continuation_hint
from src.commands import execute_agent_command, get_agent_prompt_override

router = APIRouter()


class StreamRequest(BaseModel):
    message: str
    thread_id: str | None = None
    user_id: str | None = None


# 流式对话接口 — 使用 Server-Sent Events 逐字返回 AI 回复
@router.post("")
async def stream(request: StreamRequest):
    """流式对话 — 使用 Server-Sent Events"""
    from fastapi.responses import StreamingResponse

    thread_id = request.thread_id or str(uuid4())
    command = execute_agent_command(request.message, thread_id)

    if command:
        # 生成命令响应的 SSE 事件流
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

    # 生成 SSE 事件流：文本增量 + 工具调用事件
    async def event_generator():
        metadata = json.dumps({"thread_id": thread_id}, ensure_ascii=False)
        yield f"data: {metadata}\n\n"
        try:
            full_answer = ""
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
                            full_answer += chunk.content
                            payload = json.dumps({"text": chunk.content}, ensure_ascii=False)
                            yield f"data: {payload}\n\n"

            # 正常完成：保存完整回答
            if full_answer:
                from src.services import ConversationService
                ConversationService.append_assistant_message(
                    thread_id,
                    type("Message", (), {"role": "assistant", "content": maybe_append_continuation_hint(full_answer)})(),
                )
        except TimeoutError:
            if full_answer:
                # 超时但有部分结果 → 返回部分内容 + 继续提示
                partial = maybe_append_continuation_hint(full_answer)
                from src.services import ConversationService
                ConversationService.append_assistant_message(
                    thread_id,
                    type("Message", (), {"role": "assistant", "content": partial})(),
                )
                yield f"data: {json.dumps({'text': partial, 'partial': True}, ensure_ascii=False)}\n\n"
            else:
                payload = json.dumps(
                    {"error": {"code": "AGENT_TIMEOUT", "message": "AI助手响应超时，请稍后重试。"}},
                    ensure_ascii=False,
                )
                yield f"data: {payload}\n\n"
        except Exception:
            logging.getLogger("agent.stream").exception("Stream failed")
            if full_answer:
                partial = maybe_append_continuation_hint(full_answer)
                from src.services import ConversationService
                ConversationService.append_assistant_message(
                    thread_id,
                    type("Message", (), {"role": "assistant", "content": partial})(),
                )
                yield f"data: {json.dumps({'text': partial, 'partial': True}, ensure_ascii=False)}\n\n"
            else:
                payload = json.dumps({"error": "Internal server error"}, ensure_ascii=False)
                yield f"data: {payload}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
