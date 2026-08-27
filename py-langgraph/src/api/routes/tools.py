from fastapi import APIRouter, Request

from src.tools import get_tool_metadata_for_user
from src.api.auth import get_agent_tool_identity
from src.tools.runtime.authorization import permissions_for_roles

router = APIRouter()


# 获取工具列表，根据用户权限过滤可见工具
@router.get("")
# 获取 list tools 对应的数据
async def list_tools(request: Request):
    identity = get_agent_tool_identity(request)
    return get_tool_metadata_for_user(list(permissions_for_roles(identity["roles"])))
