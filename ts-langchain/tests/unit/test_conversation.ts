import { afterEach, describe, expect, it } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import {
  MAX_HISTORY_MESSAGES,
  appendMessage,
  clearHistory,
  getHistory,
} from "../../src/memory/conversation.js";

describe("conversation history", () => {
  const threadId = "bounded-history";

  afterEach(() => clearHistory(threadId));

  it("bounds retained history and starts on a human message", () => {
    for (let index = 0; index < MAX_HISTORY_MESSAGES; index++) {
      appendMessage(threadId, new HumanMessage(`question ${index}`));
      appendMessage(threadId, new AIMessage(`answer ${index}`));
    }

    const history = getHistory(threadId);
    expect(history.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    expect(history[0]._getType()).toBe("human");
  });
});
