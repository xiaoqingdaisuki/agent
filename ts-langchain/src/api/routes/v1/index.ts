/**
 * External API v1 — 给前端 UI 使用
 *
 * 设计原则：
 * 1. 业务命名（conversations, knowledge）而非技术命名（agent, rag）
 * 2. 统一错误格式，不暴露内部实现
 * 3. 版本化 /api/v1/
 */

import type { FastifyInstance } from "fastify";
import {
  ConversationService,
  AgentService,
  KnowledgeService,
  CapabilitiesService,
  BusinessError,
  BusinessErrorCode,
} from "../../../services/index.js";
import { clearHistory } from "../../../memory/conversation.js";
import { ProfileService, MemoryService, HistoryService } from "../../../profile/service.js";

export async function registerV1Routes(app: FastifyInstance) {
  // ============ 健康检查 ============
  app.get("/health", async () => ({
    status: "ok",
    version: "0.2.0",
    timestamp: new Date().toISOString(),
  }));

  // ============ 会话管理 ==========

  app.post<{
    Body: { title: string; mode?: "chat" | "knowledge" | "mixed" };
  }>("/conversations", async (request, reply) => {
    try {
      const { title, mode = "chat" } = request.body;
      if (!title) {
        return reply.status(400).send({
          error: { code: BusinessErrorCode.INVALID_REQUEST, message: "title is required" },
        });
      }

      const conv = ConversationService.create(title, mode);
      return reply.status(201).send(conv);
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: { code: BusinessErrorCode.INTERNAL_ERROR, message: "创建会话失败" },
      });
    }
  });

  app.get("/conversations", async () => {
    return ConversationService.list();
  });

  app.get<{ Params: { id: string } }>("/conversations/:id", async (request, reply) => {
    const conv = ConversationService.get(request.params.id);
    if (!conv) {
      return reply.status(404).send({
        error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
      });
    }
    return conv;
  });

  app.delete<{ Params: { id: string } }>("/conversations/:id", async (request, reply) => {
    const deleted = ConversationService.delete(request.params.id);
    if (!deleted) {
      return reply.status(404).send({
        error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
      });
    }
    return { success: true };
  });

  app.get<{ Params: { id: string } }>("/conversations/:id/messages", async (request, reply) => {
    const conv = ConversationService.get(request.params.id);
    if (!conv) {
      return reply.status(404).send({
        error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
      });
    }
    return [];
  });

  app.post<{
    Params: { id: string };
    Body: { content: string; user_id?: string };
  }>("/conversations/:id/messages", async (request, reply) => {
    try {
      const { content } = request.body;
      const conv = ConversationService.get(request.params.id);

      if (!conv) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
        });
      }
      if (!content) {
        return reply.status(400).send({
          error: { code: BusinessErrorCode.INVALID_REQUEST, message: "content is required" },
        });
      }

      ConversationService.appendUserMessage(request.params.id, content);
      const assistantMessage = await AgentService.chat(request.params.id, content, request.body.user_id);

      return reply.status(200).send({ message: assistantMessage });
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: { code: BusinessErrorCode.INTERNAL_ERROR, message: "发送消息失败" },
      });
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/conversations/:id/messages",
    async (request, reply) => {
      const conv = ConversationService.get(request.params.id);
      if (!conv) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
        });
      }
      clearHistory(request.params.id);
      return { success: true };
    }
  );

  // ============ 知识库管理 ==========

  app.post("/knowledge/documents", async (request, reply) => {
    try {
      const body: any = request.body;
      const file = body.file as { data?: Buffer; filename?: string } | undefined;

      if (!file) {
        return reply.status(400).send({
          error: { code: BusinessErrorCode.INVALID_REQUEST, message: "file is required" },
        });
      }

      const doc = await KnowledgeService.uploadDocument(
        Buffer.from(file.data || ""),
        file.filename || "unknown"
      );

      return reply.status(201).send(doc);
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: { code: BusinessErrorCode.INTERNAL_ERROR, message: "文档上传失败" },
      });
    }
  });

  app.get("/knowledge/documents", async () => {
    return KnowledgeService.listDocuments();
  });

  app.get<{ Params: { id: string } }>("/knowledge/documents/:id", async (request, reply) => {
    const doc = KnowledgeService.getDocument(request.params.id);
    if (!doc) {
      return reply.status(404).send({
        error: { code: BusinessErrorCode.NOT_FOUND, message: "文档不存在" },
      });
    }
    return doc;
  });

  app.delete<{ Params: { id: string } }>("/knowledge/documents/:id", async (request, reply) => {
    const deleted = KnowledgeService.deleteDocument(request.params.id);
    if (!deleted) {
      return reply.status(404).send({
        error: { code: BusinessErrorCode.NOT_FOUND, message: "文档不存在" },
      });
    }
    return { success: true };
  });

  app.post<{ Params: { id: string } }>("/knowledge/documents/:id/reindex", async (request, reply) => {
    try {
      const doc = await KnowledgeService.reindexDocument(request.params.id);
      return doc;
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: { code: BusinessErrorCode.INTERNAL_ERROR, message: "重新索引失败" },
      });
    }
  });

  app.post<{ Body: { query: string; top_k?: number } }>("/knowledge/search", async (request, reply) => {
    try {
      const { query, top_k = 5 } = request.body;
      if (!query) {
        return reply.status(400).send({
          error: { code: BusinessErrorCode.INVALID_REQUEST, message: "query is required" },
        });
      }

      const results = await KnowledgeService.search(query, top_k);
      return { results };
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: { code: BusinessErrorCode.INTERNAL_ERROR, message: "检索失败" },
      });
    }
  });

  // ============ 能力查询 ==========
  app.get("/capabilities", async () => {
    return CapabilitiesService.getCapabilities();
  });

  // ============ 用户画像 + 记忆 + 历史 ==========

  app.get("/profile", async (request, reply) => {
    try {
      const userId = (request.query as any).user_id;
      if (!userId) {
        return reply.status(400).send({
          error: { code: BusinessErrorCode.INVALID_REQUEST, message: "user_id is required" },
        });
      }
      const profile = ProfileService.getOrCreate(userId, (request.query as any).name);
      return profile;
    } catch (error: any) {
      return reply.status(500).send({
        error: { code: BusinessErrorCode.INTERNAL_ERROR, message: "获取用户画像失败" },
      });
    }
  });

  app.patch("/profile", async (request, reply) => {
    try {
      const { user_id } = request.query as any;
      const body = request.body as any;
      if (!user_id) {
        return reply.status(400).send({
          error: { code: BusinessErrorCode.INVALID_REQUEST, message: "user_id is required" },
        });
      }
      const profile = ProfileService.update(user_id, {
        name: body.name,
        preferences: body.preferences,
      });
      if (!profile) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "用户画像不存在" },
        });
      }
      return profile;
    } catch (error: any) {
      return reply.status(500).send({
        error: { code: BusinessErrorCode.INTERNAL_ERROR, message: "更新用户画像失败" },
      });
    }
  });

  app.get("/memory", async (request, reply) => {
    try {
      const { user_id, category } = request.query as any;
      if (!user_id) {
        return reply.status(400).send({
          error: { code: BusinessErrorCode.INVALID_REQUEST, message: "user_id is required" },
        });
      }
      const memories = MemoryService.listAll(user_id);
      const filtered = category ? memories.filter((m: any) => m.category === category) : memories;
      return { memories: filtered };
    } catch (error: any) {
      return reply.status(500).send({
        error: { code: BusinessErrorCode.INTERNAL_ERROR, message: "获取记忆失败" },
      });
    }
  });

  app.post("/memory", async (request, reply) => {
    try {
      const { user_id } = request.query as any;
      const body = request.body as any;
      if (!user_id) {
        return reply.status(400).send({
          error: { code: BusinessErrorCode.INVALID_REQUEST, message: "user_id is required" },
        });
      }
      if (!body.content) {
        return reply.status(400).send({
          error: { code: BusinessErrorCode.INVALID_REQUEST, message: "content is required" },
        });
      }
      const memory = MemoryService.add(user_id, body.content, body.category || "fact", body.importance || 3);
      return reply.status(201).send(memory);
    } catch (error: any) {
      return reply.status(500).send({
        error: { code: BusinessErrorCode.INTERNAL_ERROR, message: "添加记忆失败" },
      });
    }
  });

  app.delete("/memory", async (request, reply) => {
    try {
      const { user_id, memory_id } = request.query as any;
      if (!user_id || !memory_id) {
        return reply.status(400).send({
          error: { code: BusinessErrorCode.INVALID_REQUEST, message: "user_id and memory_id are required" },
        });
      }
      const deleted = MemoryService.delete(user_id, memory_id);
      if (!deleted) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "记忆不存在" },
        });
      }
      return { success: true };
    } catch (error: any) {
      return reply.status(500).send({
        error: { code: BusinessErrorCode.INTERNAL_ERROR, message: "删除记忆失败" },
      });
    }
  });

  app.get("/history", async (request, reply) => {
    try {
      const { user_id, conversation_id, limit } = request.query as any;
      if (!user_id) {
        return reply.status(400).send({
          error: { code: BusinessErrorCode.INVALID_REQUEST, message: "user_id is required" },
        });
      }
      const records = HistoryService.getHistory(user_id, conversation_id, limit ? Number(limit) : 50);
      return { history: records };
    } catch (error: any) {
      return reply.status(500).send({
        error: { code: BusinessErrorCode.INTERNAL_ERROR, message: "获取历史记录失败" },
      });
    }
  });
}
