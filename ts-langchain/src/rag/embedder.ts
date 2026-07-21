/**
 * RAG 向量化器
 * 使用 OpenAI Embedding 模型
 */

import OpenAI from "openai";

export interface EmbeddingOptions {
  model?: string;
  dimensions?: number;
}

export class Embedder {
  private client: OpenAI;
  private model: string;
  private dimensions: number;

  constructor(options: EmbeddingOptions = {}) {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
    this.model = options.model || "text-embedding-3-small";
    this.dimensions = options.dimensions || 1536;
  }

  /**
   * 将文本向量化
   */
  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    });

    return response.data[0].embedding;
  }

  /**
   * 批量向量化
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
    });

    return response.data.map((d) => d.embedding);
  }
}
