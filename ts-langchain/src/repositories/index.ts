/**
 * Repositories — 数据仓储层
 *
 * 根据 MEMORY_ENABLED 选择进程内仓储或 Cloudflare Service。
 * 所有业务层（Service、Tool、API Route）只能通过 Repository 访问数据。
 */

import {
  type ProfileRepository,
  type ConversationRepository,
  type MessageRepository,
  type TurnRepository,
  type MemoryRepository,
  type Repositories,
  type UserProfileData,
  type ConversationData,
  type MessageData,
  type MessageWriteData,
  type TurnData,
  type TurnStatus,
  type MemoryData,
  type SearchResponse,
  type MemorySearchResultData,
} from "./types.js";
import { CloudflareMemoryClient, MemoryGatewayError } from "../clients/memory_gateway.js";
import { config } from "../config/index.js";

// ============ 工厂函数 ============

let cachedCloudflareRepositories: { key: string; value: Repositories } | undefined;

/**
 * 根据配置创建进程内或 Cloudflare 仓储实例
 */
// 返回当前配置对应的仓储集合，关闭记忆网关时不创建远端客户端。
export function getRepositories(): Repositories {
  if (!config.MEMORY_ENABLED) return inMemoryRepositories;
  const key = `${config.CLOUDFLARE_MEMORY_BASE_URL}\u0000${config.CLOUDFLARE_MEMORY_SECRET}\u0000${config.MEMORY_REQUEST_TIMEOUT_MS}`;
  if (cachedCloudflareRepositories?.key === key) return cachedCloudflareRepositories.value;
  const client = new CloudflareMemoryClient({
    baseUrl: config.CLOUDFLARE_MEMORY_BASE_URL,
    secret: config.CLOUDFLARE_MEMORY_SECRET,
    timeoutMs: config.MEMORY_REQUEST_TIMEOUT_MS,
  });
  const value = new CloudflareRepositories(client);
  cachedCloudflareRepositories = { key, value };
  return value;
}

const inMemoryProfiles = new Map<string, UserProfileData>();
const inMemoryConversations = new Map<string, ConversationData>();
const inMemoryMessages = new Map<string, MessageData[]>();
const inMemoryTurns = new Map<string, TurnData>();
const inMemoryTurnKeys = new Map<string, string>();
const inMemoryMemories = new Map<string, MemoryData[]>();

// 生成单调递增的 ISO 时间戳，避免同一毫秒内更新被误判为未变化。
function nextIsoTimestamp(previous?: string): string {
  const previousMs = previous ? Date.parse(previous) : 0;
  return new Date(Math.max(Date.now(), previousMs + 1)).toISOString();
}

// 构建进程内仓储，供关闭 Cloudflare 记忆模式时使用。
const inMemoryRepositories: Repositories = {
  profile: {
    // 获取或创建进程内用户画像。
    async getOrCreate(userId, name = "") {
      const existing = inMemoryProfiles.get(userId);
      if (existing) return existing;
      const now = new Date().toISOString();
      const profile = { user_id: userId, name, preferences_json: "{}", created_at: now, updated_at: now };
      inMemoryProfiles.set(userId, profile);
      return profile;
    },
    // 获取进程内用户画像。
    async get(userId) {
      return inMemoryProfiles.get(userId) ?? null;
    },
    // 更新进程内用户画像。
    async update(userId, name, preferences) {
      const profile = await this.getOrCreate(userId, name ?? "");
      const updated = {
        ...profile,
        name: name ?? profile.name,
        preferences_json: preferences ? JSON.stringify(preferences) : profile.preferences_json,
        updated_at: nextIsoTimestamp(profile.updated_at),
      };
      inMemoryProfiles.set(userId, updated);
      return updated;
    },
  },
  conversation: {
    // 创建进程内会话。
    async create(userId, title, mode = "chat", conversationId = crypto.randomUUID()) {
      const now = new Date().toISOString();
      const conversation: ConversationData = {
        id: conversationId,
        user_id: userId,
        title,
        mode: mode as ConversationData["mode"],
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
      inMemoryConversations.set(conversationId, conversation);
      inMemoryMessages.set(conversationId, inMemoryMessages.get(conversationId) ?? []);
      return conversation;
    },
    // 获取未被删除的进程内会话。
    async get(conversationId) {
      const conversation = inMemoryConversations.get(conversationId);
      return conversation?.deleted_at ? null : conversation ?? null;
    },
    // 按用户列出未被删除的进程内会话。
    async list(userId, limit = 20, offset = 0) {
      return Array.from(inMemoryConversations.values())
        .filter((conversation) => conversation.user_id === userId && !conversation.deleted_at)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(offset, offset + limit);
    },
    // 软删除进程内会话并清理其消息。
    async delete(conversationId) {
      const conversation = inMemoryConversations.get(conversationId);
      if (!conversation || conversation.deleted_at) return false;
      inMemoryConversations.set(conversationId, { ...conversation, deleted_at: new Date().toISOString() });
      inMemoryMessages.delete(conversationId);
      return true;
    },
  },
  message: {
    // 幂等地批量写入进程内会话消息。
    async createBatch(conversationId, _userId, messages) {
      const existing = inMemoryMessages.get(conversationId) ?? [];
      const byId = new Map(existing.map((message) => [message.id, message]));
      let nextSequence = existing.reduce((max, message) => Math.max(max, message.sequence_no + 1), 0);
      for (const message of messages) {
        const stored: MessageData = { ...message, sequence_no: message.sequence_no ?? nextSequence++ };
        byId.set(message.id, stored);
      }
      inMemoryMessages.set(conversationId, Array.from(byId.values()).sort((a, b) => a.sequence_no - b.sequence_no));
    },
    // 分页获取进程内会话消息。
    async getMessages(conversationId, limit = 50, offset = 0, direction = "asc") {
      const all = inMemoryMessages.get(conversationId) ?? [];
      const ordered = direction === "desc" ? [...all].reverse() : all;
      return { messages: ordered.slice(offset, offset + limit), total: all.length };
    },
    // 清空进程内会话消息。
    async clear(conversationId) {
      inMemoryMessages.set(conversationId, []);
    },
  },
  turn: {
    // 原子创建进程内 Turn 并追加用户消息。
    async begin(conversationId, userId, clientMessageId, content, turnId = crypto.randomUUID(), userMessageId = crypto.randomUUID()) {
      const key = `${conversationId}\u0000${clientMessageId}`;
      const existingId = inMemoryTurnKeys.get(key);
      if (existingId) {
        const turn = inMemoryTurns.get(existingId)!;
        const userMessage = (inMemoryMessages.get(conversationId) ?? []).find((message) => message.id === turn.user_message_id);
        if (!userMessage) throw new MemoryGatewayError("MEMORY_TURN_INCONSISTENT", "Turn 缺少用户消息", 500);
        return { turn: { ...turn }, userMessage: { ...userMessage }, created: false };
      }
      if (Array.from(inMemoryTurns.values()).some((turn) => turn.conversation_id === conversationId && (turn.status === "pending" || turn.status === "streaming"))) {
        throw new MemoryGatewayError("MEMORY_CONVERSATION_BUSY", "会话中已有请求正在处理", 409);
      }
      const now = new Date().toISOString();
      const messages = inMemoryMessages.get(conversationId) ?? [];
      const userMessage: MessageData = {
        id: userMessageId, conversation_id: conversationId, user_id: userId,
        sequence_no: messages.length, role: "user", content_json: content, created_at: now,
      };
      const turn: TurnData = {
        id: turnId, conversation_id: conversationId, user_id: userId,
        client_message_id: clientMessageId, status: "streaming",
        user_message_id: userMessageId, assistant_message_id: null,
        assistant_content_json: null, error_code: null,
        created_at: now, updated_at: now, completed_at: null,
      };
      messages.push(userMessage);
      inMemoryMessages.set(conversationId, messages);
      inMemoryTurnKeys.set(key, turnId);
      inMemoryTurns.set(turnId, turn);
      return { turn: { ...turn }, userMessage: { ...userMessage }, created: true };
    },
    // 原子追加进程内助手消息并完成 Turn。
    async complete(turnId, userId, message) {
      const turn = inMemoryTurns.get(turnId);
      if (!turn || turn.user_id !== userId) throw new MemoryGatewayError("MEMORY_TURN_NOT_FOUND", "Turn 不存在或无权访问", 404);
      if (turn.status === "completed") return { ...turn };
      if (turn.status !== "streaming") throw new MemoryGatewayError("MEMORY_TURN_STATE_CONFLICT", `Cannot transition Turn from ${turn.status} to completed`, 409);
      const messages = inMemoryMessages.get(turn.conversation_id) ?? [];
      if (!messages.some((item) => item.id === message.id)) messages.push({ ...message, sequence_no: messages.length });
      inMemoryMessages.set(turn.conversation_id, messages);
      const updated: TurnData = {
        ...turn, status: "completed", assistant_message_id: message.id,
        assistant_content_json: JSON.stringify({ id: message.id, role: "assistant", content: message.content_json, createdAt: message.created_at }),
        updated_at: nextIsoTimestamp(turn.updated_at), completed_at: nextIsoTimestamp(turn.updated_at),
      };
      inMemoryTurns.set(turnId, updated);
      return { ...updated };
    },
    // 原子创建或复用进程内 Turn。
    async createOrGet(conversationId, userId, clientMessageId, turnId = crypto.randomUUID()) {
      const key = `${conversationId}\u0000${clientMessageId}`;
      const existingId = inMemoryTurnKeys.get(key);
      const existing = existingId ? inMemoryTurns.get(existingId) : undefined;
      if (existing) return { turn: { ...existing }, created: false };
      if (Array.from(inMemoryTurns.values()).some((turn) => turn.conversation_id === conversationId && (turn.status === "pending" || turn.status === "streaming"))) {
        throw new MemoryGatewayError("MEMORY_CONVERSATION_BUSY", "会话中已有请求正在处理", 409);
      }
      const now = new Date().toISOString();
      const turn: TurnData = {
        id: turnId, conversation_id: conversationId, user_id: userId,
        client_message_id: clientMessageId, status: "pending",
        user_message_id: null, assistant_message_id: null,
        assistant_content_json: null, error_code: null,
        created_at: now, updated_at: now, completed_at: null,
      };
      inMemoryTurnKeys.set(key, turnId);
      inMemoryTurns.set(turnId, turn);
      return { turn: { ...turn }, created: true };
    },
    // 按用户读取进程内 Turn。
    async get(turnId, userId) {
      const turn = inMemoryTurns.get(turnId);
      return turn?.user_id === userId ? { ...turn } : null;
    },
    // 按不可逆状态机更新进程内 Turn。
    async update(turnId, userId, changes) {
      const turn = inMemoryTurns.get(turnId);
      if (!turn || turn.user_id !== userId) throw new MemoryGatewayError("MEMORY_TURN_NOT_FOUND", "Turn 不存在或无权访问", 404);
      if (turn.status === changes.status) return { ...turn };
      const allowed: Record<TurnStatus, TurnStatus[]> = {
        pending: ["streaming", "failed", "cancelled"], streaming: ["completed", "failed", "cancelled"],
        completed: [], failed: [], cancelled: [],
      };
      if (!allowed[turn.status].includes(changes.status)) {
        throw new MemoryGatewayError("MEMORY_TURN_STATE_CONFLICT", `Cannot transition Turn from ${turn.status} to ${changes.status}`, 409);
      }
      const terminal = ["completed", "failed", "cancelled"].includes(changes.status);
      const updated: TurnData = {
        ...turn,
        ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
        updated_at: nextIsoTimestamp(turn.updated_at),
        completed_at: terminal ? nextIsoTimestamp(turn.updated_at) : turn.completed_at,
      };
      inMemoryTurns.set(turnId, updated);
      return { ...updated };
    },
  },
  memory: {
    // 保存或复用去重后的进程内长期记忆。
    async save(userId, memoryId, content, category = "fact", importance = 3, source = "user_explicit", sourceConversationId) {
      const memories = inMemoryMemories.get(userId) ?? [];
      const normalized = content.trim().toLowerCase();
      const existing = memories.find((memory) => memory.normalized_content === normalized && memory.status === "active");
      if (existing) return existing;
      const now = new Date().toISOString();
      const memory: MemoryData = {
        id: memoryId,
        user_id: userId,
        content: content.trim(),
        normalized_content: normalized,
        content_hash: `local_${memoryId}`,
        category: category as MemoryData["category"],
        importance,
        source: source as MemoryData["source"],
        source_conversation_id: sourceConversationId ?? null,
        status: "active",
        index_status: "ready",
        embedding_model: "local",
        embedding_version: 1,
        created_at: now,
        updated_at: now,
        last_accessed_at: null,
        expires_at: null,
      };
      memories.push(memory);
      inMemoryMemories.set(userId, memories);
      return memory;
    },
    // 按关键词和条件检索进程内长期记忆。
    async search(userId, query, options = {}) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const items = (inMemoryMemories.get(userId) ?? [])
        .filter((memory) => memory.status === "active" && (!options.category || memory.category === options.category))
        .map((memory) => {
          const matches = words.filter((word) => memory.normalized_content.includes(word)).length;
          const score = words.length ? matches / words.length : 0;
          return { memory, score };
        })
        .filter(({ score }) => score >= (options.minScore ?? 0))
        .sort((a, b) => b.score - a.score || b.memory.importance - a.memory.importance)
        .slice(0, options.limit ?? 10)
        .map(({ memory, score }): MemorySearchResultData => ({
          id: memory.id, content: memory.content, category: memory.category, importance: memory.importance,
          semantic_score: score, final_score: score, created_at: memory.created_at, updated_at: memory.updated_at,
          source_conversation_id: memory.source_conversation_id,
        }));
      return { items, degraded: false };
    },
    // 按条件列出进程内有效长期记忆。
    async list(userId, options = {}) {
      return (inMemoryMemories.get(userId) ?? [])
        .filter((memory) => memory.status === "active" && (!options.category || memory.category === options.category))
        .sort((a, b) => b.importance - a.importance || b.created_at.localeCompare(a.created_at))
        .slice(0, options.limit ?? 50);
    },
    // 更新进程内有效长期记忆。
    async update(userId, memoryId, changes) {
      const memories = inMemoryMemories.get(userId) ?? [];
      const index = memories.findIndex((memory) => memory.id === memoryId && memory.status === "active");
      if (index < 0) return null;
      const current = memories[index];
      const content = changes.content?.trim() ?? current.content;
      const updated: MemoryData = {
        ...current,
        content,
        normalized_content: content.toLowerCase(),
        category: (changes.category ?? current.category) as MemoryData["category"],
        importance: changes.importance ?? current.importance,
        updated_at: nextIsoTimestamp(current.updated_at),
      };
      memories[index] = updated;
      return updated;
    },
    // 软删除进程内长期记忆。
    async delete(userId, memoryId) {
      const memories = inMemoryMemories.get(userId) ?? [];
      const memory = memories.find((item) => item.id === memoryId && item.status === "active");
      if (!memory) return false;
      memory.status = "deleted";
      memory.updated_at = nextIsoTimestamp(memory.updated_at);
      return true;
    },
    // 清空指定用户的进程内长期记忆。
    async clearUser(userId) {
      const memories = inMemoryMemories.get(userId) ?? [];
      const active = memories.filter((memory) => memory.status === "active");
      inMemoryMemories.set(userId, []);
      return active.length;
    },
  },
};

// ============ Cloudflare 实现 ============

/**
 * Cloudflare Gateway 仓储实现
 */
class CloudflareRepositories implements Repositories {
  readonly profile: ProfileRepository;
  readonly conversation: ConversationRepository;
  readonly message: MessageRepository;
  readonly turn: TurnRepository;
  readonly memory: MemoryRepository;

  // 初始化当前对象
  constructor(client: CloudflareMemoryClient) {
    this.profile = new CloudflareProfileRepository(client);
    this.conversation = new CloudflareConversationRepository(client);
    this.message = new CloudflareMessageRepository(client);
    this.turn = new CloudflareTurnRepository(client);
    this.memory = new CloudflareMemoryRepository(client);
  }
}

class CloudflareTurnRepository implements TurnRepository {
  private useLocalFallback = false;

  // 初始化 Turn 仓储。
  constructor(private readonly _client: CloudflareMemoryClient) {}

  // 原子创建 Turn 并保存用户消息。
  async begin(conversationId: string, userId: string, clientMessageId: string, content: string, turnId?: string, userMessageId?: string) {
    if (this.useLocalFallback) return inMemoryRepositories.turn.begin(conversationId, userId, clientMessageId, content, turnId, userMessageId);
    try {
      return await this._client.beginTurn(conversationId, userId, clientMessageId, content, turnId, userMessageId);
    } catch (error) {
      if (!this.isLegacyGateway(error)) throw error;
      this.enableLocalFallback();
      return inMemoryRepositories.turn.begin(conversationId, userId, clientMessageId, content, turnId, userMessageId);
    }
  }

  // 原子保存助手消息并完成 Turn。
  async complete(turnId: string, userId: string, message: MessageData): Promise<TurnData> {
    if (this.useLocalFallback) return inMemoryRepositories.turn.complete(turnId, userId, message);
    return this._client.completeTurn(
      turnId,
      userId,
      message,
      JSON.stringify({ id: message.id, role: "assistant", content: message.content_json, createdAt: message.created_at }),
    );
  }

  // 判断旧版 Gateway 是否尚未提供 Turn API。
  private isLegacyGateway(error: unknown): boolean {
    return error instanceof MemoryGatewayError && error.statusCode === 404 && error.code === "MEMORY_NOT_FOUND";
  }

  // 切换到进程内 Turn 兼容层并只记录一次降级告警。
  private enableLocalFallback(): void {
    if (this.useLocalFallback) return;
    this.useLocalFallback = true;
    console.warn("[turn] Gateway does not expose Turn API; using local compatibility storage");
  }

  // 原子创建或复用客户端消息对应的 Turn。
  async createOrGet(conversationId: string, userId: string, clientMessageId: string, turnId?: string) {
    if (this.useLocalFallback) {
      return inMemoryRepositories.turn.createOrGet(conversationId, userId, clientMessageId, turnId);
    }
    try {
      return await this._client.createOrGetTurn(conversationId, userId, clientMessageId, turnId);
    } catch (error) {
      if (!this.isLegacyGateway(error)) throw error;
      this.enableLocalFallback();
      return inMemoryRepositories.turn.createOrGet(conversationId, userId, clientMessageId, turnId);
    }
  }

  // 按用户读取 Turn。
  async get(turnId: string, userId: string): Promise<TurnData | null> {
    if (this.useLocalFallback) return inMemoryRepositories.turn.get(turnId, userId);
    return this._client.getTurn(turnId, userId);
  }

  // 按合法状态机更新 Turn。
  async update(
    turnId: string,
    userId: string,
    changes: Partial<Pick<TurnData, "user_message_id" | "assistant_message_id" | "assistant_content_json" | "error_code">> & { status: TurnStatus },
  ): Promise<TurnData> {
    if (this.useLocalFallback) return inMemoryRepositories.turn.update(turnId, userId, changes);
    return this._client.updateTurn(turnId, userId, changes);
  }
}

// ============ Cloudflare Profile Repository ==========

class CloudflareProfileRepository implements ProfileRepository {
  // 初始化当前对象
  constructor(private readonly _client: CloudflareMemoryClient) {}

  // 获取 getOrCreate 对应的数据
  async getOrCreate(userId: string, name: string = ""): Promise<UserProfileData> {
    const existing = await this._client.getProfile(userId);
    if (existing) return existing as unknown as UserProfileData;
    const data = await this._client.putProfile(userId, name);
    return data as unknown as UserProfileData;
  }

  // 获取 get 对应的数据
  async get(userId: string): Promise<UserProfileData | null> {
    const data = await this._client.getProfile(userId);
    return data as unknown as UserProfileData | null;
  }

  // 更新或保存 update 对应的数据
  async update(
    userId: string,
    name?: string,
    preferences?: Record<string, unknown>,
  ): Promise<UserProfileData | null> {
    // putProfile 内部已处理 getOrCreate，直接调用即可
    // 如果 profile 不存在，putProfile 会创建它（符合 update-or-create 语义）
    const data = await this._client.putProfile(userId, name, preferences);
    return data as unknown as UserProfileData | null;
  }
}

// ============ Cloudflare Conversation Repository ==========

class CloudflareConversationRepository implements ConversationRepository {
  // 初始化当前对象
  constructor(private readonly _client: CloudflareMemoryClient) {}

  // 创建或注册 create 所需的数据
  async create(
    userId: string,
    title: string,
    mode: string = "chat",
    conversationId?: string,
  ): Promise<ConversationData> {
    const data = await this._client.createConversation(userId, title, mode, conversationId);
    return data as unknown as ConversationData;
  }

  // 获取 get 对应的数据
  async get(conversationId: string): Promise<ConversationData | null> {
    const data = await this._client.getConversation(conversationId);
    return data as unknown as ConversationData | null;
  }

  // 获取 list 对应的数据
  async list(
    userId: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<ConversationData[]> {
    const data = await this._client.listConversations(userId, limit, offset);
    return data as unknown as ConversationData[];
  }

  // 删除或清理 delete 对应的数据
  async delete(conversationId: string): Promise<boolean> {
    return this._client.deleteConversation(conversationId);
  }
}

// ============ Cloudflare Message Repository ==========

class CloudflareMessageRepository implements MessageRepository {
  // 初始化当前对象
  constructor(private readonly _client: CloudflareMemoryClient) {}

  // 创建或注册 createBatch 所需的数据
  async createBatch(
    conversationId: string,
    userId: string,
    messages: MessageWriteData[],
  ): Promise<void> {
    await this._client.createMessagesBatch(
      conversationId,
      userId,
      messages.map((message) => ({
        id: message.id,
        sequence_no: message.sequence_no,
        role: message.role,
        content: message.content_json,
        created_at: message.created_at,
      })),
    );
  }

  // 获取 getMessages 对应的数据
  async getMessages(
    conversationId: string,
    limit: number = 50,
    offset: number = 0,
    direction: "asc" | "desc" = "asc",
  ): Promise<{ messages: MessageData[]; total: number }> {
    const result = await this._client.getMessages(conversationId, limit, offset, direction);
    return result as unknown as { messages: MessageData[]; total: number };
  }

  // 删除或清理 clear 对应的数据
  async clear(conversationId: string): Promise<void> {
    await this._client.clearMessages(conversationId);
  }
}

// ============ Cloudflare Memory Repository ==========

class CloudflareMemoryRepository implements MemoryRepository {
  // 初始化当前对象
  constructor(private readonly _client: CloudflareMemoryClient) {}

  // 更新或保存 save 对应的数据
  async save(
    userId: string,
    memoryId: string,
    content: string,
    category: string = "fact",
    importance: number = 3,
    source: string = "user_explicit",
    sourceConversationId?: string,
    idempotencyKey?: string,
  ): Promise<MemoryData> {
    // 生成幂等性键：基于用户+内容的稳定 hash
    const key = idempotencyKey || this.computeIdempotencyKey(userId, content);
    const data = await this._client.saveMemory(
      userId,
      memoryId,
      content,
      category,
      importance,
      source,
      sourceConversationId,
      key,
    );
    return data as unknown as MemoryData;
  }

  // 查询 search 对应的结果
  async search(
    userId: string,
    query: string,
    options: { category?: string; limit?: number; minScore?: number } = {},
  ): Promise<SearchResponse> {
    const result = await this._client.searchMemories(userId, query, {
      category: options.category,
      limit: options.limit,
      minScore: options.minScore,
    });
    return result as unknown as SearchResponse;
  }

  // 获取 list 对应的数据
  async list(
    userId: string,
    options: { category?: string; limit?: number } = {},
  ): Promise<MemoryData[]> {
    const data = await this._client.listMemories(userId, {
      category: options.category,
      limit: options.limit,
    });
    return data as unknown as MemoryData[];
  }

  // 更新或保存 update 对应的数据
  async update(
    userId: string,
    memoryId: string,
    changes: { content?: string; category?: string; importance?: number },
  ): Promise<MemoryData | null> {
    const data = await this._client.updateMemory(userId, memoryId, changes);
    return data as unknown as MemoryData | null;
  }

  // 删除或清理 delete 对应的数据
  async delete(userId: string, memoryId: string): Promise<boolean> {
    return this._client.deleteMemory(userId, memoryId);
  }

  // 删除或清理 clearUser 对应的数据
  async clearUser(userId: string): Promise<number> {
    const memories = await this._client.listMemories(userId, { limit: 100 });
    let count = 0;
    const memList = memories as any[];
    for (const m of memList) {
      const deleted = await this._client.deleteMemory(userId, m.id);
      if (deleted) count++;
    }
    return count;
  }

  /**
   * 计算幂等性键
   */
  // 执行 computeIdempotencyKey 对应的业务逻辑
  private computeIdempotencyKey(userId: string, content: string): string {
    const data = new TextEncoder().encode(`${userId}:${content}`);
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash + data[i]) | 0;
    }
    return `idem_${Math.abs(hash).toString(16)}_${Date.now().toString(36)}`;
  }
}
