/**
 * Memory 数据模型 Zod Schemas
 *
 * 替代 contracts/memory/models.schema.json
 * 定义 Gateway API 请求/响应的数据结构，作为 API 契约的唯一事实来源。
 */

import { z } from "zod";

// ============ 基础类型 ==========

/** 记忆类别 */
export const MemoryCategorySchema = z.enum(["preference", "fact", "decision", "context"]);

/** 记忆来源 */
export const MemorySourceSchema = z.enum(["user_explicit", "conversation_extraction"]);

/** 记忆生命周期状态 */
export const MemoryStatusSchema = z.enum(["active", "deleted"]);

/** 索引状态 */
export const MemoryIndexStatusSchema = z.enum(["pending", "ready", "failed", "deleting"]);

/** 会话模式 */
export const ConversationModeSchema = z.enum(["chat", "knowledge", "mixed"]);

/** 消息角色 */
export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);

// ============ 数据模型 ==========

/** 用户画像 */
export const UserProfileSchema = z.object({
  user_id: z.string(),
  name: z.string().default(""),
  preferences_json: z.string().default("{}"),
  created_at: z.string(),
  updated_at: z.string(),
});

/** 会话 */
export const ConversationSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  title: z.string().default(""),
  mode: ConversationModeSchema.default("chat"),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

/** 消息 */
export const MessageSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  user_id: z.string(),
  sequence_no: z.coerce.number().int().nonnegative(),
  role: MessageRoleSchema,
  content_json: z.string(),
  created_at: z.string(),
});

/** 记忆 */
export const MemorySchema = z.object({
  id: z.string(),
  user_id: z.string(),
  content: z.string().max(500),
  normalized_content: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  category: MemoryCategorySchema,
  importance: z.coerce.number().int().min(1).max(5),
  source: MemorySourceSchema,
  status: MemoryStatusSchema,
  index_status: MemoryIndexStatusSchema,
  embedding_model: z.string(),
  embedding_version: z.coerce.number().int().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  last_accessed_at: z.string().nullable(),
  expires_at: z.string().nullable(),
});

/** 记忆保存请求 */
export const MemorySaveRequestSchema = z.object({
  content: z.string().min(1).max(500),
  category: MemoryCategorySchema,
  importance: z.coerce.number().int().min(1).max(5),
  source: MemorySourceSchema,
  source_conversation_id: z.string().nullable().optional(),
});

/** 记忆搜索请求 */
export const MemorySearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  category: MemoryCategorySchema.nullable().optional(),
  limit: z.coerce.number().int().min(1).max(50),
  min_score: z.coerce.number().min(0).max(1).optional(),
});

/** 记忆搜索结果 */
export const MemorySearchResultSchema = z.object({
  id: z.string(),
  content: z.string(),
  category: MemoryCategorySchema,
  importance: z.coerce.number().int().min(1).max(5),
  semantic_score: z.coerce.number().min(0).max(1),
  final_score: z.coerce.number(),
  created_at: z.string(),
  updated_at: z.string(),
  source_conversation_id: z.string().nullable(),
});

/** 会话创建请求 */
export const ConversationCreateSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  user_id: z.string(),
  title: z.string().max(200),
  mode: ConversationModeSchema.default("chat"),
});

/** 消息批量写入请求 */
export const MessageBatchSchema = z.object({
  user_id: z.string(),
  messages: z.array(z.object({
    id: z.string().optional(),
    sequence_no: z.coerce.number().int().nonnegative().optional(),
    role: MessageRoleSchema,
    content: z.union([z.string(), z.record(z.string(), z.unknown())]),
    created_at: z.string().optional(),
  })).min(1),
});

/** 画像保存请求 */
export const ProfileSaveSchema = z.object({
  name: z.string().max(100).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
});

// ============ 统一响应格式 ==========

/** 统一错误信息 */
export const GatewayErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** 统一响应元数据 */
export const GatewayMetaSchema = z.object({
  request_id: z.string(),
  degraded: z.boolean(),
  warnings: z.array(z.string()),
});

/** Gateway 统一响应信封 */
export const GatewayResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown(),
  error: GatewayErrorSchema.nullable(),
  meta: GatewayMetaSchema,
});

// ============ TypeScript 类型导出 ==========

export type UserProfile = z.infer<typeof UserProfileSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Memory = z.infer<typeof MemorySchema>;
export type MemorySaveRequest = z.infer<typeof MemorySaveRequestSchema>;
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;
export type ConversationCreate = z.infer<typeof ConversationCreateSchema>;
export type MessageBatch = z.infer<typeof MessageBatchSchema>;
export type ProfileSave = z.infer<typeof ProfileSaveSchema>;
export type GatewayResponse = z.infer<typeof GatewayResponseSchema>;
