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

  afterEach(async () => await clearHistory(threadId));

  it("bounds retained history and starts on a human message", async () => {
    for (let index = 0; index < MAX_HISTORY_MESSAGES; index++) {
      await appendMessage(threadId, new HumanMessage(`question ${index}`));
      await appendMessage(threadId, new AIMessage(`answer ${index}`));
    }

    const history = await getHistory(threadId);
    expect(history.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    expect(history[0]._getType()).toBe("human");
  });
});

describe("ConversationService message history", () => {
  it("stores and clears API messages without duplicating agent history", async () => {
    const conversation = await ConversationService.create("history");
    await ConversationService.appendUserMessage(conversation.id, "hello");
    await ConversationService.appendAssistantMessage(conversation.id, {
      id: "assistant-1",
      role: "assistant",
      content: "hi",
      createdAt: new Date().toISOString(),
    });

    expect((await ConversationService.getMessages(conversation.id)).map((message) => message.content))
      .toEqual(["hello", "hi"]);
    expect(await getHistory(conversation.id)).toHaveLength(2);
    await ConversationService.clearMessages(conversation.id);
    expect(await ConversationService.getMessages(conversation.id)).toEqual([]);
    expect((await ConversationService.get(conversation.id))?.messageCount).toBe(0);
  });
});
