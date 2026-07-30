import fastify from "fastify";
import multipart from "@fastify/multipart";
import { registerV1Routes } from "./routes/v1/index.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerStreamRoutes } from "./routes/stream.js";
import { registerToolRoutes } from "./routes/tools.js";
import { registerImageRoutes } from "./routes/images.js";
import { registerErrorMiddleware } from "./middleware/error.js";
import { config } from "../config/index.js";

export async function buildApp() {
  const app = fastify({
    logger: { level: "info" },
    // 全局请求超时：普通请求 60s，流式请求禁用（由路由层控制）
    requestTimeout: 60_000,
    // 连接超时
    connectionTimeout: 30_000,
    // 保持超时
    keepAliveTimeout: 5_000,
  });

  await app.register(import("@fastify/cors"), {
    origin: config.CORS_ORIGIN.length > 0 ? config.CORS_ORIGIN : false,
  });
  await app.register(multipart, {
    limits: { files: 1, fileSize: 10 * 1024 * 1024 },
  });

  // External API v1（前端 UI 使用）— 带 /api/v1 前缀
  await app.register(async (fastify) => {
    await registerV1Routes(fastify);
  }, { prefix: "/api/v1" });

  // 旧路由（保留兼容，后续迁移）
  app.get("/health", async () => ({ status: "ok", version: "0.2.0" }));
  await registerChatRoutes(app);
  await registerStreamRoutes(app);
  await registerToolRoutes(app);
  await registerImageRoutes(app);

  registerErrorMiddleware(app);

  return app;
}
