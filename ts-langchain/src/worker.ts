/** 通过 Cloudflare Node HTTP 适配层承载 Agent API 及请求绑定 */

/// <reference types="@cloudflare/workers-types" />
import { httpServerHandler } from "cloudflare:node";
import { installWorkerRouterCompatibility } from "./worker-router.js";
import { workerConfigurationResponse } from "./worker-readiness.js";
import { runWithRequestRuntime } from "./runtime.js";

interface WorkerEnv {
  MEMORY_GATEWAY: Fetcher;
  AI: {
    // 声明 Workers AI 模型调用绑定
    run(model: string, input: unknown): Promise<unknown>;
  };
  [key: string]: unknown;
}

let handler: Promise<ExportedHandler> | undefined;

// 仅初始化一次 Fastify，并通过官方 Node HTTP 适配层保留全部 API 和流式行为
async function initialize(env: WorkerEnv): Promise<ExportedHandler> {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") process.env[key] = value;
  }
  process.env.AGENT_RUNTIME = "workers";
  const { config } = await import("./config/index.js");
  if (!config.MEMORY_ENABLED || !config.AGENT_API_SECRET || !config.CLOUDFLARE_MEMORY_SECRET) {
    throw new Error("Worker requires durable storage and both Agent/Gateway authentication secrets");
  }
  if (!config.CLOUDFLARE_AI_GATEWAY_URL || !config.OPENAI_API_KEY) {
    throw new Error("Worker requires Cloudflare AI Gateway URL and model API credentials");
  }
  installWorkerRouterCompatibility();
  const { buildApp } = await import("./api/index.js");
  const { retainBackgroundTask } = await import("./runtime.js");
  const { flushAuditLogs } = await import("./tools/runtime/executor.js");
  const { flushToolMetrics } = await import("./tools/observability.js");
  const app = await buildApp();
  // 响应完成后将审计日志及工具指标纳入后台生命周期
  app.addHook("onResponse", async () => {
    retainBackgroundTask(Promise.allSettled([flushAuditLogs(), flushToolMetrics()]));
  });
  await app.ready();
  app.server.listen(6001);
  return httpServerHandler({ port: 6001 });
}

export default {
  // 为每个请求绑定私有网关与后台任务生命周期，初始化失败时允许下次重试
  async fetch(request, env, ctx) {
    const configurationResponse = workerConfigurationResponse(request, env);
    if (configurationResponse) return configurationResponse;
    return runWithRequestRuntime({
      // 将后台任务交给 Worker 请求上下文保活
      waitUntil: (task) => ctx.waitUntil(task),
      gatewayFetch: env.MEMORY_GATEWAY
        // 通过私有服务绑定调用记忆网关
        ? (input, init) => env.MEMORY_GATEWAY.fetch(input, init) as unknown as Promise<Response>
        : undefined,
      // 生图使用官方 AI 绑定，避免 AI Gateway 尚不支持 multipart 流的限制
      generateImage: env.AI ? async (model, input) => {
        const encoded = input instanceof FormData ? new Response(input) : undefined;
        const result = await env.AI.run(model, encoded
          ? { multipart: { body: encoded.body, contentType: encoded.headers.get("content-type") } }
          : input);
        if (result instanceof Response) return result;
        if (result instanceof ReadableStream) return new Response(result, { headers: { "Content-Type": "image/png" } });
        return Response.json({ result });
      } : undefined,
    // 在请求运行时上下文中复用应用初始化并转发请求
    }, async () => {
      // 初始化失败时清空缓存以允许后续请求重试
      handler ??= initialize(env).catch((error) => {
        handler = undefined;
        throw error;
      });
      const server = await handler;
      return server.fetch!(request, env, ctx);
    });
  },
} satisfies ExportedHandler<WorkerEnv>;
