/**
 * IndexJobService — 索引补偿任务
 *
 * 处理 D1 ↔ Vectorize 之间非原子写入的补偿
 */

import { getConfig, DEFAULTS, RETRY_BACKOFF_SECONDS } from "../config/index.js";
import { getEmbedding } from "./embedding.js";

// 创建索引任务
export async function createIndexJob(db: D1Database, memoryId: string, operation: "upsert" | "delete", lastError?: any): Promise<void> {
  const now = new Date().toISOString();
  const errorMessage = lastError instanceof Error ? lastError.message : String(lastError ?? "");

  await db
    .prepare(
      "INSERT INTO memory_index_jobs (id, memory_id, operation, status, retry_count, next_retry_at, last_error, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), memoryId, operation, now, errorMessage || null, now, now)
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

      if (job.operation === "upsert") {
        const memory = await db.prepare("SELECT * FROM memories WHERE id = ?").bind(job.memory_id).first<any>();
        if (!memory || memory.status === "deleted") {
          await db.prepare("UPDATE memory_index_jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), job.id).run();
          processed++;
          continue;
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
        await db.prepare("UPDATE memory_index_jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), job.id).run();
        processed++;
      } else if (job.operation === "delete") {
        await index.deleteByIds([job.memory_id]);
        await db.prepare("UPDATE memory_index_jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), job.id).run();
        processed++;
      }
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
