/** 验证 worker/test_worker_readiness 对应模块的行为与边界条件 */

import { describe, expect, it } from "vitest";
import { workerConfigurationResponse } from "../../src/worker-readiness.js";

const configured = {
  MEMORY_ENABLED: "true", MEMORY_GATEWAY: {}, CLOUDFLARE_MEMORY_SECRET: "gateway",
  AGENT_API_SECRET: "agent", OPENAI_API_KEY: "model",
  CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.example/v1",
};

describe("Worker bootstrap probes", () => {
  it.each(["/v1/health", "/v1/health/live"])("keeps %s public with missing dependencies", (path) => {
    expect(workerConfigurationResponse(new Request("https://worker.example" + path), {})?.status).toBe(200);
  });
  it.each(["/v1/health/ready"])("reports missing dependencies at %s", async (path) => {
    const response = workerConfigurationResponse(new Request("https://worker.example" + path), {});
    expect(response?.status).toBe(503);
    expect((await response?.json())?.ready).toBe(false);
    expect(workerConfigurationResponse(new Request("https://worker.example" + path), configured)?.status).toBe(200);
  });
  it("does not serve the removed unversioned health route", () => {
    expect(workerConfigurationResponse(new Request("https://worker.example/health"), configured)).toBeUndefined();
  });
  it.each(["MEMORY_GATEWAY", "CLOUDFLARE_MEMORY_SECRET", "OPENAI_API_KEY", "CLOUDFLARE_AI_GATEWAY_URL", "AGENT_API_SECRET"])("requires %s before serving business requests", (key) => {
    expect(workerConfigurationResponse(new Request("https://worker.example/v1/capabilities"), { ...configured, [key]: undefined })?.status).toBe(503);
  });
  it("requires durable mode and OpenAI-compatible credentials instead of Anthropic-only credentials", () => {
    expect(workerConfigurationResponse(new Request("https://worker.example/v1/capabilities"), { ...configured, MEMORY_ENABLED: "false" })?.status).toBe(503);
    expect(workerConfigurationResponse(new Request("https://worker.example/v1/capabilities"), { ...configured, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: "anthropic" })?.status).toBe(503);
    expect(workerConfigurationResponse(new Request("https://worker.example/v1/capabilities"), configured)).toBeUndefined();
  });
});
