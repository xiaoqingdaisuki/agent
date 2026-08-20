import json
import logging
from uuid import uuid4

from fastapi import APIRouter, Request
from pydantic import BaseModel

from src.agents.base import AGENT_RECURSION_LIMIT, build_tool_agent
from src.agents.deadline import AgentDeadline
from src.agents.response_handler import maybe_append_continuation_hint
from src.commands import execute_agent_command, get_agent_prompt_override
from src.api.auth import require_agent_user_id
from src.tools.runtime.executor import create_tool_call_context, tool_call_scope

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
    from src.services import ConversationService, Message

    ConversationService.ensure(thread_id, trusted_user_id)

    command = execute_agent_command(payload.message, thread_id)

    if command:
        ConversationService.append_user_message(
            thread_id, payload.message, trusted_user_id
        )
        ConversationService.append_assistant_message(
            thread_id,
            Message("assistant", command.reply),
            trusted_user_id,
        )
        # 生成命令响应的 SSE 事件流
        async def command_event_generator():
            payload = json.dumps({"text": command.reply}, ensure_ascii=False)
            yield f"data: {payload}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(command_event_generator(), media_type="text/event-stream")

    ConversationService.append_user_message(
        thread_id, payload.message, trusted_user_id
    )
    agent = build_tool_agent(
        system_prompt_override=get_agent_prompt_override(thread_id, payload.message)
    )
    config = {
        "configurable": {"thread_id": thread_id},
        "recursion_limit": AGENT_RECURSION_LIMIT,
    }
    if trusted_user_id:
        config["configurable"]["user_id"] = trusted_user_id
        try:
            from src.profile.service import ProfileService

            ProfileService.get_or_create(trusted_user_id)
        except Exception:
            pass

    input_data = {
        "messages": [{"role": "user", "content": payload.message}],
        "user_id": trusted_user_id,
    }

    # 生成 SSE 事件流：文本增量 + 工具调用事件
    async def event_generator():
        metadata = json.dumps({"thread_id": thread_id}, ensure_ascii=False)
        yield f"data: {metadata}\n\n"
        try:
            full_answer = ""
            runtime_context = create_tool_call_context(trusted_user_id, thread_id)
            with tool_call_scope(runtime_context):
                async with AgentDeadline():
                    async for event in agent.astream_events(
                        input_data,
                        config=config,
                        version="v2",
                    ):
                        kind = event.get("event")
                        run_id = event.get("run_id", "")
                        if kind == "on_tool_start":
                            payload = json.dumps(
                                {
                                    "event": "tool",
                                    "tool_name": event.get("name", "tool"),
                                    "status": "started",
                                    "run_id": run_id,
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
                                    "run_id": run_id,
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
                                    "run_id": run_id,
                                },
                                ensure_ascii=False,
                            )
                            yield f"data: {payload}\n\n"
                        elif kind == "on_chat_model_stream":
                            chunk = event["data"]["chunk"]
                            if isinstance(chunk.content, str) and chunk.content:
                                full_answer += chunk.content
                                payload = json.dumps(
                                    {"text": chunk.content}, ensure_ascii=False
                                )
                                yield f"data: {payload}\n\n"

            # 正常完成：保存完整回答
            if full_answer:
                ConversationService.append_assistant_message(
                    thread_id,
                    Message("assistant", maybe_append_continuation_hint(full_answer)),
                    trusted_user_id,
                )
        except TimeoutError:
            if full_answer:
                # 超时但有部分结果 → 返回部分内容 + 继续提示
                partial = maybe_append_continuation_hint(full_answer)
                ConversationService.append_assistant_message(
                    thread_id,
                    Message("assistant", partial),
                    trusted_user_id,
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
                ConversationService.append_assistant_message(
                    thread_id,
                    Message("assistant", partial),
                    trusted_user_id,
                )
                yield f"data: {json.dumps({'text': partial, 'partial': True}, ensure_ascii=False)}\n\n"
            else:
                payload = json.dumps({"error": "Internal server error"}, ensure_ascii=False)
                yield f"data: {payload}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
