import fastify from "fastify";
import multipart from "@fastify/multipart";
import { registerV1Routes } from "./routes/v1/index.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerStreamRoutes } from "./routes/stream.js";
import { registerToolRoutes } from "./routes/tools.js";
import { registerImageRoutes } from "./routes/images.js";
import { registerErrorMiddleware } from "./middleware/error.js";
import { registerAgentAuthMiddleware } from "./middleware/auth.js";
import { config } from "../config/index.js";
import { getReadiness } from "./health.js";

// 构建并配置 Fastify 应用实例，注册所有路由和中间件
export async function buildApp() {
  const app = fastify({
    logger: { level: "info" },
    // 外层服务超时长于 Agent deadline，确保业务层先返回明确的 504。
    requestTimeout: config.SERVER_REQUEST_TIMEOUT_MS,
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
  registerAgentAuthMiddleware(app);

  // External API v1（前端 UI 使用）— 带 /api/v1 前缀
  await app.register(
    async (fastify) => {
      await registerV1Routes(fastify);
    },
    { prefix: "/api/v1" },
  );

  // 旧路由（保留兼容，后续迁移）
  app.get("/health", async () => ({ status: "ok", version: "0.2.0" }));
  app.get("/health/live", async () => ({ status: "ok", live: true, version: "0.2.0" }));
  app.get("/health/ready", async (_request, reply) => {
    const readiness = getReadiness();
    return reply.status(readiness.ready ? 200 : 503).send(readiness);
  });
  await registerChatRoutes(app);
  await registerStreamRoutes(app);
  await registerToolRoutes(app);
  await registerImageRoutes(app);

  registerErrorMiddleware(app);

  return app;
}
