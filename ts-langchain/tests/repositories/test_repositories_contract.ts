/**
 * Repository Contract Test — 验证 Repository 层接口契约
 *
 * 对 CloudflareRepositories 运行完整 CRUD 测试，
 * 通过 mock CloudflareMemoryClient 避免真实 HTTP 请求。
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { getRepositories } from "../../src/repositories/index.js";

// ============ Mock CloudflareMemoryClient ============

const mockProfiles = new Map<string, any>();
const mockConversations = new Map<string, any>();
const mockMessages = new Map<string, any[]>();
const mockMemories = new Map<string, any[]>();
const mockSavedContents = new Map<string, Set<string>>();

function resetMocks() {
  mockProfiles.clear();
  mockConversations.clear();
  mockMessages.clear();
  mockMemories.clear();
  mockSavedContents.clear();
}

const mockCloudflareClient = {
  // Profile
  putProfile: vi.fn(async (userId: string, name: string = "", preferences?: any) => {
    const now = new Date().toISOString();
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
  createConversation: vi.fn(async (userId: string, title: string, mode: string = "chat") => {
    const id = crypto.randomUUID();
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
    for (const msg of messages) {
      if (!keys.has(msg.sequence_no)) {
        existing.push({
          ...msg,
          conversation_id: convId,
          user_id: userId,
          content_json: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? {}),
        });
        keys.add(msg.sequence_no);
      }
    }
    mockMessages.set(convId, existing);
  }),

  getMessages: vi.fn(async (convId: string, limit: number = 50, offset: number = 0) => {
    const all = (mockMessages.get(convId) || []).sort((a: any, b: any) => a.sequence_no - b.sequence_no);
    return { messages: all.slice(offset, offset + limit), total: all.length };
  }),

  clearMessages: vi.fn(async (convId: string) => {
    mockMessages.delete(convId);
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
};

// Mock the module
vi.mock("../../src/clients/memory_gateway", () => ({
  CloudflareMemoryClient: vi.fn(() => mockCloudflareClient),
  MemoryGatewayError: class extends Error {
    constructor(code: string, message: string, statusCode?: number) {
      super(`[${code}] ${message}`);
      this.code = code;
      this.statusCode = statusCode;
    }
  },
}));

// ============ Tests ============

describe("Repository Contract — CloudflareRepositories", () => {
  let repos: ReturnType<typeof getRepositories>;

  beforeEach(() => {
    resetMocks();
    repos = getRepositories();
  });

  // ============ Profile ============

  describe("ProfileRepository", () => {
    it("getOrCreate creates profile with defaults", async () => {
      const profile = await repos.profile.getOrCreate("user-001", "TestUser");
      expect(profile.user_id).toBe("user-001");
      expect(profile.name).toBe("TestUser");
      expect(profile.preferences_json).toBe("{}");
      expect(profile.created_at).toBeTruthy();
      expect(profile.updated_at).toBeTruthy();
    });

    it("getOrCreate preserves an existing profile", async () => {
      await repos.profile.getOrCreate("user-002", "First");
      const profile = await repos.profile.getOrCreate("user-002", "Second");
      expect(profile.user_id).toBe("user-002");
      expect(profile.name).toBe("First");
    });

    it("get returns null for nonexistent user", async () => {
      const profile = await repos.profile.get("nonexistent_user_xyz");
      expect(profile).toBeNull();
    });

    it("update modifies profile fields", async () => {
      await repos.profile.getOrCreate("user-004", "Original");
      const updated = await repos.profile.update("user-004", "Updated", { theme: "dark" });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe("Updated");
      expect(updated!.preferences_json).toContain("theme");
    });

    it("update creates profile if not exists (upsert behavior)", async () => {
      const result = await repos.profile.update("nonexistent-xyz", "Name");
      expect(result).toBeDefined();
      expect(result!.name).toBe("Name");
    });
  });

  // ============ Conversation ============

  describe("ConversationRepository", () => {
    it("create returns conversation with generated id", async () => {
      const conv = await repos.conversation.create("user-007", "Test Chat", "chat");
      expect(conv.id).toBeTruthy();
      expect(conv.user_id).toBe("user-007");
      expect(conv.title).toBe("Test Chat");
      expect(conv.mode).toBe("chat");
      expect(conv.deleted_at).toBeNull();
    });

    it("get returns conversation by id", async () => {
      const created = await repos.conversation.create("user-008", "Find Me");
      const found = await repos.conversation.get(created.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe("Find Me");
    });

    it("get returns null for nonexistent conversation", async () => {
      const conv = await repos.conversation.get("nonexistent_conv_xyz");
      expect(conv).toBeNull();
    });

    it("list returns only user's non-deleted conversations", async () => {
      const otherUid = "other-user-list";
      const conv1 = await repos.conversation.create("user-list", "Conv1");
      const conv2 = await repos.conversation.create("user-list", "Conv2");
      await repos.conversation.create(otherUid, "Other Conv");

      const list = await repos.conversation.list("user-list");
      expect(list.length).toBe(2);
      expect(list.map((c: any) => c.id)).toContain(conv1.id);
      expect(list.map((c: any) => c.id)).toContain(conv2.id);
    });

    it("list supports pagination", async () => {
      const uid = "user-page";
      await repos.conversation.create(uid, "C1");
      await repos.conversation.create(uid, "C2");
      await repos.conversation.create(uid, "C3");

      const page1 = await repos.conversation.list(uid, 2, 0);
      expect(page1.length).toBe(2);
    });

    it("delete soft-deletes conversation", async () => {
      const conv = await repos.conversation.create("user-del", "ToDelete");
      const deleted = await repos.conversation.delete(conv.id);
      expect(deleted).toBe(true);

      const found = await repos.conversation.get(conv.id);
      expect(found).toBeDefined();
      expect(found!.deleted_at).toBeTruthy();
    });

    it("delete returns false for nonexistent conversation", async () => {
      const deleted = await repos.conversation.delete("nonexistent_xyz");
      expect(deleted).toBe(false);
    });
  });

  // ============ Message ============

  describe("MessageRepository", () => {
    it("createBatch stores messages", async () => {
      const conv = await repos.conversation.create("msg-user", "MsgTest");
      const messages = [
        { id: "msg1", conversation_id: conv.id, user_id: "msg-user", sequence_no: 0, role: "user" as const, content_json: "Hello", created_at: new Date().toISOString() },
        { id: "msg2", conversation_id: conv.id, user_id: "msg-user", sequence_no: 1, role: "assistant" as const, content_json: "Hi!", created_at: new Date().toISOString() },
      ];
      await repos.message.createBatch(conv.id, "msg-user", messages);

      const result = await repos.message.getMessages(conv.id);
      expect(result.messages.length).toBe(2);
      expect(result.total).toBe(2);
    });

    it("createBatch is idempotent (same sequence_no)", async () => {
      const conv = await repos.conversation.create("idem-user", "Idempotent");
      const msg = { id: "msg1", conversation_id: conv.id, user_id: "idem-user", sequence_no: 0, role: "user" as const, content_json: "Hello", created_at: new Date().toISOString() };

      await repos.message.createBatch(conv.id, "idem-user", [msg]);
      await repos.message.createBatch(conv.id, "idem-user", [msg]); // duplicate

      const result = await repos.message.getMessages(conv.id);
      expect(result.messages.length).toBe(1);
    });

    it("getMessages supports pagination", async () => {
      const conv = await repos.conversation.create("page-user", "PageTest");
      const messages = Array.from({ length: 10 }, (_, i) => ({
        id: `msg_${i}`,
        conversation_id: conv.id,
        user_id: "page-user",
        sequence_no: i,
        role: "user" as const,
        content_json: `Msg ${i}`,
        created_at: new Date().toISOString(),
      }));
      await repos.message.createBatch(conv.id, "page-user", messages);

      const result = await repos.message.getMessages(conv.id, 5, 0);
      expect(result.messages.length).toBe(5);
      expect(result.total).toBe(10);
    });

    it("clear removes all messages", async () => {
      const conv = await repos.conversation.create("clear-user", "ClearTest");
      await repos.message.createBatch(conv.id, "clear-user", [
        { id: "m1", conversation_id: conv.id, user_id: "clear-user", sequence_no: 0, role: "user" as const, content_json: "Hello", created_at: new Date().toISOString() },
      ]);
      await repos.message.clear(conv.id);

      const result = await repos.message.getMessages(conv.id);
      expect(result.messages.length).toBe(0);
    });
  });

  // ============ Memory ============

  describe("MemoryRepository", () => {
    it("save creates a new memory with given id", async () => {
      const memory = await repos.memory.save("mem-user", "mem_001", "用户喜欢 TypeScript", "preference", 4);
      expect(memory.id).toBe("mem_001");
      expect(memory.content).toBe("用户喜欢 TypeScript");
      expect(memory.category).toBe("preference");
      expect(memory.importance).toBe(4);
      expect(memory.status).toBe("active");
    });

    it("save deduplicates by normalized content", async () => {
      const mem1 = await repos.memory.save("dedup-user", "mem_001", "Same content", "fact", 3);
      const mem2 = await repos.memory.save("dedup-user", "mem_002", "Same content", "fact", 3);
      // 相同内容应返回已有记录
      expect(mem1.id).toBe(mem2.id);
    });

    it("list returns user's active memories", async () => {
      const uid = "list-user";
      await repos.memory.save(uid, "mem_001", "Memory 1", "fact", 3);
      await repos.memory.save(uid, "mem_002", "Memory 2", "preference", 4);

      const memories = await repos.memory.list(uid);
      expect(memories.length).toBeGreaterThanOrEqual(2);
    });

    it("list supports category filter", async () => {
      const uid = "cat-user";
      await repos.memory.save(uid, "mem_001", "Fact 1", "fact", 3);
      await repos.memory.save(uid, "mem_002", "Pref 1", "preference", 4);

      const facts = await repos.memory.list(uid, { category: "fact" });
      expect(facts.length).toBeGreaterThanOrEqual(1);
      expect(facts.every((m: any) => m.category === "fact")).toBe(true);
    });

    it("search returns matching memories", async () => {
      const uid = "search-user";
      await repos.memory.save(uid, "mem_001", "用户在北京", "fact", 5);
      await repos.memory.save(uid, "mem_002", "用户在上海", "fact", 3);

      const result = await repos.memory.search(uid, "北京");
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.degraded).toBe(true);
    });

    it("search returns empty for no match", async () => {
      const uid = "empty-search";
      await repos.memory.save(uid, "mem_001", "Some content", "fact", 3);
      const result = await repos.memory.search(uid, "完全不匹配的内容_xyz");
      expect(result.items.length).toBe(0);
    });

    it("delete removes memory by id", async () => {
      const uid = "del-user";
      const mem = await repos.memory.save(uid, "mem_del", "To be deleted", "fact", 3);
      const deleted = await repos.memory.delete(uid, mem.id);
      expect(deleted).toBe(true);

      const memories = await repos.memory.list(uid);
      expect(memories.find((m: any) => m.id === mem.id)).toBeUndefined();
    });

    it("delete returns false for nonexistent memory", async () => {
      const deleted = await repos.memory.delete("missing-user", "nonexistent_mem_xyz");
      expect(deleted).toBe(false);
    });

    it("clearUser removes all user memories", async () => {
      const uid = "clear-mem-user";
      await repos.memory.save(uid, "mem_001", "Keep", "fact", 3);
      await repos.memory.save(uid, "mem_002", "Remove", "fact", 3);

      const count = await repos.memory.clearUser(uid);
      expect(count).toBeGreaterThanOrEqual(1);

      const remaining = await repos.memory.list(uid);
      expect(remaining.length).toBe(0);
    });

    it("search result includes semantic_score and final_score fields", async () => {
      const uid = "score-user";
      await repos.memory.save(uid, "mem_score", "Test scoring", "fact", 3);
      const result = await repos.memory.search(uid, "Test");
      if (result.items.length > 0) {
        expect(result.items[0]).toHaveProperty("semantic_score");
        expect(result.items[0]).toHaveProperty("final_score");
      }
    });
  });
});
