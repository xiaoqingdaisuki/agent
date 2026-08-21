/**
 * Memory Gateway Client Unit Tests
 *
 * 使用 fetch mock 测试 CloudflareMemoryClient 的 HTTP 请求行为。
 * 验证：请求头、URL 构建、错误处理、超时处理。
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.unmock("../../src/clients/memory_gateway.js");

import { CloudflareMemoryClient, MemoryGatewayError } from "../../src/clients/memory_gateway.js";

// ============ Mock fetch ============

function createMockFetch() {
  const mockResponses = new Map<string, { status: number; body: unknown }>();

  function setMockResponse(path: string, status: number, body: unknown) {
    // body 是原始数据，自动包装为 Gateway 统一响应格式
    const wrapped = status < 400
      ? { ok: true, data: body, error: null, meta: { request_id: "req_test" } }
      : { ok: false, data: null, error: (body as any).error || { code: "MEMORY_INTERNAL_ERROR", message: "Error" }, meta: { request_id: "req_test" } };
    mockResponses.set(path, { status, body: wrapped });
  }

  const mockFn = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const response = mockResponses.get(path);
    if (response) {
      return {
        ok: response.status < 400,
        status: response.status,
        text: async () => JSON.stringify(response.body),
      } as Response;
    }
    // 默认返回 404
    return {
      ok: false,
      status: 404,
      text: async () => JSON.stringify({
        ok: false,
        data: null,
        error: { code: "MEMORY_NOT_FOUND", message: "Not found" },
        meta: { request_id: "req_test" },
      }),
    } as Response;
  });

  return { mockFetch: mockFn, setMockResponse };
}

// ============ Mock Data Helpers ============

const NOW = "2026-01-01T00:00:00.000Z";

function validProfile(overrides = {}): Record<string, unknown> {
  return {
    user_id: "usr_001",
    name: "Alice",
    preferences_json: "{}",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function validConversation(overrides = {}): Record<string, unknown> {
  return {
    id: "conv_001",
    user_id: "usr_001",
    title: "Chat",
    mode: "chat",
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

function validMessage(overrides = {}): Record<string, unknown> {
  return {
    id: "msg_001",
    conversation_id: "conv_001",
    user_id: "usr_001",
    sequence_no: 0,
    role: "user",
    content_json: "Hello",
    created_at: NOW,
    ...overrides,
  };
}

function validMemory(overrides = {}): Record<string, unknown> {
  return {
    id: "mem_001",
    user_id: "usr_001",
    content: "Test memory",
    normalized_content: "test memory",
    content_hash: "a".repeat(64),
    category: "fact",
    importance: 3,
    source: "user_explicit",
    source_conversation_id: null,
    status: "active",
    index_status: "ready",
    embedding_model: "@cf/baai/bge-m3",
    embedding_version: 1,
    created_at: NOW,
    updated_at: NOW,
    last_accessed_at: NOW,
    expires_at: null,
    ...overrides,
  };
}

// ============ Tests ============

describe("CloudflareMemoryClient", () => {
  let mockSetup: ReturnType<typeof createMockFetch>;
  let client: CloudflareMemoryClient;

  beforeEach(() => {
    mockSetup = createMockFetch();
    vi.stubGlobal("fetch", mockSetup.mockFetch);

    client = new CloudflareMemoryClient({
      baseUrl: "http://localhost:8787",
      secret: "test-secret",
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ============ Profile API ============

  describe("Profile API", () => {
    it("getProfile sends GET with auth header", async () => {
      mockSetup.setMockResponse("/internal/v1/users/usr_001/profile", 200, validProfile());

      const profile = await client.getProfile("usr_001");
      expect(profile).toBeDefined();
      expect(profile!.user_id).toBe("usr_001");
      expect(mockSetup.mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockSetup.mockFetch.mock.calls[0];
      expect(options!.headers!["Authorization"]).toBe("Bearer test-secret");
    });

    it("getProfile returns null for 404 user not found", async () => {
      mockSetup.setMockResponse("/internal/v1/users/unknown/profile", 404, {
        error: { code: "MEMORY_USER_NOT_FOUND", message: "用户不存在" },
      });

      const profile = await client.getProfile("unknown");
      expect(profile).toBeNull();
    });

    it("putProfile sends PUT with body", async () => {
      mockSetup.setMockResponse("/internal/v1/users/usr_001/profile", 200, validProfile({ name: "Alice", preferences_json: '{"theme":"dark"}' }));

      const result = await client.putProfile("usr_001", "Alice", { theme: "dark" });
      expect(result.user_id).toBe("usr_001");
      const [, options] = mockSetup.mockFetch.mock.calls[0];
      const body = JSON.parse(options!.body!);
      expect(body.name).toBe("Alice");
      expect(body.preferences).toEqual({ theme: "dark" });
    });
  });

  // ============ Conversation API ============

  describe("Conversation API", () => {
    it("createConversation sends POST with user_id, title, mode", async () => {
      mockSetup.setMockResponse("/internal/v1/conversations", 201, validConversation({ id: "conv_001", title: "New Chat" }));

      const conv = await client.createConversation("usr_001", "New Chat", "chat");
      expect(conv.id).toBe("conv_001");
      expect(conv.user_id).toBe("usr_001");
    });

    it("listConversations returns array of conversations", async () => {
      mockSetup.setMockResponse("/internal/v1/users/usr_001/conversations", 200, [
        validConversation({ id: "c1", title: "Chat 1" }),
        validConversation({ id: "c2", title: "Chat 2" }),
      ]);

      const convs = await client.listConversations("usr_001", 20, 0);
      expect(convs.length).toBe(2);
    });

    it("listConversations passes limit and offset in URL", async () => {
      mockSetup.setMockResponse("/internal/v1/users/usr_001/conversations", 200, []);

      await client.listConversations("usr_001", 50, 10);
      // Verify fetch was called with correct URL containing pagination params
      const [url] = mockSetup.mockFetch.mock.calls[0];
      expect(url).toContain("limit=50");
      expect(url).toContain("offset=10");
    });

    it("deleteConversation returns true on success", async () => {
      mockSetup.setMockResponse("/internal/v1/conversations/conv_001", 200, validConversation({ id: "conv_001" }));

      const result = await client.deleteConversation("conv_001");
      expect(result).toBe(true);
    });

    it("deleteConversation returns false for 404", async () => {
      mockSetup.setMockResponse("/internal/v1/conversations/unknown", 404, {
        error: { code: "MEMORY_CONVERSATION_NOT_FOUND", message: "会话不存在" },
      });

      const result = await client.deleteConversation("unknown");
      expect(result).toBe(false);
    });
  });

  // ============ Message API ============

  describe("Message API", () => {
    it("createMessagesBatch sends batch of messages", async () => {
      mockSetup.setMockResponse(
        "/internal/v1/conversations/conv_001/messages:batch",
        200,
        { count: 2 },
      );

      await client.createMessagesBatch("conv_001", "usr_001", [
        { id: "m1", role: "user", content_json: "Hello", sequence_no: 0 },
        { id: "m2", role: "assistant", content_json: "Hi!", sequence_no: 1 },
      ]);

      expect(mockSetup.mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockSetup.mockFetch.mock.calls[0];
      const body = JSON.parse(options!.body!);
      expect(body.messages.length).toBe(2);
    });

    it("getMessages returns messages with total", async () => {
      mockSetup.setMockResponse(
        "/internal/v1/conversations/conv_001/messages",
        200,
        {
          messages: [validMessage()],
          total: 1,
        },
      );

      const result = await client.getMessages("conv_001");
      expect(result.messages.length).toBe(1);
      expect(result.total).toBe(1);
    });
  });

  // ============ Memory API ============

  describe("Memory API", () => {
    it("saveMemory sends PUT with memory data", async () => {
      mockSetup.setMockResponse(
        "/internal/v1/users/usr_001/memories/mem_001",
        200,
        validMemory({ content: "Test memory" }),
      );

      const memory = await client.saveMemory(
        "usr_001",
        "mem_001",
        "Test memory",
        "fact",
        3,
        "user_explicit",
      );
      expect(memory.id).toBe("mem_001");
      expect(memory.content).toBe("Test memory");
    });

    it("saveMemory includes idempotency key when provided", async () => {
      mockSetup.setMockResponse(
        "/internal/v1/users/usr_001/memories/mem_001",
        200,
        validMemory(),
      );

      await client.saveMemory(
        "usr_001",
        "mem_001",
        "Content",
        "fact",
        3,
        "user_explicit",
        undefined,
        "idem_abc123",
      );

      const [, options] = mockSetup.mockFetch.mock.calls[0];
      expect(options!.headers!["Idempotency-Key"]).toBe("idem_abc123");
    });

    it("searchMemories sends POST with query", async () => {
      mockSetup.setMockResponse(
        "/internal/v1/users/usr_001/memories:search",
        200,
        {
          items: [validMemory({ id: "mem_001", content: "Found memory", semantic_score: 0.9, final_score: 0.85 })],
          degraded: false,
        },
      );

      const result = await client.searchMemories("usr_001", "query", {
        limit: 10,
        minScore: 0.65,
      });
      expect(result.items.length).toBe(1);
      expect(result.degraded).toBe(false);

      const [, options] = mockSetup.mockFetch.mock.calls[0];
      const body = JSON.parse(options!.body!);
      expect(body.query).toBe("query");
      expect(body.limit).toBe(10);
    });

    it("listMemories supports category filter", async () => {
      mockSetup.setMockResponse(
        "/internal/v1/users/usr_001/memories",
        200,
        [
          validMemory({ id: "m1", category: "preference" }),
        ],
      );

      const memories = await client.listMemories("usr_001", { category: "preference" });
      expect(memories.length).toBe(1);
      expect(memories[0].category).toBe("preference");
    });

    it("deleteMemory returns true on success", async () => {
      mockSetup.setMockResponse(
        "/internal/v1/users/usr_001/memories/mem_001",
        200,
        validMemory(),
      );

      const result = await client.deleteMemory("usr_001", "mem_001");
      expect(result).toBe(true);
    });

    it("deleteMemory returns false for 404", async () => {
      mockSetup.setMockResponse(
        "/internal/v1/users/usr_001/memories/unknown",
        404,
        {
          error: { code: "MEMORY_NOT_FOUND", message: "记忆不存在" },
        },
      );

      const result = await client.deleteMemory("usr_001", "unknown");
      expect(result).toBe(false);
    });

    it("updateMemory updates memory fields", async () => {
      mockSetup.setMockResponse(
        "/internal/v1/users/usr_001/memories/mem_001",
        200,
        validMemory({ content: "Updated content", category: "preference", importance: 5 }),
      );

      const result = await client.updateMemory("usr_001", "mem_001", {
        content: "Updated content",
        category: "preference",
        importance: 5,
      });
      expect(result).toBeDefined();
      expect((result as any).content).toBe("Updated content");
    });
  });

  // ============ Error Handling ============

  describe("Error Handling", () => {
    it("throws MemoryGatewayError on 401", async () => {
      mockSetup.setMockResponse("/internal/v1/users/usr_001/profile", 401, {
        error: { code: "MEMORY_UNAUTHENTICATED", message: "认证失败" },
      });

      await expect(client.getProfile("usr_001")).rejects.toThrow(MemoryGatewayError);
    });

    it("throws MemoryGatewayError on 403", async () => {
      mockSetup.setMockResponse("/internal/v1/users/usr_001/profile", 403, {
        error: { code: "MEMORY_FORBIDDEN", message: "无权访问" },
      });

      await expect(client.getProfile("usr_001")).rejects.toThrow("MEMORY_FORBIDDEN");
    });

    it("throws MemoryGatewayError on network failure", async () => {
      mockSetup.mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(client.getProfile("usr_001")).rejects.toThrow(MemoryGatewayError);
    });

    it("throws MemoryGatewayError with MEMORY_TIMEOUT on abort", async () => {
      // Simulate abort by making the fetch never resolve
      mockSetup.mockFetch.mockImplementationOnce(
        () => new Promise((_, reject) => {
          const controller = new AbortController();
          controller.abort();
          reject(new DOMException("Aborted", "AbortError"));
        }),
      );

      const slowClient = new CloudflareMemoryClient({
        baseUrl: "http://localhost:8787",
        secret: "test-secret",
        timeoutMs: 100,
      });

      await expect(slowClient.getProfile("usr_001")).rejects.toThrow("MEMORY_TIMEOUT");
    });
  });

  // ============ URL Encoding ============

  describe("URL Construction", () => {
    it("encodes special characters in user_id", async () => {
      mockSetup.setMockResponse(
        "/internal/v1/users/user%40example.com/profile",
        200,
        validProfile({ user_id: "user@example.com" }),
      );

      await client.getProfile("user@example.com");
      expect(mockSetup.mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("user%40example.com"),
        expect.any(Object),
      );
    });

    it("includes query params for listConversations", async () => {
      mockSetup.setMockResponse(
        "/internal/v1/users/usr_001/conversations",
        200,
        [],
      );

      await client.listConversations("usr_001", 50, 10);
      expect(mockSetup.mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockSetup.mockFetch.mock.calls[0];
      expect(url).toContain("limit=50");
      expect(url).toContain("offset=10");
    });
  });
});
