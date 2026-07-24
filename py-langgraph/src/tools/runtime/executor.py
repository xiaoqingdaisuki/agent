"""
Tool Runtime — 统一执行管线

所有工具必须通过此 Runtime 执行，禁止绕过。

执行管线：
  1. 参数校验（JSON Schema 严格模式）
  2. 权限检查（permission_check）
  3. 预算守卫（budget_guard）
  4. 执行工具（带超时）
  5. 结果脱敏（result_sanitize）
  6. 审计记录（audit_record）
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Coroutine
from typing import Any, Generic, TypeVar

from src.tools.contracts import (
    ToolCallContext,
    ToolDescriptor,
    ToolError,
    ToolErrorCode,
    ToolResultEnvelope,
    ToolResultMeta,
    ToolRuntimeResult,
)
from src.tools.observability import record_tool_metric

TInput = TypeVar("TInput")
TOutput = TypeVar("TOutput")

# ============ 审计记录 ============

_audit_log: list[dict[str, Any]] = []


def get_audit_log() -> list[dict[str, Any]]:
    return list(_audit_log)


def clear_audit_log() -> None:
    _audit_log.clear()


# ============ 权限检查 ============

_permission_cache: dict[str, tuple[bool, float]] = {}
_PERMISSION_CACHE_TTL = 5.0  # seconds


def permission_check(
    context: ToolCallContext,
    descriptor: ToolDescriptor,
) -> tuple[bool, str | None]:
    """
    检查用户是否拥有指定权限。

    当前为最小可用实现：所有 R0/R1 只读工具默认允许，
    R2+ 工具需要显式声明 permissions 并通过策略。

    TODO: Phase 0.4 替换为真正的 RBAC 引擎
    """
    # R0 工具默认允许
    if descriptor.risk_level == "R0":
        return True, None

    perms = descriptor.required_permissions or []

    # 无权限要求 → 允许
    if not perms:
        return True, None

    # 检查缓存
    cache_key = f"{context.user_id}:{context.tenant_id}:{','.join(perms)}"
    cached = _permission_cache.get(cache_key)
    if cached and (time.time() - cached[1]) < _PERMISSION_CACHE_TTL:
        return cached

    # 最小 RBAC：只要有 user_id 就允许
    granted = bool(context.user_id)
    reason = None if granted else "UNAUTHENTICATED: user_id required"

    _permission_cache[cache_key] = (granted, time.time())
    return granted, reason


# ============ 参数校验 ============

def validate_input(
    schema: Callable[[Any], Any],
    raw_input: Any,
) -> ToolRuntimeResult[TInput]:
    """
    使用 Pydantic model 校验输入参数。

    严格模式：拒绝额外字段。
    """
    try:
        parsed = schema(**raw_input) if isinstance(raw_input, dict) else schema(raw_input)
        return ToolRuntimeResult(success=True, data=parsed)
    except Exception as exc:
        message = str(exc)
        return ToolRuntimeResult(
            success=False,
            error=ToolError(code="INVALID_ARGUMENT", message=message),
        )


# ============ 结果脱敏 ============

_SENSITIVE_KEYS = frozenset({
    "api_key", "apikey", "secret", "password", "token",
    "access_token", "refresh_token", "private_key",
    "authorization", "credentials",
})


def sanitize_result(data: Any) -> Any:
    """对工具返回结果进行基本脱敏 — 递归过滤常见敏感键。"""
    if isinstance(data, dict):
        result: dict[str, Any] = {}
        for key, value in data.items():
            if key.lower() in _SENSITIVE_KEYS:
                result[key] = "[REDACTED]"
            elif isinstance(value, (dict, list)):
                result[key] = sanitize_result(value)
            else:
                result[key] = value
        return result
    elif isinstance(data, list):
        return [sanitize_result(item) for item in data]
    return data


# ============ 预算守卫 ============

class _BudgetState:
    tool_calls_this_round: int = 0
    total_tool_calls: int = 0
    max_per_round: int = 8
    max_total: int = 20


_budget = _BudgetState()


def reset_round_budget() -> None:
    _budget.tool_calls_this_round = 0


def budget_guard() -> ToolRuntimeResult[None] | None:
    """检查预算限制，返回 None 表示通过，否则返回错误结果。"""
    if _budget.tool_calls_this_round >= _budget.max_per_round:
        return ToolRuntimeResult(
            success=False,
            error=ToolError(
                code="RATE_LIMITED",
                message=f"单轮工具调用已达上限 ({_budget.max_per_round})",
            ),
        )
    if _budget.total_tool_calls >= _budget.max_total:
        return ToolRuntimeResult(
            success=False,
            error=ToolError(
                code="RATE_LIMITED",
                message=f"累计工具调用已达上限 ({_budget.max_total})",
            ),
        )
    _budget.tool_calls_this_round += 1
    _budget.total_tool_calls += 1
    return None


# ============ 审计记录 ============

def record_audit(entry: dict[str, Any]) -> None:
    _audit_log.append(entry)
    # 保留最近 1000 条
    if len(_audit_log) > 1000:
        del _audit_log[: len(_audit_log) - 1000]


# ============ 核心执行器 ============

class ToolExecutor(Generic[TInput, TOutput]):
    """
    统一执行管线包装器。

    执行管线：
      validate → permission_check → budget_guard → execute → sanitize → audit
    """

    def __init__(
        self,
        descriptor: ToolDescriptor,
        execute_fn: Callable[[TInput, ToolCallContext], Coroutine[Any, Any, TOutput]],
        schema: Callable[[Any], TInput] | None = None,
    ):
        self.descriptor = descriptor
        self._execute_fn = execute_fn
        self.schema = schema


async def invoke_tool(
    executor: ToolExecutor[TInput, TOutput],
    raw_input: Any,
    context: ToolCallContext,
) -> ToolResultEnvelope[TOutput]:
    """
    统一执行入口。

    所有工具必须通过此函数调用，不得绕过。
    """
    tool_name = executor.descriptor.name
    tool_version = executor.descriptor.version
    start_time = time.perf_counter()
    call_id = f"call_{int(start_time * 1000)}_{hash(tool_name) % 10000:04x}"

    # 1. 预算守卫
    budget_result = budget_guard()
    if budget_result is not None:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        _record_audit(tool_name, tool_version, context, executor.descriptor.risk_level, False, budget_result.error.code, duration_ms, context.request_id, context.trace_id)
        return _error_envelope(call_id, tool_name, tool_version, budget_result.error, duration_ms)

    # 2. 参数校验
    validated_input = raw_input
    if executor.schema:
        validation = validate_input(executor.schema, raw_input)
        if not validation.success:
            duration_ms = int((time.perf_counter() - start_time) * 1000)
            _record_audit(tool_name, tool_version, context, executor.descriptor.risk_level, False, validation.error.code, duration_ms, context.request_id, context.trace_id)
            return _error_envelope(call_id, tool_name, tool_version, validation.error, duration_ms)
        validated_input = validation.data

    # 3. 权限检查
    granted, reason = permission_check(context, executor.descriptor)
    if not granted:
        error_code = "UNAUTHENTICATED" if reason and "UNAUTHENTICATED" in reason else "PERMISSION_DENIED"
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        _record_audit(tool_name, tool_version, context, executor.descriptor.risk_level, False, error_code, duration_ms, context.request_id, context.trace_id)
        return _error_envelope(call_id, tool_name, tool_version, ToolError(code=error_code, message=reason or "Permission denied"), duration_ms)

    # 4. 执行（带超时）
    raw_output: TOutput
    timeout_ms = executor.descriptor.timeout_ms
    try:
        raw_output = await asyncio.wait_for(
            executor._execute_fn(validated_input, context),
            timeout=timeout_ms / 1000,
        )
    except TimeoutError:
        error_code = "TIMEOUT"
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        _record_audit(tool_name, tool_version, context, executor.descriptor.risk_level, False, error_code, duration_ms, context.request_id, context.trace_id)
        return _error_envelope(call_id, tool_name, tool_version, ToolError(code=error_code, message=f"工具执行超时 ({timeout_ms}ms)"), duration_ms)
    except Exception as exc:
        error_code: ToolErrorCode = "INTERNAL_ERROR"
        message = str(exc)
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        _record_audit(tool_name, tool_version, context, executor.descriptor.risk_level, False, error_code, duration_ms, context.request_id, context.trace_id)
        return _error_envelope(call_id, tool_name, tool_version, ToolError(code=error_code, message=message), duration_ms)

    # 5. 结果脱敏
    sanitized = sanitize_result(raw_output)
    duration_ms = int((time.perf_counter() - start_time) * 1000)

    # 6. 审计记录
    _record_audit(tool_name, tool_version, context, executor.descriptor.risk_level, True, None, duration_ms, context.request_id, context.trace_id)

    return ToolResultEnvelope(
        ok=True,
        data=sanitized,
        error=None,
        meta=ToolResultMeta(
            tool_call_id=call_id,
            tool_name=tool_name,
            tool_version=tool_version,
            duration_ms=duration_ms,
        ),
    )


def _error_envelope(
    call_id: str,
    tool_name: str,
    tool_version: str,
    error: ToolError,
    duration_ms: int,
) -> ToolResultEnvelope[Any]:
    return ToolResultEnvelope(
        ok=False,
        data=None,
        error=error,
        meta=ToolResultMeta(
            tool_call_id=call_id,
            tool_name=tool_name,
            tool_version=tool_version,
            duration_ms=duration_ms,
        ),
    )


def _record_audit(
    tool_name: str,
    tool_version: str,
    context: ToolCallContext,
    risk_level: str,
    ok: bool,
    error_code: ToolErrorCode | None,
    duration_ms: int,
    request_id: str,
    trace_id: str,
) -> None:
    record_audit({
        "tool_name": tool_name,
        "tool_version": tool_version,
        "user_id": context.user_id,
        "tenant_id": context.tenant_id,
        "conversation_id": context.conversation_id,
        "risk_level": risk_level,
        "ok": ok,
        "error_code": error_code,
        "duration_ms": duration_ms,
        "request_id": request_id,
        "trace_id": trace_id,
    })
    # 同步记录可观测性指标
    record_tool_metric(
        tool_name=tool_name,
        tool_version=tool_version,
        ok=ok,
        error_code=error_code,
        duration_ms=duration_ms,
        risk_level=risk_level,
        user_id=context.user_id,
        tenant_id=context.tenant_id,
    )
