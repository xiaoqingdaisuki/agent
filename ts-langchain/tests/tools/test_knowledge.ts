/** 验证 tools/test_knowledge 对应模块的行为与边界条件 */

import { describe, it, expect } from "vitest";
import { knowledgeSearchDescriptor } from "../../src/tools/knowledge.js";

describe("Knowledge Search Tool", () => {
  it("has correct descriptor name", () => {
    expect(knowledgeSearchDescriptor.name).toBe("knowledge.search");
  });

  it("has correct category", () => {
    expect(knowledgeSearchDescriptor.category).toBe("SEARCH");
  });

  it("has R1 risk level", () => {
    expect(knowledgeSearchDescriptor.risk_level).toBe("R1");
  });

  it("requires knowledge.search permission", () => {
    expect(knowledgeSearchDescriptor.required_permissions).toContain("knowledge.search");
  });

  it("has 15s timeout", () => {
    expect(knowledgeSearchDescriptor.timeout_ms).toBe(15000);
  });

  it("has rag tag", () => {
    expect(knowledgeSearchDescriptor.tags).toContain("rag");
  });
});
