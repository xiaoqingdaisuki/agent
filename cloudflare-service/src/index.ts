/**
 * Cloudflare Memory Gateway — 入口
 *
 * 使用 Hono 框架，部署到 Cloudflare Workers
 * 绑定：DB (D1), MEMORY_INDEX (Vectorize), AI (Workers AI)
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { errorHandler } from "./middleware/error.js";
import { requestLogMiddleware } from "./middleware/security.js";
import { authMiddleware, isPublicPath } from "./middleware/auth.js";
import { healthRoute } from "./routes/health.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerConversationRoutes } from "./routes/conversation.js";
import { registerMessageRoutes } from "./routes/message.js";
import { registerTurnRoutes } from "./routes/turn.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerDocumentRoutes } from "./routes/document.js";
import { registerCheckpointRoutes } from "./routes/checkpoint.js";
import { registerAuditLogRoutes } from "./routes/audit-log.js";
import { registerToolMetricsRoutes } from "./routes/tool-metrics.js";
import { registerOpenApiRoute } from "./routes/openapi.js";

// 扩展 Hono Context 类型
type GatewayVariables = {
  authenticated: boolean;
  requestId: string;
  requestTimestamp?: string;
};

type GatewayEnv = {
  DB: D1Database;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  SERVICE_SECRET: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: string;
  MAX_MEMORIES_PER_USER: string;
  INDEX_JOB_BATCH_SIZE: string;
  INDEX_JOB_MAX_RETRIES: string;
  TURN_STALE_SECONDS?: string;
};

type GatewayContext = any; // 简化类型，避免 Hono 泛型复杂性

// 创建 Hono 应用
const app = new Hono<GatewayContext>();

// 全局中间件
app.use("*", async (c, next) => {
  c.set("authenticated", false);
  c.set("requestId", `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  await next();
});

app.use("*", requestLogMiddleware);

// CORS
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Request-Id", "X-Request-Timestamp", "Idempotency-Key"],
  maxAge: 86400,
}));

// 错误处理
app.onError(errorHandler);

// 认证中间件
app.use("*", async (c, next) => {
  const path = c.req.path;
  if (isPublicPath(path)) {
    await next();
    return;
  }
  return await authMiddleware(c, next);
});

// 注册路由
healthRoute(app);
registerProfileRoutes(app);
registerConversationRoutes(app);
registerMessageRoutes(app);
registerTurnRoutes(app);
registerMemoryRoutes(app);
registerDocumentRoutes(app);
registerCheckpointRoutes(app);
registerAuditLogRoutes(app);
registerToolMetricsRoutes(app);
registerOpenApiRoute(app);

// 根路径
app.get("/", (c) => c.text("Cloudflare Service"));

// 导出
export default app;

// 定时任务入口
export async function scheduled(event: ScheduledEvent, env: GatewayEnv) {
  const { processPendingJobs, retryFailedJobs } = await import("./services/index-job.js");
  const { failStaleTurns } = await import("./repositories/turn.js");

  try {
    const staleSeconds = Math.max(60, Number(env.TURN_STALE_SECONDS || 900));
    const staleBefore = new Date(Date.now() - staleSeconds * 1_000).toISOString();
    const recovered = await failStaleTurns(env.DB, staleBefore);
    if (recovered > 0) console.warn(`[Cron] Marked ${recovered} stale Turns as failed`);
  } catch (err) {
    console.error("[Cron] Turn recovery failed:", err);
  }

  try {
    const pending = await processPendingJobs(env.DB, env.MEMORY_INDEX, env.AI);
    console.log(`[Cron] Processed ${pending.processed} pending, ${pending.failed} failed`);
  } catch (err) {
    console.error("[Cron] Index job processing failed:", err);
  }

  try {
    const retried = await retryFailedJobs(env.DB, env.MEMORY_INDEX, env.AI);
    console.log(`[Cron] Retried ${retried.processed} failed, ${retried.failed} still failed`);
  } catch (err) {
    console.error("[Cron] Retry failed:", err);
  }
}
