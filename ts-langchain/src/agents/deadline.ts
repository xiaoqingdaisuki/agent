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

  constructor(readonly timeoutMs: number = config.AGENT_DEADLINE_MS) {
    this.signal = this.controller.signal;
    this.timeoutPromise = new Promise((_, reject) => {
      this.timeoutId = setTimeout(() => {
        const error = new AgentDeadlineError(timeoutMs);
        this.controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
  }

  run<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.timeoutPromise]);
  }

  dispose(): void {
    clearTimeout(this.timeoutId);
  }
}

export async function runWithAgentDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AgentDeadline();
  try {
    return await deadline.run(task(deadline.signal));
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
