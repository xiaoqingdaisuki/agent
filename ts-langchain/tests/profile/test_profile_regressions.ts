/** 验证 profile/test_profile_regressions 对应模块的行为与边界条件 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config/index.js";
import { inMemoryRepositories } from "../../src/repositories/index.js";
import { HistoryService, MemoryService } from "../../src/profile/service.js";
import type { Memory } from "../../src/profile/index.js";

const previousMemoryEnabled = config.MEMORY_ENABLED;

beforeEach(() => {
  config.MEMORY_ENABLED = false;
});

afterEach(() => {
  config.MEMORY_ENABLED = previousMemoryEnabled;
});

describe("Memory extraction semantics", () => {
  it.each([
    ["我讨厌香菜。", "用户讨厌: 香菜"],
    ["不要添加香菜。", "用户要求不要: 添加香菜"],
    ["别使用表情。", "用户要求不要: 使用表情"],
    ["我喜欢简洁回答。", "用户喜欢/偏好: 简洁回答"],
    ["简洁回答是我喜欢的", "用户喜欢/偏好: 简洁回答"],
  ])("preserves the meaning of %s", (question, expected) => {
    const extractor = MemoryService as unknown as {
      _extractWithRegex(userId: string, question: string): Memory[];
    };
    const memories = extractor._extractWithRegex("extraction-audit", question);
    expect(memories.map((memory) => memory.content)).toEqual([expected]);
    expect(memories[0].category).toBe("preference");
  });

  it("keeps adjacent positive and negative clauses separate", () => {
    const extractor = MemoryService as unknown as {
      _extractWithRegex(userId: string, question: string): Memory[];
    };
    expect(extractor._extractWithRegex("extraction-audit", "我讨厌香菜。简洁回答是我喜欢的")
      .map((memory) => memory.content)).toEqual([
        "用户讨厌: 香菜", "用户喜欢/偏好: 简洁回答",
      ]);
  });
});

describe("History over multiple message pages", () => {
  it("allocates unique sequences, returns the latest records and deduplicates a retry", async () => {
    const userId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    let latest;
    for (let index = 0; index < 105; index++) {
      latest = await HistoryService.record(userId, conversationId, `Q${index}`, `A${index}`);
    }
    const page = await inMemoryRepositories.message.getMessages(conversationId, 300);
    expect(page.total).toBe(210);
    expect(page.messages.map((message) => message.sequence_no)).toEqual(
      Array.from({ length: 210 }, (_, index) => index),
    );
    expect(await HistoryService.getHistory(userId, conversationId, 1)).toEqual([latest]);
    expect(await HistoryService.getHistory(userId, conversationId, 105)).toHaveLength(105);
    expect(await HistoryService.record(userId, conversationId, "Q104", "A104")).toEqual(latest);
    expect((await inMemoryRepositories.message.getMessages(conversationId)).total).toBe(210);
  });

  it("pairs a user and assistant across a page of tool messages", async () => {
    const userId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const record = await HistoryService.record(userId, conversationId, "question", "answer");
    await inMemoryRepositories.message.createBatch(conversationId, userId,
      Array.from({ length: 199 }, () => ({
        id: crypto.randomUUID(), conversation_id: conversationId, user_id: userId,
        role: "tool" as const, content_json: "tool output", created_at: record.timestamp,
      })),
    );
    expect(await HistoryService.getHistory(userId, conversationId, 1)).toEqual([record]);
  });
});
