/**
 * Repositories — 数据仓储层
 *
 * 统一使用 Cloudflare Service 作为存储后端。
 * 所有业务层（Service、Tool、API Route）只能通过 Repository 访问数据。
 */

import {
  type ProfileRepository,
  type ConversationRepository,
  type MessageRepository,
  type MemoryRepository,
  type Repositories,
  type UserProfileData,
  type ConversationData,
  type MessageData,
  type MemoryData,
  type SearchResponse,
  type MemorySearchResultData,
} from "./types.js";
import { CloudflareMemoryClient, MemoryGatewayError } from "../clients/memory_gateway.js";
import { config } from "../config/index.js";

// ============ 工厂函数 ============

/**
 * 创建 Cloudflare 仓储实例
 */
// 获取 getRepositories 对应的数据
export function getRepositories(): Repositories {
  if (!config.MEMORY_ENABLED) return inMemoryRepositories;
  const client = new CloudflareMemoryClient({
    baseUrl: config.CLOUDFLARE_MEMORY_BASE_URL,
    secret: config.CLOUDFLARE_MEMORY_SECRET,
    timeoutMs: config.MEMORY_REQUEST_TIMEOUT_MS,
  });
  return new CloudflareRepositories(client);
}

const inMemoryProfiles = new Map<string, UserProfileData>();
const inMemoryConversations = new Map<string, ConversationData>();
const inMemoryMessages = new Map<string, MessageData[]>();
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
      for (const message of messages) byId.set(message.id, message);
      inMemoryMessages.set(conversationId, Array.from(byId.values()).sort((a, b) => a.sequence_no - b.sequence_no));
    },
    // 分页获取进程内会话消息。
    async getMessages(conversationId, limit = 50, offset = 0) {
      const all = inMemoryMessages.get(conversationId) ?? [];
      return { messages: all.slice(offset, offset + limit), total: all.length };
    },
    // 清空进程内会话消息。
    async clear(conversationId) {
      inMemoryMessages.set(conversationId, []);
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
  readonly memory: MemoryRepository;

  // 初始化当前对象
  constructor(client: CloudflareMemoryClient) {
    this.profile = new CloudflareProfileRepository(client);
    this.conversation = new CloudflareConversationRepository(client);
    this.message = new CloudflareMessageRepository(client);
    this.memory = new CloudflareMemoryRepository(client);
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
    messages: MessageData[],
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
  ): Promise<{ messages: MessageData[]; total: number }> {
    const result = await this._client.getMessages(conversationId, limit, offset);
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
