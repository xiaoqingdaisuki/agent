-- LangGraph 图状态持久化（checkpoint）
-- 用于 py-langgraph 的 D1Checkpointer，替代纯内存 MemorySaver
-- 每次 Agent 运行结束后的图状态（channel values）存储在此表
-- 重启后通过 D1 恢复图状态，避免对话上下文丢失

CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  checkpoint_data TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_id)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_created
  ON checkpoints(thread_id, created_at DESC);
