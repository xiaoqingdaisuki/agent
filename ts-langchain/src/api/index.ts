import fastify from "fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import { registerV1Routes } from "./routes/v1/index.js";
import { registerImageRoutes } from "./routes/images.js";
import { registerErrorMiddleware } from "./middleware/error.js";
import { registerAgentAuthMiddleware } from "./middleware/auth.js";
import { config } from "../config/index.js";

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

  await app.register(cors, {
    origin: config.CORS_ORIGIN.length > 0 ? config.CORS_ORIGIN : false,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(multipart, {
    limits: { files: 6, fileSize: 10 * 1024 * 1024 },
  });
  registerAgentAuthMiddleware(app);

  // External API v1（前端 UI 使用）— 带 /v1 前缀
  await app.register(
    async (fastify) => {
      await registerV1Routes(fastify);
      await registerImageRoutes(fastify);
    },
    { prefix: "/v1" },
  );

  registerErrorMiddleware(app);

  return app;
}
