-- 为原子 Turn 命令增加 O(1) 消息序号，并为索引任务增加消费租约。
ALTER TABLE conversations ADD COLUMN next_sequence_no INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

UPDATE conversations
SET next_sequence_no = COALESCE((
      SELECT MAX(messages.sequence_no) + 1
      FROM messages
      WHERE messages.conversation_id = conversations.id
    ), 0),
    message_count = COALESCE((
      SELECT COUNT(*)
      FROM messages
      WHERE messages.conversation_id = conversations.id
    ), 0);

ALTER TABLE memory_index_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE memory_index_jobs ADD COLUMN lease_until TEXT;

CREATE INDEX idx_memory_index_jobs_claim
  ON memory_index_jobs(status, next_retry_at, lease_until);
