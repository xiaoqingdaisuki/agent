import { AsyncLocalStorage } from "node:async_hooks";

// ReAct 执行状态，内部状态只用于结构化观测，不包含思维链正文。
export type ReActState = "IDLE" | "REASONING" | "TOOL_CALLING" | "OBSERVING" | "ANSWERING" | "COMPLETED" | "FAILED" | "TIMEOUT" | "TOOL_ERROR" | "MAX_STEPS_REACHED";

// ReAct 终止原因，接口对外只暴露稳定枚举值。
export type ReActStopReason = "ANSWER_COMPLETE" | "CLARIFICATION_REQUIRED" | "MAX_STEPS" | "TIMEOUT" | "TOOL_FAILURE" | "ERROR";

// 工具调用后的统一 Observation 信封。
export interface ReActObservation {
  tool_call_id: string;
  tool: string;
  status: "success" | "error";
  data: unknown;
  error: { code: string; message: string } | null;
  latency_ms: number;
}

// ReAct 运行限制，默认值与 Python 版本保持一致。
export interface ReActLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxSameToolCalls: number;
  maxTotalTimeMs: number;
  maxRetriesPerCall: number;
}

// ReAct 请求结束后的结构化摘要。
export interface ReActRunSummary {
  state: ReActState;
  stop_reason: ReActStopReason;
  react_steps: number;
  tool_calls: number;
  tool_names: string[];
  tool_errors: number;
  model_calls: number;
  observations: ReActObservation[];
  reason_code?: string;
  total_latency_ms: number;
}

// 创建符合双端契约默认值的 ReAct 限制配置。
export function createDefaultReActLimits(overrides: Partial<ReActLimits> = {}): ReActLimits {
  return { maxSteps: 8, maxToolCalls: 6, maxSameToolCalls: 3, maxTotalTimeMs: 30_000, maxRetriesPerCall: 1, ...overrides };
}

// 将工具参数序列化成跨语言一致的稳定签名。
export function toolCallSignature(tool: string, args: unknown): string {
  try {
    return `${tool}:${JSON.stringify(args, Object.keys((args as object) || {}).sort())}`;
  } catch {
    return `${tool}:${String(args)}`;
  }
}

// 判断模型的最终文本是否是在请求用户补充必要信息。
export function isClarification(text: string): boolean {
  return Boolean(text && /请问|请补充|哪个城市|需要提供|能否提供/.test(text) && /[？?]$/.test(text.trim()));
}

// 记录单次 createAgent 运行的公共 ReAct 契约，不实现第二套执行循环。
export class ReActRunTracker {
  private readonly startedAt = Date.now();
  private state: ReActState = "IDLE";
  private stopReason: ReActStopReason | undefined;
  private reasonCode: string | undefined;
  private steps = 0;
  private calls = 0;
  private errors = 0;
  private modelCalls = 0;
  private readonly names: string[] = [];
  private readonly observations: ReActObservation[] = [];
  private readonly signatures = new Map<string, number>();
  private readonly failures = new Map<string, number>();

  // 初始化请求级追踪器，状态必须随请求隔离而不是存入缓存 Agent。
  constructor(private readonly limits: ReActLimits) {}

  // 判断总时限是否已到，并记录统一停止原因。
  isTimedOut(): boolean {
    if (Date.now() - this.startedAt < this.limits.maxTotalTimeMs) return false;
    this.stop("TIMEOUT", "TIMEOUT", "TOTAL_TIME_LIMIT");
    return true;
  }

  // 在每次模型调用前检查并记录步骤，达到限制时要求模型只生成最终回答。
  beginModelCall(): boolean {
    if (this.isTimedOut()) return true;
    this.modelCalls += 1;
    if (this.stopReason) return true;
    if (this.steps >= this.limits.maxSteps) {
      this.stop("MAX_STEPS_REACHED", "MAX_STEPS", "MAX_REACT_STEPS");
      return true;
    }
    this.steps += 1;
    this.state = "REASONING";
    return false;
  }

  // 在执行工具前应用总数、重复和失败重试限制。
  beforeTool(tool: string, args: unknown): { allowed: boolean; signature: string } {
    const signature = toolCallSignature(tool, args);
    if (this.isTimedOut() || this.stopReason) return { allowed: false, signature };
    if (this.calls >= this.limits.maxToolCalls) {
      this.stop("MAX_STEPS_REACHED", "MAX_STEPS", "MAX_TOOL_CALLS");
      return { allowed: false, signature };
    }
    const sameCalls = (this.signatures.get(signature) || 0) + 1;
    if (sameCalls > this.limits.maxSameToolCalls) {
      this.stop("TOOL_ERROR", "TOOL_FAILURE", "REPEATED_TOOL_CALL");
      return { allowed: false, signature };
    }
    if ((this.failures.get(signature) || 0) > this.limits.maxRetriesPerCall) {
      this.stop("TOOL_ERROR", "TOOL_FAILURE", "TOOL_RETRY_EXHAUSTED");
      return { allowed: false, signature };
    }
    this.signatures.set(signature, sameCalls);
    this.calls += 1;
    this.names.push(tool);
    this.state = "TOOL_CALLING";
    return { allowed: true, signature };
  }

  // 记录一次工具执行结果，错误结果仍会交给框架驱动下一次模型调用。
  recordTool(toolCallId: string, tool: string, signature: string, startedAt: number, result: unknown, error?: unknown): void {
    const latencyMs = Date.now() - startedAt;
    if (error) {
      this.errors += 1;
      this.failures.set(signature, (this.failures.get(signature) || 0) + 1);
      this.observations.push({ tool_call_id: toolCallId, tool, status: "error", data: null, error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "工具执行失败" }, latency_ms: latencyMs });
      this.state = "TOOL_ERROR";
      return;
    }
    this.observations.push({ tool_call_id: toolCallId, tool, status: "success", data: parseObservationData(result), error: null, latency_ms: latencyMs });
    this.state = "OBSERVING";
  }

  // 根据最终文本补齐正常完成或澄清完成的停止原因。
  complete(text: string): void {
    if (this.stopReason) return;
    const clarification = isClarification(text);
    this.stop("COMPLETED", clarification ? "CLARIFICATION_REQUIRED" : "ANSWER_COMPLETE", clarification ? "MISSING_REQUIRED_INPUT" : undefined);
  }

  // 记录框架或模型未恢复的异常。
  fail(error: unknown): void {
    if (this.stopReason) return;
    this.stop("FAILED", "ERROR", error instanceof Error ? error.name : "UNRECOVERABLE_ERROR");
  }

  // 返回稳定、可序列化且不含思维链的请求摘要。
  summary(): ReActRunSummary {
    return { state: this.state === "IDLE" ? "COMPLETED" : this.state, stop_reason: this.stopReason || "ANSWER_COMPLETE", react_steps: this.steps, tool_calls: this.calls, tool_names: [...this.names], tool_errors: this.errors, model_calls: this.modelCalls, observations: [...this.observations], reason_code: this.reasonCode, total_latency_ms: Date.now() - this.startedAt };
  }

  // 记录终止状态，首个硬限制拥有最高优先级。
  private stop(state: ReActState, reason: ReActStopReason, code?: string): void {
    if (this.stopReason) return;
    this.state = state;
    this.stopReason = reason;
    this.reasonCode = code;
  }
}

// 将工具返回内容解析为结构化数据，解析失败时保留原文。
function parseObservationData(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

const trackerStorage = new AsyncLocalStorage<ReActRunTracker>();

// 在当前异步请求作用域运行声明式 Agent 策略。
export function runWithReActTracker<T>(tracker: ReActRunTracker, callback: () => T): T {
  return trackerStorage.run(tracker, callback);
}

// 获取当前请求的 ReAct 追踪器，缓存 Agent 的 middleware 只能通过此入口读取状态。
export function getActiveReActTracker(): ReActRunTracker | undefined {
  return trackerStorage.getStore();
}
