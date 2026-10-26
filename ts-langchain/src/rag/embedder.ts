/**
 * RAG 向量化器
 * 使用 OpenAI Embedding 模型
 */

import OpenAI from "openai";
import { getModelConfiguration } from "../config/model.js";

export interface EmbeddingOptions {
  model?: string;
  dimensions?: number;
}

export class Embedder {
  private client: OpenAI;
  private model: string;
  private dimensions: number;

  // 初始化 OpenAI Embedding 客户端
  constructor(options: EmbeddingOptions = {}) {
    this.client = new OpenAI({
      ...getModelConfiguration(),
    });
    this.model = options.model || "text-embedding-3-small";
    this.dimensions = options.dimensions || 1536;
  }

  // 将文本向量化
  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    });

    return response.data[0].embedding;
  }

  // 批量向量化
  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
    });

    // 从嵌入接口响应中提取向量数组
    return response.data.map((d) => d.embedding);
  }
}
