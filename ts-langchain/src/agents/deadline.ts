import { config } from "../config/index.js";

export class AgentDeadlineError extends Error {
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

  // 初始化 AbortController 和超时定时器，启动计时
  constructor(private timeoutMs: number = config.AGENT_DEADLINE_MS) {
    this.signal = this.controller.signal;
    this.timeoutPromise = new Promise((_, reject) => {
      this.signal.addEventListener("abort", () => {
        reject(this.signal.reason instanceof Error ? this.signal.reason : new AgentDeadlineError(this.timeoutMs));
      }, { once: true });
    });
    this.scheduleTimeout();
  }

// 检测到工具调用后延长超时时间，为工具执行留出更多预算
  enableToolBudget(): void {
    if (this.timeoutMs >= config.AGENT_DEADLINE_WITH_TOOLS_MS || this.signal.aborted) return;
    this.timeoutMs = config.AGENT_DEADLINE_WITH_TOOLS_MS;
    this.scheduleTimeout();
  }

// 在超时截止时间内执行异步操作，超时则拒绝
  run<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.timeoutPromise]);
  }

// 清理超时定时器，防止内存泄漏
  dispose(): void {
    clearTimeout(this.timeoutId);
  }

// 设置或重置超时截止时间，保证剩余时间足够
  private scheduleTimeout(): void {
    clearTimeout(this.timeoutId);
    const remainingMs = Math.max(0, this.timeoutMs - (Date.now() - this.startedAt));
    this.timeoutId = setTimeout(() => {
      const error = new AgentDeadlineError(this.timeoutMs);
      this.controller.abort(error);
    }, remainingMs);
  }
}

// 执行带截止时间的任务，自动清理超时资源
export async function runWithAgentDeadline<T>(
  task: (deadline: AgentDeadline) => Promise<T>,
): Promise<T> {
  const deadline = new AgentDeadline();
  try {
    return await deadline.run(task(deadline));
  } finally {
    deadline.dispose();
  }
}

// 判断错误是否为 Agent 超时或中断错误
export function isAgentDeadlineError(error: unknown): boolean {
  return error instanceof AgentDeadlineError || (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
