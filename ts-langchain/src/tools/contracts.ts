/**
 * contracts/tools — 语言无关契约的 TS 类型定义
 *
 * 所有工具实现必须引用此文件中的类型，
 * 确保与 JSON Schema 契约保持同步。
 *
 * Phase 4 迁移：input_schema 已从 Record<string, unknown> (JSON Schema 对象)
 * 改为 z.ZodTypeAny，消除双重定义。每个工具文件只需定义一个 Zod schema，
 * 同时用于 ToolDescriptor.input_schema 和 DynamicStructuredTool.schema。
 */

import { z } from "zod";

// ============ 风险等级 ============

export type RiskLevel = "R0" | "R1" | "R2" | "R3";

// ============ 能力类别 ============

export type ToolCategory =
  "READ" | "SEARCH" | "ACTION" | "COMPUTE" | "MEMORY" | "CONTROL" | "GUARD";

// ============ 副作用类型 ============

export type SideEffect = "none" | "read" | "write" | "external";

// ============ 审批策略 ============

export type ApprovalPolicy = "never" | "conditional" | "always";

// ============ 调用者类型 ============

export type ActorType = "user" | "agent" | "service";

// ============ 数据分类 ============

export type DataClassification = "public" | "internal" | "confidential" | "pii";

// ============ 错误码 ============

export type ToolErrorCode =
  | "INVALID_ARGUMENT"
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "DEPENDENCY_ERROR"
  | "RESULT_TOO_LARGE"
  | "INTERNAL_ERROR";

// ============ 工具描述符 ============

export interface ToolDescriptor {
  name: string;
  version: string;
  title: string;
  description: string;
  category: ToolCategory;
  risk_level: RiskLevel;
  side_effect: SideEffect;
  idempotent?: boolean;
  timeout_ms: number;
  required_permissions?: string[];
  approval_policy?: ApprovalPolicy;
  /** Zod schema 实例（同时用于运行时参数校验） */
  input_schema: z.ZodTypeAny;
  output_schema?: z.ZodTypeAny;
  data_classification?: DataClassification[];
  owner?: string;
  tags?: string[];
}

// ============ 调用上下文（服务端注入） ============

export interface ToolCallContext {
  request_id: string;
  trace_id: string;
  conversation_id: string;
  tenant_id: string;
  user_id: string;
  actor_type: ActorType;
  /** 仅由受信网关注入的角色，模型和请求体不能覆盖。 */
  roles?: string[];
  agent_id?: string;
  locale?: string;
  deadline?: string;
}

export interface ToolProgressEvent {
  type: "started" | "completed" | "failed";
  toolName: string;
  callId: string;
  durationMs?: number;
}

// ============ 工具错误详情 ============

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

// ============ 工具返回信封 ============

export interface ToolResultMeta {
  tool_call_id: string;
  tool_name?: string;
  tool_version?: string;
  duration_ms: number;
  source_refs?: string[];
  warnings?: string[];
  retryable?: boolean;
}

export interface ToolResultEnvelope<T = unknown> {
  ok: boolean;
  data: T | null;
  error: ToolError | null;
  meta: ToolResultMeta;
}

// ============ 工具定义接口 ============

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  descriptor: ToolDescriptor;
  execute(input: TInput, context: ToolCallContext): Promise<TOutput>;
}

// ============ 运行时调用结果 ============

export interface ToolRuntimeResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: ToolError;
  meta: ToolResultMeta;
}
