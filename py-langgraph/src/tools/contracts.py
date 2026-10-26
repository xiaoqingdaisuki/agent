"""
contracts/tools — 语言无关契约的 Python 类型定义

所有工具实现必须引用此文件中的类型，
确保与 JSON Schema 契约保持同步
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

# ============ 风险等级 ============

RiskLevel = str  # 风险等级：R0、R1、R2 或 R3

# ============ 能力类别 ============

ToolCategory = str  # 能力类别：READ、SEARCH、ACTION、COMPUTE、MEMORY、CONTROL 或 GUARD

# ============ 副作用类型 ============

SideEffect = str  # 副作用类别：none、read、write 或 external

# ============ 审批策略 ============

ApprovalPolicy = str  # 审批策略：never、conditional 或 always

# ============ 调用者类型 ============

ActorType = str  # 调用者类型：user、agent 或 service

# ============ 数据分类 ============

DataClassification = str  # 数据分类：public、internal、confidential 或 pii

# ============ 错误码 ============

ToolErrorCode = str
# 参数与权限错误码：INVALID_ARGUMENT、UNAUTHENTICATED、PERMISSION_DENIED、POLICY_DENIED
# 审批与执行错误码：APPROVAL_REQUIRED、NOT_FOUND、CONFLICT、RATE_LIMITED、TIMEOUT
# 依赖与结果错误码：DEPENDENCY_ERROR、RESULT_TOO_LARGE、INTERNAL_ERROR

# ============ 工具描述符 ============


@dataclass
class ToolDescriptor:
    """工具元数据 — 与 TS ToolDescriptor 等价"""

    name: str
    version: str
    title: str
    description: str
    category: ToolCategory
    risk_level: RiskLevel
    side_effect: SideEffect
    timeout_ms: int = 10_000
    idempotent: bool = True
    required_permissions: list[str] = field(default_factory=list)
    approval_policy: ApprovalPolicy = "never"
    input_schema: dict[str, Any] = field(default_factory=dict)
    output_schema: dict[str, Any] | None = None
    # 为每个工具描述符创建独立的默认内部数据分类列表
    data_classification: list[DataClassification] = field(default_factory=lambda: ["internal"])
    owner: str = ""
    tags: list[str] = field(default_factory=list)


# ============ 调用上下文（服务端注入） ============


@dataclass
class ToolCallContext:
    """每次工具调用的上下文 — 由服务端注入，禁止 LLM 自行填写"""

    request_id: str
    trace_id: str
    conversation_id: str
    tenant_id: str
    user_id: str
    actor_type: ActorType
    # 为每个调用上下文创建独立的默认成员角色列表
    roles: list[str] = field(default_factory=lambda: ["member"])
    agent_id: str = ""
    locale: str = "zh-CN"
    deadline: str | None = None


# ============ 工具错误详情 ============


@dataclass
class ToolError:
    code: ToolErrorCode
    message: str
    details: dict[str, Any] | None = None


# ============ 工具返回信封 ============

T = TypeVar("T")


@dataclass
class ToolResultMeta:
    tool_call_id: str
    duration_ms: int = 0
    tool_name: str = ""
    tool_version: str = ""
    source_refs: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    retryable: bool = False


@dataclass
class ToolResultEnvelope(Generic[T]):
    ok: bool
    data: T | None
    error: ToolError | None
    meta: ToolResultMeta


# ============ 工具定义接口 ============

TInput = TypeVar("TInput")
TOutput = TypeVar("TOutput")


class ToolDefinition(Generic[TInput, TOutput]):
    """工具实现接口"""

    descriptor: ToolDescriptor

    # 执行 execute 对应的业务逻辑
    def execute(self, input: TInput, context: ToolCallContext) -> TOutput:
        raise NotImplementedError


# ============ 运行时调用结果 ============


@dataclass
class ToolRuntimeResult(Generic[T]):
    success: bool
    data: T | None = None
    error: ToolError | None = None
    meta: ToolResultMeta | None = None


__all__ = [
    "ActorType",
    "ApprovalPolicy",
    "DataClassification",
    "RiskLevel",
    "SideEffect",
    "ToolCallContext",
    "ToolCategory",
    "ToolDefinition",
    "ToolDescriptor",
    "ToolError",
    "ToolErrorCode",
    "ToolResultEnvelope",
    "ToolResultMeta",
    "ToolRuntimeResult",
]
