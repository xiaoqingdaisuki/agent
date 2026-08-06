-- 审计日志表 — 记录所有工具调用（用于合规 + 排障）
-- 通过 Gateway 端点写入，由 ts-langchain / py-langgraph 上报

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created
  ON audit_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_conversation
  ON audit_logs(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tool
  ON audit_logs(tool_name, created_at DESC);
