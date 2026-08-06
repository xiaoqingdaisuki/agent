-- 工具调用指标表 — 记录每次工具调用的性能指标（用于监控 + 告警）
-- 通过 Gateway 端点写入，由 ts-langchain / py-langgraph 上报

CREATE TABLE IF NOT EXISTS tool_metrics (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'R0',
  user_id TEXT NOT NULL DEFAULT '',
  tenant_id TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_metrics_tool_timestamp
  ON tool_metrics(tool_name, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_tool_metrics_user_timestamp
  ON tool_metrics(user_id, timestamp DESC);
