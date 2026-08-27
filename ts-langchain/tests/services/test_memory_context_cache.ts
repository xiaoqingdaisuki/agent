import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "../../src/profile/service.js";
import { invalidateMemoryContext, loadMemoryContext } from "../../src/services/index.js";

describe("memory context cache", () => {
  it("loads new users synchronously and reloads after invalidation", async () => {
    const spy = vi.spyOn(MemoryService, "buildMemoryContext")
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const userId = "cache-isolation-user";
    invalidateMemoryContext(userId);

    expect((await loadMemoryContext(userId))[0]?.content).toContain("first");
    invalidateMemoryContext(userId);
    expect((await loadMemoryContext(userId))[0]?.content).toContain("second");
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
