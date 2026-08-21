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
import {
  getHistoryBeforeInput,
  clearHistory,
  appendMessage,
} from "../memory/conversation.js";
import { DocumentLoader } from "../rag/loader.js";
import { TextSplitter } from "../rag/splitter.js";
import {
  MemoryService,
  ProfileService,
  HistoryService,
} from "../profile/service.js";
import { CloudflareMemoryClient, MemoryGatewayError } from "../clients/memory_gateway.js";
import { getRepositories } from "../repositories/index.js";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  createToolCallScope,
  runWithToolCallContext,
} from "../tools/runtime/executor.js";
import {
  clearAgentCommandState,
  executeAgentCommand,
  getDarkModeHistoryThreadId,
  getAgentPromptOverride,
  restoreAgentCommandState,
} from "../commands/index.js";
import {
  AgentDeadline,
  isClientAbortError,
  isAgentDeadlineError,
  runWithAgentDeadline,
} from "../agents/deadline.js";
import {
  getFinishReason,
  isLikelyTruncated,
  maybeAppendContinuationHint,
} from "../agents/response-handler.js";

// ============ 类型定义 ============

export interface Conversation {
  id: string;
  title: string;
  mode: "chat" | "knowledge" | "mixed";
  createdAt: string;
  messageCount: number;
  userId?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

export type AgentStreamEvent =
  | { type: "text"; text: string; partial?: boolean }
  | {
      type: "tool";
      toolName: string;
      status: "started" | "completed" | "failed";
      callId: string;
      durationMs?: number;
    };

const STREAM_FALLBACK_CHUNK_SIZE = 8;
const STREAM_FALLBACK_INTERVAL_MS = 18;

const backgroundTasks = new Set<Promise<void>>();
const backgroundChains = new Map<string, Promise<void>>();

// 将回答落库、历史记录和记忆提取移出流式响应关键路径。
function scheduleBackgroundTask(label: string, task: () => Promise<void>): void {
  const previous = backgroundChains.get(label);
  const work = new Promise<void>((resolve) => {
    setImmediate(() => {
      void (previous || Promise.resolve())
        .catch(() => undefined)
        .then(task)
        .catch((error) => {
          console.error(`[service] background task ${label} failed`, error);
        })
        .finally(resolve);
    });
  });
  backgroundTasks.add(work);
  backgroundChains.set(label, work);
  void work.finally(() => backgroundTasks.delete(work));
  void work.finally(() => {
    if (backgroundChains.get(label) === work) backgroundChains.delete(label);
  });
}

// 等待已排队的后台任务，供优雅停机和集成测试使用。
export async function flushBackgroundTasks(): Promise<void> {
  while (backgroundTasks.size > 0) {
    await Promise.all([...backgroundTasks]);
  }
}

// 从 LangChain 消息块中提取可展示的文本增量。
function getStreamText(chunk: any): string {
  const content = chunk?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) =>
      typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "",
    )
    .join("");
}

// 在回答生成后异步保存会话、历史和记忆，保证失败不影响已发送内容。
function scheduleAnswerPersistence(
  conversationId: string,
  agentHistoryThreadId: string,
  content: string,
  answer: string,
  userId?: string,
): void {
  scheduleBackgroundTask(`answer:${conversationId}`, async () => {
    await appendMessage(agentHistoryThreadId, new HumanMessage(content));
    await appendMessage(agentHistoryThreadId, new AIMessage(answer));
    await ConversationService.appendAssistantMessage(conversationId, {
      id: crypto.randomUUID(),
      role: "assistant",
      content: answer,
      createdAt: new Date().toISOString(),
    });
    if (userId) {
      await HistoryService.record(userId, conversationId, content, answer);
      await MemoryService.extractMemoriesFromConversation(userId, content, answer);
      await ProfileService.update(userId);
    }
  });
}

// 将模型完整回答按可见字符拆成平滑的 SSE 分片，避免依赖厂商工具流格式
async function* splitTextForStreaming(
  text: string,
): AsyncGenerator<string, void, unknown> {
  const characters = Array.from(text);
  for (let index = 0; index < characters.length; index += STREAM_FALLBACK_CHUNK_SIZE) {
    yield characters.slice(index, index + STREAM_FALLBACK_CHUNK_SIZE).join("");
    if (index + STREAM_FALLBACK_CHUNK_SIZE < characters.length) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, STREAM_FALLBACK_INTERVAL_MS),
      );
    }
  }
}

// 从会话消息存储恢复大公鸡模式，避免旧运行时缓存覆盖开关状态
async function restoreCommandStateFromConversation(
  conversationId: string,
): Promise<void> {
  const messages = await ConversationService.getMessages(conversationId);
  restoreAgentCommandState(
    conversationId,
    messages.flatMap((message) =>
      message.role === "user" ? [message.content] : [],
    ),
  );
}

class ToolProgressChannel {
  private readonly events: Array<Extract<AgentStreamEvent, { type: "tool" }>> =
    [];
  private readonly waiters = new Set<
    (event: Extract<AgentStreamEvent, { type: "tool" }>) => void
  >();

  // 推送一个工具进度事件，等待中的消费者优先消费
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

  // 取出一个待消费的工具进度事件，无事件时返回等待 Promise
  take(): {
    promise: Promise<Extract<AgentStreamEvent, { type: "tool" }>>;
    cancel: () => void;
  } {
    const queued = this.events.shift();
    if (queued)
      return { promise: Promise.resolve(queued), cancel: () => undefined };

    let resolve!: (event: Extract<AgentStreamEvent, { type: "tool" }>) => void;
    const promise = new Promise<Extract<AgentStreamEvent, { type: "tool" }>>(
      (nextResolve) => {
        resolve = nextResolve;
      },
    );
    // 执行 waiter 对应的业务逻辑
    const waiter = (event: Extract<AgentStreamEvent, { type: "tool" }>) => {
      this.waiters.delete(waiter);
      resolve(event);
    };
    this.waiters.add(waiter);
    return { promise, cancel: () => this.waiters.delete(waiter) };
  }

  // 清空所有未消费的工具进度事件
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
  chunk_index?: number;
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
  // 初始化当前对象
  constructor(
    public code: BusinessErrorCode | string,
    message: string,
    public statusCode: number = 500,
  ) {
    super(message);
    this.name = "BusinessError";
  }

  // 序列化错误详情为 JSON 格式
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
const DEFAULT_CONVERSATION_USER_ID = "anonymous";

export class ConversationService {
  // 创建新会话，分配唯一 ID 并初始化消息列表，同时持久化到 D1
  static async create(
    title: string,
    mode: "chat" | "knowledge" | "mixed" = "chat",
    userId: string = DEFAULT_CONVERSATION_USER_ID,
  ): Promise<Conversation> {
    const id = crypto.randomUUID();
    const conversation: Conversation = {
      id,
      title,
      mode,
      createdAt: new Date().toISOString(),
      messageCount: 0,
      userId,
    };
    conversations.set(id, conversation);
    conversationMessages.set(id, []);

    // 持久化到 D1
    try {
      const repos = getRepositories();
      await repos.conversation.create(userId, title, mode, id);
    } catch (err) {
      conversations.delete(id);
      conversationMessages.delete(id);
      throw new BusinessError(
        BusinessErrorCode.INTERNAL_ERROR,
        `会话持久化失败: ${err}`,
        503,
      );
    }

    return conversation;
  }

  // 注册一个已存在的会话 ID（前端传入的 thread_id），同步到内存和 D1
  static async ensure(
    conversationId: string,
    userId: string = DEFAULT_CONVERSATION_USER_ID,
    title: string = "New Chat",
    mode: "chat" | "knowledge" | "mixed" = "chat",
  ): Promise<Conversation> {
    const normalizedUserId = userId || DEFAULT_CONVERSATION_USER_ID;
    const cached = conversations.get(conversationId);
    if (cached?.userId && cached.userId !== normalizedUserId) {
      throw new BusinessError(
        BusinessErrorCode.FORBIDDEN,
        "无权访问该会话",
        403,
      );
    }

    // 检查 D1 是否已有记录
    let persistedConversation: Awaited<
      ReturnType<ReturnType<typeof getRepositories>["conversation"]["get"]>
    > = null;
    try {
      const repos = getRepositories();
      const existing = await repos.conversation.get(conversationId);
      if (existing && existing.user_id !== normalizedUserId) {
        throw new BusinessError(
          BusinessErrorCode.FORBIDDEN,
          "无权访问该会话",
          403,
        );
      }
      persistedConversation = existing;
      if (existing) {
        const conversation: Conversation = {
          id: existing.id,
          title: existing.title,
          mode: existing.mode,
          createdAt: existing.created_at,
          messageCount: cached?.messageCount ?? 0,
          userId: existing.user_id,
        };
        conversations.set(conversationId, conversation);
      } else {
        await repos.conversation.create(
          normalizedUserId,
          title,
          mode,
          conversationId,
        );
      }
    } catch (err) {
      if (err instanceof BusinessError) throw err;
      throw new BusinessError(
        BusinessErrorCode.INTERNAL_ERROR,
        `会话持久化失败: ${err}`,
        503,
      );
    }

    // 注册到内存
    if (!persistedConversation && !conversations.has(conversationId)) {
      const conversation: Conversation = {
        id: conversationId,
        title,
        mode,
        createdAt: new Date().toISOString(),
        messageCount: 0,
        userId: normalizedUserId,
      };
      conversations.set(conversationId, conversation);
      conversationMessages.set(conversationId, []);
    }

    return conversations.get(conversationId)!;
  }

  // 根据 ID 获取会话，内存未命中时从 D1 加载
  static async get(id: string): Promise<Conversation | undefined> {
    const cached = conversations.get(id);
    if (cached) return cached;

    // D1 回退
    try {
      const repos = getRepositories();
      const data = await repos.conversation.get(id);
      if (!data) return undefined;

      const conversation: Conversation = {
        id: data.id,
        title: data.title,
        mode: data.mode,
        createdAt: data.created_at,
        messageCount: 0,
        userId: data.user_id,
      };
      conversations.set(id, conversation);
      return conversation;
    } catch (err) {
      console.warn(`[service] D1 get conversation ${id} failed: ${err}`);
      return undefined;
    }
  }

  // 列出所有会话，内存未命中时从 D1 加载
  static async list(userId?: string): Promise<Conversation[]> {
    const normalizedUserId = userId || DEFAULT_CONVERSATION_USER_ID;
    // 优先从 D1 加载（D1 为权威数据源）
    try {
      const repos = getRepositories();
      const allConversations: Conversation[] = [];
      const dataList = await repos.conversation.list(normalizedUserId, 100, 0);
      for (const d of dataList) {
        allConversations.push({
          id: d.id,
          title: d.title,
          mode: d.mode,
          createdAt: d.created_at,
          messageCount: 0,
          userId: d.user_id,
        });
      }

      // 合并去重：D1 数据优先
      const merged = new Map<string, Conversation>();
      for (const c of allConversations) merged.set(c.id, c);
      for (const c of conversations.values()) {
        if (c.userId === normalizedUserId && !merged.has(c.id)) {
          merged.set(c.id, c);
        }
      }

      // 写回内存
      for (const [id, conv] of merged) {
        conversations.set(id, conv);
      }

      return Array.from(merged.values()).sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    } catch (err) {
      console.warn(`[service] D1 list conversations failed: ${err}`);
      // D1 失败时返回内存数据
      return Array.from(conversations.values()).filter(
        (conversation) => conversation.userId === normalizedUserId,
      ).sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    }
  }

  // 删除会话及其关联的消息和命令状态，同时从 D1 删除
  static async delete(id: string): Promise<boolean> {
    await clearHistory(id);
    await clearHistory(getDarkModeHistoryThreadId(id));
    clearAgentCommandState(id);
    conversationMessages.delete(id);
    const deletedFromMemory = conversations.delete(id);

    // 从 D1 删除，以持久化结果作为重启后删除的依据
    try {
      const repos = getRepositories();
      const deletedFromD1 = await repos.conversation.delete(id);
      return deletedFromMemory || deletedFromD1;
    } catch (err) {
      throw new BusinessError(
        BusinessErrorCode.SERVICE_UNAVAILABLE,
        `会话删除持久化失败: ${err}`,
        503,
      );
    }
  }

  // 向会话追加一条用户消息，增加消息计数
  static async appendUserMessage(conversationId: string, content: string): Promise<Message> {
    const conv = conversations.get(conversationId);
    if (!conv)
      throw new BusinessError(
        BusinessErrorCode.NOT_FOUND,
        "Conversation not found",
        404,
      );

    const msg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    conv.messageCount++;
    const messages = await this.getMessages(conversationId);
    const sequenceNumber = messages.length;
    messages.push(msg);
    conversationMessages.set(conversationId, messages);

    if (conv.userId) {
      const repos = getRepositories();
      await repos.message.createBatch(conversationId, conv.userId, [
        {
          id: msg.id,
          conversation_id: conversationId,
          user_id: conv.userId,
          sequence_no: sequenceNumber,
          role: "user",
          content_json: content,
          created_at: msg.createdAt,
        },
      ]);
    }

    return msg;
  }

  // 向会话追加一条助手消息
  static async appendAssistantMessage(
    conversationId: string,
    message: Message,
  ): Promise<void> {
    const messages = await this.getMessages(conversationId);
    const sequenceNumber = messages.length;
    messages.push(message);
    conversationMessages.set(conversationId, messages);

    const conversation = conversations.get(conversationId);
    if (conversation?.userId) {
      const repos = getRepositories();
      await repos.message.createBatch(conversationId, conversation.userId, [
        {
          id: message.id,
          conversation_id: conversationId,
          user_id: conversation.userId,
          sequence_no: sequenceNumber,
          role: "assistant",
          content_json: message.content,
          created_at: message.createdAt,
        },
      ]);
    }
  }

  // 获取会话的全部消息列表
  // 获取会话消息列表，内存未命中时从 D1 加载
  static async getMessages(conversationId: string): Promise<Message[]> {
    const cached = conversationMessages.get(conversationId);
    if (cached) return [...cached];

    // D1 回退
    try {
      const repos = getRepositories();
      const { messages } = await repos.message.getMessages(conversationId, 200, 0);
      const loaded: Message[] = messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content_json,
        createdAt: m.created_at,
      }));
      conversationMessages.set(conversationId, loaded);

      // 同步更新会话 messageCount
      const conv = conversations.get(conversationId);
      if (conv && loaded.length > 0) {
        conv.messageCount = loaded.filter((m) => m.role === "user").length;
      }

      return [...loaded];
    } catch (err) {
      console.warn(`[service] D1 get messages for conversation ${conversationId} failed: ${err}`);
      return [];
    }
  }

  // 清空会话消息列表和关联状态
  static async clearMessages(conversationId: string): Promise<void> {
    conversationMessages.set(conversationId, []);
    const conversation = conversations.get(conversationId);
    if (conversation) conversation.messageCount = 0;
    await clearHistory(conversationId);
    await clearHistory(getDarkModeHistoryThreadId(conversationId));
    clearAgentCommandState(conversationId);
    const repos = getRepositories();
    await repos.message.clear(conversationId);
  }
}

// ============ Agent Service ============

export class AgentService {
  // 执行单轮对话，处理工具调用、记忆提取和错误转换
  static async chat(
    conversationId: string,
    content: string,
    userId?: string,
  ): Promise<Message> {
    try {
      const command = executeAgentCommand(content, conversationId);
      if (command) {
        const reply: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: command.reply,
          createdAt: new Date().toISOString(),
        };
        await ConversationService.appendAssistantMessage(conversationId, reply);
        return reply;
      }

      await restoreCommandStateFromConversation(conversationId);
      const promptOverride = getAgentPromptOverride(conversationId, content);
      const agentHistoryThreadId = promptOverride
        ? getDarkModeHistoryThreadId(conversationId)
        : conversationId;
      const history = await getHistoryBeforeInput(agentHistoryThreadId, content);
      const memoryContext: SystemMessage[] = [];

      // 注入用户记忆
      if (userId) {
        try {
          const profile = await ProfileService.getOrCreate(userId);
          const context = await MemoryService.buildMemoryContext(userId);
          if (context) memoryContext.push(new SystemMessage(context));
        } catch {
          // 记忆模块不可用时静默降级
        }
      }

      const conversation = await ConversationService.get(conversationId);
      const agent =
        conversation?.mode === "knowledge"
          ? null
          : await createToolAgent(
              promptOverride,
            );

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
              () =>
                (agent as any).invoke(
                  {
                    input: content,
                    chat_history: history,
                    memory_context: memoryContext,
                  },
                  { signal: deadline.signal },
                ),
              {
                onToolProgress: (event) =>
                  event.type === "started" && deadline.enableToolBudget(),
              },
            ),
      );

      const reply: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: (result.output as string) || "抱歉，我没有理解您的问题。",
        createdAt: new Date().toISOString(),
      };

      // 检测 LLM 输出截断（finish_reason=length 或文本 abrupt ending）
      const finishReason = getFinishReason(result as any);
      if (isLikelyTruncated(reply.content, finishReason)) {
        reply.content = maybeAppendContinuationHint(reply.content, finishReason);
      }

      await appendMessage(agentHistoryThreadId, new HumanMessage(content));
      await appendMessage(agentHistoryThreadId, new AIMessage(reply.content));
      await ConversationService.appendAssistantMessage(conversationId, reply);

      // 记录问答历史 + 提取新记忆
      if (userId) {
        try {
          await HistoryService.record(userId, conversationId, content, reply.content);
          await MemoryService.extractMemoriesFromConversation(
            userId,
            content,
            reply.content,
          );
          await ProfileService.update(userId);
        } catch {
          // 记忆记录失败不影响主流程
        }
      }

      return reply;
    } catch (error: any) {
      if (error instanceof BusinessError) throw error;
      console.error("Agent chat failed", {
        conversationId,
        userId,
        content,
        errorName: error?.name,
        errorMessage: error?.message,
        errorStack: error?.stack,
      });
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
          503,
        );
      }
      if (
        error.message?.includes("rate limit") ||
        error.message?.includes("429")
      ) {
        throw new BusinessError(
          BusinessErrorCode.SERVICE_UNAVAILABLE,
          "AI 服务暂时繁忙，请稍后重试",
          503,
        );
      }
      throw new BusinessError(
        BusinessErrorCode.INTERNAL_ERROR,
        "处理请求时发生错误，请稍后重试",
        500,
      );
    }
  }

  // 流式对话，逐字返回 AI 回复和工具调用事件
  static async *chatStream(
    conversationId: string,
    content: string,
    userId?: string,
    requestSignal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent, void, unknown> {
    let fullAnswer = "";
    let agentHistoryThreadId = conversationId;
    try {
      const command = executeAgentCommand(content, conversationId);
      if (command) {
        const reply: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: command.reply,
          createdAt: new Date().toISOString(),
        };
        await ConversationService.appendAssistantMessage(conversationId, reply);
        yield { type: "text", text: command.reply };
        return;
      }

      await restoreCommandStateFromConversation(conversationId);
      const promptOverride = getAgentPromptOverride(conversationId, content);
      agentHistoryThreadId = promptOverride
        ? getDarkModeHistoryThreadId(conversationId)
        : conversationId;
      const history = await getHistoryBeforeInput(agentHistoryThreadId, content);
      const memoryContext: SystemMessage[] = [];

      if (userId) {
        try {
          const profile = await ProfileService.getOrCreate(userId);
          const context = await MemoryService.buildMemoryContext(userId);
          if (context) memoryContext.push(new SystemMessage(context));
        } catch {
          // memory module unavailable
        }
      }

      const conversation = await ConversationService.get(conversationId);
      if (conversation?.mode === "knowledge") {
        const result = await runWithAgentDeadline(
          () => KnowledgeService.chat(content, history),
          requestSignal,
        );
        fullAnswer = maybeAppendContinuationHint(
          String(result.output || "抱歉，我没有理解您的问题。"),
        );
        scheduleAnswerPersistence(
          conversationId,
          agentHistoryThreadId,
          content,
          fullAnswer,
          userId,
        );
        yield { type: "text", text: fullAnswer };
        return;
      }

      const agent = await createToolAgent(
        promptOverride,
      );

      const toolContext = {
        request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        trace_id: `trace_${Date.now()}`,
        conversation_id: conversationId,
        tenant_id: "",
        user_id: userId || "anonymous",
        actor_type: "user",
      } as const;

      const deadline = new AgentDeadline(undefined, requestSignal);
      const progress = new ToolProgressChannel();
      let emittedText = false;
      const scope = createToolCallScope(toolContext, {
        onToolProgress: (event) => {
          if (event.type === "started") deadline.enableToolBudget();
          progress.push({
            type: "tool",
            toolName: event.toolName,
            callId: event.callId,
            status: event.type,
            durationMs: event.durationMs,
          });
        },
      });
      try {
        const input = {
          input: content,
          chat_history: history,
          memory_context: memoryContext,
        };
        const eventStream = (agent as any).streamEvents
          ? (agent as any).streamEvents(input, {
              version: "v2",
              tags: ["stream"],
              signal: deadline.signal,
            })
          : null;
        if (eventStream) {
          for await (const event of eventStream) {
            if (event.event === "on_chat_model_stream") {
              const delta = getStreamText(event.data?.chunk);
              if (delta) {
                fullAnswer += delta;
                emittedText = true;
                yield { type: "text", text: delta };
              }
            } else if (event.event === "on_tool_start") {
              yield {
                type: "tool",
                toolName: event.name || "tool",
                status: "started",
                callId: event.run_id || "",
              };
            } else if (event.event === "on_tool_end") {
              yield {
                type: "tool",
                toolName: event.name || "tool",
                status: "completed",
                callId: event.run_id || "",
              };
            } else if (event.event === "on_tool_error") {
              yield {
                type: "tool",
                toolName: event.name || "tool",
                status: "failed",
                callId: event.run_id || "",
              };
            } else if (!fullAnswer && event.event === "on_chain_end") {
              const output = event.data?.output?.output;
              if (typeof output === "string") fullAnswer = output;
            }
          }
        } else {
          // 兼容旧版 LangChain 或测试替身，仍保留工具进度通道。
          const stream = await deadline.run<any>(
            scope.run(() => (agent as any).stream(input, { signal: deadline.signal })),
          );
          for await (const chunk of stream as AsyncIterable<any>) {
            if (chunk?.output) {
              fullAnswer = String(chunk.output);
              emittedText = true;
              for await (const delta of splitTextForStreaming(fullAnswer)) {
                yield { type: "text", text: delta };
              }
            }
            for (const event of progress.drain()) yield event;
          }
        }
      } finally {
        deadline.dispose();
      }

      // 不支持 token 事件的模型仍返回完整答案，按兼容路径输出而不是空流。
      if (fullAnswer && !emittedText) {
        for await (const delta of splitTextForStreaming(fullAnswer)) {
          emittedText = true;
          yield { type: "text", text: delta };
        }
      }
      if (!fullAnswer) fullAnswer = "抱歉，我没有理解您的问题。";
      const finalAnswer = maybeAppendContinuationHint(fullAnswer);
      if (finalAnswer !== fullAnswer) {
        yield { type: "text", text: finalAnswer.slice(fullAnswer.length) };
      }
      scheduleAnswerPersistence(
        conversationId,
        agentHistoryThreadId,
        content,
        finalAnswer,
        userId,
      );
    } catch (error: any) {
      if (isClientAbortError(error) || requestSignal?.aborted) return;
      if (error instanceof BusinessError) throw error;
      console.error("Agent stream failed", {
        conversationId,
        userId,
        content,
        errorName: error?.name,
        errorMessage: error?.message,
        errorStack: error?.stack,
      });
      if (isAgentDeadlineError(error)) {
        // 超时但有部分结果 → 返回部分内容 + 继续提示
        if (fullAnswer) {
          const partial = maybeAppendContinuationHint(fullAnswer);
          scheduleAnswerPersistence(
            conversationId,
            agentHistoryThreadId,
            content,
            partial,
            userId,
          );
          yield { type: "text", text: partial, partial: true };
          return;
        }
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
          503,
        );
      }
      throw new BusinessError(
        BusinessErrorCode.INTERNAL_ERROR,
        "处理请求时发生错误",
        500,
      );
    }
  }
}

// ============ Knowledge Service ============

const documents = new Map<string, Document>();
const documentContents = new Map<
  string,
  { content: string; filename: string }
>();

// 共享知识库用户 ID（服务间共享文档）
const KNOWLEDGE_USER_ID = "default";

/**
 * 将 base64 内容解码为字符串（Cloudflare Workers 兼容）
 */
// 执行 decodeBase64Content 对应的业务逻辑
function decodeBase64Content(base64: string): { text: string; bytes: number } {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const text = new TextDecoder().decode(bytes);
  return { text, bytes: bytes.length };
}

export class KnowledgeService {
  private static client = new CloudflareMemoryClient({
    baseUrl: process.env.CLOUDFLARE_MEMORY_BASE_URL || "http://localhost:8787",
    secret: process.env.CLOUDFLARE_MEMORY_SECRET || "",
  });

  private static splitter = new TextSplitter();

  /**
   * 上传文档
   */
  // 创建或注册 uploadDocument 所需的数据
  static async uploadDocument(
    buffer: Buffer,
    filename: string,
    category?: string,
  ): Promise<Document> {
    try {
      const base64 = buffer.toString("base64");
      const result = await this.client.uploadDocument(
        KNOWLEDGE_USER_ID,
        filename,
        base64,
        undefined,
        category || "general",
      );

      const doc = await DocumentLoader.loadFromBuffer(buffer, filename);
      const chunks = this.splitter.split(doc);

      const document: Document = {
        id: result.id,
        name: filename,
        size: doc.metadata.size,
        status: result.status === "failed" ? "failed" : "indexed",
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
        500,
      );
    }
  }

  /**
   * 列出所有文档，D1 为权威数据源
   */
  // 获取 listDocuments 对应的数据
  static async listDocuments(): Promise<Document[]> {
    // 优先从 D1 加载
    try {
      const result = await this.client.listDocuments(KNOWLEDGE_USER_ID, {
        limit: 100,
      });
      const d1Docs: Document[] = result.documents.map((d) => ({
        id: d.id,
        name: d.name,
        size: d.size,
        status: d.status === "failed" ? "failed" : "indexed",
        chunks: d.chunk_count,
        category: d.category,
        createdAt: d.created_at,
      }));

      // 写回内存缓存
      for (const doc of d1Docs) {
        documents.set(doc.id, doc);
      }

      return d1Docs.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    } catch {
      // D1 失败时返回内存数据
      return Array.from(documents.values()).sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    }
  }

  /**
   * 获取文档详情，内存未命中时从 D1 加载
   */
  // 获取 getDocument 对应的数据
  static async getDocument(id: string): Promise<Document | undefined> {
    const cached = documents.get(id);
    if (cached) return cached;

    // D1 回退
    try {
      const data = await this.client.getDocument(id);
      if (!data) return undefined;

      const doc: Document = {
        id: data.document.id,
        name: data.document.name,
        size: data.document.size,
        status: data.document.status === "failed" ? "failed" : "indexed",
        chunks: data.document.chunk_count,
        category: data.document.category,
        createdAt: data.document.created_at,
      };
      documents.set(id, doc);

      // 缓存原始内容用于 reindex
      if (data.document.content_text) {
        documentContents.set(id, {
          content: data.document.content_text,
          filename: data.document.filename,
        });
      }

      return doc;
    } catch {
      return undefined;
    }
  }

  /**
   * 删除文档
   */
  // 删除或清理 deleteDocument 对应的数据
  static async deleteDocument(id: string): Promise<boolean> {
    try {
      const deleted = await this.client.deleteDocument(id);
      if (!deleted) return false;
    } catch (error: any) {
      throw new BusinessError(
        BusinessErrorCode.INTERNAL_ERROR,
        `文档删除失败: ${error.message}`,
        500,
      );
    }
    documentContents.delete(id);
    documents.delete(id);
    return true;
  }

  /**
   * 重新索引，内存无内容时从 D1 加载
   */
  // 执行 reindexDocument 对应的业务逻辑
  static async reindexDocument(id: string): Promise<Document> {
    try {
      await this.client.reindexDocument(id);
      documents.delete(id);
      const refreshed = await this.getDocument(id);
      if (!refreshed) {
        throw new BusinessError(
          BusinessErrorCode.NOT_FOUND,
          "Document not found",
          404,
        );
      }
      return refreshed;
    } catch (error: any) {
      if (error instanceof BusinessError) throw error;
      if (error instanceof MemoryGatewayError && error.code === "DOCUMENT_NOT_FOUND") {
        throw new BusinessError(BusinessErrorCode.NOT_FOUND, "Document not found", 404);
      }
      throw new BusinessError(
        BusinessErrorCode.INTERNAL_ERROR,
        `文档重新索引失败: ${error.message}`,
        500,
      );
    }
  }

  /**
   * 知识模式对话（搜索文档 + 生成回答）
   */
  // 执行 chat 对应的业务逻辑
  static async chat(content: string, _history: any[] = []): Promise<any> {
    const results = await this.search(content, 5);

    if (results.length === 0) {
      return {
        output: "📚 知识库中未找到与您问题相关的内容。请尝试换一种方式提问，或联系管理员更新知识库。",
      };
    }

    const context = results
      .map(
        (r, i) =>
          `[文档 ${i + 1}] ${r.document_name} (相关度: ${r.score.toFixed(2)})\n${r.content}`,
      )
      .join("\n\n");

    return {
      output: `📚 根据知识库检索结果：\n\n${context}`,
    };
  }

  /**
   * 知识检索
   */
  // 查询 search 对应的结果
  static async search(
    query: string,
    topK: number = 5,
  ): Promise<SearchResult[]> {
    try {
      const result = await this.client.searchDocuments(
        KNOWLEDGE_USER_ID,
        query,
        { limit: topK },
      );

      return result.results.map((r) => ({
        document_id: r.document_id,
        document_name: (r.metadata.document_name as string) || (r.metadata.filename as string) || "未知文档",
        content: r.content,
        score: r.score,
        chunk_index: r.chunk_index,
      }));
    } catch (error: any) {
      throw new BusinessError(
        BusinessErrorCode.SERVICE_UNAVAILABLE,
        "知识库检索失败，请稍后重试",
        503,
      );
    }
  }
}

// ============ Capabilities Service ============

export class CapabilitiesService {
  // 获取系统能力描述（支持的模式、知识库、可用工具等）
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
