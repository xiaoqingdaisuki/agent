import { describe, expect, it, vi } from "vitest";

import { DARK_MODE_COMMAND, DARK_MODE_ENABLED_REPLY } from "../../src/commands/index.js";
import { buildApp } from "../../src/api/index.js";
import { KnowledgeService } from "../../src/services/index.js";

describe("完整 API 契约", () => {
  it("覆盖旧版接口与 v1 持久化业务接口", async () => {
    const document = {
      id: "doc_contract",
      name: "contract.txt",
      size: 8,
      status: "indexed" as const,
      chunks: 1,
      category: "tech",
      createdAt: new Date().toISOString(),
    };
    vi.spyOn(KnowledgeService, "listDocuments").mockResolvedValue([document]);
    vi.spyOn(KnowledgeService, "getDocument").mockResolvedValue(document);
    vi.spyOn(KnowledgeService, "reindexDocument").mockResolvedValue(document);
    vi.spyOn(KnowledgeService, "deleteDocument").mockResolvedValue(true);
    vi.spyOn(KnowledgeService, "search").mockResolvedValue([
      { documentId: document.id, content: "契约内容", score: 0.9 },
    ]);

    const app = await buildApp();
    const userId = "contract_user";
    const originalInject = app.inject.bind(app);
    app.inject = ((options: any) => originalInject({
      ...options,
      headers: {
        authorization: "Bearer test-agent-secret",
        "x-agent-user-id": userId,
        ...options.headers,
      },
    })) as typeof app.inject;

    try {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/tools" })).json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "math.calculate" })]),
      );
      expect((await app.inject({ method: "GET", url: "/api/v1/capabilities" })).json()).toEqual(
        expect.objectContaining({ modes: expect.any(Array), tools: expect.any(Array) }),
      );

      const legacyChat = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { message: DARK_MODE_COMMAND, user_id: userId },
      });
      expect(legacyChat.statusCode).toBe(200);
      expect(legacyChat.json().reply).toBe(DARK_MODE_ENABLED_REPLY);

      const legacyStream = await app.inject({
        method: "POST",
        url: "/stream",
        payload: { message: DARK_MODE_COMMAND, user_id: userId },
      });
      expect(legacyStream.statusCode).toBe(200);
      expect(legacyStream.body).toContain(DARK_MODE_ENABLED_REPLY);
      expect(legacyStream.body).toContain("data: [DONE]");

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        payload: { title: "契约会话", mode: "chat", user_id: userId },
      });
      expect(created.statusCode).toBe(201);
      const conversationId = created.json().id as string;

      const listed = await app.inject({
        method: "GET",
        url: `/api/v1/conversations?user_id=${userId}`,
      });
      expect(listed.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: conversationId, title: "契约会话" })]),
      );
      expect(
        (await app.inject({ method: "GET", url: `/api/v1/conversations/${conversationId}` })).statusCode,
      ).toBe(200);

      const stream = await app.inject({
        method: "POST",
        url: `/api/v1/conversations/${conversationId}/messages/stream`,
        payload: { content: DARK_MODE_COMMAND, user_id: userId },
      });
      expect(stream.statusCode).toBe(200);
      expect(stream.body).toContain(DARK_MODE_ENABLED_REPLY);
      expect(stream.body).toContain("data: [DONE]");

      const messages = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}/messages`,
      });
      expect(messages.json()).toEqual([
        expect.objectContaining({ role: "user", content: DARK_MODE_COMMAND }),
        expect.objectContaining({ role: "assistant", content: DARK_MODE_ENABLED_REPLY }),
      ]);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/v1/conversations/${conversationId}/messages`,
          })
        ).json(),
      ).toEqual({ success: true });

      const profile = await app.inject({ method: "GET", url: `/api/v1/profile?user_id=${userId}` });
      expect(profile.statusCode).toBe(200);
      expect(profile.json().id).toBe(userId);
      const updatedProfile = await app.inject({
        method: "PATCH",
        url: `/api/v1/profile?user_id=${userId}`,
        payload: { name: "契约用户", preferences: { theme: "dark" } },
      });
      expect(updatedProfile.json()).toEqual(
        expect.objectContaining({ id: userId, name: "契约用户", preferences: { theme: "dark" } }),
      );

      const createdMemory = await app.inject({
        method: "POST",
        url: `/api/v1/memory?user_id=${userId}`,
        payload: { content: "喜欢契约测试", category: "preference", importance: 4 },
      });
      expect(createdMemory.statusCode).toBe(201);
      const memoryId = createdMemory.json().id as string;
      const memories = await app.inject({ method: "GET", url: `/api/v1/memory?user_id=${userId}` });
      expect(memories.json().memories).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: memoryId, content: "喜欢契约测试" })]),
      );
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/v1/memory?user_id=${userId}&memory_id=${memoryId}`,
          })
        ).json(),
      ).toEqual({ success: true });
      const history = await app.inject({ method: "GET", url: `/api/v1/history?user_id=${userId}` });
      expect(history.statusCode).toBe(200);
      expect(history.json().history).toEqual(expect.any(Array));

      expect((await app.inject({ method: "GET", url: "/api/v1/knowledge/documents" })).json()).toEqual([
        expect.objectContaining({ id: document.id }),
      ]);
      expect(
        (await app.inject({ method: "GET", url: `/api/v1/knowledge/documents/${document.id}` })).json(),
      ).toEqual(expect.objectContaining({ id: document.id }));
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/knowledge/documents/${document.id}/reindex`,
          })
        ).json(),
      ).toEqual(expect.objectContaining({ id: document.id }));
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/knowledge/search",
            payload: { query: "契约", top_k: 3 },
          })
        ).json().results,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ documentId: document.id })]));
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/v1/knowledge/documents/${document.id}`,
          })
        ).json(),
      ).toEqual({ success: true });

      expect(
        (await app.inject({ method: "POST", url: "/images/generations", payload: {} })).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: "DELETE", url: `/api/v1/conversations/${conversationId}` })).json(),
      ).toEqual({ success: true });
    } finally {
      await app.close();
    }
  });

  it("拒绝未认证、缺少身份和冒充其他用户的请求", async () => {
    const app = await buildApp();
    try {
      expect((await app.inject({
        method: "GET",
        url: "/api/v1/conversations",
      })).statusCode).toBe(401);
      expect((await app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: { authorization: "Bearer test-agent-secret" },
        payload: { title: "missing identity" },
      })).statusCode).toBe(401);
      expect((await app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: {
          authorization: "Bearer test-agent-secret",
          "x-agent-user-id": "owner-a",
        },
        payload: { title: "spoof", user_id: "owner-b" },
      })).statusCode).toBe(403);

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: {
          authorization: "Bearer test-agent-secret",
          "x-agent-user-id": "owner-a",
        },
        payload: { title: "private", user_id: "owner-a" },
      });
      const conversationId = created.json().id as string;
      const otherUserHeaders = {
        authorization: "Bearer test-agent-secret",
        "x-agent-user-id": "owner-b",
      };
      expect((await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}`,
        headers: otherUserHeaders,
      })).statusCode).toBe(403);
      expect((await app.inject({
        method: "POST",
        url: "/chat",
        headers: otherUserHeaders,
        payload: {
          message: DARK_MODE_COMMAND,
          thread_id: conversationId,
          user_id: "owner-b",
        },
      })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("按 Python 契约拒绝越界的会话、检索和记忆参数", async () => {
    const app = await buildApp();
    const headers = {
      authorization: "Bearer test-agent-secret",
      "x-agent-user-id": "validation-user",
    };
    try {
      expect((await app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers,
        payload: { title: "x".repeat(101), mode: "chat" },
      })).statusCode).toBe(400);
      expect((await app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers,
        payload: { title: "invalid mode", mode: "unsupported" },
      })).statusCode).toBe(400);
      expect((await app.inject({
        method: "POST",
        url: "/api/v1/knowledge/search",
        headers,
        payload: { query: "test", top_k: 21 },
      })).statusCode).toBe(400);
      expect((await app.inject({
        method: "POST",
        url: "/api/v1/memory",
        headers,
        payload: { content: "test", category: "unknown", importance: 6 },
      })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
