"""Docker 可观测性：输出带请求上下文且已脱敏的错误日志。"""

from __future__ import annotations

import json
import logging
import re
import traceback
from typing import Any
from uuid import uuid4

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


# 获取请求级 ID，优先复用上游 ID，否则为当前请求生成稳定 ID
def get_request_id(request: Request) -> str:
    request_id = request.headers.get("x-request-id") or getattr(
        request.state, "request_id", None
    )
    if not request_id:
        request_id = uuid4().hex
        request.state.request_id = request_id
    return request_id


# 构造与 TS 日志 err/request_context 字段对应的错误事件
def build_request_error_payload(
    request: Request,
    error: BaseException,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    stack = "".join(traceback.format_exception(type(error), error, error.__traceback__))
    return {
        "err": {
            "type": type(error).__name__,
            "message": str(error),
            "stack": stack,
        },
        "request_context": {
            "request_id": get_request_id(request),
            "method": request.method,
            "url": str(request.url),
            "params": sanitize_log_value(dict(request.path_params)),
            "query": sanitize_log_value(dict(request.query_params)),
            "body": sanitize_log_value(get_logged_request_body(request)),
            **sanitize_log_value(context or {}),
        },
    }


# 记录与 TS 版本等价的原始异常、堆栈和请求上下文
def log_request_error(
    request: Request,
    error: BaseException,
    context: dict[str, Any] | None = None,
) -> None:
    payload = build_request_error_payload(request, error, context)
    request.state.request_error_logged = True
    logger.error(
        "Agent request failed | %s",
        json.dumps(payload, ensure_ascii=False, default=str),
        exc_info=(type(error), error, error.__traceback__),
    )
