import { afterEach, describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import {
  MAX_HISTORY_TOKENS,
  appendMessage,
  clearHistory,
  getHistory,
} from "../../src/memory/conversation.js";
import {
  AgentService,
  BusinessErrorCode,
  ConversationService,
  KnowledgeService,
  drainXmlToolStream,
} from "../../src/services/index.js";

describe("conversation history", () => {
  const threadId = "bounded-history";

  afterEach(async () => await clearHistory(threadId));

  it("uses a token budget and retains a complete user turn", async () => {
    await appendMessage(threadId, new HumanMessage(`old ${"中".repeat(MAX_HISTORY_TOKENS)}`));
    await appendMessage(threadId, new AIMessage("old answer"));
    await appendMessage(threadId, new HumanMessage("latest question"));
    await appendMessage(threadId, new AIMessage("latest answer"));

    const history = await getHistory(threadId);
    expect(history).toHaveLength(2);
    expect(history[0]._getType()).toBe("human");
    expect(history[0].content).toBe("latest question");
  });

  it("reloads the newest persisted page instead of the oldest messages", async () => {
    const conversation = await ConversationService.create("recent-page", "chat", "recent-user");
    for (let index = 0; index < 210; index += 1) {
      await ConversationService.appendUserMessage(conversation.id, `question ${index}`);
      await ConversationService.appendAssistantMessage(conversation.id, {
        id: `assistant-${index}`,
        role: "assistant",
        content: `answer ${index}`,
        createdAt: new Date().toISOString(),
      });
    }
    await clearHistory(conversation.id);

    const history = await getHistory(conversation.id);

    expect(history.at(-1)?.content).toBe("answer 209");
    expect(history.some((message) => message.content === "question 0")).toBe(false);
  });
});

describe("ConversationService message history", () => {
  it("does not expose invoke XML while streaming tool calls", () => {
    let buffer = "";
    let visible = "";
    for (const chunk of [
      "<inv",
      'oke name="memory_user_search"><parameter name="query">用户',
      "身份个人信息</parameter></invoke>",
      "已完成",
    ]) {
      buffer += chunk;
      const drained = drainXmlToolStream(buffer);
      visible += drained.text;
      buffer = drained.remainder;
    }
    visible += drainXmlToolStream(buffer, true).text;

    expect(visible).toBe("已完成");
  });

  it("does not expose dots function XML while streaming tool calls", () => {
    let buffer = "";
    let visible = "";
    for (const chunk of [
      "<dots_function_call><search><query>深圳南山区",
      "美食推荐</query></search></dots_function_call>",
      "已完成",
    ]) {
      buffer += chunk;
      const drained = drainXmlToolStream(buffer);
      visible += drained.text;
      buffer = drained.remainder;
    }
    visible += drainXmlToolStream(buffer, true).text;

    expect(visible).toBe("已完成");
  });

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
