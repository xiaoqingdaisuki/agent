/**
 * Vitest Global Setup — 自动 mock CloudflareMemoryClient
 *
 * 所有测试自动使用 FakeRepositories，避免真实 HTTP 请求。
 */

import { beforeEach, vi } from "vitest";

process.env.AGENT_API_SECRET = "test-agent-secret";
process.env.MEMORY_ENABLED = "true";

// ============ Fake 数据存储 ============

const mockProfiles = new Map<string, any>();
const mockConversations = new Map<string, any>();
const mockMessages = new Map<string, any[]>();
const mockTurns = new Map<string, any>();
const mockTurnKeys = new Map<string, string>();
const mockMemories = new Map<string, any[]>();
const mockSavedContents = new Map<string, Set<string>>();

export function resetMocks() {
  mockProfiles.clear();
  mockConversations.clear();
  mockMessages.clear();
  mockTurns.clear();
  mockTurnKeys.clear();
  mockMemories.clear();
  mockSavedContents.clear();
}

// ============ Mock CloudflareMemoryClient ============

export const mockCloudflareClient = {
  // Profile
  putProfile: vi.fn(async (userId: string, name: string = "", preferences?: any) => {
    const existing = mockProfiles.get(userId);
    const now = new Date(Math.max(Date.now(), existing ? Date.parse(existing.updated_at) + 1 : 0)).toISOString();
    if (!mockProfiles.has(userId)) {
      mockProfiles.set(userId, {
        user_id: userId,
        name,
        preferences_json: JSON.stringify(preferences || {}),
        created_at: now,
        updated_at: now,
      });
    } else {
      const profile = mockProfiles.get(userId)!;
      if (name) profile.name = name;
      if (preferences !== undefined) profile.preferences_json = JSON.stringify(preferences);
      profile.updated_at = now;
    }
    return { ...mockProfiles.get(userId)! };
  }),

  getProfile: vi.fn(async (userId: string) => {
    const profile = mockProfiles.get(userId);
    return profile ? { ...profile } : null;
  }),

  // Conversation
  createConversation: vi.fn(async (
    userId: string,
    title: string,
    mode: string = "chat",
    conversationId?: string,
  ) => {
    const id = conversationId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const conv = { id, user_id: userId, title, mode, created_at: now, updated_at: now, deleted_at: null };
    mockConversations.set(id, conv);
    return { ...conv };
  }),

  listConversations: vi.fn(async (userId: string, limit: number = 20, offset: number = 0) => {
    const all = Array.from(mockConversations.values())
      .filter((c: any) => c.user_id === userId && c.deleted_at === null)
      .sort((a: any, b: any) => b.updated_at.localeCompare(a.updated_at));
    return all.slice(offset, offset + limit).map((c: any) => ({ ...c }));
  }),

  getConversation: vi.fn(async (convId: string) => {
    const conv = mockConversations.get(convId);
    return conv ? { ...conv } : null;
  }),

  deleteConversation: vi.fn(async (convId: string) => {
    const conv = mockConversations.get(convId);
    if (!conv || conv.deleted_at !== null) return false;
    conv.deleted_at = new Date().toISOString();
    return true;
  }),

  // Message
  createMessagesBatch: vi.fn(async (convId: string, userId: string, messages: any[]) => {
    const existing = mockMessages.get(convId) || [];
    const keys = new Set(existing.map((m: any) => m.sequence_no));
    let nextSequence = Math.max(-1, ...Array.from(keys, (value) => Number(value))) + 1;
    for (const msg of messages) {
      const sequenceNo = msg.sequence_no ?? nextSequence++;
      if (!keys.has(sequenceNo)) {
        existing.push({
          ...msg,
          sequence_no: sequenceNo,
          conversation_id: convId,
          user_id: userId,
          content_json: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? {}),
        });
        keys.add(sequenceNo);
      }
    }
    mockMessages.set(convId, existing);
  }),

  getMessages: vi.fn(async (
    convId: string,
    limit: number = 50,
    offset: number = 0,
    direction: "asc" | "desc" = "asc",
  ) => {
    const all = (mockMessages.get(convId) || []).sort((a: any, b: any) => a.sequence_no - b.sequence_no);
    const ordered = direction === "desc" ? [...all].reverse() : all;
    return { messages: ordered.slice(offset, offset + limit), total: all.length };
  }),

  clearMessages: vi.fn(async (convId: string) => {
    mockMessages.delete(convId);
  }),

  createOrGetTurn: vi.fn(async (convId: string, userId: string, clientMessageId: string, turnId = crypto.randomUUID()) => {
    const key = `${convId}\u0000${clientMessageId}`;
    const existingId = mockTurnKeys.get(key);
    if (existingId) return { turn: { ...mockTurns.get(existingId) }, created: false };
    const now = new Date().toISOString();
    const turn = {
      id: turnId, conversation_id: convId, user_id: userId, client_message_id: clientMessageId,
      status: "pending", user_message_id: null, assistant_message_id: null,
      assistant_content_json: null, error_code: null, created_at: now, updated_at: now, completed_at: null,
    };
    mockTurns.set(turnId, turn);
    mockTurnKeys.set(key, turnId);
    return { turn: { ...turn }, created: true };
  }),

  beginTurn: vi.fn(async (convId: string, userId: string, clientMessageId: string, content: string, turnId = crypto.randomUUID(), userMessageId = crypto.randomUUID()) => {
    const key = `${convId}\u0000${clientMessageId}`;
    const existingId = mockTurnKeys.get(key);
    if (existingId) {
      const turn = mockTurns.get(existingId);
      const userMessage = (mockMessages.get(convId) || []).find((item: any) => item.id === turn.user_message_id);
      return { turn: { ...turn }, userMessage: { ...userMessage }, created: false };
    }
    const now = new Date().toISOString();
    const messages = mockMessages.get(convId) || [];
    const userMessage = {
      id: userMessageId, conversation_id: convId, user_id: userId, sequence_no: messages.length,
      role: "user", content_json: content, created_at: now,
    };
    const turn = {
      id: turnId, conversation_id: convId, user_id: userId, client_message_id: clientMessageId,
      status: "streaming", user_message_id: userMessageId, assistant_message_id: null,
      assistant_content_json: null, error_code: null, created_at: now, updated_at: now, completed_at: null,
    };
    messages.push(userMessage);
    mockMessages.set(convId, messages);
    mockTurns.set(turnId, turn);
    mockTurnKeys.set(key, turnId);
    return { turn: { ...turn }, userMessage: { ...userMessage }, created: true };
  }),

  completeTurn: vi.fn(async (turnId: string, userId: string, message: any, assistantContentJson: string) => {
    const turn = mockTurns.get(turnId);
    if (!turn || turn.user_id !== userId) throw new Error("MEMORY_TURN_NOT_FOUND");
    if (turn.status === "completed") return { ...turn };
    const messages = mockMessages.get(turn.conversation_id) || [];
    messages.push({ ...message, conversation_id: turn.conversation_id, sequence_no: messages.length });
    mockMessages.set(turn.conversation_id, messages);
    Object.assign(turn, {
      status: "completed", assistant_message_id: message.id,
      assistant_content_json: assistantContentJson, updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
    return { ...turn };
  }),

  getTurn: vi.fn(async (turnId: string, userId: string) => {
    const turn = mockTurns.get(turnId);
    return turn?.user_id === userId ? { ...turn } : null;
  }),

  updateTurn: vi.fn(async (turnId: string, userId: string, changes: any) => {
    const turn = mockTurns.get(turnId);
    if (!turn || turn.user_id !== userId) throw new Error("MEMORY_TURN_NOT_FOUND");
    Object.assign(turn, changes, { updated_at: new Date().toISOString() });
    if (["completed", "failed", "cancelled"].includes(changes.status)) turn.completed_at = turn.updated_at;
    return { ...turn };
  }),

  // Memory
  saveMemory: vi.fn(async (userId: string, memoryId: string, content: string, category: string = "fact",
    importance: number = 3, source: string = "user_explicit",
    sourceConversationId?: string, idempotencyKey?: string) => {
    const normalized = content.trim().toLowerCase();
    const saved = mockSavedContents.get(userId) || new Set<string>();

    // Deduplicate
    if (saved.has(normalized)) {
      const existing = mockMemories.get(userId) || [];
      const found = existing.find((m: any) => m.status !== "deleted" && m.normalized_content === normalized);
      if (found) {
        found.updated_at = new Date().toISOString();
        found.last_accessed_at = found.updated_at;
        return { ...found };
      }
    }

    const now = new Date().toISOString();
    const memory = {
      id: memoryId,
      user_id: userId,
      content: content.trim(),
      normalized_content: normalized,
      content_hash: `test_${memoryId}`,
      category,
      importance,
      source,
      source_conversation_id: sourceConversationId ?? null,
      status: "active",
      index_status: "ready",
      embedding_model: "",
      embedding_version: 1,
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      expires_at: null,
    };
    if (!mockMemories.has(userId)) mockMemories.set(userId, []);
    mockMemories.get(userId)!.push(memory);
    saved.add(normalized);
    mockSavedContents.set(userId, saved);
    return { ...memory };
  }),

  searchMemories: vi.fn(async (userId: string, query: string, options: any = {}) => {
    let memories = (mockMemories.get(userId) || []).filter((m: any) => m.status !== "deleted");

    if (query && query.trim()) {
      const q = query.toLowerCase();
      memories = memories.filter((m: any) => m.content.toLowerCase().includes(q));
    }
    if (options.category) {
      memories = memories.filter((m: any) => m.category === options.category);
    }

    memories = [...memories].sort((a: any, b: any) => b.importance - a.importance);
    const limit = options.limit ?? 10;
    const items = memories.slice(0, limit).map((m: any) => ({
      id: m.id,
      content: m.content,
      category: m.category,
      importance: m.importance,
      semantic_score: 0,
      final_score: m.importance / 5,
      created_at: m.created_at,
      updated_at: m.updated_at,
      source_conversation_id: m.source_conversation_id,
    }));

    return { items, degraded: true };
  }),

  listMemories: vi.fn(async (userId: string, options: any = {}) => {
    let memories = (mockMemories.get(userId) || []).filter((m: any) => m.status !== "deleted");
    if (options.category) {
      memories = memories.filter((m: any) => m.category === options.category);
    }
    memories = [...memories].sort((a: any, b: any) => b.importance - a.importance);
    return memories.slice(0, options.limit ?? 50).map((m: any) => ({ ...m }));
  }),

  updateMemory: vi.fn(async (_userId: string, memoryId: string, changes: any) => {
    for (const memories of mockMemories.values()) {
      for (const m of memories) {
        if (m.id === memoryId && m.status !== "deleted") {
          Object.assign(m, changes, { updated_at: new Date().toISOString() });
          if (changes.content) m.normalized_content = changes.content.trim().toLowerCase();
          return { ...m };
        }
      }
    }
    return null;
  }),

  deleteMemory: vi.fn(async (_userId: string, memoryId: string) => {
    for (const memories of mockMemories.values()) {
      for (const m of memories) {
        if (m.id === memoryId) {
          m.status = "deleted";
          m.updated_at = new Date().toISOString();
          return true;
        }
      }
    }
    return false;
  }),

  uploadDocument: vi.fn(async (
    userId: string,
    filename: string,
    content: string,
    fileType?: string,
    category = "general",
  ) => ({
    id: "doc_test",
    user_id: userId,
    name: filename,
    filename,
    file_type: fileType ?? "text/plain",
    size: content.length,
    category,
    status: "indexed",
    chunk_count: 1,
    content_text: "hello",
    content_filename: filename,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  })),
  listDocuments: vi.fn(async () => ({ documents: [], total: 0 })),
  getDocument: vi.fn(async () => null),
  deleteDocument: vi.fn(async () => true),
  reindexDocument: vi.fn(async () => ({ chunk_count: 1, degraded: false })),
  searchDocuments: vi.fn(async (_userId: string, _query: string, options: any = {}) => ({
    results: options.documentIds?.length
      ? [{
          id: "chunk_test",
          document_id: options.documentIds[0],
          chunk_index: 17,
          content: "任何一方提前终止本协议，应至少提前30日通知。",
          score: 0.92,
          metadata: { filename: "contract.pdf" },
          created_at: new Date().toISOString(),
        }]
      : [],
    degraded: false,
  })),
};

beforeEach(() => {
  resetMocks();
  vi.clearAllMocks();
});

// Mock the module
vi.mock("../src/clients/memory_gateway.js", () => ({
  CloudflareMemoryClient: vi.fn(() => mockCloudflareClient),
  MemoryGatewayError: class extends Error {
    constructor(code: string, message: string, statusCode?: number) {
      super(`[${code}] ${message}`);
      this.code = code;
      this.statusCode = statusCode;
    }
  },
}));
