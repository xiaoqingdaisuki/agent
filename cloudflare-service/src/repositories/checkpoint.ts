/**
 * CheckpointRepository — LangGraph 图状态持久化
 *
 * 为 py-langgraph 的 D1Checkpointer 提供底层存储。
 * 每次 Agent 运行后，checkpoint 数据异步写入 D1；
 * 重启后从 D1 加载最新 checkpoint 恢复图状态。
 */

// ============ 类型定义 ==========

export interface CheckpointRow {
  thread_id: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint_data: string;
  metadata: string;
  created_at: string;
}

// ============ CRUD ==========

/**
 * 保存或更新 checkpoint（upsert）
 */
// 执行 upsertCheckpoint 对应的业务逻辑
export async function upsertCheckpoint(
  db: D1Database,
  row: {
    threadId: string;
    checkpointId: string;
    parentCheckpointId?: string | null;
    checkpointData: string;
    metadata?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO checkpoints (thread_id, checkpoint_id, parent_checkpoint_id, checkpoint_data, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, checkpoint_id) DO UPDATE SET
         checkpoint_data = excluded.checkpoint_data,
         metadata = excluded.metadata,
         created_at = excluded.created_at`,
    )
    .bind(
      row.threadId,
      row.checkpointId,
      row.parentCheckpointId ?? null,
      row.checkpointData,
      row.metadata ?? "{}",
      now,
    )
    .run();
}

/**
 * 获取指定线程的最新 checkpoint
 */
// 获取 getLatestCheckpoint 对应的数据
export async function getLatestCheckpoint(
  db: D1Database,
  threadId: string,
): Promise<CheckpointRow | null> {
  const result = await db
    .prepare(
      `SELECT * FROM checkpoints
       WHERE thread_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(threadId)
    .first<CheckpointRow>();

  return result ?? null;
}

/**
 * 获取指定线程的所有 checkpoint 列表
 */
// 获取 listCheckpoints 对应的数据
export async function listCheckpoints(
  db: D1Database,
  threadId: string,
  limit = 20,
  offset = 0,
): Promise<{ checkpoints: CheckpointRow[]; total: number }> {
  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM checkpoints WHERE thread_id = ?`)
    .bind(threadId)
    .first<{ total: number }>();

  const { results } = await db
    .prepare(
      `SELECT * FROM checkpoints
       WHERE thread_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(threadId, limit, offset)
    .all<CheckpointRow>();

  return {
    checkpoints: (results as CheckpointRow[]) ?? [],
    total: countResult?.total ?? 0,
  };
}

/**
 * 删除指定线程的所有 checkpoints
 */
// 删除或清理 deleteThreadCheckpoints 对应的数据
export async function deleteThreadCheckpoints(
  db: D1Database,
  threadId: string,
): Promise<boolean> {
  await db
    .prepare(`DELETE FROM checkpoints WHERE thread_id = ?`)
    .bind(threadId)
    .run();

  return true;
}
