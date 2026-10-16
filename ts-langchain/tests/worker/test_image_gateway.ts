import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/api/index.js";
import { config } from "../../src/config/index.js";
import { runWithRequestRuntime } from "../../src/runtime.js";

describe("Workers AI image models through AI Gateway", () => {
  const original = { ...config };
  afterEach(() => {
    Object.assign(config, original);
    vi.unstubAllGlobals();
  });

  it("sends JSON and preserves the binary PNG response with its correct media type", async () => {
    config.IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
    config.IMAGE_BASE_URL = "https://gateway.ai.cloudflare.com/v1/account/default/workers-ai";
    config.IMAGE_API_KEY = "image-secret";
    config.CLOUDFLARE_AI_GATEWAY_TOKEN = "gateway-secret";
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const upstream = vi.fn(async () => new Response(bytes, { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", upstream);
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "POST", url: "/v1/images/generations",
        headers: { authorization: "Bearer test-agent-secret" }, payload: { prompt: "Blue mountain" } });
      expect(response.statusCode).toBe(200);
      expect(response.json().image_data_url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
      expect(upstream).toHaveBeenCalledWith(`${config.IMAGE_BASE_URL}/${config.IMAGE_MODEL}`, expect.objectContaining({
        headers: expect.objectContaining({ "Content-Type": "application/json", Authorization: "Bearer image-secret", "cf-aig-authorization": "Bearer gateway-secret" }),
        body: JSON.stringify({ prompt: "Blue mountain", width: 1024, height: 768, num_steps: 4 }),
      }));
    } finally { await app.close(); }
  });

  it("sends FLUX.2 dev multipart fields and decodes its Base64 JSON result", async () => {
    config.IMAGE_MODEL = "@cf/black-forest-labs/flux-2-dev";
    config.IMAGE_BASE_URL = "https://gateway.ai.cloudflare.com/v1/account/default/workers-ai";
    config.IMAGE_API_KEY = "image-secret";
    const upstream = vi.fn(async () => Response.json({ result: { image: "/9j/test" } }));
    vi.stubGlobal("fetch", upstream);
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "POST", url: "/v1/images/generations",
        headers: { authorization: "Bearer test-agent-secret" }, payload: { prompt: "Blue mountain" } });
      expect(response.statusCode).toBe(200);
      expect(response.json().image_data_url).toBe("data:image/jpeg;base64,/9j/test");
      const init = (upstream.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get("prompt")).toBe("Blue mountain");
      expect((init.body as FormData).get("width")).toBe("1024");
      expect(new Headers(init.headers).has("Content-Type")).toBe(false);
    } finally { await app.close(); }
  });

  it("uses the Worker AI binding without external API credentials", async () => {
    config.IMAGE_MODEL = "@cf/black-forest-labs/flux-2-dev";
    config.IMAGE_API_KEY = undefined;
    const binding = vi.fn(async () => Response.json({ result: { image: "/9j/binding" } }));
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const app = await buildApp();
    try {
      const response = await runWithRequestRuntime({ waitUntil: () => undefined, generateImage: binding }, async () =>
        await app.inject({ method: "POST", url: "/v1/images/generations", headers: { authorization: "Bearer test-agent-secret" }, payload: { prompt: "Blue mountain" } }));
      expect(response.statusCode).toBe(200);
      expect(response.json().image_data_url).toBe("data:image/jpeg;base64,/9j/binding");
      expect(binding).toHaveBeenCalledWith(config.IMAGE_MODEL, expect.any(FormData));
      expect(upstream).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("reports the daily quota limit without retrying billable inference", async () => {
    config.IMAGE_API_KEY = "image-secret";
    const binding = vi.fn(async () => { throw new Error("4006: you have used up your daily free allocation"); });
    const app = await buildApp();
    try {
      const response = await runWithRequestRuntime({ waitUntil: () => undefined, generateImage: binding }, async () =>
        await app.inject({ method: "POST", url: "/v1/images/generations", headers: { authorization: "Bearer test-agent-secret" }, payload: { prompt: "Blue mountain" } }));
      expect(response.statusCode).toBe(429);
      expect(response.json().code).toBe("WORKERS_AI_QUOTA_EXHAUSTED");
      expect(binding).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});
