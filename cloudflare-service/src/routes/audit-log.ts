/**
 * Audit Log Routes — 工具调用审计日志
 *
 * POST   /internal/v1/audit-logs          — 批量写入审计日志
 * GET    /internal/v1/audit-logs          — 查询审计日志（需认证）
 * DELETE /internal/v1/audit-logs          — 清空审计日志
 */

import { createAuditLogs, getAuditLogs, clearAuditLogs } from "../repositories/audit-log.js";

// 创建或注册 registerAuditLogRoutes 所需的数据
export function registerAuditLogRoutes(app: any) {
  // 批量写入审计日志
  app.post("/internal/v1/audit-logs", async (c: any) => {
    try {
      const body = await c.req.json();
      const entries = body.entries as Array<{
        user_id: string;
        tenant_id: string;
        conversation_id: string;
        tool_name: string;
        tool_version: string;
        risk_level: string;
        ok: boolean;
        error_code?: string;
        duration_ms: number;
        request_id: string;
        trace_id: string;
      }>;

      if (!Array.isArray(entries) || entries.length === 0) {
        return c.json(
          { ok: false, data: null, error: { code: "AUDIT_BAD_REQUEST", message: "entries array is required" }, meta: { request_id: c.get("requestId") } },
          400,
        );
      }

      await createAuditLogs(c.env.DB, entries);

      return c.json({
        ok: true,
        data: { count: entries.length },
        error: null,
        meta: { request_id: c.get("requestId") },
      });
    } catch (err: any) {
      console.error("Audit log write failed:", err);
      return c.json(
        { ok: false, data: null, error: { code: "AUDIT_WRITE_FAILED", message: err.message || "Write failed" }, meta: { request_id: c.get("requestId") } },
        500,
      );
    }
  });

  // 查询审计日志
  app.get("/internal/v1/audit-logs", async (c: any) => {
    try {
      const userId = c.req.query("user_id");
      const limit = Math.min(parseInt((c.req.query("limit") as string) || "50", 10), 200);
      const offset = parseInt((c.req.query("offset") as string) || "0", 10);

      if (!userId) {
        return c.json(
          { ok: false, data: null, error: { code: "AUDIT_BAD_REQUEST", message: "user_id is required" }, meta: { request_id: c.get("requestId") } },
          400,
        );
      }

      const result = await getAuditLogs(c.env.DB, userId as string, limit, offset);

      return c.json({
        ok: true,
        data: result,
        error: null,
        meta: { request_id: c.get("requestId") },
      });
    } catch (err: any) {
      console.error("Audit log query failed:", err);
      return c.json(
        { ok: false, data: null, error: { code: "AUDIT_QUERY_FAILED", message: err.message || "Query failed" }, meta: { request_id: c.get("requestId") } },
        500,
      );
    }
  });

  // 清空审计日志
  app.delete("/internal/v1/audit-logs", async (c: any) => {
    try {
      const userId = c.req.query("user_id");
      if (!userId) {
        return c.json(
          { ok: false, data: null, error: { code: "AUDIT_BAD_REQUEST", message: "user_id is required" }, meta: { request_id: c.get("requestId") } },
          400,
        );
      }

      const deleted = await clearAuditLogs(c.env.DB, userId as string);

      return c.json({
        ok: true,
        data: { user_id: userId, cleared: deleted },
        error: null,
        meta: { request_id: c.get("requestId") },
      });
    } catch (err: any) {
      console.error("Audit log clear failed:", err);
      return c.json(
        { ok: false, data: null, error: { code: "AUDIT_CLEAR_FAILED", message: err.message || "Clear failed" }, meta: { request_id: c.get("requestId") } },
        500,
      );
    }
  });
}
