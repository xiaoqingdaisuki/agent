/**
 * Service Layer — 业务逻辑编排
 *
 * 职责：
 * 1. 编排 Agent / RAG / 工具的调用
 * 2. 将内部返回转换为前端友好的格式
 * 3. 错误转换（内部错误 → 业务错误码）
 * 4. 与 API 层解耦，前端看不到内部实现
 */

import {
  createDirectChatAgent,
  createToolAgent,
  getFastPathAnswer,
  isDirectChatMessage,
} from "../agents/tool-agent.js";
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
import type { ReActRunSummary } from "../agents/react-policy.js";
import { config } from "../config/index.js";

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
      type: "agent";
      event: "agent.start" | "agent.complete";
      state?: string;
      stopReason?: string;
      react?: ReActRunSummary;
    }
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
const queuedBackgroundTasks: Array<{ label: string; task: () => Promise<void>; resolve: () => void }> = [];
const refreshingMemoryContexts = new Set<string>();
const memoryContextCache = new Map<string, string>();
let runningBackgroundTasks = 0;

// 在全局并发预算内执行后台任务，避免故障依赖导致无限并发占满连接池。
function drainBackgroundTaskQueue(): void {
  while (
    runningBackgroundTasks < config.BACKGROUND_TASK_CONCURRENCY &&
    queuedBackgroundTasks.length > 0
  ) {
    const next = queuedBackgroundTasks.shift();
    if (!next) return;
    runningBackgroundTasks += 1;
    void next.task()
      .catch((error) => {
        console.error(`[service] background task ${next.label} failed`, error);
      })
      .finally(() => {
        runningBackgroundTasks -= 1;
        next.resolve();
        drainBackgroundTaskQueue();
      });
  }
}

// 将后台任务加入有界队列，队列饱和时优先保护用户请求关键路径。
function enqueueBackgroundTask(label: string, task: () => Promise<void>): Promise<void> {
  if (queuedBackgroundTasks.length >= config.BACKGROUND_TASK_QUEUE_MAX) {
    console.warn(`[service] background queue is full; skipped ${label}`);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queuedBackgroundTasks.push({ label, task, resolve });
    drainBackgroundTaskQueue();
  });
}

// 将回答落库、历史记录和记忆提取移出流式响应关键路径。
function scheduleBackgroundTask(label: string, task: () => Promise<void>): void {
  const previous = backgroundChains.get(label);
  const work = (previous || Promise.resolve())
    .catch(() => undefined)
    .then(() => enqueueBackgroundTask(label, task));
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

// 在后台刷新记忆上下文，避免故障的记忆网关阻塞首个 token。
function refreshMemoryContext(userId: string): void {
  if (refreshingMemoryContexts.has(userId)) return;
  refreshingMemoryContexts.add(userId);
  scheduleBackgroundTask(`memory-context:${userId}`, async () => {
    try {
      memoryContextCache.set(userId, await MemoryService.buildMemoryContext(userId));
    } catch {
      // 保留最近一次成功值；首次失败时使用空上下文。
      if (!memoryContextCache.has(userId)) memoryContextCache.set(userId, "");
    } finally {
      refreshingMemoryContexts.delete(userId);
    }
  });
}

// 返回缓存记忆并异步刷新，保证首 token 与 Gateway 可用性解耦。
export async function loadMemoryContext(userId: string): Promise<SystemMessage[]> {
  refreshMemoryContext(userId);
  const context = memoryContextCache.get(userId) || "";
  return context ? [new SystemMessage(context)] : [];
}

// 从 LangChain 消息块中提取可展示的文本增量。
function getStreamText(chunk: any): string {
  if (typeof chunk === "string") return chunk;
  if (typeof chunk?.text === "string") return chunk.text;
  const content = chunk?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) =>
      typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "",
    )
    .join("");
}

// 过滤 LangGraph/LangChain 事件中的结束哨兵和 XML 工具调用文本。
function normalizeAgentOutputText(text: string): string {
  const normalized = stripXmlToolStream(text);
  return normalized.trim() === "__end__" ? "" : normalized;
}

// 从 LangChain 链路结束事件中提取最终 AI 消息，兼容 output/output.messages 两种结构。
export function extractAgentOutputText(output: unknown): string {
  if (typeof output === "string") return normalizeAgentOutputText(output);
  if (!output || typeof output !== "object") return "";
  const candidate = output as Record<string, any>;
  if (typeof candidate.output === "string") {
    return normalizeAgentOutputText(candidate.output);
  }
  if (candidate.output && candidate.output !== output) {
    const nested = extractAgentOutputText(candidate.output);
    if (nested) return nested;
  }
  if (Array.isArray(candidate.messages)) {
    for (const message of [...candidate.messages].reverse()) {
      const messageType = typeof message?._getType === "function"
        ? message._getType()
        : message?.type || message?.role;
      if (messageType !== "ai" && messageType !== "assistant") continue;
      const text = getStreamText(message);
      if (text.trim()) return normalizeAgentOutputText(text);
    }
  }
  const candidateType = typeof candidate._getType === "function"
    ? candidate._getType()
    : candidate.type || candidate.role;
  return candidateType === "ai" || candidateType === "assistant"
    ? normalizeAgentOutputText(getStreamText(candidate))
    : "";
}

// 逐项读取异步流并绑定请求截止信号，避免上游不响应取消时连接无限悬挂。
async function* iterateWithAbort<T>(
  stream: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T, void, unknown> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason || new DOMException("Aborted", "AbortError"));
          return;
        }
        onAbort = () => {
          signal.removeEventListener("abort", onAbort!);
          reject(signal.reason || new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      let next: IteratorResult<T>;
      try {
        next = await Promise.race([iterator.next(), abortPromise]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void iterator.return?.();
  }
}

const XML_TOOL_STREAM_MARKERS = ["<invoke", "<function="];

// 从模型流中提取安全可展示文本，并丢弃完整的 XML 工具调用块。
export function drainXmlToolStream(
  buffer: string,
  final = false,
): { text: string; remainder: string } {
  let text = "";
  let cursor = 0;
  while (cursor < buffer.length) {
    const lower = buffer.toLowerCase();
    let markerIndex = -1;
    for (const marker of XML_TOOL_STREAM_MARKERS) {
      const index = lower.indexOf(marker, cursor);
      if (index !== -1 && (markerIndex === -1 || index < markerIndex)) markerIndex = index;
    }
    if (markerIndex === -1) {
      const tail = buffer.slice(cursor);
      if (final) return { text: text + tail, remainder: "" };
      let holdLength = 0;
      for (const marker of XML_TOOL_STREAM_MARKERS) {
        for (let length = 1; length <= Math.min(marker.length - 1, tail.length); length += 1) {
          if (marker.startsWith(tail.slice(-length).toLowerCase())) holdLength = Math.max(holdLength, length);
        }
      }
      return {
        text: text + tail.slice(0, tail.length - holdLength),
        remainder: tail.slice(tail.length - holdLength),
      };
    }
    text += buffer.slice(cursor, markerIndex);
    const rest = lower.slice(markerIndex);
    const close = rest.startsWith("<invoke") ? "</invoke>" : "</function>";
    const closeIndex = rest.indexOf(close);
    if (closeIndex === -1) return { text, remainder: buffer.slice(markerIndex) };
    cursor = markerIndex + closeIndex + close.length;
  }
  return { text, remainder: "" };
}

// 清理非流式回退路径中的 XML 工具调用文本。
function stripXmlToolStream(text: string): string {
  return drainXmlToolStream(text, true).text.trim();
}

// 在回答生成后异步保存会话、历史和记忆，保证失败不影响已发送内容。
export function scheduleAnswerPersistence(
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
    if (cached) return cached;

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
          messageCount: 0,
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

  // 根据 ID 获取会话，服务缓存未命中时从当前仓储加载。
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

  // 列出指定用户的会话，并用当前仓储结果刷新服务缓存。
  static async list(userId?: string): Promise<Conversation[]> {
    const normalizedUserId = userId || DEFAULT_CONVERSATION_USER_ID;
    // 以当前仓储为权威数据源，兼容进程内和 Cloudflare 两种实现。
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

  // 删除会话及其关联消息、命令状态，并同步删除当前仓储记录。
  static async delete(id: string): Promise<boolean> {
    await clearHistory(id);
    await clearHistory(getDarkModeHistoryThreadId(id));
    clearAgentCommandState(id);
    conversationMessages.delete(id);
    const deletedFromMemory = conversations.delete(id);

    // 先删除当前仓储记录，再清理服务缓存和会话命令状态。
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
  // 获取会话消息列表，服务缓存未命中时从当前仓储加载。
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

      const fastAnswer = getFastPathAnswer(content);
      if (fastAnswer) {
        scheduleAnswerPersistence(conversationId, conversationId, content, fastAnswer, userId);
        return {
          id: crypto.randomUUID(),
          role: "assistant",
          content: fastAnswer,
          createdAt: new Date().toISOString(),
        };
      }

      await restoreCommandStateFromConversation(conversationId);
      const promptOverride = getAgentPromptOverride(conversationId, content);
      const agentHistoryThreadId = promptOverride
        ? getDarkModeHistoryThreadId(conversationId)
        : conversationId;
      const history = await getHistoryBeforeInput(agentHistoryThreadId, content);
      const memoryContext: SystemMessage[] = [];

      // 注入用户记忆，但不让记忆网关拖慢模型首响应。
      if (userId) memoryContext.push(...(await loadMemoryContext(userId)));

      const conversation = await ConversationService.get(conversationId);
      const agent =
        conversation?.mode === "knowledge"
          ? null
          : await (isDirectChatMessage(content)
            ? createDirectChatAgent(promptOverride)
            : createToolAgent(promptOverride));

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
        content: extractAgentOutputText(result) || "抱歉，我没有理解您的问题。",
        createdAt: new Date().toISOString(),
      };

      // 检测 LLM 输出截断（finish_reason=length 或文本 abrupt ending）
      const finishReason = getFinishReason(result as any);
      if (isLikelyTruncated(reply.content, finishReason)) {
        reply.content = maybeAppendContinuationHint(reply.content, finishReason);
      }

      scheduleAnswerPersistence(
        conversationId,
        agentHistoryThreadId,
        content,
        reply.content,
        userId,
      );

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
    let streamTextBuffer = "";
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

      const fastAnswer = getFastPathAnswer(content);
      if (fastAnswer) {
        scheduleAnswerPersistence(conversationId, conversationId, content, fastAnswer, userId);
        yield { type: "text", text: fastAnswer };
        return;
      }

      await restoreCommandStateFromConversation(conversationId);
      const promptOverride = getAgentPromptOverride(conversationId, content);
      agentHistoryThreadId = promptOverride
        ? getDarkModeHistoryThreadId(conversationId)
        : conversationId;
      const history = await getHistoryBeforeInput(agentHistoryThreadId, content);
      const memoryContext: SystemMessage[] = [];

      // 注入用户记忆，但不让记忆网关拖慢模型首响应。
      if (userId) memoryContext.push(...(await loadMemoryContext(userId)));

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

      const agent = await (isDirectChatMessage(content)
        ? createDirectChatAgent(promptOverride)
        : createToolAgent(promptOverride));

      yield { type: "agent", event: "agent.start" };

      const toolContext = {
        request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        trace_id: `trace_${Date.now()}`,
        conversation_id: conversationId,
        tenant_id: "",
        user_id: userId || "anonymous",
        actor_type: "user",
      } as const;

      const deadline = new AgentDeadline(
        config.AGENT_DEADLINE_MS,
        requestSignal,
        config.AGENT_DEADLINE_WITH_TOOLS_MS,
      );
      const progress = new ToolProgressChannel();
      let reactSummary: ReActRunSummary | undefined;
      let emittedText = false;
      let observedToolEvent = false;
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
              toolCallScope: scope,
            })
          : null;
        if (eventStream) {
          for await (const event of iterateWithAbort(
            eventStream as AsyncIterable<any>,
            deadline.signal,
          )) {
            if (event.event === "on_chat_model_stream") {
              const delta = getStreamText(event.data?.chunk);
              if (delta) {
                streamTextBuffer += delta;
                const visible = drainXmlToolStream(streamTextBuffer);
                streamTextBuffer = visible.remainder;
                if (visible.text.trim() || emittedText) {
                  fullAnswer += visible.text;
                  emittedText = true;
                  yield { type: "text", text: visible.text };
                }
              }
            } else if (event.event === "on_tool_start") {
              observedToolEvent = true;
              yield {
                type: "tool",
                toolName: event.name || "tool",
                status: "started",
                callId: event.run_id || "",
              };
            } else if (event.event === "on_tool_end") {
              observedToolEvent = true;
              yield {
                type: "tool",
                toolName: event.name || "tool",
                status: "completed",
                callId: event.run_id || "",
              };
            } else if (event.event === "on_tool_error") {
              observedToolEvent = true;
              yield {
                type: "tool",
                toolName: event.name || "tool",
                status: "failed",
                callId: event.run_id || "",
              };
            } else if (
              !fullAnswer.trim() &&
              (event.event === "on_chain_end" || event.event === "on_chat_model_end")
            ) {
              fullAnswer = extractAgentOutputText(event.data?.output);
              const summary = event.data?.output?.react;
              if (summary) reactSummary = summary as ReActRunSummary;
            } else if (event.event === "on_chain_end") {
              const summary = event.data?.output?.react;
              if (summary) reactSummary = summary as ReActRunSummary;
            }
          }
        } else {
          // 兼容旧版 LangChain 或测试替身，仍保留工具进度通道。
          const stream = await deadline.run<any>(
            scope.run(() =>
              (agent as any).stream(input, {
                signal: deadline.signal,
                toolCallScope: scope,
              }),
            ),
          );
          for await (const chunk of iterateWithAbort(stream as AsyncIterable<any>, deadline.signal)) {
            if (chunk?.output) {
              fullAnswer = stripXmlToolStream(String(chunk.output));
              emittedText = true;
              for await (const delta of splitTextForStreaming(fullAnswer)) {
                yield { type: "text", text: delta };
              }
            }
            for (const event of progress.drain()) yield event;
          }
        }
        const visibleTail = drainXmlToolStream(streamTextBuffer, true).text;
        if (visibleTail.trim()) {
          fullAnswer += visibleTail;
          emittedText = true;
          yield { type: "text", text: visibleTail };
        }
        fullAnswer = stripXmlToolStream(fullAnswer);

        // 部分 OpenAI 兼容网关只在非流式工具调用中返回结构化 tool_calls。
        if (
          !fullAnswer.trim() &&
          !observedToolEvent &&
          typeof (agent as any).invoke === "function"
        ) {
          const fallbackResult = await deadline.run<any>(
            scope.run(() =>
              (agent as any).invoke(input, { signal: deadline.signal }),
            ),
          );
          fullAnswer = stripXmlToolStream(extractAgentOutputText(fallbackResult));
          reactSummary = fallbackResult.react || reactSummary;
          for (const event of progress.drain()) yield event;
        }
      } finally {
        deadline.dispose();
      }

      // 不支持 token 事件的模型仍返回完整答案，按兼容路径输出而不是空流。
      if (fullAnswer.trim() && !emittedText) {
        for await (const delta of splitTextForStreaming(fullAnswer)) {
          emittedText = true;
          yield { type: "text", text: delta };
        }
      }
      // 工具调用或模型空响应不能让 SSE 以无文本事件结束，否则前端会误判接口失败。
      if (!fullAnswer.trim()) {
        fullAnswer = "抱歉，我没有理解您的问题。";
        emittedText = true;
        yield { type: "text", text: fullAnswer };
      }
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
      if (reactSummary) {
        yield {
          type: "agent",
          event: "agent.complete",
          state: reactSummary.state,
          stopReason: reactSummary.stop_reason,
          react: reactSummary,
        };
      }
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
        if (fullAnswer.trim()) {
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
        const timeoutAnswer = "AI助手响应超时，请稍后重试。";
        scheduleAnswerPersistence(
          conversationId,
          agentHistoryThreadId,
          content,
          timeoutAnswer,
          userId,
        );
        yield { type: "text", text: timeoutAnswer };
        return;
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

// MEMORY_ENABLED=false 时保存进程内文档、原文、分块及字符倒排索引，进程重启后数据清空。
const documents = new Map<string, Document>();
const documentContents = new Map<
  string,
  { content: string; filename: string }
>();
const documentChunks = new Map<string, string[]>();
// 描述单个本地分块的检索元数据，供倒排候选召回与相关度计算复用。
interface LocalSearchEntry {
  documentId: string;
  chunkIndex: number;
  content: string;
  normalizedContent: string;
  characters: Set<string>;
}
const localSearchEntries = new Map<string, LocalSearchEntry>();
const localSearchPostings = new Map<string, Set<string>>();
const localDocumentSearchKeys = new Map<string, Set<string>>();

// 共享知识库用户 ID（服务间共享文档）
const KNOWLEDGE_USER_ID = "default";

// 移除单个本地文档的倒排检索项，避免删除或重建后残留。
function removeLocalDocumentSearchIndex(documentId: string): void {
  const keys = localDocumentSearchKeys.get(documentId);
  if (!keys) return;
  for (const key of keys) {
    const entry = localSearchEntries.get(key);
    if (!entry) continue;
    for (const character of entry.characters) {
      const postings = localSearchPostings.get(character);
      postings?.delete(key);
      if (postings?.size === 0) localSearchPostings.delete(character);
    }
    localSearchEntries.delete(key);
  }
  localDocumentSearchKeys.delete(documentId);
}

// 用最新文档块重建字符倒排索引，减少检索时的无关块扫描。
function replaceLocalDocumentSearchIndex(documentId: string, chunks: string[]): void {
  removeLocalDocumentSearchIndex(documentId);
  const keys = new Set<string>();
  chunks.forEach((content, chunkIndex) => {
    const normalizedContent = content.toLowerCase();
    const characters = new Set([...normalizedContent].filter((character) => !/\s/.test(character)));
    const key = `${documentId}:${chunkIndex}`;
    localSearchEntries.set(key, {
      documentId,
      chunkIndex,
      content,
      normalizedContent,
      characters,
    });
    keys.add(key);
    for (const character of characters) {
      const postings = localSearchPostings.get(character) || new Set<string>();
      postings.add(key);
      localSearchPostings.set(character, postings);
    }
  });
  localDocumentSearchKeys.set(documentId, keys);
}

// 在关闭 Cloudflare Memory 时通过倒排索引执行有界 Top-K 词法检索。
function searchLocalDocuments(query: string, topK: number): SearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  const queryCharacters = new Set([...normalizedQuery].filter((character) => !/\s/.test(character)));
  if (!normalizedQuery || queryCharacters.size === 0) return [];

  const candidateKeys = new Set<string>();
  for (const character of queryCharacters) {
    for (const key of localSearchPostings.get(character) || []) candidateKeys.add(key);
  }
  const results: SearchResult[] = [];
  for (const key of candidateKeys) {
    const entry = localSearchEntries.get(key);
    const document = entry ? documents.get(entry.documentId) : undefined;
    if (!entry || !document) continue;
    const exactMatch = entry.normalizedContent.includes(normalizedQuery);
    const matchedCharacters = exactMatch
      ? queryCharacters.size
      : [...queryCharacters].filter((character) => entry.characters.has(character)).length;
    const score = exactMatch ? 1 : matchedCharacters / queryCharacters.size;
    if (score <= 0) continue;
    const result = {
      document_id: document.id,
      document_name: document.name,
      content: entry.content.slice(0, 2_000),
      score,
      chunk_index: entry.chunkIndex,
    };
    if (results.length < topK) {
      results.push(result);
      continue;
    }
    let lowestIndex = 0;
    for (let index = 1; index < results.length; index++) {
      if (results[index].score < results[lowestIndex].score) lowestIndex = index;
    }
    if (score > results[lowestIndex].score) results[lowestIndex] = result;
  }
  return results.sort((left, right) => right.score - left.score);
}

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
      const doc = await DocumentLoader.loadFromBuffer(buffer, filename);
      const chunks = this.splitter.split(doc);
      const result = config.MEMORY_ENABLED
        ? await this.client.uploadDocument(
            KNOWLEDGE_USER_ID,
            filename,
            buffer.toString("base64"),
            undefined,
            category || "general",
          )
        : { id: doc.id, status: "indexed" };

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
      documentChunks.set(document.id, chunks.map((chunk) => chunk.text));
      replaceLocalDocumentSearchIndex(document.id, chunks.map((chunk) => chunk.text));
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
   * 列出所有文档；本地模式读取进程内索引，网关模式以远端仓储为权威
   */
  // 获取 listDocuments 对应的数据
  static async listDocuments(): Promise<Document[]> {
    if (!config.MEMORY_ENABLED) {
      return Array.from(documents.values()).sort(
        (left, right) =>
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      );
    }
    // 网关模式优先从远端仓储加载并刷新服务缓存。
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
   * 获取文档详情；本地模式只读进程内数据，网关模式允许远端回源
   */
  // 获取 getDocument 对应的数据
  static async getDocument(id: string): Promise<Document | undefined> {
    const cached = documents.get(id);
    if (cached) return cached;
    if (!config.MEMORY_ENABLED) return undefined;

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
    if (!config.MEMORY_ENABLED) {
      removeLocalDocumentSearchIndex(id);
      const deleted = documents.delete(id);
      documentContents.delete(id);
      documentChunks.delete(id);
      return deleted;
    }
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
    documentChunks.delete(id);
    removeLocalDocumentSearchIndex(id);
    documents.delete(id);
    return true;
  }

  /**
   * 重新索引；本地模式重切进程内原文，网关模式允许远端回源
   */
  // 执行 reindexDocument 对应的业务逻辑
  static async reindexDocument(id: string): Promise<Document> {
    if (!config.MEMORY_ENABLED) {
      const document = documents.get(id);
      const stored = documentContents.get(id);
      if (!document || !stored) {
        throw new BusinessError(
          BusinessErrorCode.NOT_FOUND,
          "Document not found",
          404,
        );
      }
      const chunks = this.splitter.split({
        content: stored.content,
        metadata: { source: `upload://${stored.filename}`, filename: stored.filename },
      });
      document.chunks = chunks.length;
      document.status = "indexed";
      documentChunks.set(id, chunks.map((chunk) => chunk.text));
      replaceLocalDocumentSearchIndex(id, chunks.map((chunk) => chunk.text));
      return document;
    }
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
    if (!config.MEMORY_ENABLED) return searchLocalDocuments(query, topK);
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
