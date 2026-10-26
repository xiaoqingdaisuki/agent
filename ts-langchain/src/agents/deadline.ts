/** 管理 Agent 请求截止时间、取消信号及工具阶段预算 */

import { config } from "../config/index.js";

export class AgentDeadlineError extends Error {
  // 初始化当前对象
  constructor(readonly timeoutMs: number = config.AGENT_DEADLINE_MS) {
    super(`Agent request exceeded the ${timeoutMs}ms deadline`);
    this.name = "AgentDeadlineError";
  }
}

export class AgentDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timeoutId!: NodeJS.Timeout;
  private readonly timeoutPromise: Promise<never>;
  private readonly startedAt = Date.now();
  private readonly parentSignal?: AbortSignal;
  // 将父请求的取消原因转发给当前截止时间控制器
  private readonly onParentAbort = () => {
    this.controller.abort(this.parentSignal?.reason);
  };

  // 初始化 AbortController 和超时定时器，启动计时
  constructor(
    private timeoutMs: number = config.AGENT_DEADLINE_MS,
    parentSignal?: AbortSignal,
    private readonly toolTimeoutMs: number = config.AGENT_DEADLINE_WITH_TOOLS_MS,
  ) {
    this.parentSignal = parentSignal;
    this.signal = this.controller.signal;
    // 将请求取消信号转换为可参与竞速的拒绝承诺
    this.timeoutPromise = new Promise((_, reject) => {
      // 使用当前取消原因拒绝截止时间承诺
      const rejectAbort = () =>
        reject(
          this.signal.reason instanceof Error
            ? this.signal.reason
            : new AgentDeadlineError(this.timeoutMs),
        );
      if (this.signal.aborted) {
        rejectAbort();
        return;
      }
      this.signal.addEventListener(
        "abort",
        rejectAbort,
        { once: true },
      );
    });
    // 流式调用可能只传递 signal 而不调用 run，提前消费拒绝避免超时触发未处理异常
    void this.timeoutPromise.catch(() => undefined);
    if (parentSignal) {
      if (parentSignal.aborted) {
        this.controller.abort(parentSignal.reason);
      } else {
        parentSignal.addEventListener("abort", this.onParentAbort, { once: true });
      }
    }
    this.scheduleTimeout();
  }

  // 检测到工具调用后延长超时时间，为工具执行留出更多预算
  enableToolBudget(): void {
    if (
      this.timeoutMs >= this.toolTimeoutMs ||
      this.signal.aborted
    )
      return;
    this.timeoutMs = this.toolTimeoutMs;
    this.scheduleTimeout();
  }

  // 在超时截止时间内执行异步操作，超时则拒绝
  run<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.timeoutPromise]);
  }

  // 清理超时定时器，防止内存泄漏
  dispose(): void {
    clearTimeout(this.timeoutId);
    this.parentSignal?.removeEventListener("abort", this.onParentAbort);
  }

  // 设置或重置超时截止时间，保证剩余时间足够
  private scheduleTimeout(): void {
    clearTimeout(this.timeoutId);
    const remainingMs = Math.max(
      0,
      this.timeoutMs - (Date.now() - this.startedAt),
    );
    // 到达截止时间时取消请求并携带超时原因
    this.timeoutId = setTimeout(() => {
      const error = new AgentDeadlineError(this.timeoutMs);
      this.controller.abort(error);
    }, remainingMs);
  }
}

// 执行带截止时间的任务，自动清理超时资源
export async function runWithAgentDeadline<T>(
  task: (deadline: AgentDeadline) => Promise<T>,
  parentSignal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  const deadline = new AgentDeadline(timeoutMs, parentSignal, timeoutMs);
  try {
    return await deadline.run(task(deadline));
  } finally {
    deadline.dispose();
  }
}

// 判断错误是否由 Agent 自身的总时限触发
export function isAgentDeadlineError(error: unknown): boolean {
  return error instanceof AgentDeadlineError;
}

// 判断错误链中是否包含模型客户端或上游网络超时
export function isModelTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (
      current.name === "TimeoutError"
      || current.name === "ConnectTimeoutError"
      || /timed? out|timeout|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT/i.test(current.message)
    ) {
      return true;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

// 判断错误是否由客户端主动断开请求引起
export function isClientAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(?:Client disconnected|The operation was aborted|This operation was aborted|Request aborted)$/i.test(
      error.message,
    )
  );
}
