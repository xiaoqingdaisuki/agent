from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.agents.base import build_tool_agent
from src.prompts.system import TOOL_CALLING_PROMPT

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
        # 注入用户记忆（与 v1 API / AgentService 保持一致）
        system_prompt: str | None = None
        if request.user_id:
            try:
                from src.profile.service import MemoryService, ProfileService
                profile = ProfileService.get_or_create(request.user_id)
                memory_context = MemoryService.build_memory_context(request.user_id)
                if memory_context:
                    system_prompt = f"{memory_context}\n\n{TOOL_CALLING_PROMPT}"
            except Exception:
                # 记忆模块不可用时静默降级，使用默认 prompt
                pass

        agent = build_tool_agent(system_prompt_override=system_prompt)

        thread_id = request.thread_id or "default"
        config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 20}
        if request.user_id:
            config["configurable"]["user_id"] = request.user_id

        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": request.message}], "user_id": request.user_id},
            config=config,
        )

        last_msg = result["messages"][-1]
        reply_text = last_msg.content or "抱歉，我没有理解您的问题。"

        return ChatResponse(reply=reply_text, thread_id=thread_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
