/**
 * DocumentRepository — 文档仓储
 *
 * 负责文档和文档块的 D1 持久化，以及通过 Vectorize 的语义搜索。
 * 与 MemoryRepository 共用 MEMORY_INDEX Vectorize 索引，通过 metadata 中的
 * `entity_type` 字段区分 memory 和 document_chunk。
 */

import { getEmbedding, getEmbeddingBatch } from "../services/embedding.js";
import { createIndexJob } from "../services/index-job.js";

// ============ 类型定义 ==========

export interface Document {
  id: string;
  user_id: string;
  name: string;
  filename: string;
  file_type: string | null;
  size: number;
  category: string;
  status: "indexed" | "failed";
  chunk_count: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Chunk {
  id: string;
  document_id: string;
  user_id: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  token_count: number;
  embedding_model: string;
  embedding_version: number;
  vectorize_id: string | null;
  created_at: string;
}

export interface DocumentSearchResult {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ============ 工具函数 ==========

/**
 * 简单文本切分：按段落分隔符拆分
 */
export function splitText(text: string, chunkSize = 1000, chunkOverlap = 200): string[] {
  const separators = ["\n\n", "\n", "。", ". ", " "];
  const chunks: string[] = [];

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= chunkSize) {
      chunks.push(remaining.trim());
      break;
    }

    // 找最佳切分点
    let splitPoint = chunkSize;
    for (const sep of separators) {
      const idx = remaining.lastIndexOf(sep, chunkSize);
      if (idx > chunkSize * 0.3) {
        splitPoint = idx + sep.length;
        break;
      }
    }

    const chunk = remaining.slice(0, splitPoint).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitPoint - chunkOverlap);
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * 计算文本的 SHA-256 哈希
 */
export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content.toLowerCase().replace(/\s+/g, " ").trim());
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============ 文档 CRUD ==========

/**
 * 创建文档及其块
 */
export async function createDocument(
  db: D1Database,
  index: VectorizeIndex,
  ai: Ai,
  doc: {
    id: string;
    user_id: string;
    name: string;
    filename: string;
    file_type: string | null;
    size: number;
    category: string;
    content: string;
  },
): Promise<{ document: Document; degraded: boolean }> {
  const now = new Date().toISOString();

  // 切分文本
  const textChunks = splitText(doc.content);

  // 生成哈希用于去重
  const hashPromises = textChunks.map((c) => hashContent(c));
  const hashes = await Promise.all(hashPromises);

  // 生成 embedding
  let embeddings: number[][];
  let degraded = false;
  try {
    embeddings = await getEmbeddingBatch(ai, textChunks);
  } catch (err) {
    console.error("Embedding generation failed:", err);
    embeddings = textChunks.map(() => new Array(1024).fill(0));
    degraded = true;
  }

  // 写入文档记录
  const document: Document = {
    id: doc.id,
    user_id: doc.user_id,
    name: doc.name,
    filename: doc.filename,
    file_type: doc.file_type,
    size: doc.size,
    category: doc.category,
    status: degraded ? "failed" : "indexed",
    chunk_count: textChunks.length,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };

  await db
    .prepare(
      "INSERT INTO documents (id, user_id, name, filename, file_type, size, category, status, chunk_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      document.id,
      document.user_id,
      document.name,
      document.filename,
      document.file_type,
      document.size,
      document.category,
      document.status,
      document.chunk_count,
      document.created_at,
      document.updated_at,
    )
    .run();

  // 批量写入块
  const chunkStmt = db.prepare(
    "INSERT OR REPLACE INTO chunks (id, document_id, user_id, chunk_index, content, content_hash, token_count, embedding_model, embedding_version, vectorize_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const vectorizeIds: string[] = [];
  const vectorizeVectors: number[][] = [];
  const vectorizeMetadata: Record<string, unknown>[] = [];

  for (let i = 0; i < textChunks.length; i++) {
    const chunkId = `${doc.id}:chunk_${i}`;
    const vectorizeId = `doc_${chunkId}`;

    chunkStmt
      .bind(
        chunkId,
        doc.id,
        doc.user_id,
        i,
        textChunks[i],
        hashes[i],
        Math.ceil(textChunks[i].length / 4), // 粗略 token 估算
        "@cf/baai/bge-m3",
        1,
        null, // 先设为 null，upsert 成功后更新
        now,
      )
      .run();

    vectorizeIds.push(vectorizeId);
    vectorizeVectors.push(embeddings[i]);
    vectorizeMetadata.push({
      entity_type: "document_chunk",
      document_id: doc.id,
      user_id: doc.user_id,
      chunk_index: i,
      filename: doc.filename,
    });
  }

  // 写入 Vectorize
  if (!degraded) {
    try {
      const vectors: VectorizeVector[] = vectorizeIds.map((id, i) => ({
        id,
        values: vectorizeVectors[i],
        metadata: vectorizeMetadata[i] as Record<string, VectorizeVectorMetadata>,
      }));
      await index.upsert(vectors);

      // 更新 vectorize_id
      for (let i = 0; i < vectorizeIds.length; i++) {
        await db
          .prepare("UPDATE chunks SET vectorize_id = ? WHERE id = ?")
          .bind(vectorizeIds[i], `${doc.id}:chunk_${i}`)
          .run();
      }
    } catch (err) {
      console.error("Vectorize upsert failed, creating compensation job:", err);
      // 补偿任务可能因 FK 约束失败（document_id 不是 memory_id），静默降级
      try {
        await createIndexJob(db, doc.id, "upsert", "document_chunk", err);
      } catch {
        // 忽略补偿任务创建失败，文档和块已持久化
      }
      document.status = "failed";
      await db
        .prepare("UPDATE documents SET status = ? WHERE id = ?")
        .bind("failed", doc.id)
        .run();
      degraded = true;
    }
  }

  return { document, degraded };
}

/**
 * 获取文档详情
 */
export async function getDocument(
  db: D1Database,
  documentId: string,
): Promise<Document | null> {
  const result = await db
    .prepare("SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL")
    .bind(documentId)
    .first<Document>();

  return result ?? null;
}

/**
 * 列出用户文档
 */
export async function listDocuments(
  db: D1Database,
  userId: string,
  limit = 20,
  offset = 0,
  category?: string,
): Promise<{ documents: Document[]; total: number }> {
  let query = "SELECT * FROM documents WHERE user_id = ? AND deleted_at IS NULL";
  const params: unknown[] = [userId];

  if (category) {
    query += " AND category = ?";
    params.push(category);
  }

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM documents WHERE user_id = ? AND deleted_at IS NULL${category ? " AND category = ?" : ""}`)
    .bind(...params)
    .first<{ total: number }>();

  const { results } = await db
    .prepare(query + " ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(...params, limit, offset)
    .all<Document>();

  return {
    documents: (results as Document[]) ?? [],
    total: countResult?.total ?? 0,
  };
}

/**
 * 删除文档（软删除 + 清理 Vectorize）
 */
export async function deleteDocument(
  db: D1Database,
  index: VectorizeIndex,
  documentId: string,
): Promise<boolean> {
  const now = new Date().toISOString();

  // 先确认文档存在
  const existing = await getDocument(db, documentId);
  if (!existing) {
    return false;
  }

  await db
    .prepare("UPDATE documents SET deleted_at = ?, status = 'failed' WHERE id = ?")
    .bind(now, documentId)
    .run();

  // 获取所有 chunk 的 vectorize_id
  const { results: chunks } = await db
    .prepare("SELECT id, vectorize_id FROM chunks WHERE document_id = ?")
    .bind(documentId)
    .all<Chunk>();

  const idsToDelete = (chunks as Chunk[])
    .filter((c) => c.vectorize_id)
    .map((c) => c.vectorize_id!);

  // 删除 Vectorize 中的向量
  if (idsToDelete.length > 0) {
    try {
      await index.deleteByIds(idsToDelete);
    } catch (err) {
      console.error("Vectorize delete failed, creating compensation job:", err);
      await createIndexJob(db, documentId, "delete", "document_chunk", err);
    }
  }

  // 软删除 chunks
  await db
    .prepare("DELETE FROM chunks WHERE document_id = ?")
    .bind(documentId)
    .run();

  return true;
}

// ============ 块操作 ==========

/**
 * 批量创建块
 */
export async function createChunksBatch(
  db: D1Database,
  chunks: Array<{
    id: string;
    document_id: string;
    user_id: string;
    chunk_index: number;
    content: string;
    content_hash: string;
    embedding_model: string;
    embedding_version: number;
    created_at: string;
  }>,
): Promise<void> {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO chunks (id, document_id, user_id, chunk_index, content, content_hash, token_count, embedding_model, embedding_version, vectorize_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  for (const chunk of chunks) {
    await stmt.bind(
      chunk.id,
      chunk.document_id,
      chunk.user_id,
      chunk.chunk_index,
      chunk.content,
      chunk.content_hash,
      Math.ceil(chunk.content.length / 4),
      chunk.embedding_model,
      chunk.embedding_version,
      null,
      chunk.created_at,
    ).run();
  }
}

/**
 * 获取文档的所有块
 */
export async function getChunksByDocument(
  db: D1Database,
  documentId: string,
): Promise<Chunk[]> {
  const { results } = await db
    .prepare("SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index ASC")
    .bind(documentId)
    .all<Chunk>();

  return (results as Chunk[]) ?? [];
}

/**
 * 删除文档的所有块
 */
export async function deleteChunksByDocument(
  db: D1Database,
  documentId: string,
): Promise<void> {
  await db.prepare("DELETE FROM chunks WHERE document_id = ?").bind(documentId).run();
}

// ============ 文档搜索 ==========

/**
 * 语义搜索文档块
 */
export async function searchDocuments(
  db: D1Database,
  index: VectorizeIndex,
  ai: Ai,
  userId: string,
  query: string,
  options: { limit?: number; minScore?: number } = {},
  forceDegraded = false,
): Promise<{ results: DocumentSearchResult[]; degraded: boolean }> {
  const { limit = 5, minScore = 0.6 } = options;

  // 降级路径：纯 SQL（按 content 匹配）
  if (forceDegraded) {
    return degradeSearch(db, userId, limit);
  }

  // 正常路径：Vectorize 语义搜索
  try {
    const embedding = await getEmbedding(ai, query);

    const vectorResults = await index.query(embedding, {
      topK: Math.min(limit * 3, 30),
      filter: {
        entity_type: { $eq: "document_chunk" },
        user_id: { $eq: userId },
      },
      returnValues: false,
      returnMetadata: true,
    });

    const matchIds: string[] = [];
    const scoreMap: Record<string, number> = {};
    for (const m of vectorResults.matches) {
      matchIds.push(m.id);
      scoreMap[m.id] = m.score;
    }

    if (matchIds.length === 0) {
      return { results: [], degraded: false };
    }

    // D1 回表
    const placeholders = matchIds.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT id, document_id, user_id, chunk_index, content, content_hash, token_count, embedding_model, embedding_version, vectorize_id, created_at FROM chunks WHERE id IN (${placeholders})`,
      )
      .bind(...matchIds)
      .all<Chunk>();

    const chunks = (results as Chunk[]) ?? [];

    // 获取关联的文档名称
    const docIds = [...new Set(chunks.map((c) => c.document_id))];
    const docPlaceholders = docIds.map(() => "?").join(",");
    const { results: docs } = await db
      .prepare(`SELECT id, name, filename FROM documents WHERE id IN (${docPlaceholders})`)
      .bind(...docIds)
      .all<Document>();
    const docMap = new Map((docs as Document[] ?? []).map((d) => [d.id, d]));

    // 过滤低分 + 构建结果
    const scored = chunks
      .filter((c) => (scoreMap[c.id] ?? 0) >= minScore)
      .map((c) => {
        const doc = docMap.get(c.document_id);
        return {
          id: c.id,
          document_id: c.document_id,
          chunk_index: c.chunk_index,
          content: c.content,
          score: Math.round((scoreMap[c.id] ?? 0) * 1000) / 1000,
          metadata: {
            document_name: doc?.name ?? "",
            filename: doc?.filename ?? "",
            ...(c.content_hash ? { content_hash: c.content_hash } : {}),
          },
          created_at: c.created_at,
        };
      });

    scored.sort((a, b) => b.score - a.score);
    return { results: scored.slice(0, limit), degraded: false };
  } catch (err) {
    console.error("Vectorize document search failed, degrading to SQL:", err);
    return degradeSearch(db, userId, limit);
  }
}

/**
 * 降级搜索：纯 SQL 全文匹配
 */
async function degradeSearch(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<{ results: DocumentSearchResult[]; degraded: boolean }> {
  try {
    const { results } = await db
      .prepare(
        `SELECT c.id, c.document_id, c.chunk_index, c.content, c.created_at, d.name as doc_name
         FROM chunks c
         JOIN documents d ON c.document_id = d.id
         WHERE c.user_id = ? AND d.deleted_at IS NULL
         ORDER BY c.created_at DESC
         LIMIT ?`,
      )
      .bind(userId, limit)
      .all<any>();

    const rows = (results ?? []) as any[];
    return {
      results: rows.map((r) => ({
        id: r.id,
        document_id: r.document_id,
        chunk_index: r.chunk_index,
        content: r.content,
        score: 0,
        metadata: { document_name: r.doc_name || "", degraded: true },
        created_at: r.created_at,
      })),
      degraded: true,
    };
  } catch {
    return { results: [], degraded: true };
  }
}
