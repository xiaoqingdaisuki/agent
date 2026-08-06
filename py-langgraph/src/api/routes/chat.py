from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.agents.base import AGENT_RECURSION_LIMIT, build_tool_agent
from src.agents.deadline import AgentDeadline
from src.agents.response_handler import get_finish_reason, is_likely_truncated, maybe_append_continuation_hint
from src.commands import execute_agent_command, get_agent_prompt_override
from src.services import ConversationService, Message

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
async def chat(request: ChatRequest):
    """旧版对话接口 — 强制走 tool agent，保证工具调用能力

    与 /stream 和 /api/v1 一致，所有旧接口统一使用 build_tool_agent，
    避免出现无工具绑定的"哑巴" agent。
    """
    try:
        thread_id = request.thread_id or str(uuid4())
        ConversationService.ensure(thread_id, request.user_id)
        ConversationService.append_user_message(
            thread_id,
            request.message,
            request.user_id or "",
        )
        command = execute_agent_command(request.message, thread_id)
        if command:
            ConversationService.append_assistant_message(
                thread_id,
                Message("assistant", command.reply),
                request.user_id or "",
            )
            return ChatResponse(reply=command.reply, thread_id=thread_id)

        if request.user_id:
            try:
                from src.profile.service import ProfileService

                # 获取用户画像，不存在时自动创建
                ProfileService.get_or_create(request.user_id)
            except Exception:
                # Profile storage is optional; the agent loads memory when available.
                pass

        agent = build_tool_agent(
            system_prompt_override=get_agent_prompt_override(thread_id, request.message)
        )

        config = {
            "configurable": {"thread_id": thread_id},
            "recursion_limit": AGENT_RECURSION_LIMIT,
        }
        if request.user_id:
            config["configurable"]["user_id"] = request.user_id

        async with AgentDeadline():
            result = await agent.ainvoke(
                {
                    "messages": [{"role": "user", "content": request.message}],
                    "user_id": request.user_id,
                },
                config=config,
            )

        last_msg = result["messages"][-1]
        reply_text = last_msg.content or "抱歉，我没有理解您的问题。"

        # 检测 LLM 输出截断（finish_reason=length 或文本 abrupt ending）
        finish_reason = get_finish_reason(last_msg)
        if is_likely_truncated(reply_text, finish_reason):
            reply_text = maybe_append_continuation_hint(reply_text, finish_reason)

        ConversationService.append_assistant_message(
            thread_id,
            Message("assistant", reply_text),
            request.user_id or "",
        )

        return ChatResponse(reply=reply_text, thread_id=thread_id)
    except TimeoutError:
        raise HTTPException(
            status_code=504,
            detail={"code": "AGENT_TIMEOUT", "message": "AI助手响应超时，请稍后重试。"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
