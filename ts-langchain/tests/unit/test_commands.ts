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
        payload: { message: `user: ${DARK_MODE_COMMAND}` },
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json().reply).toBe(DARK_MODE_ENABLED_REPLY);
      expect(enabled.json().thread_id).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });

  it("streams the command through the v1 conversation API", async () => {
    const app = await buildApp();

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        payload: { title: "stream test" },
      });
      const conversationId = created.json().id as string;
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/conversations/${conversationId}/messages/stream`,
        payload: { content: DARK_MODE_COMMAND },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain(JSON.stringify({ delta: DARK_MODE_ENABLED_REPLY }));
      expect(response.body).toContain("data: [DONE]");
    } finally {
      await app.close();
    }
  });

  it("recognizes legacy formatted conversations without a stable thread id", () => {
    const formattedCommand = `user: ${DARK_MODE_COMMAND}`;
    expect(executeAgentCommand(formattedCommand, threadId)?.reply)
      .toBe(DARK_MODE_ENABLED_REPLY);

    const nextRequest = [
      formattedCommand,
      `assistant: ${DARK_MODE_ENABLED_REPLY}`,
      "user: 你好",
    ].join("\n\n");
    expect(getAgentPromptOverride("new-random-thread", nextRequest)).toBe(DARK_MODE_PROMPT);

    const disabledRequest = [
      nextRequest,
      `assistant: 大公鸡模式回答`,
      `user: ${DARK_MODE_COMMAND}`,
    ].join("\n\n");
    expect(executeAgentCommand(disabledRequest, "another-random-thread")?.reply)
      .toBe(DARK_MODE_DISABLED_REPLY);
    expect(getAgentPromptOverride("another-random-thread", disabledRequest)).toBeUndefined();
  });
});
