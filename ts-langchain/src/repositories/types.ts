/**
 * Repository Types — 数据仓储层共享类型定义
 *
 * 定义 Profile、Conversation、Message、Memory 的接口契约，
 * 以及 Repository 的统一接口。InMemory 和 Cloudflare 实现共享这些类型。
 */

// ============ 基础类型 ============

/** 用户画像 */
export interface UserProfileData {
  user_id: string;
  name: string;
  preferences_json: string;
  created_at: string;
  updated_at: string;
}

/** 会话 */
export interface ConversationData {
  id: string;
  user_id: string;
  title: string;
  mode: "chat" | "knowledge" | "mixed";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** 消息 */
export interface MessageData {
  id: string;
  conversation_id: string;
  user_id: string;
  sequence_no: number;
  role: "user" | "assistant" | "system" | "tool";
  content_json: string;
  created_at: string;
}

/** 长期记忆 */
export interface MemoryData {
  id: string;
  user_id: string;
  content: string;
  normalized_content: string;
  content_hash: string;
  category: "preference" | "fact" | "decision" | "context";
  importance: number;
  source: "user_explicit" | "conversation_extraction";
  source_conversation_id: string | null;
  status: "active" | "deleted";
  index_status: "pending" | "ready" | "failed" | "deleting";
  embedding_model: string;
  embedding_version: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  expires_at: string | null;
}

/** 语义搜索结果 */
export interface MemorySearchResultData {
  id: string;
  content: string;
  category: string;
  importance: number;
  semantic_score: number;
  final_score: number;
  created_at: string;
  updated_at: string;
}

/** 搜索响应 */
export interface SearchResponse {
  items: MemorySearchResultData[];
  degraded: boolean;
}

// ============ Repository 接口 ============

/**
 * Profile 仓储接口
 */
export interface ProfileRepository {
  /** 创建或获取用户画像 */
  getOrCreate(userId: string, name?: string): Promise<UserProfileData>;

  /** 获取用户画像，不存在返回 null */
  get(userId: string): Promise<UserProfileData | null>;

  /** 更新用户画像 */
  update(
    userId: string,
    name?: string,
    preferences?: Record<string, unknown>,
  ): Promise<UserProfileData | null>;
}

/**
 * Conversation 仓储接口
 */
export interface ConversationRepository {
  /** 创建会话 */
  create(userId: string, title: string, mode?: string): Promise<ConversationData>;

  /** 获取会话详情 */
  get(conversationId: string): Promise<ConversationData | null>;

  /** 列出用户会话（分页） */
  list(userId: string, limit?: number, offset?: number): Promise<ConversationData[]>;

  /** 删除会话（软删除） */
  delete(conversationId: string): Promise<boolean>;
}

/**
 * Message 仓储接口
 */
export interface MessageRepository {
  /** 批量写入消息 */
  createBatch(
    conversationId: string,
    userId: string,
    messages: MessageData[],
  ): Promise<void>;

  /** 获取会话消息列表 */
  getMessages(
    conversationId: string,
    limit?: number,
    offset?: number,
  ): Promise<{ messages: MessageData[]; total: number }>;

  /** 清空会话消息 */
  clear(conversationId: string): Promise<void>;
}

/**
 * Memory 仓储接口
 */
export interface MemoryRepository {
  /** 保存记忆（幂等） */
  save(
    userId: string,
    memoryId: string,
    content: string,
    category?: string,
    importance?: number,
    source?: string,
    sourceConversationId?: string,
    idempotencyKey?: string,
  ): Promise<MemoryData>;

  /** 语义搜索记忆 */
  search(
    userId: string,
    query: string,
    options?: { category?: string; limit?: number; minScore?: number },
  ): Promise<SearchResponse>;

  /** 列出用户记忆 */
  list(
    userId: string,
    options?: { category?: string; limit?: number },
  ): Promise<MemoryData[]>;

  /** 更新记忆 */
  update(
    userId: string,
    memoryId: string,
    changes: { content?: string; category?: string; importance?: number },
  ): Promise<MemoryData | null>;

  /** 删除记忆 */
  delete(userId: string, memoryId: string): Promise<boolean>;

  /** 清空用户所有记忆 */
  clearUser(userId: string): Promise<number>;
}

/**
 * 组合仓储接口
 */
export interface Repositories {
  profile: ProfileRepository;
  conversation: ConversationRepository;
  message: MessageRepository;
  memory: MemoryRepository;
}
