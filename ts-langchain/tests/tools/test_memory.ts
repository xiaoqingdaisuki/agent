import { describe, it, expect } from "vitest";
import {
  memorySessionSearchTool,
  sessionMemoryDescriptor,
  sessionStore,
} from "../../src/tools/memory-session.js";
import {
  memoryUserSearchTool,
  memoryUserSaveTool,
  userMemorySearchDescriptor,
  userMemorySaveDescriptor,
  userMemoryStore,
} from "../../src/tools/memory-user.js";

describe("Memory Tools", () => {
  describe("memory.session.search", () => {
    it("has correct descriptor name", () => {
      expect(sessionMemoryDescriptor.name).toBe("memory.session.search");
    });

    it("has MEMORY category", () => {
      expect(sessionMemoryDescriptor.category).toBe("MEMORY");
    });

    it("has R1 risk level", () => {
      expect(sessionMemoryDescriptor.risk_level).toBe("R1");
    });

    it("requires memory.session.read permission", () => {
      expect(sessionMemoryDescriptor.required_permissions).toContain("memory.session.read");
    });

    it("returns string result", async () => {
      const result = await memorySessionSearchTool.invoke({
        conversation_id: "test-conv",
      });
      expect(typeof result).toBe("string");
    });
  });

  describe("memory.user.search", () => {
    it("has correct descriptor name", () => {
      expect(userMemorySearchDescriptor.name).toBe("memory.user.search");
    });

    it("has PII data classification", () => {
      expect(userMemorySearchDescriptor.data_classification).toContain("pii");
    });

    it("returns string result", async () => {
      const result = await memoryUserSearchTool.invoke({
        user_id: "test-user",
      });
      expect(typeof result).toBe("string");
    });
  });

  describe("memory.user.save", () => {
    it("has correct descriptor name", () => {
      expect(userMemorySaveDescriptor.name).toBe("memory.user.save");
    });

    it("has R2 risk level", () => {
      expect(userMemorySaveDescriptor.risk_level).toBe("R2");
    });

    it("has write side effect", () => {
      expect(userMemorySaveDescriptor.side_effect).toBe("write");
    });

    it("returns string result", async () => {
      const result = await memoryUserSaveTool.invoke({
        user_id: "test-user",
        content: "Likes testing",
      });
      expect(typeof result).toBe("string");
    });
  });

  describe("SessionMemoryStore", () => {
    it("adds and retrieves messages", () => {
      sessionStore.add("conv1", "user", "Hello");
      sessionStore.add("conv1", "assistant", "Hi!");
      const messages = sessionStore.get("conv1");
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe("user");
    });

    it("searches by query", () => {
      sessionStore.add("conv2", "user", "What is Python?");
      sessionStore.add("conv2", "assistant", "Python is great.");
      const results = sessionStore.search("conv2", "Python");
      expect(results.length).toBeGreaterThan(0);
    });

    it("returns empty for empty conversation", () => {
      const results = sessionStore.search("empty-conv", "test");
      expect(results.length).toBe(0);
    });
  });

  describe("UserMemoryStore", () => {
    it("adds and searches memories", () => {
      userMemoryStore.add("u1", "Likes pizza", "preference", 4);
      userMemoryStore.add("u1", "Likes coding", "preference");
      const results = userMemoryStore.search("u1", "likes");
      expect(results.length).toBe(2);
    });

    it("filters by category", () => {
      userMemoryStore.add("u2", "Fact A", "fact");
      userMemoryStore.add("u2", "Pref B", "preference");
      const facts = userMemoryStore.search("u2", "", "fact");
      expect(facts.length).toBe(1);
      expect(facts[0].category).toBe("fact");
    });

    it("deletes memories", () => {
      const mem = userMemoryStore.add("u3", "Temp info");
      expect(userMemoryStore.delete("u3", mem.id)).toBe(true);
      expect(userMemoryStore.delete("u3", mem.id)).toBe(false);
    });

    it("deduplicates on save", async () => {
      const r1 = await memoryUserSaveTool.invoke({
        user_id: "dedup-ts",
        content: "Unique memory 99999",
      });
      const r2 = await memoryUserSaveTool.invoke({
        user_id: "dedup-ts",
        content: "Unique memory 99999",
      });
      expect(r1).toContain("已保存");
      expect(r2).toContain("已存在");
    });
  });
});
