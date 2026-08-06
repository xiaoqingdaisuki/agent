/**
 * Tool Metrics Routes — 工具调用性能指标
 *
 * POST   /internal/v1/tool-metrics         — 批量写入指标
 * GET    /internal/v1/tool-metrics         — 查询指标（需认证）
 * GET    /internal/v1/tool-metrics/snapshot — 获取指标快照
 */

import { createToolMetrics, getToolMetrics, getToolMetricsSnapshot } from "../repositories/tool-metrics.js";

export function registerToolMetricsRoutes(app: any) {
  // 批量写入指标
  app.post("/internal/v1/tool-metrics", async (c: any) => {
    try {
      const body = await c.req.json();
      const entries = body.entries as Array<{
        tool_name: string;
        tool_version: string;
        ok: boolean;
        error_code?: string;
        duration_ms: number;
        risk_level: string;
        user_id: string;
        tenant_id: string;
      }>;

      if (!Array.isArray(entries) || entries.length === 0) {
        return c.json(
          { ok: false, data: null, error: { code: "METRICS_BAD_REQUEST", message: "entries array is required" }, meta: { request_id: c.get("requestId") } },
          400,
        );
      }

      await createToolMetrics(c.env.DB, entries);

      return c.json({
        ok: true,
        data: { count: entries.length },
        error: null,
        meta: { request_id: c.get("requestId") },
      });
    } catch (err: any) {
      console.error("Tool metrics write failed:", err);
      return c.json(
        { ok: false, data: null, error: { code: "METRICS_WRITE_FAILED", message: err.message || "Write failed" }, meta: { request_id: c.get("requestId") } },
        500,
      );
    }
  });

  // 查询指标
  app.get("/internal/v1/tool-metrics", async (c: any) => {
    try {
      const toolName = c.req.query("tool_name") || undefined;
      const limit = Math.min(parseInt((c.req.query("limit") as string) || "100", 10), 500);
      const offset = parseInt((c.req.query("offset") as string) || "0", 10);

      const result = await getToolMetrics(c.env.DB, toolName, limit, offset);

      return c.json({
        ok: true,
        data: result,
        error: null,
        meta: { request_id: c.get("requestId") },
      });
    } catch (err: any) {
      console.error("Tool metrics query failed:", err);
      return c.json(
        { ok: false, data: null, error: { code: "METRICS_QUERY_FAILED", message: err.message || "Query failed" }, meta: { request_id: c.get("requestId") } },
        500,
      );
    }
  });

  // 指标快照
  app.get("/internal/v1/tool-metrics/snapshot", async (c: any) => {
    try {
      const sinceHours = parseInt((c.req.query("since_hours") as string) || "24", 10);
      const snapshot = await getToolMetricsSnapshot(c.env.DB, sinceHours);

      return c.json({
        ok: true,
        data: snapshot,
        error: null,
        meta: { request_id: c.get("requestId") },
      });
    } catch (err: any) {
      console.error("Tool metrics snapshot failed:", err);
      return c.json(
        { ok: false, data: null, error: { code: "METRICS_SNAPSHOT_FAILED", message: err.message || "Snapshot failed" }, meta: { request_id: c.get("requestId") } },
        500,
      );
    }
  });
}
