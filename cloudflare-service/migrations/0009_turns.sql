-- 可恢复的 Agent 单轮执行记录；业务消息仍是事实记录，Turn 保存运行生命周期与幂等键。
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'cancelled')),
  user_message_id TEXT,
  assistant_message_id TEXT,
  assistant_content_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (user_id) REFERENCES profiles(user_id),
  UNIQUE (conversation_id, client_message_id)
);

CREATE INDEX idx_turns_conversation_updated ON turns(conversation_id, updated_at DESC);
CREATE INDEX idx_turns_recovery ON turns(status, updated_at);
CREATE UNIQUE INDEX idx_turns_one_active_per_conversation
  ON turns(conversation_id)
  WHERE status IN ('pending', 'streaming');
