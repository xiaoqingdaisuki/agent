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
 */

import type { ToolDescriptor, ToolCallContext, ToolRuntimeResult, ToolResultEnvelope } from "../contracts.js";

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

export function getAuditLog(): ReadonlyArray<AuditEntry> {
  return auditLog;
}

export function clearAuditLog(): void {
  auditLog.length = 0;
}

// ============ 权限检查 ============

const permissionCache = new Map<string, { granted: boolean; expires: number }>();
const PERMISSION_CACHE_TTL_MS = 5_000;

/**
 * 检查用户是否拥有指定权限
 *
 * 当前为最小可用实现：所有 R0/R1 只读工具默认允许，
 * R2+ 工具需要显式声明 permissions 并通过策略。
 *
 * TODO: Phase 0.4 替换为真正的 RBAC 引擎
 */
export function permissionCheck(
  context: ToolCallContext,
  descriptor: ToolDescriptor
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
export function validateInput<T>(
  schema: { parse: (input: unknown) => T },
  rawInput: unknown
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
  "api_key", "apikey", "secret", "password", "token",
  "access_token", "refresh_token", "private_key",
  "authorization", "credentials",
]);

export function sanitizeResult<T>(data: T): T {
  if (typeof data !== "object" || data === null) return data;

  if (Array.isArray(data)) {
    return data.map(sanitizeResult) as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      result[key] = sanitizeResult(value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

// ============ 预算守卫 ============

interface BudgetState {
  toolCallsThisRound: number;
  totalToolCalls: number;
  maxPerRound: number;
  maxTotal: number;
}

const budgetState: BudgetState = {
  toolCallsThisRound: 0,
  totalToolCalls: 0,
  maxPerRound: 8,
  maxTotal: 20,
};

export function resetRoundBudget(): void {
  budgetState.toolCallsThisRound = 0;
}

export function budgetGuard(): ToolRuntimeResult<null> | null {
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

export function recordAudit(entry: Omit<AuditEntry, "timestamp">): void {
  auditLog.push({
    ...entry,
    timestamp: new Date().toISOString(),
  });

  // 保留最近 1000 条
  if (auditLog.length > 1000) {
    auditLog.splice(0, auditLog.length - 1000);
  }
}

// ============ 辅助函数 ============

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
export async function invokeTool<TInput, TOutput>(
  executor: ToolExecutor<TInput, TOutput>,
  rawInput: unknown,
  context: ToolCallContext
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
      error: budgetResult.error,
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
        error: validation.error,
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
      error: { code: errorCode, message: permResult.reason ?? "Permission denied" },
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
  let timedOut = false;

  try {
    const timeoutMs = executor.descriptor.timeout_ms ?? 10_000;

    rawOutput = await Promise.race([
      executor.execute(
        (executor.schema ? validateInput(executor.schema, rawInput).data! : rawInput) as TInput,
        context,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
      ),
    ]);
  } catch (error: unknown) {
    const isTimeout = error instanceof Error && error.message === "TIMEOUT";
    const errorCode: ToolRuntimeResult["error"]["code"] = isTimeout ? "TIMEOUT" : "INTERNAL_ERROR";

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
        message: isTimeout ? `工具执行超时 (${executor.descriptor.timeout_ms}ms)` : (error instanceof Error ? error.message : "执行失败"),
      },
      meta: {
        tool_call_id: callId,
        tool_name: toolName,
        tool_version: toolVersion,
        duration_ms: Date.now() - startTime,
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
