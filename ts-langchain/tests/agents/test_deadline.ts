import { describe, expect, it } from "vitest";

import { AgentDeadline, AgentDeadlineError } from "../../src/agents/deadline.js";

describe("agent deadline", () => {
  it("aborts an operation and returns the deadline error", async () => {
    const deadline = new AgentDeadline(5);
    const operation = new Promise<never>((_, reject) => {
      deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true });
    });

    try {
      await expect(deadline.run(operation)).rejects.toBeInstanceOf(AgentDeadlineError);
      expect(deadline.signal.aborted).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  it("does not leave an unhandled rejection for signal-only streams", async () => {
    const deadline = new AgentDeadline(5);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });
});
