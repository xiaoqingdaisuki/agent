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
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from collections.abc import Callable, Coroutine
from typing import Any, Generic, TypeVar
from uuid import uuid4

from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel

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
from src.tools.runtime.data_redaction import redact_text_content
from src.config.settings import settings

TInput = TypeVar("TInput")
TOutput = TypeVar("TOutput")

# ============ 审计记录 ============

_audit_log: list[dict[str, Any]] = []


# 返回审计日志的只读副本
def get_audit_log() -> list[dict[str, Any]]:
    return list(_audit_log)


# 清空审计日志
def clear_audit_log() -> None:
    _audit_log.clear()


# ============ 权限检查 ============

_permission_cache: dict[str, tuple[bool, float]] = {}
_PERMISSION_CACHE_TTL = 5.0  # seconds


# 检查用户是否拥有指定权限（当前为最小 RBAC 实现）
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


# 使用 Pydantic model 校验输入参数
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

_SENSITIVE_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "secret",
        "password",
        "token",
        "access_token",
        "refresh_token",
        "private_key",
        "authorization",
        "credentials",
    }
)


# 递归过滤结果中的敏感字段（密钥、Token、密码等），并对文本内容做内容级脱敏
def sanitize_result(data: Any) -> Any:
    """对工具返回结果进行脱敏 — key 过滤 + 字符串内容正则脱敏。"""
    if data is None or isinstance(data, (bool, int, float)):
        return data

    if isinstance(data, str):
        return redact_text_content(data)

    if isinstance(data, list):
        return [sanitize_result(item) for item in data]

    if isinstance(data, dict):
        result: dict[str, Any] = {}
        for key, value in data.items():
            if key.lower() in _SENSITIVE_KEYS:
                result[key] = "[REDACTED]"
            elif isinstance(value, str):
                result[key] = redact_text_content(value)
            else:
                result[key] = sanitize_result(value)
        return result

    return data


# ============ 预算守卫 ============


@dataclass
class _BudgetState:
    tool_calls_this_round: int = 0
    total_tool_calls: int = 0
    max_per_round: int = 8
    max_total: int = 20


@dataclass
class _RuntimeScope:
    context: ToolCallContext
    budget: _BudgetState = field(default_factory=_BudgetState)
    seen_memory_saves: set[str] = field(default_factory=set)


_runtime_scope: ContextVar[_RuntimeScope | None] = ContextVar(
    "tool_runtime_scope", default=None
)
_fallback_budget = _BudgetState()


# 获取当前请求隔离的工具预算，直接调用时回退到测试预算
def _get_budget() -> _BudgetState:
    scope = _runtime_scope.get()
    return scope.budget if scope else _fallback_budget


# 创建一次 Agent 请求使用的可信工具调用上下文
def create_tool_call_context(user_id: str, conversation_id: str) -> ToolCallContext:
    request_id = f"req_{uuid4().hex}"
    return ToolCallContext(
        request_id=request_id,
        trace_id=f"trace_{uuid4().hex}",
        conversation_id=conversation_id,
        tenant_id="",
        user_id=user_id,
        actor_type="user",
    )


# 获取当前请求的工具调用上下文，未进入运行时作用域时返回空
def get_tool_call_context() -> ToolCallContext | None:
    scope = _runtime_scope.get()
    return scope.context if scope else None


# 在当前异步请求内隔离工具身份、预算与记忆去重状态
@contextmanager
def tool_call_scope(context: ToolCallContext):
    token = _runtime_scope.set(_RuntimeScope(context=context))
    try:
        yield
    finally:
        _runtime_scope.reset(token)


# 重置当前轮次的工具调用预算计数器
def reset_round_budget() -> None:
    budget = _get_budget()
    budget.tool_calls_this_round = 0


# 检查工具调用预算，返回 None 表示通过，否则返回错误结果
def budget_guard() -> ToolRuntimeResult[None] | None:
    """检查预算限制，返回 None 表示通过，否则返回错误结果。"""
    budget = _get_budget()
    if budget.tool_calls_this_round >= budget.max_per_round:
        return ToolRuntimeResult(
            success=False,
            error=ToolError(
                code="RATE_LIMITED",
                message=f"单轮工具调用已达上限 ({budget.max_per_round})",
            ),
        )
    if budget.total_tool_calls >= budget.max_total:
        return ToolRuntimeResult(
            success=False,
            error=ToolError(
                code="RATE_LIMITED",
                message=f"累计工具调用已达上限 ({budget.max_total})",
            ),
        )
    budget.tool_calls_this_round += 1
    budget.total_tool_calls += 1
    return None


# ============ 审计记录 ============


# 记录审计日志条目，同时同步写入可观测性指标
def record_audit(entry: dict[str, Any]) -> None:
    _audit_log.append(entry)
    # 保留最近 1000 条
    if len(_audit_log) > 1000:
        del _audit_log[: len(_audit_log) - 1000]

    # 达到 500 条时异步刷入 Gateway
    if len(_audit_log) >= 500:
        _flush_audit_logs()


# 异步批量刷入 Gateway（不阻塞工具执行）
def _flush_audit_logs() -> None:
    """将审计日志批量写入 Gateway D1"""
    if not settings.memory_enabled:
        return
    if not _audit_log:
        return
    entries = _audit_log.copy()
    _audit_log.clear()
    try:
        import asyncio

        from src.clients.memory_gateway import CloudflareMemoryClient

        client = CloudflareMemoryClient()

        # 执行 do flush 对应的业务逻辑
        async def _do_flush():
            await client.write_audit_logs(entries)

        # 在已有事件循环中提交后台任务
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.ensure_future(_do_flush())
            else:
                loop.run_until_complete(_do_flush())
        except RuntimeError:
            # 无事件循环，创建新线程运行
            import threading

            # 执行 run 对应的业务逻辑
            def _run():
                asyncio.run(_do_flush())

            threading.Thread(target=_run, daemon=True).start()
    except Exception:
        pass  # 刷入失败静默降级


# ============ 核心执行器 ============


class ToolExecutor(Generic[TInput, TOutput]):
    """
    统一执行管线包装器。

    执行管线：
      validate → permission_check → budget_guard → execute → sanitize → audit
    """

    # 初始化工具执行器
    def __init__(
        self,
        descriptor: ToolDescriptor,
        execute_fn: Callable[[TInput, ToolCallContext], Coroutine[Any, Any, TOutput]],
        schema: Callable[[Any], TInput] | None = None,
    ):
        self.descriptor = descriptor
        self._execute_fn = execute_fn
        self.schema = schema


# 统一执行入口：所有工具必须通过此函数调用，不得绕过
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
        _record_audit(
            tool_name,
            tool_version,
            context,
            executor.descriptor.risk_level,
            False,
            budget_result.error.code,
            duration_ms,
            context.request_id,
            context.trace_id,
        )
        return _error_envelope(call_id, tool_name, tool_version, budget_result.error, duration_ms)

    # 2. 参数校验
    validated_input = raw_input
    if executor.schema:
        validation = validate_input(executor.schema, raw_input)
        if not validation.success:
            duration_ms = int((time.perf_counter() - start_time) * 1000)
            _record_audit(
                tool_name,
                tool_version,
                context,
                executor.descriptor.risk_level,
                False,
                validation.error.code,
                duration_ms,
                context.request_id,
                context.trace_id,
            )
            return _error_envelope(call_id, tool_name, tool_version, validation.error, duration_ms)
        validated_input = validation.data

    # 3. 权限检查
    granted, reason = permission_check(context, executor.descriptor)
    if not granted:
        error_code = (
            "UNAUTHENTICATED" if reason and "UNAUTHENTICATED" in reason else "PERMISSION_DENIED"
        )
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        _record_audit(
            tool_name,
            tool_version,
            context,
            executor.descriptor.risk_level,
            False,
            error_code,
            duration_ms,
            context.request_id,
            context.trace_id,
        )
        return _error_envelope(
            call_id,
            tool_name,
            tool_version,
            ToolError(code=error_code, message=reason or "Permission denied"),
            duration_ms,
        )

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
        _record_audit(
            tool_name,
            tool_version,
            context,
            executor.descriptor.risk_level,
            False,
            error_code,
            duration_ms,
            context.request_id,
            context.trace_id,
        )
        return _error_envelope(
            call_id,
            tool_name,
            tool_version,
            ToolError(code=error_code, message=f"工具执行超时 ({timeout_ms}ms)"),
            duration_ms,
        )
    except Exception as exc:
        error_code: ToolErrorCode = "INTERNAL_ERROR"
        message = str(exc)
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        _record_audit(
            tool_name,
            tool_version,
            context,
            executor.descriptor.risk_level,
            False,
            error_code,
            duration_ms,
            context.request_id,
            context.trace_id,
        )
        return _error_envelope(
            call_id,
            tool_name,
            tool_version,
            ToolError(code=error_code, message=message),
            duration_ms,
        )

    # 5. 结果脱敏
    sanitized = sanitize_result(raw_output)
    duration_ms = int((time.perf_counter() - start_time) * 1000)

    # 6. 审计记录
    _record_audit(
        tool_name,
        tool_version,
        context,
        executor.descriptor.risk_level,
        True,
        None,
        duration_ms,
        context.request_id,
        context.trace_id,
    )

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


# 构造工具执行错误响应信封
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


# 记录审计日志并同步写入可观测性指标
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
    record_audit(
        {
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
        }
    )
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


# 将 LangChain 工具包装为统一权限、预算、超时、脱敏和审计管线
def wrap_tool_with_runtime(tool: BaseTool, descriptor: ToolDescriptor) -> StructuredTool:
    async def wrapped_tool(**raw_input: Any) -> str:
        scope = _runtime_scope.get()
        if scope is None:
            raise RuntimeError("Tool runtime context is required")

        scoped_input = dict(raw_input)
        if descriptor.name.startswith("memory.user."):
            scoped_input["user_id"] = scope.context.user_id
        if descriptor.name == "memory.session.search":
            scoped_input["conversation_id"] = scope.context.conversation_id

        if descriptor.name == "memory.user.save":
            content_key = str(scoped_input.get("content", ""))
            if content_key in scope.seen_memory_saves:
                return "🧠 记忆已存在（内容重复），未重复保存。"
            scope.seen_memory_saves.add(content_key)

        # 执行原始工具并保持其 Pydantic 参数模型约束
        async def execute_tool(input_data: Any, _context: ToolCallContext) -> Any:
            payload = input_data.model_dump() if isinstance(input_data, BaseModel) else input_data
            return await tool.ainvoke(payload)

        executor = ToolExecutor(
            descriptor=descriptor,
            execute_fn=execute_tool,
            schema=tool.args_schema,
        )
        result = await invoke_tool(executor, scoped_input, scope.context)
        if not result.ok:
            raise RuntimeError(result.error.message if result.error else "Tool execution failed")
        return str(result.data or "")

    return StructuredTool(
        name=tool.name,
        description=tool.description,
        args_schema=tool.args_schema,
        return_direct=tool.return_direct,
        tags=tool.tags,
        metadata=tool.metadata,
        coroutine=wrapped_tool,
    )
