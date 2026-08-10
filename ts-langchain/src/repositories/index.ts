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
  const client = new CloudflareMemoryClient({
    baseUrl: config.CLOUDFLARE_MEMORY_BASE_URL,
    secret: config.CLOUDFLARE_MEMORY_SECRET,
    timeoutMs: config.MEMORY_REQUEST_TIMEOUT_MS,
  });
  return new CloudflareRepositories(client);
}

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
