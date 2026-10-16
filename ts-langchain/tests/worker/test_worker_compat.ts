import { describe, expect, it, vi } from "vitest";
import { AIMessage, ChatMessageChunk } from "@langchain/core/messages";
import "../../src/worker-router.js";
import { buildApp } from "../../src/api/index.js";
import { createReActPolicyMiddleware } from "../../src/agents/tool-agent.js";
import { runWithRequestRuntime, fetchMemoryGateway, retainBackgroundTask } from "../../src/runtime.js";
import { getModelConfiguration } from "../../src/config/model.js";
import { config } from "../../src/config/index.js";

describe("Worker runtime compatibility", () => {
  it("registers and matches real API routes with string code generation disabled", async () => {
    const original = globalThis.Function;
    globalThis.Function = new Proxy(original, { construct() { throw new Error("eval forbidden"); } });
    let app;
    try {
      app = await buildApp();
      await app.ready();
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/conversations/missing/messages", headers: {
        authorization: "Bearer test-agent-secret", "x-agent-user-id": "worker-router-user",
      } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/tools" })).statusCode).toBe(401);
    } finally {
      globalThis.Function = original;
      await app?.close();
    }
  });

  it("converts role-less provider stream chunks into recognized AI messages", async () => {
    const middleware = createReActPolicyMiddleware();
    const response = await middleware.wrapModelCall!({ tools: [] } as any, async () =>
      new ChatMessageChunk({ role: "", content: "模型正文" }) as any);
    expect(AIMessage.isInstance(response)).toBe(true);
    expect((response as AIMessage).content).toBe("模型正文");
  });

  it("keeps simultaneous requests on their own service bindings and lifecycles", async () => {
    const left = vi.fn(async () => new Response("left"));
    const right = vi.fn(async () => new Response("right"));
    const retained = vi.fn();
    const values = await Promise.all([left, right].map((gatewayFetch) =>
      runWithRequestRuntime({ gatewayFetch, waitUntil: retained }, async () => {
        await Promise.resolve();
        retainBackgroundTask(Promise.resolve());
        return (await fetchMemoryGateway("https://gateway.internal/test", {})).text();
      })));
    expect(values).toEqual(["left", "right"]);
    expect(retained).toHaveBeenCalledTimes(2);
  });

  it("routes model requests through AI Gateway while retaining provider authentication", () => {
    const before = { ...config };
    try {
      config.CLOUDFLARE_AI_GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/account/gateway/custom-dots/v1";
      config.CLOUDFLARE_AI_GATEWAY_TOKEN = "gateway-secret";
      config.OPENAI_API_KEY = "provider-secret";
      expect(getModelConfiguration()).toEqual({
        baseURL: config.CLOUDFLARE_AI_GATEWAY_URL,
        apiKey: "provider-secret",
        defaultHeaders: { "cf-aig-authorization": "Bearer gateway-secret" },
      });
    } finally {
      Object.assign(config, before);
    }
  });
});
