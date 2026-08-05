-- Cloudflare Memory Gateway — 初始 DDL
-- 对应 CLOUDFLARE_MEMORY_PLAN §7.1
-- 时间字段统一为 UTC ISO 8601 字符串（TEXT）
-- ID 由调用方生成 UUID/ULID

PRAGMA foreign_keys = ON;

-- ============ 用户画像 ============

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  preferences_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============ 会话 ============

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'chat',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (user_id) REFERENCES profiles(user_id)
);

CREATE INDEX idx_conversations_user_updated
  ON conversations(user_id, updated_at DESC);

-- ============ 消息 ============

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (user_id) REFERENCES profiles(user_id),
  UNIQUE (conversation_id, sequence_no)
);

CREATE INDEX idx_messages_conversation_sequence
  ON messages(conversation_id, sequence_no);

-- ============ 长期记忆 ============

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  normalized_content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  category TEXT NOT NULL
    CHECK (category IN ('preference', 'fact', 'decision', 'context')),
  importance INTEGER NOT NULL DEFAULT 3
    CHECK (importance BETWEEN 1 AND 5),
  source TEXT NOT NULL DEFAULT 'user_explicit',
  source_conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deleted')),
  index_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending', 'ready', 'failed', 'deleting')),
  embedding_model TEXT NOT NULL,
  embedding_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (user_id) REFERENCES profiles(user_id),
  UNIQUE (user_id, content_hash)
);

CREATE INDEX idx_memories_user_status_importance
  ON memories(user_id, status, importance DESC, updated_at DESC);

CREATE INDEX idx_memories_user_category
  ON memories(user_id, category, status);

-- ============ 索引补偿任务 ============

CREATE TABLE memory_index_jobs (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id)
);

CREATE INDEX idx_memory_index_jobs_due
  ON memory_index_jobs(status, next_retry_at);
