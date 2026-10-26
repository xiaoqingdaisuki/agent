/** 封装 Workers Agent 追踪上下文、跨度及模型工具输入输出记录 */

import { z } from "zod";

export const AGENT_TRACE_CONTEXT_SCHEMA = z.object({
  agentName: z.string().optional(),
  agentId: z.string().optional(),
  conversationId: z.string().optional(),
});

export type AgentTraceContext = {
  agentName: string;
  agentId: string;
  conversationId: string;
};

type TraceStatus = {
  code: "unset" | "ok" | "error";
  message?: string;
};

type TraceException =
  | string
  | { code: string | number; name?: string; message?: string; stack?: string }
  | { code?: string | number; name: string; message?: string; stack?: string }
  | { code?: string | number; name?: string; message: string; stack?: string };

export type AgentTraceSpan = {
  readonly isTraced: boolean;
  // 设置单个追踪属性并返回当前跨度
  setAttribute(key: string, value: boolean | number | string): AgentTraceSpan;
  // 批量设置追踪属性并返回当前跨度
  setAttributes(attributes: Record<string, boolean | number | string | undefined>): AgentTraceSpan;
  // 记录跨度执行期间发生的异常
  recordException(exception: TraceException): void;
  // 更新追踪跨度的执行状态
  setStatus(status: TraceStatus): AgentTraceSpan;
  // 结束当前追踪跨度
  end(): void;
};

type WorkerTracing = {
  // 进入带有当前上下文的命名追踪跨度并执行回调
  enterSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: AgentTraceSpan, ...args: A) => T,
    ...args: A
  ): T;
  // 创建活动追踪跨度并在其上下文中执行回调
  startActiveSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: AgentTraceSpan, ...args: A) => T,
    ...args: A
  ): T;
};

const DEFAULT_AGENT_NAME = "ts-langchain-agent";
const DEFAULT_AGENT_ID = "ts-langchain-worker";
let workerTracingPromise: Promise<WorkerTracing | undefined> | undefined;

// 延迟加载 Workers tracing，保证本地 Node 测试和服务器启动仍可使用同一套代码
async function loadWorkerTracing(): Promise<WorkerTracing | undefined> {
  if (typeof process === "undefined" || process.env.AGENT_RUNTIME !== "workers") return undefined;
  workerTracingPromise ??= import("cloudflare:workers")
    // 从 Workers 模块中提取追踪接口
    .then((module) => module.tracing as unknown as WorkerTracing)
    // 追踪模块不可用时降级为无追踪模式
    .catch(() => undefined);
  return workerTracingPromise;
}

// 构建当前 Agent turn 使用的稳定身份和会话标识
export function createAgentTraceContext(conversationId?: string): AgentTraceContext {
  return {
    agentName: DEFAULT_AGENT_NAME,
    agentId: DEFAULT_AGENT_ID,
    conversationId: conversationId?.trim() || "unknown",
  };
}

// 将 LangChain runtime context 解析为完整的 tracing identity，并为测试或旧调用提供默认值
export function getAgentTraceContext(context: unknown): AgentTraceContext {
  const candidate = context && typeof context === "object"
    ? context as Record<string, unknown>
    : {};
  return {
    agentName: typeof candidate.agentName === "string" && candidate.agentName
      ? candidate.agentName
      : DEFAULT_AGENT_NAME,
    agentId: typeof candidate.agentId === "string" && candidate.agentId
      ? candidate.agentId
      : DEFAULT_AGENT_ID,
    conversationId: typeof candidate.conversationId === "string" && candidate.conversationId
      ? candidate.conversationId
      : "unknown",
  };
}

// 为 Agent、模型和工具 span 写入 Cloudflare Agents Dashboard 所需的身份字段
function setTraceIdentity(span: AgentTraceSpan, operation: string, context: AgentTraceContext): void {
  if (!span.isTraced) return;
  span.setAttributes({
    "gen_ai.operation.name": operation,
    "gen_ai.agent.name": context.agentName,
    "gen_ai.agent.id": context.agentId,
    "gen_ai.conversation.id": context.conversationId,
  });
}

// 将结构化 payload 安全地序列化为 custom span 支持的标量属性
export function serializeTracePayload(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    // 将大整数和异常转换为可序列化的追踪值
    const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === "bigint") return `${candidate}n`;
      if (candidate instanceof Error) {
        return {
          name: candidate.name,
          message: candidate.message,
          stack: candidate.stack,
        };
      }
      if (candidate && typeof candidate === "object") {
        if (seen.has(candidate)) return "[Circular]";
        seen.add(candidate);
      }
      return candidate;
    });
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

// 为自定义 span 写入序列化后的 payload，未采样请求不会产生额外序列化开销
function setTracePayload(span: AgentTraceSpan | undefined, key: string, value: unknown): void {
  if (!span?.isTraced || value === undefined) return;
  span.setAttribute(key, serializeTracePayload(value));
}

// 将异常记录到当前 span，并同步标记 span 状态
export function recordAgentTraceError(span: AgentTraceSpan | undefined, error: unknown): void {
  if (!span?.isTraced) return;
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : message);
  span.setStatus({ code: "error", message });
}

// 在自定义 span 中执行一个 Agent 操作，并自动处理成功与异常状态
export async function withAgentSpan<T>(
  name: "chat" | "execute_tool",
  context: AgentTraceContext,
  callback: (span?: AgentTraceSpan) => T | Promise<T>,
): Promise<T> {
  const tracing = await loadWorkerTracing();
  if (!tracing) return callback(undefined);
  // 为命名跨度设置身份并记录回调的异常
  return tracing.enterSpan(name, async (span) => {
    setTraceIdentity(span, name, context);
    try {
      return await callback(span);
    } catch (error) {
      recordAgentTraceError(span, error);
      throw error;
    }
  });
}

// 为完整的 Agent turn 创建一个保持 active 的父 span，覆盖流式生产者的整个生命周期
export async function withActiveAgentTrace<T>(
  context: AgentTraceContext,
  callback: () => Promise<T>,
): Promise<T> {
  const tracing = await loadWorkerTracing();
  if (!tracing) return callback();
  // 在活动 Agent 跨度中执行请求并记录成功或异常状态
  return tracing.startActiveSpan("invoke_agent", async (span) => {
    setTraceIdentity(span, "invoke_agent", context);
    try {
      const result = await callback();
      if (span.isTraced) span.setStatus({ code: "ok" });
      return result;
    } catch (error) {
      recordAgentTraceError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

// 为一次非流式 Agent turn 创建 invoke_agent 父 span
export async function withAgentTrace<T>(
  context: AgentTraceContext,
  callback: () => T | Promise<T>,
): Promise<T> {
  const tracing = await loadWorkerTracing();
  if (!tracing) return callback();
  // 在 Agent 跨度中执行请求并记录成功或异常状态
  return tracing.enterSpan("invoke_agent", async (span) => {
    setTraceIdentity(span, "invoke_agent", context);
    try {
      const result = await callback();
      if (span.isTraced) span.setStatus({ code: "ok" });
      return result;
    } catch (error) {
      recordAgentTraceError(span, error);
      throw error;
    }
  });
}

// 从 LangChain 模型请求中提取安全的模型名称，避免把模型对象或凭据写入 span
function getModelName(model: unknown): string | undefined {
  if (typeof model === "string") return model;
  if (!model || typeof model !== "object") return undefined;
  const candidate = model as Record<string, unknown>;
  for (const key of ["modelName", "model", "name"]) {
    if (typeof candidate[key] === "string" && candidate[key]) return candidate[key];
  }
  return undefined;
}

// 记录 chat span 的输入消息、系统指令、工具定义和模型名称
export function recordModelInput(span: AgentTraceSpan | undefined, request: unknown): void {
  if (!span?.isTraced) return;
  const candidate = request && typeof request === "object"
    ? request as Record<string, unknown>
    : {};
  setTracePayload(span, "gen_ai.input.messages", candidate.messages);
  setTracePayload(span, "gen_ai.system_instructions", candidate.systemPrompt ?? candidate.systemMessage);
  setTracePayload(span, "gen_ai.tool.definitions", candidate.tools);
  const modelName = getModelName(candidate.model);
  if (modelName) span.setAttribute("gen_ai.request.model", modelName);
}

// 记录 chat span 的完整模型响应，包括文本、tool_calls 和 usage metadata
export function recordModelOutput(span: AgentTraceSpan | undefined, response: unknown): void {
  setTracePayload(span, "gen_ai.output.messages", response);
}

// 记录 execute_tool span 的工具名称、调用 ID、参数和工具定义
export function recordToolInput(span: AgentTraceSpan | undefined, request: unknown): void {
  if (!span?.isTraced) return;
  const candidate = request && typeof request === "object"
    ? request as Record<string, unknown>
    : {};
  const toolCall = candidate.toolCall && typeof candidate.toolCall === "object"
    ? candidate.toolCall as Record<string, unknown>
    : {};
  if (typeof toolCall.name === "string") span.setAttribute("gen_ai.tool.name", toolCall.name);
  if (typeof toolCall.id === "string") span.setAttribute("gen_ai.tool.call.id", toolCall.id);
  setTracePayload(span, "gen_ai.tool.call.arguments", toolCall.args);
  setTracePayload(span, "gen_ai.tool.definition", candidate.tool);
}

// 记录 execute_tool span 的工具结果或错误结果
export function recordToolOutput(span: AgentTraceSpan | undefined, result: unknown): void {
  setTracePayload(span, "gen_ai.tool.call.result", result);
}
