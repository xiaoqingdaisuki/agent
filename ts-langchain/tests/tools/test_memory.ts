import { describe, it, expect } from "vitest";
import {
  memorySessionSearchTool,
  sessionMemoryDescriptor,
} from "../../src/tools/memory-session.js";
import {
  memoryUserSearchTool,
  memoryUserSaveTool,
  userMemorySearchDescriptor,
  userMemorySaveDescriptor,
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
