import { afterEach, describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import {
  MAX_HISTORY_MESSAGES,
  appendMessage,
  clearHistory,
  getHistory,
} from "../../src/memory/conversation.js";
import {
  DARK_MODE_COMMAND,
  DARK_MODE_DISABLED_REPLY,
  DARK_MODE_ENABLED_REPLY,
  getDarkModeHistoryThreadId,
} from "../../src/commands/index.js";
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

  it("keeps dark mode and normal agent histories independent", async () => {
    const conversation = await ConversationService.create("isolated personas");
    const darkHistoryId = getDarkModeHistoryThreadId(conversation.id);
    await ConversationService.appendUserMessage(conversation.id, "普通问题");
    await ConversationService.appendAssistantMessage(conversation.id, {
      id: "normal-answer",
      role: "assistant",
      content: "普通回答",
      createdAt: new Date().toISOString(),
    });
    await ConversationService.appendUserMessage(conversation.id, DARK_MODE_COMMAND);
    await ConversationService.appendAssistantMessage(conversation.id, {
      id: "enable-dark",
      role: "assistant",
      content: DARK_MODE_ENABLED_REPLY,
      createdAt: new Date().toISOString(),
    });
    await ConversationService.appendUserMessage(conversation.id, "大公鸡问题");
    await ConversationService.appendAssistantMessage(conversation.id, {
      id: "dark-answer",
      role: "assistant",
      content: "大公鸡回答",
      createdAt: new Date().toISOString(),
    });
    await ConversationService.appendUserMessage(conversation.id, DARK_MODE_COMMAND);
    await ConversationService.appendAssistantMessage(conversation.id, {
      id: "disable-dark",
      role: "assistant",
      content: DARK_MODE_DISABLED_REPLY,
      createdAt: new Date().toISOString(),
    });
    await ConversationService.appendUserMessage(conversation.id, "恢复普通问题");

    expect((await getHistory(conversation.id)).map((message) => message.content)).toEqual([
      "普通问题",
      "普通回答",
      "恢复普通问题",
    ]);
    expect((await getHistory(darkHistoryId)).map((message) => message.content)).toEqual([
      "大公鸡问题",
      "大公鸡回答",
    ]);
  });
});
