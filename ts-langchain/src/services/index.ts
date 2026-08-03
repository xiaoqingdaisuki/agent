/**
 * Service Layer — 业务逻辑编排
 *
 * 职责：
 * 1. 编排 Agent / RAG / 工具的调用
 * 2. 将内部返回转换为前端友好的格式
 * 3. 错误转换（内部错误 → 业务错误码）
 * 4. 与 API 层解耦，前端看不到内部实现
 */

import { createToolAgent } from "../agents/tool-agent.js";
import { getHistory, clearHistory, appendMessage } from "../memory/conversation.js";
import { RAGAgent } from "../rag/rag-agent.js";
import { DocumentLoader } from "../rag/loader.js";
import { TextSplitter } from "../rag/splitter.js";
import { MemoryService, ProfileService, HistoryService } from "../profile/service.js";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createToolCallScope, runWithToolCallContext } from "../tools/runtime/executor.js";
import {
  clearAgentCommandState,
  executeAgentCommand,
  getAgentPromptOverride,
} from "../commands/index.js";
import {
  AgentDeadline,
  isAgentDeadlineError,
  runWithAgentDeadline,
} from "../agents/deadline.js";

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

export type AgentStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool"; toolName: string; status: "started" | "completed" | "failed"; durationMs?: number };

class ToolProgressChannel {
  private readonly events: Array<Extract<AgentStreamEvent, { type: "tool" }>> = [];
  private readonly waiters = new Set<(event: Extract<AgentStreamEvent, { type: "tool" }>) => void>();

  push(event: Extract<AgentStreamEvent, { type: "tool" }>): void {
    const waiter = this.waiters.values().next().value as
      | ((nextEvent: Extract<AgentStreamEvent, { type: "tool" }>) => void)
      | undefined;
    if (waiter) {
      waiter(event);
      return;
    }
    this.events.push(event);
  }

  take(): { promise: Promise<Extract<AgentStreamEvent, { type: "tool" }>>; cancel: () => void } {
    const queued = this.events.shift();
    if (queued) return { promise: Promise.resolve(queued), cancel: () => undefined };

    let resolve!: (event: Extract<AgentStreamEvent, { type: "tool" }>) => void;
    const promise = new Promise<Extract<AgentStreamEvent, { type: "tool" }>>((nextResolve) => {
      resolve = nextResolve;
    });
    const waiter = (event: Extract<AgentStreamEvent, { type: "tool" }>) => {
      this.waiters.delete(waiter);
      resolve(event);
    };
    this.waiters.add(waiter);
    return { promise, cancel: () => this.waiters.delete(waiter) };
  }

  drain(): Array<Extract<AgentStreamEvent, { type: "tool" }>> {
    return this.events.splice(0);
  }
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
  AGENT_TIMEOUT = "AGENT_TIMEOUT",
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
const conversationMessages = new Map<string, Message[]>();

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
    conversationMessages.set(id, []);
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
    clearAgentCommandState(id);
    conversationMessages.delete(id);
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
    conversationMessages.get(conversationId)!.push(msg);

    return msg;
  }

  static appendAssistantMessage(conversationId: string, message: Message): void {
    const messages = conversationMessages.get(conversationId);
    if (messages) messages.push(message);
  }

  static getMessages(conversationId: string): Message[] {
    return [...(conversationMessages.get(conversationId) ?? [])];
  }

  static clearMessages(conversationId: string): void {
    conversationMessages.set(conversationId, []);
    const conversation = conversations.get(conversationId);
    if (conversation) conversation.messageCount = 0;
    clearHistory(conversationId);
    clearAgentCommandState(conversationId);
  }
}

// ============ Agent Service ============

export class AgentService {
  static async chat(conversationId: string, content: string, userId?: string): Promise<Message> {
    try {
      const command = executeAgentCommand(content, conversationId);
      if (command) {
        const reply: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: command.reply,
          createdAt: new Date().toISOString(),
        };
        ConversationService.appendAssistantMessage(conversationId, reply);
        return reply;
      }

      const history = getHistory(conversationId);
      const memoryContext: SystemMessage[] = [];

      // 注入用户记忆
      if (userId) {
        try {
          ProfileService.getOrCreate(userId);
          const context = MemoryService.buildMemoryContext(userId);
          if (context) memoryContext.push(new SystemMessage(context));
        } catch {
          // 记忆模块不可用时静默降级
        }
      }

      const conversation = ConversationService.get(conversationId);
      const agent = conversation?.mode === "knowledge"
        ? null
        : await createToolAgent(getAgentPromptOverride(conversationId, content));

      // 设置工具调用上下文，确保 invokeTool 管线能获取到 user_id 等信息
      const toolContext = {
        request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        trace_id: `trace_${Date.now()}`,
        conversation_id: conversationId,
        tenant_id: "",
        user_id: userId || "anonymous",
        actor_type: "user",
      } as const;

      const result = await runWithAgentDeadline<any>((deadline) =>
        conversation?.mode === "knowledge"
          ? KnowledgeService.chat(content, history)
          : runWithToolCallContext(
              toolContext,
              () => (agent as any).invoke(
                {
                  input: content,
                  chat_history: history,
                  memory_context: memoryContext,
                },
                { signal: deadline.signal },
              ),
              { onToolProgress: (event) => event.type === "started" && deadline.enableToolBudget() },
            ),
      );

      const reply: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: (result.output as string) || "抱歉，我没有理解您的问题。",
        createdAt: new Date().toISOString(),
      };

      appendMessage(conversationId, new HumanMessage(content));
      appendMessage(conversationId, new AIMessage(reply.content));
      ConversationService.appendAssistantMessage(conversationId, reply);

      // 记录问答历史 + 提取新记忆
      if (userId) {
        try {
          HistoryService.record(userId, conversationId, content, reply.content);
          MemoryService.extractMemoriesFromConversation(userId, content, reply.content);
          ProfileService.update(userId);
        } catch {
          // 记忆记录失败不影响主流程
        }
      }

      return reply;
    } catch (error: any) {
      if (error instanceof BusinessError) throw error;
      if (isAgentDeadlineError(error)) {
        throw new BusinessError(
          BusinessErrorCode.AGENT_TIMEOUT,
          "AI助手响应超时，请稍后重试。",
          504,
        );
      }
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
    content: string,
    userId?: string
  ): AsyncGenerator<AgentStreamEvent, void, unknown> {
    try {
      const command = executeAgentCommand(content, conversationId);
      if (command) {
        const reply: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: command.reply,
          createdAt: new Date().toISOString(),
        };
        ConversationService.appendAssistantMessage(conversationId, reply);
        yield { type: "text", text: command.reply };
        return;
      }

      const history = getHistory(conversationId);
      const memoryContext: SystemMessage[] = [];

      if (userId) {
        try {
          ProfileService.getOrCreate(userId);
          const context = MemoryService.buildMemoryContext(userId);
          if (context) memoryContext.push(new SystemMessage(context));
        } catch {
          // memory module unavailable
        }
      }

      const agent = await createToolAgent(getAgentPromptOverride(conversationId, content));

      const toolContext = {
        request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        trace_id: `trace_${Date.now()}`,
        conversation_id: conversationId,
        tenant_id: "",
        user_id: userId || "anonymous",
        actor_type: "user",
      } as const;

      const deadline = new AgentDeadline();
      const progress = new ToolProgressChannel();
      const scope = createToolCallScope(toolContext, {
        onToolProgress: (event) => {
          if (event.type === "started") deadline.enableToolBudget();
          progress.push({
            type: "tool",
            toolName: event.toolName,
            status: event.type,
            durationMs: event.durationMs,
          });
        },
      });
      let fullAnswer = "";
      try {
        const stream = await deadline.run<any>(scope.run(() => (agent as any).stream(
          { input: content, chat_history: history, memory_context: memoryContext },
          { tags: ["stream"], signal: deadline.signal },
        )));
        const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<any>;
        let next = scope.run(() => iterator.next()) as Promise<IteratorResult<any>>;

        while (true) {
          const pendingProgress = progress.take();
          const winner = await deadline.run(Promise.race([
            next.then((result) => ({ kind: "agent" as const, result })),
            pendingProgress.promise.then((event) => ({ kind: "tool" as const, event })),
          ]));
          pendingProgress.cancel();
          if (winner.kind === "tool") {
            yield winner.event;
            continue;
          }

          const { value: chunk, done } = winner.result;
          if (done) break;
          if (chunk?.output) {
            const text = String(chunk.output);
            fullAnswer += text;
            yield { type: "text", text };
          }
          next = scope.run(() => iterator.next()) as Promise<IteratorResult<any>>;
        }
        for (const event of progress.drain()) yield event;
      } finally {
        deadline.dispose();
      }

      if (fullAnswer) {
        appendMessage(conversationId, new HumanMessage(content));
        appendMessage(conversationId, new AIMessage(fullAnswer));
        ConversationService.appendAssistantMessage(conversationId, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: fullAnswer,
          createdAt: new Date().toISOString(),
        });
      }

      // Record Q&A + extract memories
      if (userId && fullAnswer) {
        try {
          HistoryService.record(userId, conversationId, content, fullAnswer);
          MemoryService.extractMemoriesFromConversation(userId, content, fullAnswer);
          ProfileService.update(userId);
        } catch {
          // silent
        }
      }
    } catch (error: any) {
      if (error instanceof BusinessError) throw error;
      if (isAgentDeadlineError(error)) {
        throw new BusinessError(
          BusinessErrorCode.AGENT_TIMEOUT,
          "AI助手响应超时，请稍后重试。",
          504,
        );
      }
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
const documentContents = new Map<string, { content: string; filename: string }>();

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

  static async chat(content: string, history: any[] = []) {
    return this.getRAGAgent().chat(content, history);
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
      const doc = await DocumentLoader.loadFromBuffer(buffer, filename);
      const chunks = this.splitter.split(doc);

      // 索引到向量库
      await this.getRAGAgent().indexDocument(doc.content, filename, doc.id);

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
      documentContents.set(document.id, { content: doc.content, filename });
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
  static async deleteDocument(id: string): Promise<boolean> {
    if (!documents.has(id)) return false;
    await this.getRAGAgent().deleteDocument(id);
    documentContents.delete(id);
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

    const source = documentContents.get(id);
    if (!source) {
      throw new BusinessError(BusinessErrorCode.NOT_FOUND, "Document content not found", 404);
    }
    doc.status = "indexing";
    await this.getRAGAgent().deleteDocument(id);
    const result = await this.getRAGAgent().indexDocument(source.content, source.filename, id);
    doc.status = "indexed";
    doc.chunks = result.chunks;
    return doc;
  }

  /**
   * 知识检索
   */
  static async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    try {
      const results = await this.getRAGAgent()["retriever"].retrieve(query, topK);

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
