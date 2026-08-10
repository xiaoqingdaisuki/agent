"""Agent 外部 API 的服务认证与可信用户身份绑定。"""

import hmac
import re

from fastapi import Request
from fastapi.responses import JSONResponse

from src.config.settings import settings
from src.services import BusinessError, BusinessErrorCode

PUBLIC_PATHS = {"/health", "/api/v1/health"}
USER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


# 校验服务间 Bearer 密钥并记录可信用户标识
async def agent_auth_middleware(request: Request, call_next):
    if request.url.path in PUBLIC_PATHS:
        return await call_next(request)

    if not settings.agent_api_secret:
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "code": BusinessErrorCode.SERVICE_UNAVAILABLE.value,
                    "message": "Agent API authentication is not configured",
                }
            },
        )

    authorization = request.headers.get("authorization", "")
    provided = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
    if not hmac.compare_digest(provided, settings.agent_api_secret):
        return JSONResponse(
            status_code=401,
            content={
                "error": {
                    "code": BusinessErrorCode.UNAUTHORIZED.value,
                    "message": "缺少或无效的认证凭证",
                }
            },
        )

    raw_user_id = request.headers.get("x-agent-user-id")
    if raw_user_id is not None and not USER_ID_PATTERN.fullmatch(raw_user_id):
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "code": BusinessErrorCode.INVALID_REQUEST.value,
                    "message": "用户标识格式不正确",
                }
            },
        )
    request.state.agent_user_id = raw_user_id
    return await call_next(request)


# 获取可信用户标识并拒绝请求参数冒充其他用户
def require_agent_user_id(request: Request, submitted_user_id: str | None = None) -> str:
    trusted_user_id = getattr(request.state, "agent_user_id", None)
    if not trusted_user_id:
        raise BusinessError(
            BusinessErrorCode.UNAUTHORIZED,
            "缺少可信用户标识",
            401,
        )
    if submitted_user_id and submitted_user_id != trusted_user_id:
        raise BusinessError(
            BusinessErrorCode.FORBIDDEN,
            "请求中的用户标识与认证身份不一致",
            403,
        )
    return trusted_user_id
