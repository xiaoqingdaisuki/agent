/**
 * Gateway 响应数据模型 Zod Schemas
 *
 * 与 cloudflare-service 的 src/schemas/memory-models.ts 保持一致。
 * 用于运行时校验 Gateway 响应，确保数据不偏离契约。
 * 基于 Zod 3.x API（ts-langchain 项目使用 zod 3.25）。
 */

import { z } from "zod";

// ============ 基础枚举 ==========

export const MemoryCategorySchema = z.enum(["preference", "fact", "decision", "context"]);
export const MemorySourceSchema = z.enum(["user_explicit", "conversation_extraction"]);
export const MemoryStatusSchema = z.enum(["active", "deleted"]);
export const MemoryIndexStatusSchema = z.enum(["pending", "ready", "failed", "deleting"]);
export const ConversationModeSchema = z.enum(["chat", "knowledge", "mixed"]);
export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);

// ============ 数据模型 ==========

export const UserProfileSchema = z.object({
  user_id: z.string(),
  name: z.string().default(""),
  preferences_json: z.string().default("{}"),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ConversationSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  title: z.string().default(""),
  mode: ConversationModeSchema.default("chat"),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable().default(null),
});

export const MessageSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  user_id: z.string(),
  sequence_no: z.number().nonnegative().int(),
  role: MessageRoleSchema.default("user"),
  content_json: z.string(),
  created_at: z.string(),
});

export const MemorySchema = z.object({
  id: z.string(),
  user_id: z.string(),
  content: z.string().max(500),
  normalized_content: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  category: MemoryCategorySchema.default("fact"),
  importance: z.number().int().min(1).max(5).default(3),
  source: MemorySourceSchema.default("user_explicit"),
  source_conversation_id: z.string().nullable(),
  status: MemoryStatusSchema.default("active"),
  index_status: MemoryIndexStatusSchema.default("pending"),
  embedding_model: z.string(),
  embedding_version: z.number().int().min(1).default(1),
  created_at: z.string(),
  updated_at: z.string(),
  last_accessed_at: z.string().nullable().default(null),
  expires_at: z.string().nullable().default(null),
});

export const MemorySearchResultSchema = z.object({
  id: z.string(),
  content: z.string(),
  category: MemoryCategorySchema,
  importance: z.number().int().min(1).max(5),
  semantic_score: z.number().min(0).max(1),
  final_score: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  source_conversation_id: z.string().nullable(),
});

export const MessagesPageSchema = z.object({
  messages: z.array(MessageSchema),
  total: z.number(),
});

export const SearchResponseSchema = z
  .object({
    items: z.array(MemorySearchResultSchema).optional(),
    // 兼容旧版 Worker 曾返回的 results 字段。
    results: z.array(MemorySearchResultSchema).optional(),
    degraded: z.boolean(),
  })
  .transform((data) => ({
    items: data.items ?? data.results ?? [],
    degraded: data.degraded,
  }));

// ============ 文档模型 ==========

export const DocumentSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  filename: z.string(),
  file_type: z.string().nullable(),
  size: z.coerce.number().int().nonnegative(),
  category: z.string(),
  status: z.enum(["indexed", "failed"]),
  chunk_count: z.coerce.number().int().nonnegative(),
  content_text: z.string().default(""),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

export const ChunkSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  user_id: z.string(),
  chunk_index: z.coerce.number().int().nonnegative(),
  content: z.string(),
  content_hash: z.string(),
  token_count: z.coerce.number().int().nonnegative(),
  embedding_model: z.string(),
  embedding_version: z.coerce.number().int().min(1),
  vectorize_id: z.string().nullable(),
  created_at: z.string(),
});

export const DocumentSearchResultSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  chunk_index: z.coerce.number().int(),
  content: z.string(),
  score: z.coerce.number(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

export const DocumentSearchResponseSchema = z.object({
  results: z.array(DocumentSearchResultSchema),
  degraded: z.boolean(),
});

// ============ 类型导出 ==========

export const GatewayErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const GatewayMetaSchema = z.object({
  request_id: z.string(),
  degraded: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
});

export const GatewayResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown(),
  error: GatewayErrorSchema.nullable(),
  meta: GatewayMetaSchema,
});

// ============ 类型导出 ==========

export type UserProfileData = z.infer<typeof UserProfileSchema>;
export type ConversationData = z.infer<typeof ConversationSchema>;
export type MessageData = z.infer<typeof MessageSchema>;
export type MemoryData = z.infer<typeof MemorySchema>;
export type MemorySearchResultData = z.infer<typeof MemorySearchResultSchema>;
export type MessagesPageData = z.infer<typeof MessagesPageSchema>;
export type SearchResponseData = z.infer<typeof SearchResponseSchema>;
export type DocumentData = z.infer<typeof DocumentSchema>;
export type ChunkData = z.infer<typeof ChunkSchema>;
export type DocumentSearchResultData = z.infer<typeof DocumentSearchResultSchema>;
export type DocumentSearchResponseData = z.infer<typeof DocumentSearchResponseSchema>;
