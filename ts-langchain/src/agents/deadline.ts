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

  constructor(private timeoutMs: number = config.AGENT_DEADLINE_MS) {
    this.signal = this.controller.signal;
    this.timeoutPromise = new Promise((_, reject) => {
      this.signal.addEventListener("abort", () => {
        reject(this.signal.reason instanceof Error ? this.signal.reason : new AgentDeadlineError(this.timeoutMs));
      }, { once: true });
    });
    this.scheduleTimeout();
  }

  enableToolBudget(): void {
    if (this.timeoutMs >= config.AGENT_DEADLINE_WITH_TOOLS_MS || this.signal.aborted) return;
    this.timeoutMs = config.AGENT_DEADLINE_WITH_TOOLS_MS;
    this.scheduleTimeout();
  }

  run<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.timeoutPromise]);
  }

  dispose(): void {
    clearTimeout(this.timeoutId);
  }

  private scheduleTimeout(): void {
    clearTimeout(this.timeoutId);
    const remainingMs = Math.max(0, this.timeoutMs - (Date.now() - this.startedAt));
    this.timeoutId = setTimeout(() => {
      const error = new AgentDeadlineError(this.timeoutMs);
      this.controller.abort(error);
    }, remainingMs);
  }
}

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

export function isAgentDeadlineError(error: unknown): boolean {
  return error instanceof AgentDeadlineError || (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
