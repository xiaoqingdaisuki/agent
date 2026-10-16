import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/config/index.js";
import { AgentService, ConversationService, KnowledgeService, TurnService, flushBackgroundTasks } from "../../src/services/index.js";
import { getRepositories } from "../../src/repositories/index.js";
import { getHistoryBeforeInput } from "../../src/memory/conversation.js";
import { parseSessionDocument } from "../../src/services/session-documents.js";

describe("verified local runtime regressions", () => {
  it("recovers old local Turns while rejecting a concurrent live request", async () => {
    config.MEMORY_ENABLED = false;
    const user = `orphan-${crypto.randomUUID()}`;
    const conversation = await ConversationService.create("orphan", "chat", user);
    const first = await TurnService.begin(conversation.id, user, "first", "one");
    await expect(TurnService.begin(conversation.id, user, "second", "two")).rejects.toMatchObject({ code: "TURN_IN_PROGRESS" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 331_000);
    expect((await TurnService.begin(conversation.id, user, "second", "two")).created).toBe(true);
    expect((await getRepositories().turn.get(first.turn.id, user))?.status).toBe("failed");
  });
  const memoryEnabled = config.MEMORY_ENABLED;
  afterEach(() => {
    config.MEMORY_ENABLED = memoryEnabled;
    vi.restoreAllMocks();
  });

  it("preserves every character in long document paragraphs", async () => {
    const text = "A".repeat(40_003) + "TAIL_MARKER";
    const document = await parseSessionDocument(Buffer.from(text), "long.txt");
    expect(document.parts.map((part) => part.content).join("")).toBe(text);
    expect(document.parts.every((part) => part.content.length <= 20_000)).toBe(true);
    expect(document.parts.map((part) => part.partIndex)).toEqual([0, 1, 2]);
  });

  it("rejects the full extracted text above 1MB", async () => {
    await expect(parseSessionDocument(Buffer.from("A".repeat(1_000_001)), "oversized.txt"))
      .rejects.toThrow("SESSION_DOCUMENT_TEXT_TOO_LARGE");
  });

  it("keeps non-BMP characters intact at the document part boundary", async () => {
    const text = "A".repeat(19_999) + "😀TAIL";
    const document = await parseSessionDocument(Buffer.from(text), "unicode.txt");
    expect(document.parts.map((part) => part.content)).toEqual(["A".repeat(19_999) + "😀", "TAIL"]);
    expect(document.parts.every((part) => Buffer.from(part.content).toString("utf8") === part.content)).toBe(true);
  });

  it("uses local knowledge for both chat modes when memory is disabled", async () => {
    config.MEMORY_ENABLED = false;
    const user = `audit-knowledge-${crypto.randomUUID()}`;
    await KnowledgeService.uploadDocument(Buffer.from("退款截止为三十天"), "rules.txt", undefined, user);
    const conversation = await ConversationService.create("local knowledge", "knowledge", user);
    const reply = await AgentService.chat(conversation.id, "退款截止", user);
    const events = [];
    for await (const event of AgentService.chatStream(conversation.id, "退款截止", user)) events.push(event);
    expect(reply.content).toContain("退款截止为三十天");
    expect(events).toEqual([{ type: "text", text: reply.content }]);
    await flushBackgroundTasks();
  });

  it("uses persisted history and consistent counts after a cold service load", async () => {
    config.MEMORY_ENABLED = false;
    const repositories = getRepositories();
    const id = crypto.randomUUID();
    await repositories.conversation.create("audit-history", "cold history", "chat", id);
    const messages = Array.from({ length: 204 }, (_, index) => ({
      id: crypto.randomUUID(), conversation_id: id, user_id: "audit-history",
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content_json: `message-${index}`, created_at: new Date().toISOString(),
    }));
    await repositories.message.createBatch(id, "audit-history", messages);
    await ConversationService.ensure(id, "audit-history");
    const turn = await TurnService.begin(id, "audit-history", "current-question", "new-turn");
    const history = await getHistoryBeforeInput(id, "current-question");
    expect(history.at(-1)?.content).toBe("message-203");
    expect(history.some((message) => message.content === "current-question")).toBe(false);
    expect(await ConversationService.getMessages(id)).toHaveLength(205);
    await TurnService.complete(turn.turn.id, "audit-history", {
      id: crypto.randomUUID(), role: "assistant", content: "current-answer", createdAt: new Date().toISOString(),
    });
    expect((await ConversationService.get(id))?.messageCount).toBe(206);
    expect((await ConversationService.list("audit-history")).find((item) => item.id === id)?.messageCount).toBe(206);
  });
});
