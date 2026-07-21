import fastify from "fastify";
import { registerV1Routes } from "./routes/v1/index.js";
import { registerInternalRoutes } from "./routes/internal/index.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerStreamRoutes } from "./routes/stream.js";
import { registerToolRoutes } from "./routes/tools.js";
import { registerErrorMiddleware } from "./middleware/error.js";

export async function buildApp() {
  const app = fastify({ logger: { level: "info" } });

  await app.register(import("@fastify/cors"), { origin: "*" });

  // External API v1（前端 UI 使用）— 带 /api/v1 前缀
  await app.register(async (fastify) => {
    await registerV1Routes(fastify);
  }, { prefix: "/api/v1" });

  // Internal API（QQ Bot 使用）— 带 /api/internal 前缀
  await app.register(async (fastify) => {
    await registerInternalRoutes(fastify);
  }, { prefix: "/api/internal" });

  // 旧路由（保留兼容，后续迁移）
  app.get("/health", async () => ({ status: "ok", version: "0.2.0" }));
  await registerChatRoutes(app);
  await registerStreamRoutes(app);
  await registerToolRoutes(app);

  registerErrorMiddleware(app);

  return app;
}
