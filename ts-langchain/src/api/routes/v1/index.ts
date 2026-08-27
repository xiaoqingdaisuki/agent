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
  invalidateMemoryContext,
  waitForConversationPersistence,
  TurnService,
} from "../../../services/index.js";
import {
  ProfileService,
  MemoryService,
  HistoryService,
} from "../../../profile/service.js";
import type {
  Conversation,
  Document,
  Message,
} from "../../../services/index.js";
import { getAgentToolIdentity, requireAgentUserId } from "../../middleware/auth.js";
import { logRequestError } from "../../middleware/error.js";
import { SseEventSequencer, encodeSseHeartbeat } from "../../sse.js";
import { getReadiness } from "../../health.js";

// 向 SSE 客户端写入一条事件，并在内核背压时等待 drain。
async function writeSse(raw: any, data: string): Promise<void> {
  if (raw.writableEnded || raw.destroyed) return;
  if (!raw.write(data)) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        raw.removeListener("drain", finish);
        raw.removeListener("close", finish);
        resolve();
      };
      raw.once("drain", finish);
      raw.once("close", finish);
    });
  }
}

// 将 Conversation 对象序列化为前端 API 响应格式
function serializeConversation(conversation: Conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    mode: conversation.mode,
    created_at: conversation.createdAt,
    message_count: conversation.messageCount,
  };
}

// 将 Message 对象序列化为前端 API 响应格式
function serializeMessage(message: Message) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    created_at: message.createdAt,
  };
}

// 将 Document 对象序列化为前端 API 响应格式
function serializeDocument(document: Document) {
  return {
    id: document.id,
    name: document.name,
    size: document.size,
    status: document.status,
    chunks: document.chunks,
    category: document.category,
    created_at: document.createdAt,
  };
}

// 创建或注册 registerV1Routes 所需的数据
export async function registerV1Routes(app: FastifyInstance) {
  // ============ 健康检查 ============
  app.get("/health", async () => ({
    status: "ok",
    version: "0.2.0",
    timestamp: new Date().toISOString(),
  }));
  app.get("/health/live", async () => ({ status: "ok", live: true, version: "0.2.0" }));
  app.get("/health/ready", async (_request, reply) => {
    const readiness = getReadiness();
    return reply.status(readiness.ready ? 200 : 503).send(readiness);
  });

  // ============ 会话管理 ==========

  app.post<{
    Body: { title: string; mode?: "chat" | "knowledge" | "mixed"; user_id?: string };
  }>("/conversations", async (request, reply) => {
    try {
      const { title, mode = "chat", user_id } = request.body;
      const trustedUserId = requireAgentUserId(request, user_id);
      if (typeof title !== "string" || title.length < 1 || title.length > 100) {
        return reply.status(400).send({
          error: {
            code: BusinessErrorCode.INVALID_REQUEST,
            message: "title length must be between 1 and 100",
          },
        });
      }
      if (!["chat", "knowledge", "mixed"].includes(mode)) {
        return reply.status(400).send({
          error: {
            code: BusinessErrorCode.INVALID_REQUEST,
            message: "mode must be chat, knowledge or mixed",
          },
        });
      }

      const conv = await ConversationService.create(title, mode, trustedUserId);
      return reply.status(201).send(serializeConversation(conv));
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: {
          code: BusinessErrorCode.INTERNAL_ERROR,
          message: "创建会话失败",
        },
      });
    }
  });

  app.get<{ Querystring: { user_id?: string } }>("/conversations", async (request) => {
    const trustedUserId = requireAgentUserId(request, request.query.user_id);
    const convs = await ConversationService.list(trustedUserId);
    return convs.map(serializeConversation);
  });

  app.get<{ Params: { id: string } }>(
    "/conversations/:id",
    async (request, reply) => {
      const conv = await ConversationService.get(request.params.id);
      if (!conv) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
        });
      }
      requireAgentUserId(request, conv.userId);
      return serializeConversation(conv);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/conversations/:id",
    async (request, reply) => {
      const conversation = await ConversationService.get(request.params.id);
      if (!conversation) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
        });
      }
      requireAgentUserId(request, conversation.userId);
      const deleted = await ConversationService.delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
        });
      }
      return { success: true };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/conversations/:id/messages",
    async (request, reply) => {
      const conv = await ConversationService.get(request.params.id);
      if (!conv) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
        });
      }
      requireAgentUserId(request, conv.userId);
      const messages = await ConversationService.getMessages(request.params.id);
      return messages.map(serializeMessage);
    },
  );

  app.post<{
    Params: { id: string };
    Body: { content: string; user_id?: string; client_message_id?: string };
  }>("/conversations/:id/messages", async (request, reply) => {
    let activeTurn: { id: string; userId: string } | null = null;
    try {
      const { content, user_id, client_message_id } = request.body;
      const convId = request.params.id;
      const trustedUserId = requireAgentUserId(request, user_id);
      const toolIdentity = getAgentToolIdentity(request, user_id);

      // 确保会话存在于当前仓储并校验用户归属。
      await ConversationService.ensure(convId, trustedUserId);

      const conv = await ConversationService.get(convId);

      if (!conv) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
        });
      }
      if (typeof content !== "string" || content.length < 1 || content.length > 16_000) {
        return reply.status(400).send({
          error: {
            code: BusinessErrorCode.INVALID_REQUEST,
            message: "content is required",
          },
        });
      }

      const turnResult = await TurnService.begin(convId, trustedUserId, client_message_id);
      if (!turnResult.created) {
        const completed = TurnService.completedMessage(turnResult.turn);
        if (completed) return reply.status(200).send({ ...serializeMessage(completed), turn_id: turnResult.turn.id });
        throw TurnService.duplicateError(turnResult.turn.status);
      }
      await waitForConversationPersistence(convId);
      const userMessage = await ConversationService.appendUserMessage(convId, content);
      await TurnService.start(turnResult.turn.id, trustedUserId, userMessage.id);
      activeTurn = { id: turnResult.turn.id, userId: trustedUserId };
      const assistantMessage = await AgentService.chat(
        convId,
        content,
        trustedUserId,
        toolIdentity,
      );
      const persistedAssistant = (await ConversationService.getMessages(convId)).reverse().find((item) => item.role === "assistant") ?? assistantMessage;
      await TurnService.complete(turnResult.turn.id, trustedUserId, persistedAssistant);
      activeTurn = null;

      return reply.status(200).send({ ...serializeMessage(persistedAssistant), turn_id: turnResult.turn.id });
    } catch (error: any) {
      if (activeTurn) {
        await TurnService.terminate(activeTurn.id, activeTurn.userId, false, error?.code || "INTERNAL_ERROR").catch(() => undefined);
      }
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: {
          code: BusinessErrorCode.INTERNAL_ERROR,
          message: "发送消息失败",
        },
      });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { content: string; user_id?: string; client_message_id?: string };
  }>("/conversations/:id/messages/stream", async (request, reply) => {
    const { content, user_id, client_message_id } = request.body;
    const convId = request.params.id;
    const trustedUserId = requireAgentUserId(request, user_id);
    const toolIdentity = getAgentToolIdentity(request, user_id);

    // 确保会话存在于当前仓储并校验已有 thread_id 的用户归属。
    await ConversationService.ensure(convId, trustedUserId);

    const conversation = await ConversationService.get(convId);
    if (!conversation) {
      return reply.status(404).send({
        error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
      });
    }
    if (typeof content !== "string" || content.length < 1 || content.length > 16_000) {
      return reply.status(400).send({
        error: {
          code: BusinessErrorCode.INVALID_REQUEST,
          message: "content is required",
        },
      });
    }

    const turnResult = await TurnService.begin(convId, trustedUserId, client_message_id);
    const completed = turnResult.created ? null : TurnService.completedMessage(turnResult.turn);
    if (!turnResult.created && !completed) {
      const error = TurnService.duplicateError(turnResult.turn.status);
      return reply.status(error.statusCode).send(error.toJSON());
    }
    if (turnResult.created) {
      await waitForConversationPersistence(convId);
      const userMessage = await ConversationService.appendUserMessage(convId, content);
      await TurnService.start(turnResult.turn.id, trustedUserId, userMessage.id);
    }
    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();
    const requestController = new AbortController();
    const abortOnDisconnect = () => {
      if (!reply.raw.writableEnded) {
        requestController.abort(new Error("Client disconnected"));
      }
    };
    request.raw.once("aborted", abortOnDisconnect);
    reply.raw.once("close", abortOnDisconnect);
    const heartbeat = setInterval(() => {
      void writeSse(reply.raw, encodeSseHeartbeat());
    }, 15_000);
    heartbeat.unref();
    const sseEvents = new SseEventSequencer(turnResult.turn.id);
    let fullAnswer = "";
    let turnCompleted = Boolean(completed);

    try {
      await writeSse(
        reply.raw,
        sseEvents.event("meta", { conversation_id: convId, thread_id: convId, turn_id: turnResult.turn.id }),
      );
      if (completed) {
        await writeSse(reply.raw, sseEvents.event("text", { delta: completed.content, text: completed.content, partial: false, replayed: true }));
        return;
      }
      for await (const event of AgentService.chatStream(
        convId,
        content,
        trustedUserId,
        requestController.signal,
        toolIdentity,
      )) {
        let eventName: string;
        let payload: Record<string, unknown>;
        if (event.type === "text") {
          fullAnswer += event.text;
          eventName = "text";
          payload = event.partial === undefined
            ? { delta: event.text, text: event.text }
            : { delta: event.text, text: event.text, partial: event.partial };
        } else if (event.type === "tool") {
          eventName = "tool";
          payload = {
            event: "tool",
            tool_name: event.toolName,
            status: event.status,
            call_id: event.callId,
            duration_ms: event.durationMs,
          };
        } else {
          eventName = event.event;
          payload = {
            state: event.state,
            stop_reason: event.stopReason,
            react: event.react,
          };
        }
        await writeSse(
          reply.raw,
          sseEvents.event(eventName, payload),
        );
      }
      const assistantMessage = (await ConversationService.getMessages(convId)).reverse().find((item) => item.role === "assistant")
        ?? { id: crypto.randomUUID(), role: "assistant" as const, content: fullAnswer, createdAt: new Date().toISOString() };
      await TurnService.complete(turnResult.turn.id, trustedUserId, assistantMessage);
      turnCompleted = true;
    } catch (error: unknown) {
      logRequestError(request, error, {
        conversation_id: convId,
        user_id: trustedUserId,
        stream: true,
      });
      const businessError =
        error instanceof BusinessError
          ? error
          : new BusinessError(
              BusinessErrorCode.INTERNAL_ERROR,
              "处理请求时发生错误",
              500,
            );
      try {
        await writeSse(
          reply.raw,
          sseEvents.event("error", {
            ok: false,
            error: businessError.toJSON().error,
          }),
        );
      } catch {
        // raw response already closed / unreachable — nothing to write
      }
      if (!turnCompleted) {
        await TurnService.terminate(
          turnResult.turn.id,
          trustedUserId,
          requestController.signal.aborted,
          requestController.signal.aborted ? "CLIENT_CANCELLED" : (error as any)?.code || "INTERNAL_ERROR",
        ).catch(() => undefined);
      }
    } finally {
      clearInterval(heartbeat);
      request.raw.removeListener("aborted", abortOnDisconnect);
      reply.raw.removeListener("close", abortOnDisconnect);
      try {
        await writeSse(reply.raw, sseEvents.done());
      } catch {
        // raw response already closed / unreachable — nothing to write
      } finally {
        reply.raw.end();
      }
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/conversations/:id/messages",
    async (request, reply) => {
      const conv = await ConversationService.get(request.params.id);
      if (!conv) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "会话不存在" },
        });
      }
      requireAgentUserId(request, conv.userId);
      await ConversationService.clearMessages(request.params.id);
      return { success: true };
    },
  );

  // ============ 知识库管理 ==========

  app.post("/knowledge/documents", async (request, reply) => {
    try {
      const userId = requireAgentUserId(request);
      const file = await request.file();

      if (!file) {
        return reply.status(400).send({
          error: {
            code: BusinessErrorCode.INVALID_REQUEST,
            message: "file is required",
          },
        });
      }

      const buffer = await file.toBuffer();
      const rawCategory = file.fields.category;
      const categoryField = Array.isArray(rawCategory)
        ? rawCategory[0]
        : rawCategory;
      const doc = await KnowledgeService.uploadDocument(
        buffer,
        file.filename || "unknown",
        categoryField?.type === "field"
          ? String(categoryField.value)
          : undefined,
        userId,
      );

      return reply.status(201).send(serializeDocument(doc));
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: {
          code: BusinessErrorCode.INTERNAL_ERROR,
          message: "文档上传失败",
        },
      });
    }
  });

  app.get("/knowledge/documents", async (request) => {
    const docs = await KnowledgeService.listDocuments(requireAgentUserId(request));
    return docs.map(serializeDocument);
  });

  app.get<{ Params: { id: string } }>(
    "/knowledge/documents/:id",
    async (request, reply) => {
      const doc = await KnowledgeService.getDocument(request.params.id, requireAgentUserId(request));
      if (!doc) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "文档不存在" },
        });
      }
      return serializeDocument(doc);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/knowledge/documents/:id",
    async (request, reply) => {
      const deleted = await KnowledgeService.deleteDocument(request.params.id, requireAgentUserId(request));
      if (!deleted) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "文档不存在" },
        });
      }
      return { success: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/knowledge/documents/:id/reindex",
    async (request, reply) => {
      try {
        const doc = await KnowledgeService.reindexDocument(request.params.id, requireAgentUserId(request));
        return serializeDocument(doc);
      } catch (error: any) {
        if (error instanceof BusinessError) {
          return reply.status(error.statusCode).send(error.toJSON());
        }
        return reply.status(500).send({
          error: {
            code: BusinessErrorCode.INTERNAL_ERROR,
            message: "重新索引失败",
          },
        });
      }
    },
  );

  app.post<{ Body: { query: string; top_k?: number } }>(
    "/knowledge/search",
    async (request, reply) => {
      try {
        const userId = requireAgentUserId(request);
        const { query, top_k = 5 } = request.body;
        if (typeof query !== "string" || query.length < 1) {
          return reply.status(400).send({
            error: {
              code: BusinessErrorCode.INVALID_REQUEST,
              message: "query is required",
            },
          });
        }
        if (!Number.isInteger(top_k) || top_k < 1 || top_k > 20) {
          return reply.status(400).send({
            error: {
              code: BusinessErrorCode.INVALID_REQUEST,
              message: "top_k must be an integer between 1 and 20",
            },
          });
        }

        const results = await KnowledgeService.search(query, top_k, userId);
        return { results };
      } catch (error: any) {
        if (error instanceof BusinessError) {
          return reply.status(error.statusCode).send(error.toJSON());
        }
        return reply.status(500).send({
          error: {
            code: BusinessErrorCode.INTERNAL_ERROR,
            message: "检索失败",
          },
        });
      }
    },
  );

  // ============ 能力查询 ==========
  app.get("/capabilities", async () => {
    return CapabilitiesService.getCapabilities();
  });

  // ============ 用户画像 + 记忆 + 历史 ==========

  app.get("/profile", async (request, reply) => {
    try {
      const submittedUserId = (request.query as any).user_id;
      const userId = requireAgentUserId(request, submittedUserId);
      const profile = await ProfileService.getOrCreate(
        userId,
        (request.query as any).name,
      );
      return profile;
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: {
          code: BusinessErrorCode.INTERNAL_ERROR,
          message: "获取用户画像失败",
        },
      });
    }
  });

  app.patch("/profile", async (request, reply) => {
    try {
      const { user_id } = request.query as any;
      const trustedUserId = requireAgentUserId(request, user_id);
      const body = request.body as any;
      const profile = await ProfileService.update(trustedUserId,
        body.name,
        body.preferences,
      );
      if (!profile) {
        return reply.status(404).send({
          error: {
            code: BusinessErrorCode.NOT_FOUND,
            message: "用户画像不存在",
          },
        });
      }
      return profile;
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: {
          code: BusinessErrorCode.INTERNAL_ERROR,
          message: "更新用户画像失败",
        },
      });
    }
  });

  app.get("/memory", async (request, reply) => {
    try {
      const { user_id, category } = request.query as any;
      const trustedUserId = requireAgentUserId(request, user_id);
      const memories = await MemoryService.listAll(trustedUserId);
      const filtered = category
        ? memories.filter((m: any) => m.category === category)
        : memories;
      return { memories: filtered };
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: {
          code: BusinessErrorCode.INTERNAL_ERROR,
          message: "获取记忆失败",
        },
      });
    }
  });

  app.post("/memory", async (request, reply) => {
    try {
      const { user_id } = request.query as any;
      const trustedUserId = requireAgentUserId(request, user_id);
      const body = request.body as any;
      if (typeof body.content !== "string" || body.content.length < 1) {
        return reply.status(400).send({
          error: {
            code: BusinessErrorCode.INVALID_REQUEST,
            message: "content is required",
          },
        });
      }
      const category = body.category ?? "fact";
      const importance = body.importance ?? 3;
      if (!["preference", "fact", "decision", "context"].includes(category)) {
        return reply.status(400).send({
          error: {
            code: BusinessErrorCode.INVALID_REQUEST,
            message: "category is invalid",
          },
        });
      }
      if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
        return reply.status(400).send({
          error: {
            code: BusinessErrorCode.INVALID_REQUEST,
            message: "importance must be an integer between 1 and 5",
          },
        });
      }
      const memory = await MemoryService.add(
        trustedUserId,
        body.content,
        category,
        importance,
      );
      invalidateMemoryContext(trustedUserId);
      return reply.status(201).send(memory);
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: {
          code: BusinessErrorCode.INTERNAL_ERROR,
          message: "添加记忆失败",
        },
      });
    }
  });

  app.delete("/memory", async (request, reply) => {
    try {
      const { user_id, memory_id } = request.query as any;
      const trustedUserId = requireAgentUserId(request, user_id);
      if (!memory_id) {
        return reply.status(400).send({
          error: {
            code: BusinessErrorCode.INVALID_REQUEST,
            message: "memory_id is required",
          },
        });
      }
      const deleted = await MemoryService.delete(trustedUserId, memory_id);
      if (!deleted) {
        return reply.status(404).send({
          error: { code: BusinessErrorCode.NOT_FOUND, message: "记忆不存在" },
        });
      }
      invalidateMemoryContext(trustedUserId);
      return { success: true };
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: {
          code: BusinessErrorCode.INTERNAL_ERROR,
          message: "删除记忆失败",
        },
      });
    }
  });

  app.get("/history", async (request, reply) => {
    try {
      const { user_id, conversation_id, limit } = request.query as any;
      const trustedUserId = requireAgentUserId(request, user_id);
      const records = await HistoryService.getHistory(
        trustedUserId,
        conversation_id,
        limit ? Number(limit) : 50,
      );
      return { history: records };
    } catch (error: any) {
      if (error instanceof BusinessError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      return reply.status(500).send({
        error: {
          code: BusinessErrorCode.INTERNAL_ERROR,
          message: "获取历史记录失败",
        },
      });
    }
  });
}
