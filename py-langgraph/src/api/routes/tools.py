from fastapi import APIRouter
from src.tools import tools as tool_list

router = APIRouter()


@router.get("")
async def list_tools():
    return [
        {"name": t.name, "description": t.description}
        for t in tool_list
    ]
