from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from src.agents.base import AGENT_RECURSION_LIMIT, build_tool_agent
from src.agents.deadline import AgentDeadline
from src.agents.response_handler import get_finish_reason, is_likely_truncated, maybe_append_continuation_hint
from src.commands import execute_agent_command, get_agent_prompt_override
from src.api.auth import require_agent_user_id
from src.services import BusinessError, ConversationService, Message
from src.tools.runtime.executor import create_tool_call_context, tool_call_scope
from src.config.settings import settings

router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    thread_id: str | None = None
    user_id: str | None = None


class ChatResponse(BaseModel):
    reply: str
    thread_id: str


@router.post("", response_model=ChatResponse)
# 旧版对话接口 — 强制走 tool agent，保证工具调用能力
async def chat(payload: ChatRequest, request: Request):
    """旧版对话接口 — 强制走 tool agent，保证工具调用能力

    与 /stream 和 /api/v1 一致，所有旧接口统一使用 build_tool_agent，
    避免出现无工具绑定的"哑巴" agent。
    """
    trusted_user_id = require_agent_user_id(request, payload.user_id)
    try:
        thread_id = payload.thread_id or str(uuid4())
        if settings.memory_enabled:
            ConversationService.ensure(thread_id, trusted_user_id)
            ConversationService.append_user_message(
                thread_id,
                payload.message,
                trusted_user_id,
            )
        command = execute_agent_command(payload.message, thread_id)
        if command:
            if settings.memory_enabled:
                ConversationService.append_assistant_message(
                    thread_id,
                    Message("assistant", command.reply),
                    trusted_user_id,
                )
            return ChatResponse(reply=command.reply, thread_id=thread_id)

        if settings.memory_enabled and trusted_user_id:
            try:
                from src.profile.service import ProfileService

                # 获取用户画像，不存在时自动创建
                ProfileService.get_or_create(trusted_user_id)
            except Exception:
                # Profile storage is optional; the agent loads memory when available.
                pass

        agent = build_tool_agent(
            system_prompt_override=get_agent_prompt_override(thread_id, payload.message)
        )

        config = {
            "configurable": {"thread_id": thread_id},
            "recursion_limit": AGENT_RECURSION_LIMIT,
        }
        if trusted_user_id:
            config["configurable"]["user_id"] = trusted_user_id

        runtime_context = create_tool_call_context(trusted_user_id, thread_id)
        with tool_call_scope(runtime_context):
            async with AgentDeadline():
                result = await agent.ainvoke(
                    {
                        "messages": [{"role": "user", "content": payload.message}],
                        "user_id": trusted_user_id,
                    },
                    config=config,
                )

        last_msg = result["messages"][-1]
        reply_text = last_msg.content or "抱歉，我没有理解您的问题。"

        # 检测 LLM 输出截断（finish_reason=length 或文本 abrupt ending）
        finish_reason = get_finish_reason(last_msg)
        if is_likely_truncated(reply_text, finish_reason):
            reply_text = maybe_append_continuation_hint(reply_text, finish_reason)

        if settings.memory_enabled:
            ConversationService.append_assistant_message(
                thread_id,
                Message("assistant", reply_text),
                trusted_user_id,
            )

        return ChatResponse(reply=reply_text, thread_id=thread_id)
    except BusinessError as error:
        raise HTTPException(status_code=error.status_code, detail=error.to_dict())
    except TimeoutError:
        raise HTTPException(
            status_code=504,
            detail={"code": "AGENT_TIMEOUT", "message": "AI助手响应超时，请稍后重试。"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
