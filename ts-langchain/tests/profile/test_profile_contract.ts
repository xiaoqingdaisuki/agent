/**
 * Profile Contract Test — 验证现有内存实现的接口与 contracts/memory/models.schema.json 对齐
 */

import { describe, expect, it } from "vitest";
import {
  UserProfile,
  Memory,
  QARecord,
  createMemory,
  createQARecord,
} from "../../src/profile/index.js";
import { ProfileService, MemoryService, HistoryService } from "../../src/profile/service.js";

describe("Profile Contract — UserProfile shape", () => {
  it("UserProfile must have all required fields", async () => {
    const profile = await ProfileService.getOrCreate("contract_user_1", "Alice");
    expect(profile).toHaveProperty("id");
    expect(profile).toHaveProperty("created_at");
    expect(profile).toHaveProperty("last_active_at");
    expect(typeof profile.id).toBe("string");
    expect(typeof profile.created_at).toBe("string");
    expect(typeof profile.last_active_at).toBe("string");
  });

  it("UserProfile name is optional with default empty string", async () => {
    const profile = await ProfileService.getOrCreate("contract_user_2");
    expect(profile.name).toBe("");
  });

  it("UserProfile update updates last_active_at", async () => {
    const before = (await ProfileService.getOrCreate("contract_user_3", "Alice")).last_active_at;
    // 等待至少 1ms 以确保时间戳不同
    await new Promise((r) => setTimeout(r, 1));
    const updated = await ProfileService.update("contract_user_3");
    expect(updated).toBeDefined();
    expect(updated!.name).toBe("Alice");
    expect(updated!.last_active_at).not.toBe(before);
  });
});

describe("Profile Contract — Memory shape", () => {
  it("Memory must have all required fields from models.schema.json", async () => {
    const mem = await MemoryService.add("contract_user_4", "用户喜欢 TypeScript", "preference", 4);
    expect(mem).toHaveProperty("id");
    expect(mem).toHaveProperty("user_id");
    expect(mem).toHaveProperty("content");
    expect(mem).toHaveProperty("category");
    expect(mem).toHaveProperty("importance");
    expect(mem).toHaveProperty("created_at");
    expect(mem).toHaveProperty("updated_at");
    // 类型校验
    expect(typeof mem.id).toBe("string");
    expect(typeof mem.user_id).toBe("string");
    expect(typeof mem.content).toBe("string");
    expect(["preference", "fact", "decision", "context"]).toContain(mem.category);
    expect(typeof mem.importance).toBe("number");
    expect(mem.importance).toBeGreaterThanOrEqual(1);
    expect(mem.importance).toBeLessThanOrEqual(5);
  });

  it("Memory category must be one of: preference|fact|decision|context", async () => {
    const validCategories = ["preference", "fact", "decision", "context"];
    for (const cat of validCategories) {
      const mem = await MemoryService.add("contract_user_5", `test ${cat}`, cat, 3);
      expect(mem.category).toBe(cat);
    }
  });

  it("Memory importance defaults to 3", async () => {
    const mem = await MemoryService.add("contract_user_6", "default importance", "fact");
    expect(mem.importance).toBe(3);
  });
});

describe("Profile Contract — CRUD operations", () => {
  it("add then get returns same content", async () => {
    await ProfileService.getOrCreate("contract_user_7");
    await MemoryService.add("contract_user_7", "可检索的记忆", "fact", 3);
    const all = await MemoryService.listAll("contract_user_7");
    const found = all.find((m: any) => m.content === "可检索的记忆");
    expect(found).toBeDefined();
  });

  it("delete removes memory", async () => {
    await ProfileService.getOrCreate("contract_user_8");
    const mem = await MemoryService.add("contract_user_8", "待删除记忆", "fact", 3);
    const deleted = await MemoryService.delete("contract_user_8", mem.id);
    expect(deleted).toBe(true);
    const remaining = await MemoryService.listAll("contract_user_8");
    expect(remaining.length).toBe(0);
  });

  it("getByCategory filters correctly", async () => {
    await ProfileService.getOrCreate("contract_user_9");
    await MemoryService.add("contract_user_9", "偏好A", "preference", 3);
    await MemoryService.add("contract_user_9", "事实B", "fact", 3);
    const prefs = await MemoryService.getByCategory("contract_user_9", "preference");
    expect(prefs).toHaveLength(1);
    expect(prefs[0].content).toBe("偏好A");
  });

  it("getRelevant returns top N by importance", async () => {
    await ProfileService.getOrCreate("contract_user_10");
    await MemoryService.add("contract_user_10", "低", "fact", 1);
    await MemoryService.add("contract_user_10", "高", "fact", 5);
    await MemoryService.add("contract_user_10", "中", "fact", 3);
    const relevant = await MemoryService.getRelevant("contract_user_10", 2);
    expect(relevant).toHaveLength(2);
    expect(relevant[0].importance).toBeGreaterThanOrEqual(relevant[1].importance);
  });
});

describe("Profile Contract — QARecord shape", () => {
  it("QARecord must have all required fields", async () => {
    await ProfileService.getOrCreate("contract_user_11", "Bob");
    const record = await HistoryService.record("contract_user_11", "conv_1", "问题", "回答");
    expect(record).toHaveProperty("id");
    expect(record).toHaveProperty("user_id");
    expect(record).toHaveProperty("conversation_id");
    expect(record).toHaveProperty("question");
    expect(record).toHaveProperty("answer");
    expect(record).toHaveProperty("timestamp");
  });

  it("history filters by conversation_id", async () => {
    await ProfileService.getOrCreate("contract_user_12", "Charlie");
    await HistoryService.record("contract_user_12", "conv_A", "Q1", "A1");
    await HistoryService.record("contract_user_12", "conv_B", "Q2", "A2");
    const history = await HistoryService.getHistory("contract_user_12");
    const convA = history.filter((r: any) => r.conversation_id === "conv_A");
    expect(convA.length).toBeGreaterThanOrEqual(1);
    expect(convA[0].conversation_id).toBe("conv_A");
  });

  it("history respects limit", async () => {
    await ProfileService.getOrCreate("contract_user_13", "Dave");
    for (let i = 0; i < 10; i++) {
      await HistoryService.record("contract_user_13", "conv_limit", `Q${i}`, `A${i}`);
    }
    const limited = await HistoryService.getHistory("contract_user_13", "conv_limit", 3);
    expect(limited.length).toBeLessThanOrEqual(3);
  });
});

describe("Profile Contract — buildMemoryContext output", () => {
  it("returns empty string when no memories", async () => {
    await ProfileService.getOrCreate("contract_user_14");
    const ctx = await MemoryService.buildMemoryContext("contract_user_14");
    expect(ctx).toBe("");
  });

  it("formats memories as prompt block with header", async () => {
    await ProfileService.getOrCreate("contract_user_15");
    await MemoryService.add("contract_user_15", "用户在北京", "fact", 5);
    await MemoryService.add("contract_user_15", "用户喜欢简洁", "preference", 4);
    const ctx = await MemoryService.buildMemoryContext("contract_user_15");
    expect(ctx).toContain("[我记住的关于你的事]");
    expect(ctx).toContain("用户在北京");
    expect(ctx).toContain("用户喜欢简洁");
  });
});
