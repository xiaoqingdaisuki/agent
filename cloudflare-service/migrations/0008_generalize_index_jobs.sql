-- 允许索引补偿任务同时引用 memories 与 documents，避免文档任务被旧外键拒绝

CREATE TABLE memory_index_jobs_v2 (
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
  entity_type TEXT DEFAULT 'memory'
);

INSERT INTO memory_index_jobs_v2 (
  id, memory_id, operation, status, retry_count, next_retry_at,
  last_error, created_at, updated_at, entity_type
)
SELECT
  id, memory_id, operation, status, retry_count, next_retry_at,
  last_error, created_at, updated_at, entity_type
FROM memory_index_jobs;

DROP TABLE memory_index_jobs;
ALTER TABLE memory_index_jobs_v2 RENAME TO memory_index_jobs;

CREATE INDEX idx_memory_index_jobs_due
  ON memory_index_jobs(status, next_retry_at);
CREATE INDEX idx_memory_index_jobs_entity
  ON memory_index_jobs(entity_type, status, next_retry_at);
