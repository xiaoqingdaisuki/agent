/**
 * Health check — 报告 Gateway 及各依赖组件状态
 *
 * GET /internal/v1/health
 * 无需认证
 */

import { isPublicPath } from "../middleware/auth.js";

export async function healthRoute(app: any) {
  app.get("/internal/v1/health", async (c: any) => {
    const components: Record<string, string> = {
      gateway: "ok",
      d1: "unknown",
      vectorize: "unknown",
      ai: "unknown",
    };

    // 检查 D1
    try {
      await c.env.DB.prepare("SELECT 1").first();
      components.d1 = "ok";
    } catch {
      components.d1 = "error";
    }

    // 检查 Vectorize
    try {
      if (c.env.MEMORY_INDEX) {
        components.vectorize = "ok";
      } else {
        components.vectorize = "not_configured";
      }
    } catch {
      components.vectorize = "error";
    }

    // 检查 Workers AI
    try {
      if (c.env.AI) {
        components.ai = "ok";
      } else {
        components.ai = "not_configured";
      }
    } catch {
      components.ai = "error";
    }

    const allHealthy = Object.values(components).every((v) => v === "ok");
    return c.json({
      status: allHealthy ? "ok" : "degraded",
      components,
      timestamp: new Date().toISOString(),
    });
  });
}
