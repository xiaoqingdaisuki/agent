"""
Tests for Tool Runtime — 验证统一执行管线
"""

import asyncio
import pytest
from langchain_core.tools import tool
from src.tools.contracts import (
    ToolCallContext,
    ToolDescriptor,
    ToolError,
    ToolErrorCode,
    ToolResultEnvelope,
)
from src.tools.runtime.executor import (
    ToolExecutor,
    invoke_tool,
    permission_check,
    validate_input,
    sanitize_result,
    budget_guard,
    reset_round_budget,
    record_audit,
    get_audit_log,
    clear_audit_log,
    create_tool_call_context,
    tool_call_scope,
    wrap_tool_with_runtime,
)
from src.tools.calculator import DESCRIPTOR as CALC_DESCRIPTOR, safe_calculate


@pytest.fixture(autouse=True)
def reset_state():
    """每个测试前重置预算和审计"""
    reset_round_budget()
    clear_audit_log()
    yield


def _make_context(user_id: str = "user_1", tenant_id: str = "tenant_1", roles: list[str] | None = None) -> ToolCallContext:
    return ToolCallContext(
        request_id="req_test",
        trace_id="trace_test",
        conversation_id="conv_test",
        tenant_id=tenant_id,
        user_id=user_id,
        actor_type="user",
        roles=roles or ["member"],
    )


class TestPermissionCheck:
    def test_r0_tool_always_allowed(self):
        desc = ToolDescriptor(
            name="test.tool", version="1.0.0", title="Test",
            description="test", category="COMPUTE", risk_level="R0",
            side_effect="none", timeout_ms=5000,
        )
        granted, _ = permission_check(_make_context(), desc)
        assert granted is True

    def test_r1_with_permissions_allowed(self):
        desc = ToolDescriptor(
            name="test.tool", version="1.0.0", title="Test",
            description="test", category="SEARCH", risk_level="R1",
            side_effect="read", timeout_ms=5000,
            required_permissions=["web.search"],
        )
        granted, _ = permission_check(_make_context(user_id="user_1"), desc)
        assert granted is True

    def test_r1_without_user_denied(self):
        desc = ToolDescriptor(
            name="test.tool", version="1.0.0", title="Test",
            description="test", category="SEARCH", risk_level="R1",
            side_effect="read", timeout_ms=5000,
            required_permissions=["web.search"],
        )
        granted, reason = permission_check(_make_context(user_id=""), desc)
        assert granted is False
        assert "UNAUTHENTICATED" in (reason or "")


class TestValidateInput:
    def test_valid_input(self):
        from pydantic import BaseModel

        class Input(BaseModel):
            x: int

        result = validate_input(Input, {"x": 42})
        assert result.success is True
        assert result.data.x == 42

    def test_invalid_input(self):
        from pydantic import BaseModel

        class Input(BaseModel):
            x: int

        result = validate_input(Input, {"x": "not_a_number"})
        assert result.success is False
        assert result.error.code == "INVALID_ARGUMENT"


class TestSanitizeResult:
    def test_plain_data_unchanged(self):
        assert sanitize_result({"key": "value"}) == {"key": "value"}

    def test_nested_dict_unchanged(self):
        assert sanitize_result({"a": {"b": 1}}) == {"a": {"b": 1}}

    def test_sensitive_key_redacted(self):
        result = sanitize_result({"api_key": "secret123"})
        assert result["api_key"] == "[REDACTED]"

    def test_multiple_sensitive_keys(self):
        result = sanitize_result({
            "api_key": "secret",
            "password": "pwd",
            "name": "Alice",
        })
        assert result["api_key"] == "[REDACTED]"
        assert result["password"] == "[REDACTED]"
        assert result["name"] == "Alice"

    def test_list_sanitized(self):
        result = sanitize_result([{"token": "abc"}, {"ok": True}])
        assert result[0]["token"] == "[REDACTED]"
        assert result[1]["ok"] is True


class TestBudgetGuard:
    def test_first_call_passes(self):
        result = budget_guard()
        assert result is None

    def test_exhausted_round_blocks(self):
        for _ in range(8):
            budget_guard()
        result = budget_guard()
        assert result is not None
        assert result.error.code == "RATE_LIMITED"


class TestAuditLog:
    def test_record_and_retrieve(self):
        record_audit({
            "tool_name": "test.tool",
            "tool_version": "1.0.0",
            "user_id": "u1",
            "tenant_id": "t1",
            "conversation_id": "c1",
            "risk_level": "R0",
            "ok": True,
            "duration_ms": 100,
            "request_id": "r1",
            "trace_id": "tr1",
        })
        log = get_audit_log()
        assert len(log) == 1
        assert log[0]["tool_name"] == "test.tool"
        assert log[0]["ok"] is True

    def test_clear_log(self):
        record_audit({
            "tool_name": "test.tool", "tool_version": "1.0.0",
            "user_id": "u1", "tenant_id": "t1", "conversation_id": "c1",
            "risk_level": "R0", "ok": True, "duration_ms": 1,
            "request_id": "r1", "trace_id": "tr1",
        })
        clear_audit_log()
        assert len(get_audit_log()) == 0


class TestInvokeTool:
    @pytest.mark.asyncio
    async def test_successful_execution(self):
        async def execute_fn(input_data, ctx):
            return input_data * 2

        executor = ToolExecutor(
            descriptor=CALC_DESCRIPTOR,
            execute_fn=execute_fn,
        )
        result = await invoke_tool(executor, 21, _make_context())
        assert result.ok is True
        assert result.data == 42
        assert result.error is None
        assert result.meta.duration_ms >= 0

    @pytest.mark.asyncio
    async def test_timeout_handled(self):
        async def slow_fn(input_data, ctx):
            await asyncio.sleep(5)
            return input_data

        desc = ToolDescriptor(
            name="slow.tool", version="1.0.0", title="Slow",
            description="test", category="COMPUTE", risk_level="R0",
            side_effect="none", timeout_ms=100,
        )
        executor = ToolExecutor(descriptor=desc, execute_fn=slow_fn)
        result = await invoke_tool(executor, 1, _make_context())
        assert result.ok is False
        assert result.error.code == "TIMEOUT"

    @pytest.mark.asyncio
    async def test_execution_error_handled(self):
        async def failing_fn(input_data, ctx):
            raise RuntimeError("boom")

        desc = ToolDescriptor(
            name="failing.tool", version="1.0.0", title="Failing",
            description="test", category="COMPUTE", risk_level="R0",
            side_effect="none", timeout_ms=5000,
        )
        executor = ToolExecutor(descriptor=desc, execute_fn=failing_fn)
        result = await invoke_tool(executor, 1, _make_context())
        assert result.ok is False
        assert result.error.code == "INTERNAL_ERROR"
        assert "boom" in result.error.message

    @pytest.mark.asyncio
    async def test_result_sanitized(self):
        async def return_secrets(input_data, ctx):
            return {"api_key": "secret123", "result": "ok"}

        desc = ToolDescriptor(
            name="secret.tool", version="1.0.0", title="Secret",
            description="test", category="READ", risk_level="R1",
            side_effect="read", timeout_ms=5000, required_permissions=["test.read"],
        )
        executor = ToolExecutor(descriptor=desc, execute_fn=return_secrets)
        result = await invoke_tool(executor, {}, _make_context(user_id="u1", tenant_id="t1", roles=["admin"]))
        assert result.ok is True
        assert result.data["api_key"] == "[REDACTED]"
        assert result.data["result"] == "ok"

    @pytest.mark.asyncio
    async def test_audit_recorded_on_success(self):
        async def ok_fn(input_data, ctx):
            return "done"

        desc = ToolDescriptor(
            name="audit.tool", version="1.0.0", title="Audit",
            description="test", category="COMPUTE", risk_level="R0",
            side_effect="none", timeout_ms=5000,
        )
        executor = ToolExecutor(descriptor=desc, execute_fn=ok_fn)
        await invoke_tool(executor, 1, _make_context())
        log = get_audit_log()
        assert len(log) == 1
        assert log[0]["tool_name"] == "audit.tool"
        assert log[0]["ok"] is True


class TestRuntimeToolWrapper:
    @pytest.mark.asyncio
    async def test_global_registry_tools_use_runtime_pipeline(self):
        from src.tools.registry import get_registry

        wrapped = get_registry().get_tool("math.calculate")
        context = create_tool_call_context("trusted-user", "trusted-conversation")

        with tool_call_scope(context):
            result = await wrapped.ainvoke({"expression": "2 + 2"})

        assert "4" in result
        assert get_audit_log()[-1]["tool_name"] == "math.calculate"

    @pytest.mark.asyncio
    async def test_runtime_wrapper_emits_one_tool_lifecycle(self):
        from src.tools.registry import get_registry

        wrapped = get_registry().get_tool("math.calculate")
        context = create_tool_call_context("trusted-user", "trusted-conversation")
        lifecycle = []

        with tool_call_scope(context):
            async for event in wrapped.astream_events(
                {"expression": "2 + 2"}, version="v2"
            ):
                if event.get("event") in {"on_tool_start", "on_tool_end"}:
                    lifecycle.append(event)

        assert [event["event"] for event in lifecycle] == [
            "on_tool_start",
            "on_tool_end",
        ]
        assert len({event["run_id"] for event in lifecycle}) == 1
        assert len(get_audit_log()) == 1

    @pytest.mark.asyncio
    async def test_scopes_model_supplied_user_id_to_trusted_context(self):
        @tool
        async def echo_user(user_id: str) -> str:
            """Return the effective user id."""
            return user_id

        descriptor = ToolDescriptor(
            name="memory.user.search",
            version="1.0.0",
            title="Echo user",
            description="test",
            category="MEMORY",
            risk_level="R1",
            side_effect="read",
            timeout_ms=5000,
            required_permissions=["memory.user.read"],
        )
        wrapped = wrap_tool_with_runtime(echo_user, descriptor)
        context = create_tool_call_context("trusted-user", "trusted-conversation")

        with tool_call_scope(context):
            result = await wrapped.ainvoke({"user_id": "spoofed-user"})

        assert result == "trusted-user"
        assert get_audit_log()[-1]["user_id"] == "trusted-user"

    @pytest.mark.asyncio
    async def test_requires_a_request_scope(self):
        @tool
        async def echo(value: str) -> str:
            """Return the supplied value."""
            return value

        descriptor = ToolDescriptor(
            name="test.echo",
            version="1.0.0",
            title="Echo",
            description="test",
            category="COMPUTE",
            risk_level="R0",
            side_effect="none",
            timeout_ms=5000,
        )
        wrapped = wrap_tool_with_runtime(echo, descriptor)

        with pytest.raises(RuntimeError, match="runtime context"):
            await wrapped.ainvoke({"value": "test"})
