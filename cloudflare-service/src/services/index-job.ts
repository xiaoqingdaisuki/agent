/**
 * IndexJobService — 索引补偿任务
 *
 * 处理 D1 ↔ Vectorize 之间非原子写入的补偿。
 * 支持两种实体类型：memory（长期记忆）和 document_chunk（文档块）。
 */

import { getConfig, DEFAULTS, RETRY_BACKOFF_SECONDS } from "../config/index.js";
import { getEmbedding, getEmbeddingBatch } from "./embedding.js";

// 实体类型
export type EntityType = "memory" | "document_chunk";

// 创建索引任务
export async function createIndexJob(
  db: D1Database,
  entityId: string,
  operation: "upsert" | "delete",
  entityType: EntityType = "memory",
  lastError?: any,
): Promise<void> {
  const now = new Date().toISOString();
  const errorMessage = lastError instanceof Error ? lastError.message : String(lastError ?? "");

  await db
    .prepare(
      "INSERT INTO memory_index_jobs (id, memory_id, operation, entity_type, status, retry_count, next_retry_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), entityId, operation, entityType, now, errorMessage || null, now, now)
    .run();
}

// 处理到期的待处理任务
export async function processPendingJobs(db: D1Database, index: VectorizeIndex, ai: Ai): Promise<{ processed: number; failed: number }> {
  const batchSize = DEFAULTS.INDEX_JOB_BATCH_SIZE;
  const maxRetries = DEFAULTS.INDEX_JOB_MAX_RETRIES;

  const { results } = await db
    .prepare("SELECT * FROM memory_index_jobs WHERE status = 'pending' AND next_retry_at <= ? ORDER BY created_at ASC LIMIT ?")
    .bind(new Date().toISOString(), batchSize)
    .all<any>();

  const jobs = (results as any[]) ?? [];
  let processed = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      await db.prepare("UPDATE memory_index_jobs SET status = 'processing', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), job.id).run();

      const entityType = job.entity_type || "memory";

      if (entityType === "document_chunk") {
        await processDocumentChunkJob(db, index, ai, job);
      } else {
        await processMemoryJob(db, index, ai, job);
      }

      await db.prepare("UPDATE memory_index_jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), job.id).run();
      processed++;
    } catch (err) {
      const retryCount = job.retry_count + 1;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (retryCount >= maxRetries) {
        await db
          .prepare("UPDATE memory_index_jobs SET status = 'failed', retry_count = ?, last_error = ?, updated_at = ? WHERE id = ?")
          .bind(retryCount, errorMsg, new Date().toISOString(), job.id)
          .run();
        failed++;
      } else {
        const backoffIndex = Math.min(retryCount - 1, RETRY_BACKOFF_SECONDS.length - 1);
        const nextRetry = new Date(Date.now() + RETRY_BACKOFF_SECONDS[backoffIndex] * 1000).toISOString();
        await db
          .prepare("UPDATE memory_index_jobs SET retry_count = ?, next_retry_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
          .bind(retryCount, nextRetry, errorMsg, new Date().toISOString(), job.id)
          .run();
      }
    }
  }

  return { processed, failed };
}

// 处理记忆索引任务
async function processMemoryJob(db: D1Database, index: VectorizeIndex, ai: Ai, job: any): Promise<void> {
  if (job.operation === "upsert") {
    const memory = await db.prepare("SELECT * FROM memories WHERE id = ?").bind(job.memory_id).first<any>();
    if (!memory || memory.status === "deleted") {
      return;
    }

    const embedding = await getEmbedding(ai, memory.content);
    await index.upsert([
      {
        id: memory.id,
        values: embedding,
        metadata: { user_id: memory.user_id, category: memory.category, active: true, embedding_version: memory.embedding_version },
      },
    ]);

    await db.prepare("UPDATE memories SET index_status = 'ready' WHERE id = ?").bind(memory.id).run();
  } else if (job.operation === "delete") {
    await index.deleteByIds([job.memory_id]);
  }
}

// 处理文档块索引任务
async function processDocumentChunkJob(db: D1Database, index: VectorizeIndex, ai: Ai, job: any): Promise<void> {
  // 从 memory_id 字段获取 document_id
  const documentId = job.memory_id;

  if (job.operation === "upsert") {
    // 获取文档的所有块
    const { results: chunks } = await db
      .prepare("SELECT * FROM chunks WHERE document_id = ?")
      .bind(documentId)
      .all<any>();

    const chunkList = (chunks as any[]) ?? [];
    if (chunkList.length === 0) {
      // 文档已被删除，标记完成
      await db.prepare("UPDATE documents SET status = 'failed' WHERE id = ?").bind(documentId).run();
      return;
    }

    // 重新生成 embedding
    const texts = chunkList.map((c) => c.content);
    const embeddings = await getEmbeddingBatch(ai, texts);

    // 构建 Vectorize upsert 数据
    const vectors = chunkList.map((chunk, i) => ({
      id: `doc_${chunk.id}`,
      values: embeddings[i],
      metadata: {
        entity_type: "document_chunk",
        document_id: documentId,
        user_id: chunk.user_id,
        chunk_index: chunk.chunk_index,
      },
    }));

    await index.upsert(vectors);

    // 更新 vectorize_id
    for (let i = 0; i < chunkList.length; i++) {
      await db
        .prepare("UPDATE chunks SET vectorize_id = ? WHERE id = ?")
        .bind(`doc_${chunkList[i].id}`, chunkList[i].id)
        .run();
    }

    await db.prepare("UPDATE documents SET status = 'indexed', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), documentId).run();

  } else if (job.operation === "delete") {
    // 获取所有块的 vectorize_id
    const { results: chunks } = await db
      .prepare("SELECT vectorize_id FROM chunks WHERE document_id = ? AND vectorize_id IS NOT NULL")
      .bind(documentId)
      .all<any>();

    const vectorizeIds = (chunks as any[]).map((c) => c.vectorize_id).filter(Boolean);
    if (vectorizeIds.length > 0) {
      await index.deleteByIds(vectorizeIds);
    }
    await db
      .prepare("DELETE FROM chunks WHERE document_id = ?")
      .bind(documentId)
      .run();
  }
}

// 重试失败的任务
export async function retryFailedJobs(db: D1Database, index: VectorizeIndex, ai: Ai): Promise<{ processed: number; failed: number }> {
  const { results } = await db
    .prepare("SELECT * FROM memory_index_jobs WHERE status = 'failed' ORDER BY created_at ASC LIMIT ?")
    .bind(DEFAULTS.INDEX_JOB_BATCH_SIZE)
    .all<any>();

  const jobs = (results as any[]) ?? [];
  const now = new Date().toISOString();

  for (const job of jobs) {
    await db
      .prepare("UPDATE memory_index_jobs SET status = 'pending', retry_count = 0, next_retry_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
      .bind(now, now, job.id)
      .run();
  }

  return processPendingJobs(db, index, ai);
}
