/**
 * ToolMetricsRepository — 工具调用指标仓储
 *
 * 记录每次工具调用的性能指标，用于监控 + 告警。
 * 由 ts-langchain / py-langgraph 的 tool runtime 上报。
 */

// ============ 类型定义 ==========

export interface ToolMetricEntry {
  id: string;
  tool_name: string;
  tool_version: string;
  ok: boolean;
  error_code: string | null;
  duration_ms: number;
  risk_level: string;
  user_id: string;
  tenant_id: string;
  timestamp: string;
}

// ============ CRUD ==========

/**
 * 批量写入工具指标
 */
export async function createToolMetrics(
  db: D1Database,
  entries: Array<{
    tool_name: string;
    tool_version: string;
    ok: boolean;
    error_code?: string;
    duration_ms: number;
    risk_level: string;
    user_id: string;
    tenant_id: string;
  }>,
): Promise<void> {
  if (entries.length === 0) return;

  const stmt = db.prepare(
    `INSERT INTO tool_metrics
     (id, tool_name, tool_version, ok, error_code, duration_ms, risk_level, user_id, tenant_id, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const now = new Date().toISOString();
  for (const entry of entries) {
    await stmt.bind(
      `metric_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      entry.tool_name,
      entry.tool_version,
      entry.ok ? 1 : 0,
      entry.error_code ?? null,
      entry.duration_ms,
      entry.risk_level,
      entry.user_id,
      entry.tenant_id,
      now,
    ).run();
  }
}

/**
 * 查询工具指标（按工具名 + 时间范围）
 */
export async function getToolMetrics(
  db: D1Database,
  toolName?: string,
  limit = 100,
  offset = 0,
): Promise<{ metrics: ToolMetricEntry[]; total: number }> {
  let whereClause = "";
  const params: unknown[] = [];

  if (toolName) {
    whereClause = "WHERE tool_name = ?";
    params.push(toolName);
  }

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM tool_metrics ${whereClause}`)
    .bind(...params)
    .first<{ total: number }>();

  const { results } = await db
    .prepare(
      `SELECT * FROM tool_metrics
       ${whereClause}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all<ToolMetricEntry>();

  return {
    metrics: (results as ToolMetricEntry[]) ?? [],
    total: countResult?.total ?? 0,
  };
}

/**
 * 获取指标快照（汇总统计）
 */
export async function getToolMetricsSnapshot(
  db: D1Database,
  sinceHours = 24,
): Promise<{
  total_calls: number;
  success_calls: number;
  failed_calls: number;
  avg_duration_ms: number;
  by_tool: Record<string, { calls: number; success: number; fail: number; avg_duration: number }>;
  error_distribution: Record<string, number>;
}> {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();

  // 总体统计
  const totalResult = await db
    .prepare(
      `SELECT
        COUNT(*) as total_calls,
        SUM(ok) as success_calls,
        AVG(duration_ms) as avg_duration_ms
       FROM tool_metrics
       WHERE timestamp >= ?`,
    )
    .bind(since)
    .first<{ total_calls: number; success_calls: number; avg_duration_ms: number }>();

  // 错误分布
  const errorResults = await db
    .prepare(
      `SELECT error_code, COUNT(*) as count
       FROM tool_metrics
       WHERE timestamp >= ? AND error_code IS NOT NULL
       GROUP BY error_code`,
    )
    .bind(since)
    .all<{ error_code: string; count: number }>();

  const errorDistribution: Record<string, number> = {};
  for (const row of (errorResults.results ?? []) as { error_code: string; count: number }[]) {
    errorDistribution[row.error_code] = row.count;
  }

  // 按工具统计
  const toolResults = await db
    .prepare(
      `SELECT
        tool_name,
        COUNT(*) as calls,
        SUM(ok) as success,
        AVG(duration_ms) as avg_duration
       FROM tool_metrics
       WHERE timestamp >= ?
       GROUP BY tool_name`,
    )
    .bind(since)
    .all<{
      tool_name: string;
      calls: number;
      success: number;
      avg_duration: number;
    }>();

  const byTool: Record<string, { calls: number; success: number; fail: number; avg_duration: number }> = {};
  for (const row of (toolResults.results ?? []) as {
    tool_name: string;
    calls: number;
    success: number;
    avg_duration: number;
  }[]) {
    byTool[row.tool_name] = {
      calls: row.calls,
      success: row.success,
      fail: row.calls - row.success,
      avg_duration: Math.round(row.avg_duration || 0),
    };
  }

  return {
    total_calls: totalResult?.total_calls ?? 0,
    success_calls: totalResult?.success_calls ?? 0,
    failed_calls: (totalResult?.total_calls ?? 0) - (totalResult?.success_calls ?? 0),
    avg_duration_ms: Math.round(totalResult?.avg_duration_ms ?? 0),
    by_tool: byTool,
    error_distribution: errorDistribution,
  };
}
