import { afterEach, describe, expect, it } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import {
  MAX_HISTORY_MESSAGES,
  appendMessage,
  clearHistory,
  getHistory,
} from "../../src/memory/conversation.js";
import { ConversationService } from "../../src/services/index.js";

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

describe("ConversationService message history", () => {
  it("stores and clears API messages without duplicating agent history", () => {
    const conversation = ConversationService.create("history");
    ConversationService.appendUserMessage(conversation.id, "hello");
    ConversationService.appendAssistantMessage(conversation.id, {
      id: "assistant-1",
      role: "assistant",
      content: "hi",
      createdAt: new Date().toISOString(),
    });

    expect(ConversationService.getMessages(conversation.id).map((message) => message.content))
      .toEqual(["hello", "hi"]);
    expect(getHistory(conversation.id)).toHaveLength(0);
    ConversationService.clearMessages(conversation.id);
    expect(ConversationService.getMessages(conversation.id)).toEqual([]);
    expect(ConversationService.get(conversation.id)?.messageCount).toBe(0);
  });
});
