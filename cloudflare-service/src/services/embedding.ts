/**
 * EmbeddingService — 向量化服务
 *
 * 调用 Workers AI 生成文本 embedding
 * 模型：@cf/baai/bge-m3（1024 维，多语言）
 */

import { DEFAULTS } from "../config/index.js";

// 生成单条文本的 embedding
export async function getEmbedding(ai: Ai, text: string, model = DEFAULTS.EMBEDDING_MODEL): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    return new Array(DEFAULTS.EMBEDDING_DIMENSIONS).fill(0);
  }

  const trimmed = text.slice(0, 512);

  // Workers AI 返回格式: { data: [[...]] } 或直接是数组
  const result = (await ai.run(model as any, { text: trimmed })) as any;
  const embedding: number[] = result.data?.[0] ?? result;

  return embedding;
}

// 批量生成 embedding（控制并发）
export async function getEmbeddingBatch(ai: Ai, texts: string[], concurrency = 3): Promise<number[][]> {
  const results: number[][] = [];
  const batches: string[][] = [];

  for (let i = 0; i < texts.length; i += concurrency) {
    batches.push(texts.slice(i, i + concurrency));
  }

  for (const batch of batches) {
    const batchResults = await Promise.all(batch.map((t) => getEmbedding(ai, t)));
    results.push(...batchResults);
  }

  return results;
}
