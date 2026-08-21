"""Docker 可观测性：输出带请求上下文且已脱敏的错误日志。"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import Request

logger = logging.getLogger("agent.request")

_SENSITIVE_FIELD_PATTERN = re.compile(
    r"authorization|api[_-]?key|token|secret|password|cookie", re.IGNORECASE
)
_MAX_LOGGED_TEXT_LENGTH = 10_000


# 递归脱敏日志值并截断超长文本，保留排障所需的请求内容
def sanitize_log_value(value: Any, field_name: str = "") -> Any:
    if _SENSITIVE_FIELD_PATTERN.search(field_name):
        return "[REDACTED]"
    if isinstance(value, str):
        return (
            f"{value[:_MAX_LOGGED_TEXT_LENGTH]}…[TRUNCATED]"
            if len(value) > _MAX_LOGGED_TEXT_LENGTH
            else value
        )
    if isinstance(value, list):
        return [sanitize_log_value(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): sanitize_log_value(item, str(key))
            for key, item in value.items()
        }
    return value


# 从已缓存的请求体中提取可安全记录的 JSON 数据
def get_logged_request_body(request: Request) -> Any:
    raw_body = getattr(request, "_body", b"")
    if not raw_body:
        return None
    try:
        return json.loads(raw_body)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return {"raw_body": raw_body.decode("utf-8", errors="replace")}


# 记录原始异常、堆栈和请求上下文，便于直接通过 Docker 日志排障
def log_request_error(
    request: Request,
    error: Exception,
    context: dict[str, Any] | None = None,
) -> None:
    logger.error(
        "Agent request failed | request_id=%s method=%s path=%s query=%s body=%s context=%s",
        request.headers.get("x-request-id", ""),
        request.method,
        request.url.path,
        sanitize_log_value(dict(request.query_params)),
        sanitize_log_value(get_logged_request_body(request)),
        sanitize_log_value(context or {}),
        exc_info=(type(error), error, error.__traceback__),
    )
