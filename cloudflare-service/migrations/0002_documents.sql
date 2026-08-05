-- 文档管理表（RAG 知识库）

-- 文档表
CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_type TEXT,
    size INTEGER DEFAULT 0,
    category TEXT DEFAULT 'general',
    status TEXT DEFAULT 'indexed',
    chunk_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX idx_documents_user_created ON documents(user_id, created_at DESC);

-- 文档块表
CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    token_count INTEGER DEFAULT 0,
    embedding_model TEXT NOT NULL,
    embedding_version INTEGER DEFAULT 1,
    vectorize_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE INDEX idx_chunks_document ON chunks(document_id, chunk_index);
CREATE INDEX idx_chunks_user ON chunks(user_id);
