"""Agent 外部 API 的服务认证与可信用户身份绑定。"""

import hmac
import re
import time

from fastapi import Request
from fastapi.responses import JSONResponse

from src.config.settings import settings
from src.services import BusinessError, BusinessErrorCode

PUBLIC_PATHS = {
    "/health",
    "/health/live",
    "/health/ready",
    "/api/v1/health",
    "/api/v1/health/live",
    "/api/v1/health/ready",
}
USER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
TENANT_ID_PATTERN = re.compile(r"^[A-Za-z0-9:_-]{1,128}$")
ALLOWED_ROLES = frozenset({"viewer", "member", "admin"})
RATE_WINDOW_SECONDS = 60.0
MAX_RATE_BUCKETS = 20000
_rate_buckets: dict[str, tuple[int, float]] = {}


# 对可信身份执行进程内固定窗口限流，并返回需要等待的秒数。
def _consume_rate_limit(key: str, limit: int, now: float | None = None) -> int:
    current_time = time.monotonic() if now is None else now
    count, reset_at = _rate_buckets.get(key, (0, current_time + RATE_WINDOW_SECONDS))
    if reset_at <= current_time:
        count, reset_at = 0, current_time + RATE_WINDOW_SECONDS
    if count >= limit:
        return max(1, int(reset_at - current_time + 0.999))
    _rate_buckets[key] = (count + 1, reset_at)
    if len(_rate_buckets) > MAX_RATE_BUCKETS:
        for bucket_key, (_, candidate_reset) in list(_rate_buckets.items()):
            if candidate_reset <= current_time or len(_rate_buckets) > MAX_RATE_BUCKETS:
                _rate_buckets.pop(bucket_key, None)
            if len(_rate_buckets) <= MAX_RATE_BUCKETS:
                break
    return 0


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
    raw_tenant_id = request.headers.get("x-agent-tenant-id")
    if raw_tenant_id is not None and not TENANT_ID_PATTERN.fullmatch(raw_tenant_id):
        return JSONResponse(
            status_code=400,
            content={"error": {"code": BusinessErrorCode.INVALID_REQUEST.value, "message": "租户标识格式不正确"}},
        )
    request.state.agent_tenant_id = raw_tenant_id
    raw_roles = request.headers.get("x-agent-roles")
    roles = list(dict.fromkeys(role.strip() for role in raw_roles.split(",") if role.strip())) if raw_roles else ["member"]
    if raw_roles is not None and (not roles or any(role not in ALLOWED_ROLES for role in roles)):
        return JSONResponse(
            status_code=400,
            content={"error": {"code": BusinessErrorCode.INVALID_REQUEST.value, "message": "角色标识格式不正确"}},
        )
    request.state.agent_roles = roles
    if raw_user_id:
        tenant_id = raw_tenant_id or f"user:{raw_user_id}"
        retry_after = max(
            _consume_rate_limit(
                f"user:{tenant_id}:{raw_user_id}", settings.user_rate_limit_rpm
            ),
            _consume_rate_limit(
                f"tenant:{tenant_id}", settings.tenant_rate_limit_rpm
            ),
        )
        if retry_after:
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "code": BusinessErrorCode.RATE_LIMITED.value,
                        "message": "请求过于频繁，请稍后重试",
                    }
                },
                headers={"Retry-After": str(retry_after)},
            )
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


# 返回仅由已认证服务注入的完整工具身份。
def get_agent_tool_identity(request: Request, submitted_user_id: str | None = None) -> dict[str, str | list[str]]:
    user_id = require_agent_user_id(request, submitted_user_id)
    return {
        "user_id": user_id,
        "tenant_id": getattr(request.state, "agent_tenant_id", None) or f"user:{user_id}",
        "roles": getattr(request.state, "agent_roles", ["member"]),
    }
