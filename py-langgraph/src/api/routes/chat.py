import asyncio
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.agents.base import AGENT_RECURSION_LIMIT, build_tool_agent
from src.commands import execute_agent_command, get_agent_prompt_override
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
async def chat(request: ChatRequest):
    """旧版对话接口 — 强制走 tool agent，保证工具调用能力

    与 /stream 和 /api/v1 一致，所有旧接口统一使用 build_tool_agent，
    避免出现无工具绑定的"哑巴" agent。
    """
    try:
        thread_id = request.thread_id or str(uuid4())
        command = execute_agent_command(request.message, thread_id)
        if command:
            return ChatResponse(reply=command.reply, thread_id=thread_id)

        if request.user_id:
            try:
                from src.profile.service import ProfileService

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

        async with asyncio.timeout(settings.agent_deadline_ms / 1000):
            result = await agent.ainvoke(
                {
                    "messages": [{"role": "user", "content": request.message}],
                    "user_id": request.user_id,
                },
                config=config,
            )

        last_msg = result["messages"][-1]
        reply_text = last_msg.content or "抱歉，我没有理解您的问题。"

        return ChatResponse(reply=reply_text, thread_id=thread_id)
    except TimeoutError:
        raise HTTPException(
            status_code=504,
            detail={"code": "AGENT_TIMEOUT", "message": "AI助手响应超时，请稍后重试。"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
