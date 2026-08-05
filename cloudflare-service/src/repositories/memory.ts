/**
 * MemoryRepository — 长期记忆仓储
 *
 * 核心操作：save（含去重 + embedding + Vectorize）、search（语义搜索）、list、delete
 */

import { getEmbedding } from "../services/embedding.js";
import { createIndexJob, processPendingJobs } from "../services/index-job.js";

// 记忆数据类型（与 D1 memories 表对应）
export interface Memory {
  id: string;
  user_id: string;
  content: string;
  normalized_content: string;
  content_hash: string;
  category: "preference" | "fact" | "decision" | "context";
  importance: number;
  source: "user_explicit" | "conversation_extraction";
  source_conversation_id: string | null;
  status: "active" | "deleted";
  index_status: "pending" | "ready" | "failed" | "deleting";
  embedding_model: string;
  embedding_version: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  expires_at: string | null;
}

// 语义搜索结果
export interface MemorySearchResult {
  id: string;
  content: string;
  category: string;
  importance: number;
  semantic_score: number;
  final_score: number;
  created_at: string;
  updated_at: string;
}

// 规范化内容：去除首尾空白、合并连续空白、英文小写
export function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

// 异步计算 SHA-256 hash
export async function computeContentHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 同步计算简单 hash（用于 cache key 等非安全场景）
export function simpleHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}

// 保存记忆（幂等）
export async function saveMemory(
  db: D1Database,
  index: VectorizeIndex,
  ai: Ai,
  memoryData: {
    id: string;
    user_id: string;
    content: string;
    category: string;
    importance: number;
    source: string;
    source_conversation_id: string | null;
  },
): Promise<{ memory: Memory; indexed: boolean }> {
  const normalized = normalizeContent(memoryData.content);
  const contentHash = await computeContentHash(normalized);
  const now = new Date().toISOString();

  // 检查是否已有相同 content_hash 的记录
  const existing = await db
    .prepare("SELECT id, status FROM memories WHERE user_id = ? AND content_hash = ?")
    .bind(memoryData.user_id, contentHash)
    .first<{ id: string; status: string }>();

  let memoryId: string;
  let isNew = false;

  if (existing) {
    if (existing.status === "active") {
      // 已存在且活跃 → 返回已有记录
      const current = await getMemoryById(db, existing.id);
      if (current) {
        // 重新检查索引状态
        const indexReady = current.index_status === "ready";
        return { memory: current, indexed: indexReady };
      }
    }
    // 已软删除 → 恢复
    memoryId = existing.id;
    await db
      .prepare(
        `UPDATE memories SET content = ?, normalized_content = ?, content_hash = ?, category = ?, importance = ?,
         source = ?, source_conversation_id = ?, status = 'active', index_status = 'pending', updated_at = ?
         WHERE id = ?`,
      )
      .bind(memoryData.content, normalized, contentHash, memoryData.category, memoryData.importance, memoryData.source, memoryData.source_conversation_id, now, memoryId)
      .run();
  } else {
    // 新记录
    memoryId = memoryData.id;
    isNew = true;
    await db
      .prepare(
        `INSERT INTO memories (id, user_id, content, normalized_content, content_hash, category, importance,
         source, source_conversation_id, status, index_status, embedding_model, embedding_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'pending', '@cf/baai/bge-m3', 1, ?, ?)`,
      )
      .bind(memoryId, memoryData.user_id, memoryData.content, normalized, contentHash, memoryData.category, memoryData.importance, memoryData.source, memoryData.source_conversation_id, now, now)
      .run();
  }

  // 同步 embedding + Vectorize upsert
  let indexed = false;
  try {
    const embedding = await getEmbedding(ai, memoryData.content);
    await index.upsert([
      {
        id: memoryId,
        values: embedding,
        metadata: { user_id: memoryData.user_id, category: memoryData.category, active: true, embedding_version: 1 },
      },
    ]);

    await db
      .prepare("UPDATE memories SET index_status = 'ready' WHERE id = ?")
      .bind(memoryId)
      .run();

    indexed = true;
  } catch (err) {
    // Vectorize 失败，创建补偿任务
    await createIndexJob(db, memoryId, "upsert", err);
    await db.prepare("UPDATE memories SET index_status = 'failed' WHERE id = ?").bind(memoryId).run();
  }

  const result = await getMemoryById(db, memoryId);
  return { memory: result!, indexed };
}

// 语义搜索记忆
export async function searchMemories(
  db: D1Database,
  index: VectorizeIndex,
  ai: Ai,
  userId: string,
  query: string,
  options: { category?: string; limit?: number; minScore?: number } = {},
  forceDegraded = false,
): Promise<{ results: MemorySearchResult[]; degraded: boolean }> {
  const { category, limit = 10, minScore = 0.65 } = options;

  // 降级路径：纯 SQL
  if (forceDegraded) {
    return degradeSearch(db, userId, category, limit);
  }

  // 正常路径：Vectorize 语义搜索
  try {
    const embedding = await getEmbedding(ai, query);

    const vectorResults = await index.query(embedding, {
      topK: Math.min(limit * 3, 50),
      filter: { user_id: { $eq: userId }, active: { $eq: true } },
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
      .prepare(`SELECT id, user_id, content, normalized_content, content_hash, category, importance, source, source_conversation_id, status, index_status, embedding_model, embedding_version, created_at, updated_at, last_accessed_at, expires_at FROM memories WHERE id IN (${placeholders}) AND user_id = ? AND status = 'active'`)
      .bind(...matchIds, userId)
      .all<Memory>();

    const memories = (results as Memory[]) ?? [];

    // 过滤低分 + 计算综合评分
    const now = Date.now();
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 天

    const scored = memories
      .filter((m) => (scoreMap[m.id] ?? 0) >= minScore)
      .map((m) => {
        const semanticScore = scoreMap[m.id] ?? 0;
        const updatedTime = new Date(m.updated_at).getTime();
        const recencyScore = Math.max(0, 1 - (now - updatedTime) / maxAge);
        const importanceScore = m.importance / 5;
        const finalScore = semanticScore * 0.6 + importanceScore * 0.25 + recencyScore * 0.1;

        // 异步更新 last_accessed_at
        db.prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?").bind(new Date().toISOString(), m.id).run().catch(() => {});

        return {
          id: m.id,
          content: m.content,
          category: m.category,
          importance: m.importance,
          semantic_score: Math.round(semanticScore * 1000) / 1000,
          final_score: Math.round(finalScore * 1000) / 1000,
          created_at: m.created_at,
          updated_at: m.updated_at,
        };
      });

    scored.sort((a, b) => b.final_score - a.final_score);
    return { results: scored.slice(0, limit), degraded: false };
  } catch (err) {
    console.error("Vectorize search failed, degrading to SQL:", err);
    return degradeSearch(db, userId, category, limit);
  }
}

// 降级搜索（纯 SQL）
async function degradeSearch(db: D1Database, userId: string, category?: string, limit = 10): Promise<{ results: MemorySearchResult[]; degraded: boolean }> {
  let sql = "SELECT * FROM memories WHERE user_id = ? AND status = 'active'";
  const params: any[] = [userId];

  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }

  sql += " ORDER BY importance DESC, updated_at DESC LIMIT ?";
  params.push(limit);

  const { results } = await db.prepare(sql).bind(...params).all<Memory>();
  const memories = (results as Memory[]) ?? [];

  return {
    results: memories.map((m) => ({
      id: m.id,
      content: m.content,
      category: m.category,
      importance: m.importance,
      semantic_score: 0,
      final_score: m.importance / 5,
      created_at: m.created_at,
      updated_at: m.updated_at,
    })),
    degraded: true,
  };
}

// 列出用户记忆
export async function listMemories(
  db: D1Database,
  userId: string,
  options: { category?: string; limit?: number } = {},
): Promise<Memory[]> {
  const { category, limit = 50 } = options;

  let sql = "SELECT * FROM memories WHERE user_id = ? AND status = 'active'";
  const params: any[] = [userId];

  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }

  sql += " ORDER BY importance DESC, updated_at DESC LIMIT ?";
  params.push(Math.min(limit, 100));

  const { results } = await db.prepare(sql).bind(...params).all<Memory>();
  return (results as Memory[]) ?? [];
}

// 获取单条记忆
export async function getMemoryById(db: D1Database, id: string): Promise<Memory | null> {
  const result = await db.prepare("SELECT * FROM memories WHERE id = ?").bind(id).first<Memory>();
  return result ?? null;
}

// 更新记忆
export async function updateMemory(
  db: D1Database,
  id: string,
  changes: { content?: string; category?: string; importance?: number; normalized_content?: string; content_hash?: string },
): Promise<Memory | null> {
  const existing = await getMemoryById(db, id);
  if (!existing || existing.status === "deleted") return null;

  const now = new Date().toISOString();
  const newContent = changes.content ?? existing.content;
  const newCategory = changes.category ?? existing.category;
  const newImportance = changes.importance ?? existing.importance;
  const newNormalized = changes.normalized_content ?? normalizeContent(newContent);
  const newHash = changes.content_hash ?? await computeContentHash(newNormalized);

  await db
    .prepare(
      "UPDATE memories SET content = ?, normalized_content = ?, content_hash = ?, category = ?, importance = ?, updated_at = ?, index_status = 'pending' WHERE id = ?",
    )
    .bind(newContent, newNormalized, newHash, newCategory, newImportance, now, id)
    .run();

  return getMemoryById(db, id);
}

// 删除记忆（软删除 + Vectorize 清理）
export async function deleteMemory(db: D1Database, index: VectorizeIndex, id: string): Promise<boolean> {
  const existing = await getMemoryById(db, id);
  if (!existing || existing.status === "deleted") return false;

  const now = new Date().toISOString();

  // D1 软删除
  await db
    .prepare("UPDATE memories SET status = 'deleted', index_status = 'deleting', updated_at = ? WHERE id = ?")
    .bind(now, id)
    .run();

  // Vectorize 删除
  try {
    await index.deleteByIds([id]);
  } catch (err) {
    // Vectorize 删除失败，创建补偿任务
    await createIndexJob(db, id, "delete", err);
  }

  return true;
}

// 清空用户所有记忆
export async function clearUserMemories(db: D1Database, userId: string): Promise<number> {
  const now = new Date().toISOString();
  const result = await db
    .prepare("UPDATE memories SET status = 'deleted', updated_at = ? WHERE user_id = ? AND status = 'active'")
    .bind(now, userId)
    .run();

  return (result.meta?.rows_written ?? 0) as number;
}
