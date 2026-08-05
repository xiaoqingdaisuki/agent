/**
 * 工具统一返回信封 Zod Schemas
 *
 * 替代 contracts/tools/error.schema.json
 * 定义所有工具调用的统一返回格式。
 */

import { z } from "zod";

/** 错误码枚举 */
export const ToolErrorCodeSchema = z.enum([
  "INVALID_ARGUMENT",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "TIMEOUT",
  "DEPENDENCY_ERROR",
  "RESULT_TOO_LARGE",
  "INTERNAL_ERROR",
]);

/** 工具错误信息 */
export const ToolErrorSchema = z.object({
  code: ToolErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** 工具返回元数据 */
export const ToolResultMetaSchema = z.object({
  tool_call_id: z.string(),
  tool_name: z.string().optional(),
  tool_version: z.string().optional(),
  duration_ms: z.coerce.number().int().nonnegative(),
  source_refs: z.array(z.string()),
  warnings: z.array(z.string()),
  retryable: z.boolean(),
});

/** 工具统一返回信封 */
export const ToolResultEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().nullable(),
  error: ToolErrorSchema.nullable(),
  meta: ToolResultMetaSchema,
});

export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;
export type ToolError = z.infer<typeof ToolErrorSchema>;
export type ToolResultMeta = z.infer<typeof ToolResultMetaSchema>;
export type ToolResultEnvelope = z.infer<typeof ToolResultEnvelopeSchema>;
