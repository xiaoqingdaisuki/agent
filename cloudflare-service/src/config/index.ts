/**
 * Gateway 环境配置
 *
 * 在 Cloudflare Worker 中，配置来自 env bindings。
 * 本模块导出配置键常量和读取函数。
 */

// Gateway Env 类型
export interface GatewayEnv {
  DB: D1Database;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  SERVICE_SECRET: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: string;
  MAX_MEMORIES_PER_USER: string;
  INDEX_JOB_BATCH_SIZE: string;
  INDEX_JOB_MAX_RETRIES: string;
}

// 默认值
export const DEFAULTS = {
  EMBEDDING_MODEL: "@cf/baai/bge-m3",
  EMBEDDING_DIMENSIONS: 1024,
  MAX_MEMORIES_PER_USER: 50,
  INDEX_JOB_BATCH_SIZE: 20,
  INDEX_JOB_MAX_RETRIES: 5,
  MEMORY_REQUEST_TIMEOUT_MS: 5000,
} as const;

// 从 env 读取配置值
export function getConfig(env: GatewayEnv) {
  return {
    serviceSecret: env.SERVICE_SECRET || "",
    embeddingModel: env.EMBEDDING_MODEL || DEFAULTS.EMBEDDING_MODEL,
    embeddingDimensions: parseInt(env.EMBEDDING_DIMENSIONS || String(DEFAULTS.EMBEDDING_DIMENSIONS), 10),
    maxMemoriesPerUser: parseInt(env.MAX_MEMORIES_PER_USER || String(DEFAULTS.MAX_MEMORIES_PER_USER), 10),
    indexJobBatchSize: parseInt(env.INDEX_JOB_BATCH_SIZE || String(DEFAULTS.INDEX_JOB_BATCH_SIZE), 10),
    indexJobMaxRetries: parseInt(env.INDEX_JOB_MAX_RETRIES || String(DEFAULTS.INDEX_JOB_MAX_RETRIES), 10),
  };
}

// 指数退避间隔（秒）
export const RETRY_BACKOFF_SECONDS = [1, 5, 30, 120, 600] as const;
