/**
 * AuditLogRepository — 审计日志仓储
 *
 * 记录所有工具调用的审计信息，用于合规 + 排障。
 * 由 ts-langchain / py-langgraph 的 tool runtime 上报。
 */

// ============ 类型定义 ==========

export interface AuditLogEntry {
  id: string;
  user_id: string;
  tenant_id: string;
  conversation_id: string;
  tool_name: string;
  tool_version: string;
  risk_level: string;
  ok: boolean;
  error_code: string | null;
  duration_ms: number;
  request_id: string;
  trace_id: string;
  created_at: string;
}

// ============ CRUD ==========

/**
 * 批量写入审计日志
 */
// 创建或注册 createAuditLogs 所需的数据
export async function createAuditLogs(
  db: D1Database,
  entries: Array<{
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
  }>,
): Promise<void> {
  if (entries.length === 0) return;

  const now = new Date().toISOString();

  // 批量插入（使用单个事务）
  const stmt = db.prepare(
    `INSERT INTO audit_logs
     (id, user_id, tenant_id, conversation_id, tool_name, tool_version, risk_level, ok, error_code, duration_ms, request_id, trace_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const entry of entries) {
    await stmt.bind(
      `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      entry.user_id,
      entry.tenant_id,
      entry.conversation_id,
      entry.tool_name,
      entry.tool_version,
      entry.risk_level,
      entry.ok ? 1 : 0,
      entry.error_code ?? null,
      entry.duration_ms,
      entry.request_id,
      entry.trace_id,
      now,
    ).run();
  }
}

/**
 * 查询用户的审计日志（分页）
 */
// 获取 getAuditLogs 对应的数据
export async function getAuditLogs(
  db: D1Database,
  userId: string,
  limit = 50,
  offset = 0,
): Promise<{ logs: AuditLogEntry[]; total: number }> {
  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM audit_logs WHERE user_id = ?`)
    .bind(userId)
    .first<{ total: number }>();

  const { results } = await db
    .prepare(
      `SELECT * FROM audit_logs
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(userId, limit, offset)
    .all<AuditLogEntry>();

  return {
    logs: (results as AuditLogEntry[]) ?? [],
    total: countResult?.total ?? 0,
  };
}

/**
 * 清空用户的审计日志
 */
// 删除或清理 clearAuditLogs 对应的数据
export async function clearAuditLogs(db: D1Database, userId: string): Promise<number> {
  await db
    .prepare(`DELETE FROM audit_logs WHERE user_id = ?`)
    .bind(userId)
    .run();

  return 0; // D1 不返回受影响行数，返回 0 表示操作已执行
}
