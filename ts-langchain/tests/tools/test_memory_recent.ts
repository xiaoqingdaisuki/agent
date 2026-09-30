import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/repositories/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/index.js")>();
  return { ...actual, getRepositories: () => actual.inMemoryRepositories };
});

import { inMemoryRepositories } from "../../src/repositories/index.js";
import { memorySessionSearchTool } from "../../src/tools/memory-session.js";

describe("recent session memory with real in-memory repositories", () => {
  it("reads the latest messages in chronological order beyond the first page", async () => {
    const conversationId = "recent-session-audit";
    await inMemoryRepositories.message.createBatch(conversationId, "audit-user", Array.from({ length: 40 }, (_, index) => ({
      id: `${conversationId}-${index}`, conversation_id: conversationId, user_id: "audit-user",
      role: "user" as const, content_json: `message-${String(index + 1).padStart(2, "0")}`,
      created_at: "2026-09-30T00:00:00Z",
    })));
    const result = await memorySessionSearchTool.invoke({ conversation_id: conversationId, max_results: 5 });
    expect(result).toContain("message-36");
    expect(result).toContain("message-40");
    expect(result).not.toContain("message-21");
    expect(result.indexOf("message-36")).toBeLessThan(result.indexOf("message-40"));
    const filtered = await memorySessionSearchTool.invoke({ conversation_id: conversationId, query: "message-40", max_results: 5 });
    expect(filtered).toContain("message-40");
  });
});
