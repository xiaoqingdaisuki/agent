/**
 * Cloudflare Service HTTP Client
 *
 * 提供与 Cloudflare Service 通信的 HTTP 客户端。
 * 所有请求通过 Service 进行，Agent 服务不直接持有 Cloudflare API Token。
 * 使用原生 fetch API，依赖 Node.js 18+ 或 Cloudflare Workers runtime。
 * 所有响应经过 Zod 运行时校验，确保不偏离契约。
 */

// ============ 错误类型定义 ============

/**
 * Gateway 请求失败异常
 */
export class MemoryGatewayError extends Error {
  // 初始化当前对象
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500,
  ) {
    super(`[${code}] ${message}`);
    this.name = "MemoryGatewayError";
  }
}

// ============ Schema 校验 ==========

import { z } from "zod";
import {
  type UserProfileData,
  type ConversationData,
  type MessagesPageData,
  type MemoryData,
  type SearchResponseData,
  type DocumentData,
  type ChunkData,
  type DocumentSearchResultData,
  type DocumentSearchResponseData,
  GatewayResponseSchema,
  UserProfileSchema,
  ConversationSchema,
  MessagesPageSchema,
  MemorySchema,
  SearchResponseSchema,
  DocumentSchema,
  ChunkSchema,
  DocumentSearchResponseSchema,
} from "./schemas.js";

/**
 * 校验 Gateway 统一响应信封
 */
// 校验并判断 validateGatewayResponse 对应的状态
function validateGatewayResponse(raw: unknown) {
  return GatewayResponseSchema.parse(raw);
}

/**
 * 校验用户画像数据
 */
// 校验并判断 validateProfile 对应的状态
function validateProfile(data: unknown) {
  return UserProfileSchema.parse(data);
}

/**
 * 校验会话数据
 */
// 校验并判断 validateConversation 对应的状态
function validateConversation(data: unknown) {
  return ConversationSchema.parse(data);
}

/**
 * 校验会话数组
 */
// 校验并判断 validateConversationList 对应的状态
function validateConversationList(data: unknown) {
  return z.array(ConversationSchema).parse(data);
}

/**
 * 校验消息分页数据
 */
// 校验并判断 validateMessagesPage 对应的状态
function validateMessagesPage(data: unknown) {
  return MessagesPageSchema.parse(data);
}

/**
 * 校验记忆数据
 */
// 校验并判断 validateMemory 对应的状态
function validateMemory(data: unknown) {
  return MemorySchema.parse(data);
}

/**
 * 校验记忆数组
 */
// 校验并判断 validateMemoryList 对应的状态
function validateMemoryList(data: unknown) {
  return z.array(MemorySchema).parse(data);
}

/**
 * 校验搜索结果
 */
// 校验并判断 validateSearchResponse 对应的状态
function validateSearchResponse(data: unknown) {
  return SearchResponseSchema.parse(data);
}

// ============ HTTP 客户端 ============

export interface MemoryGatewayClientOptions {
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
}

/**
 * Cloudflare Memory Gateway HTTP 客户端
 *
 * 负责：
 * - 服务间鉴权（Bearer Secret）
 * - 请求超时控制
 * - 统一错误码映射
 * - 所有 Gateway API 端点调用
 */
export class CloudflareMemoryClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;

  // 初始化当前对象
  constructor(options: MemoryGatewayClientOptions = {}) {
    this.baseUrl = (options.baseUrl || "").replace(/\/$/, "");
    this.secret = options.secret || "";
    this.timeoutMs = options.timeoutMs || 5_000;
  }

  // ============ 内部请求方法 ============

  /**
   * 发送 HTTP 请求到 Gateway
   * @param method HTTP 方法
   * @param path 请求路径（不含 baseUrl）
   * @param body 请求体（可选）
   * @param idempotencyKey 幂等性键（可选）
   */
  // 执行 request 对应的业务逻辑
  private async request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secret}`,
      "Content-Type": "application/json",
    };
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      // 读取响应体（即使非 JSON）
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }

      // 错误码映射
      if (response.status === 401) {
        throw new MemoryGatewayError(
          "MEMORY_UNAUTHENTICATED",
          "缺少或无效的认证凭证",
          401,
        );
      }
      if (response.status === 403) {
        throw new MemoryGatewayError("MEMORY_FORBIDDEN", "无权访问该资源", 403);
      }
      if (response.status === 404) {
        const errData = parsed as any;
        throw new MemoryGatewayError(
          errData?.error?.code || "MEMORY_NOT_FOUND",
          errData?.error?.message || "资源不存在",
          404,
        );
      }
      if (response.status === 409) {
        const errData = parsed as any;
        throw new MemoryGatewayError(
          "MEMORY_CONFLICT",
          errData?.error?.message || "数据冲突",
          409,
        );
      }

      if (!response.ok) {
        const errData = parsed as any;
        throw new MemoryGatewayError(
          errData?.error?.code || "MEMORY_INTERNAL_ERROR",
          errData?.error?.message || `HTTP ${response.status}`,
          response.status,
        );
      }

      // 校验响应信封格式
      validateGatewayResponse(parsed);
      return parsed;
    } catch (error) {
      if (error instanceof MemoryGatewayError) throw error;
      if ((error as any)?.name === "AbortError") {
        throw new MemoryGatewayError(
          "MEMORY_TIMEOUT",
          "请求 Gateway 超时",
          408,
        );
      }
      throw new MemoryGatewayError(
        "MEMORY_INTERNAL_ERROR",
        (error as Error).message || "网络请求失败",
        500,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============ Profile API ============

  /**
   * 获取用户画像
   * @returns 画像数据，不存在时返回 null
   */
  // 获取 getProfile 对应的数据
  async getProfile(userId: string): Promise<UserProfileData | null> {
    try {
      const result = validateGatewayResponse(await this.request(
        "GET",
        `/internal/v1/users/${encodeURIComponent(userId)}/profile`,
      )) as { data: unknown };
      return result.data ? validateProfile(result.data) : null;
    } catch (error) {
      if ((error as MemoryGatewayError).code === "MEMORY_USER_NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  /**
   * 创建或更新用户画像
   */
  // 更新或保存 putProfile 对应的数据
  async putProfile(
    userId: string,
    name?: string,
    preferences?: Record<string, unknown>,
  ): Promise<UserProfileData> {
    const body: Record<string, unknown> = {};
    if (name !== undefined) {
      body.name = name;
    }
    if (preferences !== undefined) {
      body.preferences = preferences;
    }
    const result = validateGatewayResponse(await this.request(
      "PUT",
      `/internal/v1/users/${encodeURIComponent(userId)}/profile`,
      body,
    )) as { data: unknown };
    return validateProfile(result.data);
  }

  // ============ Conversation API ============

  /**
   * 创建会话
   */
  // 创建或注册 createConversation 所需的数据
  async createConversation(
    userId: string,
    title: string,
    mode: string = "chat",
    conversationId?: string,
  ): Promise<ConversationData> {
    const body: Record<string, string> = { user_id: userId, title, mode };
    if (conversationId) body.id = conversationId;
    const result = validateGatewayResponse(await this.request(
      "POST",
      "/internal/v1/conversations",
      body,
    )) as { data: unknown };
    return validateConversation(result.data);
  }

  /**
   * 列出用户的会话（分页）
   */
  // 获取 listConversations 对应的数据
  async listConversations(
    userId: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<ConversationData[]> {
    const result = validateGatewayResponse(await this.request(
      "GET",
      `/internal/v1/users/${encodeURIComponent(userId)}/conversations?limit=${limit}&offset=${offset}`,
    )) as { data: unknown };
    return validateConversationList(result.data);
  }

  /**
   * 获取会话详情
   */
  // 获取 getConversation 对应的数据
  async getConversation(
    conversationId: string,
  ): Promise<ConversationData | null> {
    try {
      const result = validateGatewayResponse(await this.request(
        "GET",
        `/internal/v1/conversations/${encodeURIComponent(conversationId)}`,
      )) as { data: unknown };
      return result.data ? validateConversation(result.data) : null;
    } catch (error) {
      if ((error as MemoryGatewayError).code === "MEMORY_CONVERSATION_NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  /**
   * 删除会话（软删除）
   */
  // 删除或清理 deleteConversation 对应的数据
  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      await this.request(
        "DELETE",
        `/internal/v1/conversations/${encodeURIComponent(conversationId)}`,
      );
      return true;
    } catch (error) {
      if ((error as MemoryGatewayError).code === "MEMORY_CONVERSATION_NOT_FOUND") {
        return false;
      }
      throw error;
    }
  }

  // ============ Message API ============

  /**
   * 批量写入消息
   */
  // 创建或注册 createMessagesBatch 所需的数据
  async createMessagesBatch(
    conversationId: string,
    userId: string,
    messages: Record<string, unknown>[],
  ): Promise<void> {
    await this.request(
      "POST",
      `/internal/v1/conversations/${encodeURIComponent(conversationId)}/messages:batch`,
      { user_id: userId, messages },
    );
  }

  /**
   * 获取会话消息列表
   */
  // 获取 getMessages 对应的数据
  async getMessages(
    conversationId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<MessagesPageData> {
    const result = validateGatewayResponse(await this.request(
      "GET",
      `/internal/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}&offset=${offset}`,
    )) as { data: unknown };
    return validateMessagesPage(result.data);
  }

  /**
   * 清空会话消息
   */
  // 删除或清理 clearMessages 对应的数据
  async clearMessages(conversationId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/internal/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
  }

  // ============ Memory API ============

  /**
   * 保存记忆（幂等）
   * @param memoryId 记忆 ID（建议 UUID/ULID）
   * @param idempotencyKey 幂等性键，相同键+相同内容幂等返回
   */
  // 更新或保存 saveMemory 对应的数据
  async saveMemory(
    userId: string,
    memoryId: string,
    content: string,
    category: string = "fact",
    importance: number = 3,
    source: string = "user_explicit",
    sourceConversationId?: string,
    idempotencyKey?: string,
  ): Promise<MemoryData> {
    const result = validateGatewayResponse(await this.request(
      "PUT",
      `/internal/v1/users/${encodeURIComponent(userId)}/memories/${encodeURIComponent(memoryId)}`,
      {
        content,
        category,
        importance,
        source,
        source_conversation_id: sourceConversationId ?? null,
      },
      idempotencyKey,
    )) as { data: unknown };
    return validateMemory(result.data);
  }

  /**
   * 列出用户的长期记忆
   */
  // 获取 listMemories 对应的数据
  async listMemories(
    userId: string,
    options: { category?: string; limit?: number } = {},
  ): Promise<MemoryData[]> {
    const params = new URLSearchParams();
    if (options.category) params.set("category", options.category);
    params.set("limit", String(options.limit ?? 50));
    const result = validateGatewayResponse(await this.request(
      "GET",
      `/internal/v1/users/${encodeURIComponent(userId)}/memories?${params.toString()}`,
    )) as { data: unknown };
    return validateMemoryList(result.data);
  }

  /**
   * 更新记忆
   */
  // 更新或保存 updateMemory 对应的数据
  async updateMemory(
    userId: string,
    memoryId: string,
    changes: { content?: string; category?: string; importance?: number },
  ): Promise<MemoryData | null> {
    try {
      const result = validateGatewayResponse(await this.request(
        "PATCH",
        `/internal/v1/users/${encodeURIComponent(userId)}/memories/${encodeURIComponent(memoryId)}`,
        changes,
      )) as { data: unknown };
      return result.data ? validateMemory(result.data) : null;
    } catch (error) {
      if ((error as MemoryGatewayError).code === "MEMORY_NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  /**
   * 删除记忆（软删除）
   */
  // 删除或清理 deleteMemory 对应的数据
  async deleteMemory(userId: string, memoryId: string): Promise<boolean> {
    try {
      await this.request(
        "DELETE",
        `/internal/v1/users/${encodeURIComponent(userId)}/memories/${encodeURIComponent(memoryId)}`,
      );
      return true;
    } catch (error) {
      if ((error as MemoryGatewayError).code === "MEMORY_NOT_FOUND") {
        return false;
      }
      throw error;
    }
  }

  /**
   * 语义搜索记忆
   * @returns 搜索结果对象 { items, degraded }
   */
  // 查询 searchMemories 对应的结果
  async searchMemories(
    userId: string,
    query: string,
    options: { category?: string; limit?: number; minScore?: number } = {},
  ): Promise<SearchResponseData> {
    const body: Record<string, unknown> = {
      query,
      limit: options.limit ?? 10,
      min_score: options.minScore ?? 0.65,
    };
    if (options.category) {
      body.category = options.category;
    }
    const result = validateGatewayResponse(await this.request(
      "POST",
      `/internal/v1/users/${encodeURIComponent(userId)}/memories:search`,
      body,
    )) as { data: unknown };
    return validateSearchResponse(result.data);
  }

  // ============ Document API ==========

  /**
   * 上传文档
   */
  // 创建或注册 uploadDocument 所需的数据
  async uploadDocument(
    userId: string,
    filename: string,
    content: string, // base64 encoded
    fileType?: string,
    category = "general",
  ): Promise<DocumentData> {
    const body: Record<string, unknown> = {
      user_id: userId,
      filename,
      content,
      category,
    };
    if (fileType) body.file_type = fileType;

    const result = validateGatewayResponse(await this.request(
      "POST",
      "/internal/v1/documents",
      body,
    )) as { data: unknown };
    return (result.data as { document: DocumentData }).document;
  }

  /**
   * 列出用户文档
   */
  // 获取 listDocuments 对应的数据
  async listDocuments(
    userId: string,
    options: { limit?: number; offset?: number; category?: string } = {},
  ): Promise<{ documents: DocumentData[]; total: number }> {
    const params = new URLSearchParams();
    params.set("user_id", userId);
    if (options.category) params.set("category", options.category);
    params.set("limit", String(options.limit ?? 20));
    params.set("offset", String(options.offset ?? 0));

    const result = validateGatewayResponse(await this.request(
      "GET",
      `/internal/v1/documents?${params.toString()}`,
    )) as { data: { documents: DocumentData[]; total: number } };
    return result.data;
  }

  /**
   * 获取文档详情
   */
  // 获取 getDocument 对应的数据
  async getDocument(documentId: string): Promise<{ document: DocumentData; chunks: ChunkData[] } | null> {
    try {
      const result = validateGatewayResponse(await this.request(
        "GET",
        `/internal/v1/documents/${encodeURIComponent(documentId)}`,
      )) as { data: { document: DocumentData; chunks: ChunkData[] } };
      return result.data;
    } catch (error) {
      if ((error as MemoryGatewayError).code === "DOCUMENT_NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  /**
   * 删除文档
   */
  // 删除或清理 deleteDocument 对应的数据
  async deleteDocument(documentId: string): Promise<boolean> {
    try {
      await this.request(
        "DELETE",
        `/internal/v1/documents/${encodeURIComponent(documentId)}`,
      );
      return true;
    } catch (error) {
      if ((error as MemoryGatewayError).code === "DOCUMENT_NOT_FOUND") {
        return false;
      }
      throw error;
    }
  }

  // 请求 Gateway 原地重建文档索引并保留文档 ID
  async reindexDocument(documentId: string): Promise<{ chunk_count: number; degraded: boolean }> {
    const result = validateGatewayResponse(await this.request(
      "POST",
      `/internal/v1/documents/${encodeURIComponent(documentId)}/reindex`,
    )) as { data: { chunk_count: number; degraded: boolean } };
    return result.data;
  }

  /**
   * 语义搜索文档
   */
  // 查询 searchDocuments 对应的结果
  async searchDocuments(
    userId: string,
    query: string,
    options: { limit?: number; minScore?: number } = {},
  ): Promise<DocumentSearchResponseData> {
    const body: Record<string, unknown> = {
      user_id: userId,
      query,
      limit: options.limit ?? 5,
      min_score: options.minScore ?? 0.6,
    };
    const result = validateGatewayResponse(await this.request(
      "POST",
      "/internal/v1/documents:search",
      body,
    )) as { data: { results: DocumentSearchResultData[]; degraded: boolean } };
    return {
      results: result.data.results,
      degraded: result.data.degraded,
    };
  }

  // ============ Audit Log API ==========

  /**
   * 批量写入审计日志（异步，不阻塞工具执行）
   */
  // 更新或保存 writeAuditLogs 对应的数据
  async writeAuditLogs(
    entries: Array<{
      user_id: string;
      tenant_id: string;
      conversation_id: string;
      tool_name: string;
      tool_version: string;
      risk_level: string;
      ok: boolean;
      error_code?: string;
      duration_ms: number;
      request_id: string;
      trace_id: string;
    }>,
  ): Promise<void> {
    try {
      await this.request(
        "POST",
        "/internal/v1/audit-logs",
        { entries },
      );
    } catch {
      // 审计日志写入失败不影响主流程
    }
  }

  // ============ Tool Metrics API ==========

  /**
   * 批量写入工具指标（异步，不阻塞工具执行）
   */
  // 更新或保存 writeToolMetrics 对应的数据
  async writeToolMetrics(
    entries: Array<{
      tool_name: string;
      tool_version: string;
      ok: boolean;
      error_code?: string;
      duration_ms: number;
      risk_level: string;
      user_id: string;
      tenant_id: string;
    }>,
  ): Promise<void> {
    try {
      await this.request(
        "POST",
        "/internal/v1/tool-metrics",
        { entries },
      );
    } catch {
      // 指标写入失败不影响主流程
    }
  }
}
