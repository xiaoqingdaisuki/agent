/**
 * RAG 检索器 — Cloudflare Service（通过 Memory Gateway）
 *
 * 封装文档向量搜索，对外提供统一接口。
 * 所有向量操作通过 Cloudflare Service Gateway 进行。
 */

import { VectorStore, SearchResult } from "./vector-store.js";

export interface RetrieverOptions {
  /** Cloudflare Memory Gateway 地址（可选） */
  baseUrl?: string;
  /** Gateway 认证密钥 */
  secret?: string;
  /** 返回条数 */
  topK?: number;
}

export class Retriever {
  private vectorStore: VectorStore;
  private topK: number;
  private userId: string;

  // 初始化检索器
  constructor(options: RetrieverOptions, userId: string) {
    this.vectorStore = new VectorStore({
      baseUrl: options.baseUrl,
      secret: options.secret,
    });
    this.topK = options.topK || 5;
    this.userId = userId;
  }

  /**
   * 检索相关文档
   */
  async retrieve(
    query: string,
    topK: number = this.topK,
  ): Promise<SearchResult[]> {
    return this.vectorStore.search(this.userId, query, topK);
  }

  /**
   * 批量检索
   */
  async retrieveBatch(
    queries: string[],
  ): Promise<Array<SearchResult & { query: string }>> {
    const results = await Promise.all(queries.map((q) => this.retrieve(q)));
    return results.flat().map((r, i) => ({
      ...r,
      query: queries[Math.floor(i / this.topK)],
    }));
  }
}
