-- 索引任务表扩展：增加 entity_type 字段以区分 memory 和 document_chunk

ALTER TABLE memory_index_jobs ADD COLUMN entity_type TEXT DEFAULT 'memory';
CREATE INDEX idx_memory_index_jobs_entity ON memory_index_jobs(entity_type, status, next_retry_at);
