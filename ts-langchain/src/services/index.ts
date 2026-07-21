/**
 * Service Layer — 业务逻辑编排
 *
 * 职责：
 * 1. 编排 Agent / RAG / 工具的调用
 * 2. 将内部返回转换为前端友好的格式
 * 3. 错误转换（内部错误 → 业务错误码）
 * 4. 与 API 层解耦，前端看不到内部实现
 */

import { createChatAgent } from "../agents/chat-agent.js";
import { createToolAgent } from "../agents/tool-agent.js";
import { getHistory, clearHistory } from "../memory/conversation.js";
import { RAGAgent } from "../rag/rag-agent.js";
import { DocumentLoader } from "../rag/loader.js";
import { TextSplitter } from "../rag/splitter.js";

// ============ 类型定义 ============

export interface Conversation {
  id: string;
  title: string;
  mode: "chat" | "knowledge" | "mixed";
  createdAt: string;
  messageCount: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface Document {
  id: string;
  name: string;
  size: number;
  status: "indexing" | "indexed" | "failed";
  chunks: number;
  category?: string;
  createdAt: string;
}

export interface SearchResult {
  document_id: string;
  document_name: string;
  content: string;
  score: number;
  page?: number;
}

export interface Capabilities {
  modes: string[];
  knowledge: {
    enabled: boolean;
    categories: string[];
  };
  tools: Array<{
    name: string;
    description: string;
    available: boolean;
  }>;
}

// ============ 错误码 ============

export enum BusinessErrorCode {
  INVALID_REQUEST = "INVALID_REQUEST",
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  NOT_FOUND = "NOT_FOUND",
  SESSION_EXPIRED = "SESSION_EXPIRED",
  RATE_LIMITED = "RATE_LIMITED",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
}

export class BusinessError extends Error {
  constructor(
    public code: BusinessErrorCode | string,
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = "BusinessError";
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
      },
    };
  }
}

// ============ Conversation Service ============

const conversations = new Map<string, Conversation>();

export class ConversationService {
  static create(title: string, mode: "chat" | "knowledge" | "mixed" = "chat"): Conversation {
    const id = crypto.randomUUID();
    const conversation: Conversation = {
      id,
      title,
      mode,
      createdAt: new Date().toISOString(),
      messageCount: 0,
    };
    conversations.set(id, conversation);
    return conversation;
  }

  static get(id: string): Conversation | undefined {
    return conversations.get(id);
  }

  static list(): Conversation[] {
    return Array.from(conversations.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  static delete(id: string): boolean {
    clearHistory(id);
    return conversations.delete(id);
  }

  static appendUserMessage(conversationId: string, content: string): Message {
    const conv = conversations.get(conversationId);
    if (!conv) throw new BusinessError(BusinessErrorCode.NOT_FOUND, "Conversation not found", 404);

    const msg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    conv.messageCount++;
    return msg;
  }
}

// ============ Agent Service ============

export class AgentService {
  private static chatAgent: ReturnType<typeof createChatAgent> | null = null;
  private static toolAgent: ReturnType<typeof createToolAgent> | null = null;

  private static getChatAgent() {
    if (!this.chatAgent) this.chatAgent = createChatAgent();
    return this.chatAgent;
  }

  private static getToolAgent() {
    if (!this.toolAgent) this.toolAgent = createToolAgent();
    return this.toolAgent;
  }

  static async chat(conversationId: string, content: string): Promise<Message> {
    try {
      const history = getHistory(conversationId);
      const input = { input: content, chat_history: history };

      const agent = this.getToolAgent();
      const result = await (agent as any).invoke(input);

      const reply: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: (result.output as string) || "抱歉，我没有理解您的问题。",
        createdAt: new Date().toISOString(),
      };

      return reply;
    } catch (error: any) {
      if (error.message?.includes("API key")) {
        throw new BusinessError(
          BusinessErrorCode.SERVICE_UNAVAILABLE,
          "AI 服务配置异常，请联系管理员",
          503
        );
      }
      if (error.message?.includes("rate limit") || error.message?.includes("429")) {
        throw new BusinessError(
          BusinessErrorCode.SERVICE_UNAVAILABLE,
          "AI 服务暂时繁忙，请稍后重试",
          503
        );
      }
      throw new BusinessError(
        BusinessErrorCode.INTERNAL_ERROR,
        "处理请求时发生错误，请稍后重试",
        500
      );
    }
  }

  static async *chatStream(
    conversationId: string,
    content: string
  ): AsyncGenerator<string, void, unknown> {
    try {
      const agent = this.getToolAgent();
      const input = { input: content, chat_history: [] };
      const stream = await (agent as any).stream(input, { tags: ["stream"] });

      for await (const chunk of stream) {
        if (chunk?.output) {
          yield chunk.output;
        }
      }
    } catch (error: any) {
      if (error.message?.includes("rate limit")) {
        throw new BusinessError(
          BusinessErrorCode.SERVICE_UNAVAILABLE,
          "AI 服务暂时繁忙，请稍后重试",
          503
        );
      }
      throw new BusinessError(
        BusinessErrorCode.INTERNAL_ERROR,
        "处理请求时发生错误",
        500
      );
    }
  }
}

// ============ Knowledge Service ============

const documents = new Map<string, Document>();

export class KnowledgeService {
  private static ragAgent: RAGAgent | null = null;
  private static splitter = new TextSplitter();

  private static getRAGAgent() {
    if (!this.ragAgent) {
      this.ragAgent = new RAGAgent({
        qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
        collectionName: "documents",
      });
    }
    return this.ragAgent;
  }

  /**
   * 上传文档
   */
  static async uploadDocument(
    buffer: Buffer,
    filename: string,
    category?: string
  ): Promise<Document> {
    try {
      const doc = DocumentLoader.loadFromBuffer(buffer, filename);
      const chunks = this.splitter.split(doc);

      // 索引到向量库
      await this.getRAGAgent().indexDocument(doc.content, filename);

      const document: Document = {
        id: doc.id,
        name: filename,
        size: doc.metadata.size,
        status: "indexed",
        chunks: chunks.length,
        category,
        createdAt: new Date().toISOString(),
      };

      documents.set(document.id, document);
      return document;
    } catch (error: any) {
      throw new BusinessError(
        BusinessErrorCode.INTERNAL_ERROR,
        `文档上传失败: ${error.message}`,
        500
      );
    }
  }

  /**
   * 列出所有文档
   */
  static listDocuments(): Document[] {
    return Array.from(documents.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * 获取文档详情
   */
  static getDocument(id: string): Document | undefined {
    return documents.get(id);
  }

  /**
   * 删除文档
   */
  static deleteDocument(id: string): boolean {
    return documents.delete(id);
  }

  /**
   * 重新索引
   */
  static async reindexDocument(id: string): Promise<Document> {
    const doc = documents.get(id);
    if (!doc) {
      throw new BusinessError(BusinessErrorCode.NOT_FOUND, "Document not found", 404);
    }

    doc.status = "indexed";
    doc.chunks = Math.floor(doc.size / 800); // 估算
    return doc;
  }

  /**
   * 知识检索
   */
  static async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    try {
      const results = await this.getRAGAgent()["retriever"].retrieve(query);

      return results.map((r) => ({
        document_id: r.metadata.source,
        document_name: r.metadata.filename,
        content: r.content,
        score: r.score,
        page: r.metadata.chunkIndex,
      }));
    } catch (error: any) {
      throw new BusinessError(
        BusinessErrorCode.SERVICE_UNAVAILABLE,
        "知识库检索失败，请稍后重试",
        503
      );
    }
  }
}

// ============ Capabilities Service ============

export class CapabilitiesService {
  static getCapabilities(): Capabilities {
    return {
      modes: ["chat", "knowledge", "mixed"],
      knowledge: {
        enabled: true,
        categories: ["hr", "product", "tech"],
      },
      tools: [
        { name: "weather", description: "天气查询", available: true },
        { name: "calculator", description: "计算器", available: true },
      ],
    };
  }
}
