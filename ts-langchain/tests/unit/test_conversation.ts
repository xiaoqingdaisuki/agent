import { afterEach, describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import {
  MAX_HISTORY_MESSAGES,
  appendMessage,
  clearHistory,
  getHistory,
} from "../../src/memory/conversation.js";
import {
  AgentService,
  BusinessErrorCode,
  ConversationService,
  KnowledgeService,
} from "../../src/services/index.js";

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

  it("isolates lists and rejects reusing another user's conversation id", async () => {
    const owned = await ConversationService.create("private", "chat", "owner-a");
    await ConversationService.create("other", "chat", "owner-b");

    const visible = await ConversationService.list("owner-a");
    expect(visible.map((conversation) => conversation.id)).toContain(owned.id);
    expect(visible.every((conversation) => conversation.userId === "owner-a")).toBe(true);
    await expect(ConversationService.ensure(owned.id, "owner-b")).rejects.toMatchObject({
      code: BusinessErrorCode.FORBIDDEN,
      statusCode: 403,
    });
  });

  it("uses the RAG path for a streamed knowledge conversation", async () => {
    const conversation = await ConversationService.create(
      "knowledge",
      "knowledge",
      "knowledge-user",
    );
    const chat = vi.spyOn(KnowledgeService, "chat").mockResolvedValue({
      output: "knowledge answer",
      sourceDocuments: [],
    });

    const events = [];
    for await (const event of AgentService.chatStream(
      conversation.id,
      "question",
    )) {
      events.push(event);
    }

    expect(chat).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: "text", text: "knowledge answer" }]);
  });
});
