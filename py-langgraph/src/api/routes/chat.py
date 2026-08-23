from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from src.agents.graph_agents import (
    AGENT_RECURSION_LIMIT,
    build_chat_agent,
    build_tool_agent,
    get_fast_path_answer,
    is_direct_chat_message,
)
from src.agents.react_policy import summarize_react_state
from src.agents.deadline import AgentDeadline
from src.config.settings import settings
from src.agents.response_handler import get_finish_reason, is_likely_truncated, maybe_append_continuation_hint
from src.commands import (
    execute_agent_command,
    get_dark_mode_thread_id,
    get_agent_prompt_override,
    restore_agent_command_state,
)
from src.api.auth import require_agent_user_id
from src.services import (
    BusinessError,
    ConversationService,
    Message,
    extract_agent_output_text,
    schedule_answer_persistence,
)
from src.tools.runtime.executor import create_tool_call_context, tool_call_scope

router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    thread_id: str | None = None
    user_id: str | None = None


class ChatResponse(BaseModel):
    reply: str
    thread_id: str
    stop_reason: str | None = None
    react: dict | None = None


@router.post("", response_model=ChatResponse)
# 旧版非流式对话接口按消息意图选择本地快答、轻量对话或完整工具 Agent。
async def chat(payload: ChatRequest, request: Request):
    """旧版非流式对话接口，复用与 v1 相同的安全路由策略。

    明确普通生成任务使用无工具轻量图；实时、计算、文件、记忆和未知意图
    使用完整工具图，避免为了降低延迟而丢失工具能力。
    """
    trusted_user_id = require_agent_user_id(request, payload.user_id)
    try:
        thread_id = payload.thread_id or str(uuid4())
        ConversationService.ensure(thread_id, trusted_user_id)
        ConversationService.append_user_message(
            thread_id,
            payload.message,
            trusted_user_id,
        )
        command = execute_agent_command(payload.message, thread_id)
        if command:
            ConversationService.append_assistant_message(
                thread_id,
                Message("assistant", command.reply),
                trusted_user_id,
            )
            return ChatResponse(reply=command.reply, thread_id=thread_id)

        fast_answer = get_fast_path_answer(payload.message)
        if fast_answer:
            schedule_answer_persistence(
                thread_id,
                payload.message,
                fast_answer,
                trusted_user_id,
            )
            return ChatResponse(reply=fast_answer, thread_id=thread_id)

        user_messages = [
            str(message["content"])
            for message in ConversationService.get_messages(thread_id)
            if message.get("role") == "user"
        ]
        restore_agent_command_state(thread_id, user_messages)
        prompt_override = get_agent_prompt_override(thread_id, payload.message)
        agent_thread_id = (
            get_dark_mode_thread_id(thread_id)
            if prompt_override
            else thread_id
        )
        agent = (
            build_chat_agent()
            if is_direct_chat_message(payload.message)
            else build_tool_agent(system_prompt_override=prompt_override)
        )

        config = {
            "configurable": {"thread_id": agent_thread_id},
            "recursion_limit": AGENT_RECURSION_LIMIT,
        }
        if trusted_user_id:
            config["configurable"]["user_id"] = trusted_user_id

        runtime_context = create_tool_call_context(trusted_user_id, thread_id)
        with tool_call_scope(runtime_context):
            async with AgentDeadline(
                settings.agent_deadline_ms,
                settings.agent_deadline_with_tools_ms,
            ):
                result = await agent.ainvoke(
                    {
                        "messages": [{"role": "user", "content": payload.message}],
                        "user_id": trusted_user_id,
                    },
                    config=config,
                )

        reply_text = extract_agent_output_text(result) or "抱歉，我没有理解您的问题。"
        react_summary = summarize_react_state(result)

        # 检测 LLM 输出截断（finish_reason=length 或文本 abrupt ending）
        last_msg = next(
            (
                message
                for message in reversed(result.get("messages", []))
                if getattr(message, "type", "") == "ai"
            ),
            None,
        )
        finish_reason = get_finish_reason(last_msg) if last_msg is not None else None
        if is_likely_truncated(reply_text, finish_reason):
            reply_text = maybe_append_continuation_hint(reply_text, finish_reason)

        schedule_answer_persistence(
            thread_id,
            payload.message,
            reply_text,
            trusted_user_id,
        )

        return ChatResponse(
            reply=reply_text,
            thread_id=thread_id,
            stop_reason=react_summary["stop_reason"],
            react=react_summary,
        )
    except BusinessError as error:
        raise HTTPException(status_code=error.status_code, detail=error.to_dict())
    except TimeoutError:
        raise HTTPException(
            status_code=504,
            detail={"code": "AGENT_TIMEOUT", "message": "AI助手响应超时，请稍后重试。"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
