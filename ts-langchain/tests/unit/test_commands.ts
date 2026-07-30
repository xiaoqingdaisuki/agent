import { afterEach, describe, expect, it } from "vitest";

import {
  DARK_MODE_COMMAND,
  DARK_MODE_DISABLED_REPLY,
  DARK_MODE_ENABLED_REPLY,
  clearAgentCommandState,
  executeAgentCommand,
  getAgentPromptOverride,
} from "../../src/commands/index.js";
import { DARK_MODE_PROMPT } from "../../src/prompts/system.js";
import { buildApp } from "../../src/api/index.js";

describe("agent commands", () => {
  const threadId = "command-thread";

  afterEach(() => clearAgentCommandState(threadId));

  it("toggles dark mode for one thread", () => {
    expect(executeAgentCommand(DARK_MODE_COMMAND, threadId)?.reply)
      .toBe(DARK_MODE_ENABLED_REPLY);
    expect(getAgentPromptOverride(threadId)).toBe(DARK_MODE_PROMPT);

    expect(executeAgentCommand(`  ${DARK_MODE_COMMAND}  `, threadId)?.reply)
      .toBe(DARK_MODE_DISABLED_REPLY);
    expect(getAgentPromptOverride(threadId)).toBeUndefined();
  });

  it("ignores normal messages and isolates thread state", () => {
    expect(executeAgentCommand("你好", threadId)).toBeUndefined();
    executeAgentCommand(DARK_MODE_COMMAND, threadId);
    expect(getAgentPromptOverride("another-thread")).toBeUndefined();
  });

  it("handles the command through the chat API without calling the model", async () => {
    const app = await buildApp();

    try {
      const enabled = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { message: DARK_MODE_COMMAND, thread_id: threadId },
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toEqual({
        reply: DARK_MODE_ENABLED_REPLY,
        thread_id: threadId,
      });
    } finally {
      await app.close();
    }
  });
});
