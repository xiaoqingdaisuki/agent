import { afterEach, describe, expect, it, vi } from "vitest";

describe("配置契约", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("将字符串 false 解析为关闭自动记忆提取", async () => {
    vi.stubEnv("MEMORY_AUTO_EXTRACT", "false");
    vi.resetModules();

    const { config } = await import("../../src/config/index.js");

    expect(config.MEMORY_AUTO_EXTRACT).toBe(false);
  });

  it("将字符串 true 解析为开启自动记忆提取", async () => {
    vi.stubEnv("MEMORY_AUTO_EXTRACT", "true");
    vi.resetModules();

    const { config } = await import("../../src/config/index.js");

    expect(config.MEMORY_AUTO_EXTRACT).toBe(true);
  });
});
