/**
 * 应用配置 — 从环境变量读取并校验
 *
 * 使用 zod 做运行时校验，确保必填字段和类型正确。
 * 所有 Agent 服务和 API 路由从此模块读取配置。
 */

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

// 将常见布尔环境变量文本转换为真正的布尔值
function parseBooleanEnv(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return value;
}

const envSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_BASE_URL: z.string().optional(),
  IMAGE_API_KEY: z.string().optional(),
  IMAGE_BASE_URL: z
    .string()
    .url()
    .default("https://api.cloudflare.com/client/v4/accounts/572890169551ba29ece8e74c7b27c215/ai/run"),
  IMAGE_MODEL: z.string().default("@cf/black-forest-labs/flux-2-klein-9b"),
  AGENT_DEADLINE_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(300_000)
    .default(120_000),
  AGENT_DEADLINE_WITH_TOOLS_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(600_000)
    .default(300_000),
  SERVER_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(600_000)
    .default(310_000),
  LLM_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(120_000)
    .default(30_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(1),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(128_000).default(128_000),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  MAX_AGENT_ITERATIONS: z.coerce.number().int().min(1).max(8).default(6),
  REACT_MAX_STEPS: z.coerce.number().int().min(1).max(8).default(8),
  REACT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(6).default(6),
  REACT_MAX_SAME_TOOL_CALLS: z.coerce.number().int().min(1).max(3).default(3),
  REACT_MAX_TOTAL_TIME_MS: z.coerce.number().int().min(1_000).max(30_000).default(30_000),

  // ============ Anthropic 配置 ============
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-3-5-haiku-20241022"),

  // ============ Tavily 搜索配置 ============
  TAVILY_API_KEY: z.string().optional(),
  TAVILY_SEARCH_DEPTH: z.string().default("basic"),

  // ============ 搜索运行时配置 ============
  SEARCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(15_000)
    .default(4_500),
  SEARCH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(2).default(1),
  SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(8),
  SEARCH_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600)
    .default(30),
  SEARCH_STALE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(600),

  PORT: z.coerce.number().default(6001),
  AGENT_API_SECRET: z.string().default(""),
  CORS_ORIGIN: z
    .string()
    .default("")
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),

  // ============ Cloudflare Service 配置 ============
  MEMORY_ENABLED: z.preprocess(parseBooleanEnv, z.boolean()).default(true),
  CLOUDFLARE_MEMORY_BASE_URL: z.string().url().default("http://localhost:8787"),
  CLOUDFLARE_MEMORY_SECRET: z.string().default(""),
  MEMORY_SEARCH_MODE: z
    .string()
    .default("hybrid")
    .refine(
      (v) => v === "hybrid" || v === "sql",
      { message: "MEMORY_SEARCH_MODE must be 'hybrid' or 'sql'" },
    ),
  MEMORY_AUTO_EXTRACT: z.preprocess(parseBooleanEnv, z.boolean()).default(true),
  MEMORY_MAX_ACTIVE_PER_USER: z.coerce.number().int().min(1).max(200).default(50),
  MEMORY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(15_000),
  BACKGROUND_TASK_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  BACKGROUND_TASK_QUEUE_MAX: z.coerce.number().int().min(1).max(1_000).default(200),
});

export const config = envSchema.parse(process.env);
