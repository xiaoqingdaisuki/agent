/**
 * Document 数据模型 Zod Schemas
 *
 * 定义文档管理 API 的请求/响应数据结构。
 */

import { z } from "zod";

// ============ 基础类型 ==========

/** 文档状态 */
export const DocumentStatusSchema = z.enum(["indexed", "failed"]);

/** 文档分类 */
export const DocumentCategorySchema = z.enum(["general", "code", "manual", "faq", "other"]);

// ============ 文档模型 ==========

/** 文档 */
export const DocumentSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  filename: z.string(),
  file_type: z.string().nullable(),
  size: z.coerce.number().int().nonnegative(),
  category: DocumentCategorySchema,
  status: DocumentStatusSchema,
  chunk_count: z.coerce.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

/** 文档块 */
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

// ============ 请求模型 ==========

/** 文档上传请求 */
export const DocumentUploadRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  content: z.string().min(1),  // base64 编码的原始文件内容
  file_type: z.string().nullable().optional(),
  category: DocumentCategorySchema.default("general"),
});

/** 文档搜索请求 */
export const DocumentSearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  min_score: z.coerce.number().min(0).max(1).default(0.6),
});

/** 文档列表查询参数 */
export const DocumentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  category: DocumentCategorySchema.nullable().optional(),
});

// ============ 响应模型 ==========

/** 文档搜索结果 */
export const DocumentSearchResultSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  chunk_index: z.coerce.number().int(),
  content: z.string(),
  score: z.coerce.number(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

/** 分页元数据 */
export const PaginatedMetaSchema = z.object({
  total: z.coerce.number().int().nonnegative(),
  limit: z.coerce.number().int().nonnegative(),
  offset: z.coerce.number().int().nonnegative(),
});

// ============ TypeScript 类型导出 ==========

export type Document = z.infer<typeof DocumentSchema>;
export type Chunk = z.infer<typeof ChunkSchema>;
export type DocumentUploadRequest = z.infer<typeof DocumentUploadRequestSchema>;
export type DocumentSearchRequest = z.infer<typeof DocumentSearchRequestSchema>;
export type DocumentListQuery = z.infer<typeof DocumentListQuerySchema>;
export type DocumentSearchResult = z.infer<typeof DocumentSearchResultSchema>;
export type PaginatedMeta = z.infer<typeof PaginatedMetaSchema>;
