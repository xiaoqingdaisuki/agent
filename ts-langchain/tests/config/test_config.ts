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

  it("将字符串 false 解析为关闭记忆模式", async () => {
    vi.stubEnv("MEMORY_ENABLED", "false");
    vi.resetModules();

    const { config } = await import("../../src/config/index.js");

    expect(config.MEMORY_ENABLED).toBe(false);
  });

  it("默认限制单次模型输出 token，避免普通请求无限扩写", async () => {
    vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "2048");
    vi.resetModules();

    const { config } = await import("../../src/config/index.js");

    expect(config.LLM_MAX_OUTPUT_TOKENS).toBe(2048);
  });

  it("将模型输出硬上限限制为 8192", async () => {
    vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "8192");
    vi.resetModules();

    const { config } = await import("../../src/config/index.js");

    expect(config.LLM_MAX_OUTPUT_TOKENS).toBe(8192);
  });
});
