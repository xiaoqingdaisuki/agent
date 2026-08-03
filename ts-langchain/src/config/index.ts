import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_BASE_URL: z.string().optional(),
  IMAGE_MODEL: z.string().default("step-image-edit-2"),
  AGENT_DEADLINE_MS: z.coerce.number().int().min(5_000).max(40_000).default(30_000),
  SERVER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(60_000).default(40_000),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(12_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(1),
  MAX_AGENT_ITERATIONS: z.coerce.number().int().min(1).max(8).default(6),
  PORT: z.coerce.number().default(6001),
  CORS_ORIGIN: z
    .string()
    .default("")
    .transform((val) =>
      val ? val.split(",").map((s) => s.trim()).filter(Boolean) : []
    ),
});

export const config = envSchema.parse(process.env);
