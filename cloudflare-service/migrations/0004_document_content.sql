-- 为 documents 表添加原始内容列，用于 reindex 恢复
-- 重启后可通过此列恢复文档内容，无需重新上传

ALTER TABLE documents ADD COLUMN content_text TEXT DEFAULT '';
ALTER TABLE documents ADD COLUMN content_filename TEXT DEFAULT '';
