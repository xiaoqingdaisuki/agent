/**
 * Tool Runtime — 统一执行管线
 *
 * 所有工具必须通过此 Runtime 执行，禁止绕过。
 *
 * 执行管线：
 *   1. 参数校验（JSON Schema 严格模式）
 *   2. 权限检查（permission_check）
 *   3. 预算守卫（budget_guard）
 *   4. 执行工具（带超时）
 *   5. 结果脱敏（result_sanitize）
 *   6. 审计记录（audit_record）
 *   7. 指标记录（metrics）
 */

import type {
  ToolDescriptor,
  ToolCallContext,
  ToolProgressEvent,
  ToolRuntimeResult,
  ToolResultEnvelope,
} from "../contracts.js";
import { recordToolMetric } from "../observability.js";
import { AsyncLocalStorage } from "node:async_hooks";

// ============ 审计记录 ============

interface AuditEntry {
  timestamp: string;
  tool_name: string;
  tool_version: string;
  user_id: string;
  tenant_id: string;
  conversation_id: string;
  risk_level: string;
  ok: boolean;
  error_code?: string;
  duration_ms: number;
  request_id: string;
  trace_id: string;
}

const auditLog: AuditEntry[] = [];
let gatewayClient: any = null;

// 获取 getGatewayClient 对应的数据
function getGatewayClient() {
  if (!gatewayClient) {
    const { CloudflareMemoryClient } = require("../../clients/memory_gateway.js");
    gatewayClient = new CloudflareMemoryClient({
      baseUrl: process.env.CLOUDFLARE_MEMORY_BASE_URL || "http://localhost:8787",
      secret: process.env.CLOUDFLARE_MEMORY_SECRET || "",
    });
  }
  return gatewayClient;
}

// 批量写入审计日志到 Gateway（异步，不阻塞）
async function flushAuditLogs(): Promise<void> {
  if (auditLog.length === 0) return;
  const entries = auditLog.splice(0, auditLog.length);
  try {
    const client = getGatewayClient();
    await client.writeAuditLogs(
      entries.map((e) => ({
        user_id: e.user_id,
        tenant_id: e.tenant_id,
        conversation_id: e.conversation_id,
        tool_name: e.tool_name,
        tool_version: e.tool_version,
        risk_level: e.risk_level,
        ok: e.ok,
        error_code: e.error_code,
        duration_ms: e.duration_ms,
        request_id: e.request_id,
        trace_id: e.trace_id,
      })),
    );
  } catch (err) {
    console.warn("[executor] Failed to flush audit logs to Gateway:", err);
  }
}

// 获取 getAuditLog 对应的数据
export function getAuditLog(): ReadonlyArray<AuditEntry> {
  return auditLog;
}

// 删除或清理 clearAuditLog 对应的数据
export function clearAuditLog(): void {
  auditLog.length = 0;
}

// ============ 权限检查 ============

const permissionCache = new Map<
  string,
  { granted: boolean; expires: number }
>();
const PERMISSION_CACHE_TTL_MS = 5_000;

/**
 * 检查用户是否拥有指定权限
 *
 * 当前为最小可用实现：所有 R0/R1 只读工具默认允许，
 * R2+ 工具需要显式声明 permissions 并通过策略。
 *
 * TODO: Phase 0.4 替换为真正的 RBAC 引擎
 */
// 执行 permissionCheck 对应的业务逻辑
export function permissionCheck(
  context: ToolCallContext,
  descriptor: ToolDescriptor,
): { granted: boolean; reason?: string } {
  // R0 工具默认允许
  if (descriptor.risk_level === "R0") {
    return { granted: true };
  }

  const perms = descriptor.required_permissions ?? [];

  // 无权限要求 → 允许
  if (perms.length === 0) {
    return { granted: true };
  }

  // 检查缓存
  const cacheKey = `${context.user_id}:${context.tenant_id}:${perms.join(",")}`;
  const cached = permissionCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return { granted: cached.granted };
  }

  // 最小 RBAC：只要有 user_id 就允许（Phase 0.4 会替换为真正的策略）
  const granted = !!context.user_id;
  const reason = granted ? undefined : "UNAUTHENTICATED: user_id required";

  permissionCache.set(cacheKey, {
    granted,
    expires: Date.now() + PERMISSION_CACHE_TTL_MS,
  });

  return { granted, reason };
}

// ============ 参数校验 ============

/**
 * 使用 Zod schema 校验输入参数
 *
 * 严格模式：拒绝额外字段。
 */
// 校验并判断 validateInput 对应的状态
export function validateInput<T>(
  schema: { parse: (input: unknown) => T },
  rawInput: unknown,
): ToolRuntimeResult<T> {
  try {
    const parsed = schema.parse(rawInput);
    return { success: true, data: parsed, meta: createMeta("validation") };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid input";
    return {
      success: false,
      error: { code: "INVALID_ARGUMENT", message },
      meta: createMeta("validation"),
    };
  }
}

// ============ 结果脱敏 ============

/**
 * 对工具返回结果进行基本脱敏
 *
 * 移除可能的密钥、Token、密码等敏感字段。
 * 当前为最小实现：递归过滤常见敏感键。
 */
const SENSITIVE_KEYS = new Set([
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
]);

// 执行 sanitizeResult 对应的业务逻辑
export function sanitizeResult<T>(data: T): T {
  if (data === null || data === undefined) return data;

  if (Array.isArray(data)) {
    return data.map(sanitizeResult) as T;
  }

  if (typeof data === "string") {
    return redactTextContent(data) as T;
  }

  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = "[REDACTED]";
      } else if (typeof value === "string") {
        result[key] = redactTextContent(value);
      } else {
        result[key] = sanitizeResult(value);
      }
    }
    return result as T;
  }

  return data;
}

// ============ 预算守卫 ============

interface BudgetState {
  toolCallsThisRound: number;
  totalToolCalls: number;
  maxPerRound: number;
  maxTotal: number;
}

interface ToolRuntimeContext {
  context: ToolCallContext;
  budget: BudgetState;
  onToolProgress?: (event: ToolProgressEvent) => void;
  seenMemorySaves?: Set<string>;
}

const runtimeStorage = new AsyncLocalStorage<ToolRuntimeContext>();

// 执行 reportToolProgress 对应的业务逻辑
function reportToolProgress(event: ToolProgressEvent): void {
  runtimeStorage.getStore()?.onToolProgress?.(event);
}

// 创建或注册 createBudgetState 所需的数据
function createBudgetState(): BudgetState {
  return {
    toolCallsThisRound: 0,
    totalToolCalls: 0,
    maxPerRound: 8,
    maxTotal: 20,
  };
}

// 仅供没有请求上下文的直接调用使用；Agent 请求使用 AsyncLocalStorage 隔离预算。
const fallbackBudgetState = createBudgetState();

// 获取 getBudgetState 对应的数据
function getBudgetState(): BudgetState {
  return runtimeStorage.getStore()?.budget ?? fallbackBudgetState;
}

// 执行 resetRoundBudget 对应的业务逻辑
export function resetRoundBudget(): void {
  getBudgetState().toolCallsThisRound = 0;
}

// 执行 budgetGuard 对应的业务逻辑
export function budgetGuard(): ToolRuntimeResult<null> | null {
  const budgetState = getBudgetState();
  if (budgetState.toolCallsThisRound >= budgetState.maxPerRound) {
    return {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: `单轮工具调用已达上限 (${budgetState.maxPerRound})`,
      },
      meta: createMeta("budget_guard"),
    };
  }

  if (budgetState.totalToolCalls >= budgetState.maxTotal) {
    return {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: `累计工具调用已达上限 (${budgetState.maxTotal})`,
      },
      meta: createMeta("budget_guard"),
    };
  }

  budgetState.toolCallsThisRound++;
  budgetState.totalToolCalls++;
  return null;
}

// ============ 审计记录 ============

// 记录一条审计日志，同时同步写入可观测性指标
export function recordAudit(entry: Omit<AuditEntry, "timestamp">): void {
  auditLog.push({
    ...entry,
    timestamp: new Date().toISOString(),
  });

  // 保留最近 1000 条，超出阈值时异步刷入 Gateway
  if (auditLog.length > 1000) {
    auditLog.splice(0, auditLog.length - 1000);
  }
  if (auditLog.length >= 500) {
    // 达到 500 条时异步刷入 Gateway，避免内存堆积
    void flushAuditLogs();
  }

  // 同步记录可观测性指标
  recordToolMetric({
    tool_name: entry.tool_name,
    tool_version: entry.tool_version,
    ok: entry.ok,
    error_code: entry.error_code,
    duration_ms: entry.duration_ms,
    risk_level: entry.risk_level,
    user_id: entry.user_id,
    tenant_id: entry.tenant_id,
  });
}

// ============ 辅助函数 ============

// 生成工具调用元数据，包含唯一 ID 和默认值
function createMeta(source: string) {
  return {
    tool_call_id: `call_${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    duration_ms: 0,
    source_refs: [],
    warnings: [],
    retryable: false,
  };
}

// ============ 核心执行器 ============

export interface ToolExecutor<TInput, TOutput> {
  descriptor: ToolDescriptor;
  schema?: { parse: (input: unknown) => TInput };
  execute: (input: TInput, context: ToolCallContext) => Promise<TOutput>;
}

/**
 * 统一执行管线：
 *   validate → permission_check → budget_guard → execute → sanitize → audit
 */
// 执行 invokeTool 对应的业务逻辑
export async function invokeTool<TInput, TOutput>(
  executor: ToolExecutor<TInput, TOutput>,
  rawInput: unknown,
  context: ToolCallContext,
): Promise<ToolResultEnvelope<TOutput>> {
  const toolName = executor.descriptor.name;
  const toolVersion = executor.descriptor.version;
  const startTime = Date.now();
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 1. 预算守卫
  const budgetResult = budgetGuard();
  if (budgetResult && !budgetResult.success) {
    recordAudit({
      tool_name: toolName,
      tool_version: toolVersion,
      user_id: context.user_id,
      tenant_id: context.tenant_id,
      conversation_id: context.conversation_id,
      risk_level: executor.descriptor.risk_level,
      ok: false,
      error_code: budgetResult.error!.code,
      duration_ms: Date.now() - startTime,
      request_id: context.request_id,
      trace_id: context.trace_id,
    });
    return {
      ok: false,
      data: null,
      error: budgetResult.error ?? null,
      meta: {
        tool_call_id: callId,
        tool_name: toolName,
        tool_version: toolVersion,
        duration_ms: Date.now() - startTime,
      },
    };
  }

  // 2. 参数校验
  if (executor.schema) {
    const validation = validateInput(executor.schema, rawInput);
    if (!validation.success) {
      recordAudit({
        tool_name: toolName,
        tool_version: toolVersion,
        user_id: context.user_id,
        tenant_id: context.tenant_id,
        conversation_id: context.conversation_id,
        risk_level: executor.descriptor.risk_level,
        ok: false,
        error_code: validation.error!.code,
        duration_ms: Date.now() - startTime,
        request_id: context.request_id,
        trace_id: context.trace_id,
      });
      return {
        ok: false,
        data: null,
        error: validation.error ?? null,
        meta: {
          tool_call_id: callId,
          tool_name: toolName,
          tool_version: toolVersion,
          duration_ms: Date.now() - startTime,
        },
      };
    }
  }

  // 3. 权限检查
  const permResult = permissionCheck(context, executor.descriptor);
  if (!permResult.granted) {
    const errorCode = permResult.reason?.includes("UNAUTHENTICATED")
      ? "UNAUTHENTICATED"
      : "PERMISSION_DENIED";

    recordAudit({
      tool_name: toolName,
      tool_version: toolVersion,
      user_id: context.user_id,
      tenant_id: context.tenant_id,
      conversation_id: context.conversation_id,
      risk_level: executor.descriptor.risk_level,
      ok: false,
      error_code: errorCode,
      duration_ms: Date.now() - startTime,
      request_id: context.request_id,
      trace_id: context.trace_id,
    });

    return {
      ok: false,
      data: null,
      error: {
        code: errorCode,
        message: permResult.reason ?? "Permission denied",
      },
      meta: {
        tool_call_id: callId,
        tool_name: toolName,
        tool_version: toolVersion,
        duration_ms: Date.now() - startTime,
      },
    };
  }

  // 4. 执行（带超时）
  let rawOutput: TOutput;
  reportToolProgress({ type: "started", toolName, callId });

  try {
    const timeoutMs = executor.descriptor.timeout_ms ?? 10_000;

    rawOutput = await Promise.race([
      executor.execute(
        (executor.schema
          ? validateInput(executor.schema, rawInput).data!
          : rawInput) as TInput,
        context,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
      ),
    ]);
  } catch (error: unknown) {
    const isTimeout = error instanceof Error && error.message === "TIMEOUT";
    const errorCode = isTimeout ? "TIMEOUT" : "INTERNAL_ERROR";

    recordAudit({
      tool_name: toolName,
      tool_version: toolVersion,
      user_id: context.user_id,
      tenant_id: context.tenant_id,
      conversation_id: context.conversation_id,
      risk_level: executor.descriptor.risk_level,
      ok: false,
      error_code: errorCode,
      duration_ms: Date.now() - startTime,
      request_id: context.request_id,
      trace_id: context.trace_id,
    });

    const durationMs = Date.now() - startTime;
    reportToolProgress({ type: "failed", toolName, callId, durationMs });
    return {
      ok: false,
      data: null,
      error: {
        code: errorCode,
        message: isTimeout
          ? `工具执行超时 (${executor.descriptor.timeout_ms}ms)`
          : error instanceof Error
            ? error.message
            : "执行失败",
      },
      meta: {
        tool_call_id: callId,
        tool_name: toolName,
        tool_version: toolVersion,
        duration_ms: durationMs,
      },
    };
  }

  // 5. 结果脱敏
  const sanitized = sanitizeResult(rawOutput);

  const durationMs = Date.now() - startTime;

  // 6. 审计记录
  recordAudit({
    tool_name: toolName,
    tool_version: toolVersion,
    user_id: context.user_id,
    tenant_id: context.tenant_id,
    conversation_id: context.conversation_id,
    risk_level: executor.descriptor.risk_level,
    ok: true,
    duration_ms: durationMs,
    request_id: context.request_id,
    trace_id: context.trace_id,
  });
  reportToolProgress({ type: "completed", toolName, callId, durationMs });

  return {
    ok: true,
    data: sanitized,
    error: null,
    meta: {
      tool_call_id: callId,
      tool_name: toolName,
      tool_version: toolVersion,
      duration_ms: durationMs,
    },
  };
}

// ============ Per-Request 上下文管理 ============

// 获取当前异步上下文中的工具调用上下文信息
export function getToolCallContext(): ToolCallContext | undefined {
  return runtimeStorage.getStore()?.context;
}

/**
 * 在独立异步上下文中运行一次 Agent 请求，隔离用户身份与工具预算。
 */
// 在独立异步上下文中运行一次请求，隔离用户身份与工具预算
export function runWithToolCallContext<T>(
  context: ToolCallContext,
  callback: () => T,
  options?: { onToolProgress?: (event: ToolProgressEvent) => void },
): T {
  return createToolCallScope(context, options).run(callback);
}

// 创建一个工具调用作用域，用于隔离请求上下文
export function createToolCallScope(
  context: ToolCallContext,
  options: { onToolProgress?: (event: ToolProgressEvent) => void } = {},
): {
  run<T>(callback: () => T): T;
} {
  const store = {
    context,
    budget: createBudgetState(),
    onToolProgress: options.onToolProgress,
    seenMemorySaves: new Set<string>(),
  };
  return {
    // 执行 run 对应的业务逻辑
    run<T>(callback: () => T): T {
      return runtimeStorage.run(store, callback);
    },
  };
}

// ============ 工具 Runtime 包装 ============

import { DynamicStructuredTool } from "langchain/tools";
import { redactTextContent, redactStructuredData } from "./data-redaction.js";

/**
 * 将 LangChain DynamicStructuredTool 包装为走 invokeTool 管线的版本。
 *
 * 替换原始 tool.func，使其在 AgentExecutor 调用时自动经过：
 *   预算守卫 → 参数校验 → 权限检查 → 执行(超时) → 脱敏 → 审计 → 指标
 *
 * @param tool 原始 LangChain 工具
 * @param descriptor 工具描述符（ToolDescriptor）
 * @param schema Zod schema（用于参数校验，可选）
 * @returns 新的 DynamicStructuredTool，func 已包装
 */
// 执行 wrapToolWithRuntime 对应的业务逻辑
export function wrapToolWithRuntime(
  tool: DynamicStructuredTool,
  descriptor: ToolDescriptor,
  schema?: { parse: (input: unknown) => unknown },
): DynamicStructuredTool {
  // 执行 wrappedFunc 对应的业务逻辑
  const wrappedFunc = async (rawInput: unknown): Promise<string> => {
    const context = getToolCallContext();
    if (!context) {
      throw new Error("Tool runtime context is required");
    }

    // 用户/会话 ID 属于服务端上下文，禁止模型通过工具参数越权覆盖。
    let scopedInput = rawInput;
    if (rawInput && typeof rawInput === "object") {
      const input = { ...(rawInput as Record<string, unknown>) };
      if (descriptor.name.startsWith("memory.user."))
        input.user_id = context.user_id;
      if (descriptor.name === "memory.session.search") {
        input.conversation_id = context.conversation_id;
      }
      scopedInput = input;
    }

    // 去重：同一轮中 memory_user_save 相同内容只执行一次
    if (
      descriptor.name === "memory.user.save" ||
      descriptor.name === "memory_user_save"
    ) {
      const store = runtimeStorage.getStore();
      if (store) {
        const contentKey = String((scopedInput as Record<string, unknown>).content ?? "");
        if (!store.seenMemorySaves) store.seenMemorySaves = new Set<string>();
        if (store.seenMemorySaves.has(contentKey)) {
          return "🧠 记忆已存在（内容重复），未重复保存。";
        }
        store.seenMemorySaves.add(contentKey);
      }
    }

    const executor: ToolExecutor<unknown, string> = {
      descriptor,
      schema,
      execute: async (input: unknown) => tool.func(input as any),
    };

    const result = await invokeTool(executor, scopedInput, context);

    if (!result.ok) {
      throw new Error(result.error?.message ?? "Tool execution failed");
    }

    return (result.data as string) ?? "";
  };

  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    func: wrappedFunc as any,
    returnDirect: tool.returnDirect,
  });
}
