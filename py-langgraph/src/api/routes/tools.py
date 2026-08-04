from fastapi import APIRouter

from src.tools import get_tool_metadata_for_user

router = APIRouter()


# 获取工具列表，根据用户权限过滤可见工具
@router.get("")
async def list_tools(permissions: str = ""):
    user_perms = [p.strip() for p in permissions.split(",") if p.strip()]
    return get_tool_metadata_for_user(user_perms)
