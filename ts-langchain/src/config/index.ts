import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_BASE_URL: z.string().optional(),
  IMAGE_MODEL: z.string().default("step-image-edit-2"),
  PORT: z.coerce.number().default(6001),
  CORS_ORIGIN: z
    .string()
    .default("")
    .transform((val) =>
      val ? val.split(",").map((s) => s.trim()).filter(Boolean) : []
    ),
});

export const config = envSchema.parse(process.env);
