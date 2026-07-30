/**
 * RAG 检索器
 * 封装向量搜索，对外提供统一接口
 */

import { Embedder } from "./embedder.js";
import { VectorStore, SearchResult } from "./vector-store.js";

export interface RetrieverOptions {
  qdrantUrl: string;
  collectionName: string;
  topK?: number;
}

export class Retriever {
  private embedder: Embedder;
  private vectorStore: VectorStore;
  private topK: number;

  constructor(options: RetrieverOptions) {
    this.embedder = new Embedder();
    this.vectorStore = new VectorStore({
      url: options.qdrantUrl,
      collectionName: options.collectionName,
    });
    this.topK = options.topK || 5;
  }

  /**
   * 检索相关文档
   */
  async retrieve(query: string, topK: number = this.topK): Promise<SearchResult[]> {
    const queryEmbedding = await this.embedder.embed(query);
    return this.vectorStore.search(queryEmbedding, topK);
  }

  /**
   * 批量检索
   */
  async retrieveBatch(queries: string[]): Promise<
    Array<SearchResult & { query: string }>
  > {
    const results = await Promise.all(queries.map((q) => this.retrieve(q)));
    return results.flat().map((r, i) => ({
      ...r,
      query: queries[Math.floor(i / this.topK)],
    }));
  }
}
