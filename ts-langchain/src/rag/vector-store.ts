/**
 * RAG 向量存储 — Cloudflare Service（通过 Memory Gateway）
 *
 * 文档向量存储在 Cloudflare Service 的 Vectorize 索引中，
 * 本模块作为 Gateway 的客户端封装，提供统一的向量搜索接口。
 */

import { CloudflareMemoryClient } from "../clients/memory_gateway.js";

export interface CloudflareVectorStoreConfig {
  /** Cloudflare Memory Gateway 地址（可选，默认从环境变量读取） */
  baseUrl?: string;
  /** Gateway 认证密钥 */
  secret?: string;
  /** 集合名称（保持接口兼容，实际不使用） */
  collectionName?: string;
}

export interface SearchResult {
  content: string;
  score: number;
  metadata: Record<string, any>;
}

/**
 * CloudflareVectorStore — 通过 Gateway 操作文档向量
 */
export class VectorStore {
  private client: CloudflareMemoryClient;

  constructor(config: CloudflareVectorStoreConfig) {
    this.client = new CloudflareMemoryClient({
      baseUrl: config.baseUrl,
      secret: config.secret,
    });
  }

  /**
   * 确保 collection 存在（Cloudflare Vectorize 无需手动创建，此方法为空操作）
   */
  async ensureCollection(_dimensions: number): Promise<void> {
    // Vectorize index 在 cloudflare-service 部署时已创建，无需前端调用
    return;
  }

  /**
   * 上传文档（通过 Gateway）
   */
  async uploadDocument(
    userId: string,
    filename: string,
    content: string, // base64 encoded
    fileType?: string,
    category = "general",
  ): Promise<any> {
    return this.client.uploadDocument(userId, filename, content, fileType, category);
  }

  /**
   * 搜索相似文档
   */
  async search(
    userId: string,
    query: string,
    topK: number = 5,
  ): Promise<SearchResult[]> {
    const result = await this.client.searchDocuments(userId, query, { limit: topK });
    return result.results.map((r: any) => ({
      content: r.content,
      score: r.score,
      metadata: r.metadata || {},
    }));
  }

  /**
   * 删除文档
   */
  async deleteDocument(documentId: string): Promise<void> {
    await this.client.deleteDocument(documentId);
  }

  /**
   * 删除 collection（Cloudflare Vectorize 不支持前端删除，此方法为兼容接口）
   */
  async deleteCollection(): Promise<void> {
    return;
  }

  /**
   * 列出用户文档
   */
  async listDocuments(userId: string, limit = 20, offset = 0): Promise<any> {
    return this.client.listDocuments(userId, { limit, offset });
  }

  /**
   * 获取文档详情
   */
  async getDocument(documentId: string): Promise<any> {
    return this.client.getDocument(documentId);
  }
}
