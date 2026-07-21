from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from src.agents.base import build_chat_agent
from src.config.settings import settings


router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    thread_id: str | None = None


class ChatResponse(BaseModel):
    reply: str
    thread_id: str


@router.post("", response_model=ChatResponse)
async def chat(request: ChatRequest):
    try:
        agent = build_chat_agent()
        thread_id = request.thread_id or "default"
        config = {"configurable": {"thread_id": thread_id}}

        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": request.message}]},
            config=config,
        )

        last_msg = result["messages"][-1]
        return ChatResponse(reply=last_msg.content, thread_id=thread_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
