/**
 * RAG 向量存储 — Qdrant
 * 使用 @qdrant/js-client-rest 直接调用 Qdrant REST API
 */

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  collectionName: string;
}

export interface SearchResult {
  content: string;
  score: number;
  metadata: Record<string, any>;
}

export class VectorStore {
  private baseUrl: string;
  private apiKey?: string;
  private collectionName: string;

  // 初始化 Qdrant 向量存储客户端
  constructor(config: QdrantConfig) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.collectionName = config.collectionName;
  }

  /**
   * 确保 collection 存在
   */
  async ensureCollection(dimensions: number): Promise<void> {
    const url = `${this.baseUrl}/collections/${this.collectionName}`;

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { "api-key": this.apiKey } : {}),
      },
      body: JSON.stringify({
        vectors: {
          size: dimensions,
          distance: "Cosine",
        },
      }),
    });

    if (!response.ok && response.status !== 409) {
      throw new Error(`Failed to create collection: ${response.statusText}`);
    }
  }

  /**
   * 添加文档
   */
  async addDocuments(
    documents: Array<{ content: string; metadata: Record<string, any> }>,
    embeddings: number[][]
  ): Promise<void> {
    await this.ensureCollection(embeddings[0]?.length || 1536);

    const points = documents.map((doc, i) => ({
      id: crypto.randomUUID(),
      vector: embeddings[i],
      payload: {
        content: doc.content,
        metadata: doc.metadata,
      },
    }));

    const url = `${this.baseUrl}/collections/${this.collectionName}/points`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { "api-key": this.apiKey } : {}),
      },
      body: JSON.stringify({ points }),
    });

    if (!response.ok) {
      throw new Error(`Failed to add documents: ${response.statusText}`);
    }
  }

  /**
   * 搜索相似文档
   */
  async search(queryVector: number[], topK: number = 5): Promise<SearchResult[]> {
    const url = `${this.baseUrl}/collections/${this.collectionName}/points/search`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { "api-key": this.apiKey } : {}),
      },
      body: JSON.stringify({
        vector: queryVector,
        limit: topK,
        with_payload: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to search: ${response.statusText}`);
    }

    const data = await response.json();

    return data.result?.map((r: any) => ({
      content: r.payload?.content || "",
      score: r.score,
      metadata: r.payload?.metadata || {},
    })) || [];
  }

  async deleteDocuments(documentId: string): Promise<void> {
    const url = `${this.baseUrl}/collections/${this.collectionName}/points/delete?wait=true`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { "api-key": this.apiKey } : {}),
      },
      body: JSON.stringify({
        filter: {
          must: [{ key: "metadata.document_id", match: { value: documentId } }],
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to delete document vectors: ${response.statusText}`);
    }
  }

  /**
   * 删除 collection
   */
  async deleteCollection(): Promise<void> {
    const url = `${this.baseUrl}/collections/${this.collectionName}`;
    await fetch(url, {
      method: "DELETE",
      headers: {
        ...(this.apiKey ? { "api-key": this.apiKey } : {}),
      },
    });
  }
}
