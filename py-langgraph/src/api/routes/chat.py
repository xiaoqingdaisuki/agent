from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.agents.base import build_chat_agent

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
    try:
        agent = build_chat_agent()
        thread_id = request.thread_id or "default"
        config = {"configurable": {"thread_id": thread_id}}

        input_data = {"messages": [{"role": "user", "content": request.message}]}
        if request.user_id:
            input_data["user_id"] = request.user_id

        result = await agent.ainvoke(
            input_data,
            config=config,
        )

        last_msg = result["messages"][-1]
        return ChatResponse(reply=last_msg.content, thread_id=thread_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
