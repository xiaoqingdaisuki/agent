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

export async function registerV1Routes(app: FastifyInstance) {
  // ============ 健康检查 ============
  app.get("/health", async () => ({
    status: "ok",
    version: "0.2.0",
    timestamp: new Date().toISOString(),
  }));

  // ============ 会话管理 ============

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
    Body: { content: string };
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
      const assistantMessage = await AgentService.chat(request.params.id, content);

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

  // ============ 知识库管理 ============

  app.post("/knowledge/documents", async (request, reply) => {
    try {
      // 处理文件上传（简化版）
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

  // ============ 能力查询 ============
  app.get("/capabilities", async () => {
    return CapabilitiesService.getCapabilities();
  });
}
