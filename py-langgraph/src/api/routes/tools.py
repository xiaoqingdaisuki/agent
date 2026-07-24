from fastapi import APIRouter

from src.tools import get_tool_metadata_for_user

router = APIRouter()


@router.get("")
async def list_tools(permissions: str = ""):
    user_perms = [p.strip() for p in permissions.split(",") if p.strip()]
    return get_tool_metadata_for_user(user_perms)
