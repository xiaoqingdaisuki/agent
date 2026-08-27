/**
 * Message Routes — 消息管理
 *
 * POST   /internal/v1/conversations/{id}/messages:batch  — 批量写入消息
 * GET    /internal/v1/conversations/{id}/messages        — 查询消息
 * DELETE /internal/v1/conversations/{id}/messages        — 清空消息
 */

import {
  clearMessages,
  createMessageBatch,
  getMessagesByConversation,
  getNextSequenceNumber,
} from "../repositories/message.js";
import { MessageBatchSchema } from "../schemas/memory-models.js";
import { getConversation } from "../repositories/conversation.js";

const MAX_SEQUENCE_INSERT_ATTEMPTS = 3;

// 识别会话消息序号的唯一约束冲突，以便仅重试由并发自动分配导致的冲突。
function isSequenceConflict(error: unknown): boolean {
  return error instanceof Error
    && /(?:unique|constraint).*(?:conversation_id|sequence_no)|(?:conversation_id|sequence_no).*(?:unique|constraint)/i.test(error.message);
}

// 从当前序号构造连续消息批次，显式传入的序号不会被自动覆盖。
function formatMessageBatch(
  conversationId: string,
  userId: string,
  messages: Array<{ id?: string; sequence_no?: number; role?: "user" | "assistant" | "system" | "tool"; content?: unknown; created_at?: string }>,
  startSequence: number,
) {
  let nextSequence = startSequence;
  const explicitSequences = new Set(
    messages
      .map((message) => message.sequence_no)
      .filter((sequence): sequence is number => sequence !== undefined),
  );
  return messages.map((msg) => {
    while (explicitSequences.has(nextSequence)) nextSequence += 1;
    const sequenceNumber = msg.sequence_no ?? nextSequence++;
    return {
      id: msg.id || crypto.randomUUID(),
      conversation_id: conversationId,
      user_id: userId,
      sequence_no: sequenceNumber,
      role: msg.role || "user",
      content_json: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || {}),
      created_at: msg.created_at || new Date().toISOString(),
    };
  });
}

// 创建或注册 registerMessageRoutes 所需的数据
export function registerMessageRoutes(app: any) {
  // 批量写入消息
  app.post("/internal/v1/conversations/:conversation_id/messages:batch", async (c: any) => {
    const conversationId = c.req.param("conversation_id");
    const body = await c.req.json();
    const parsed = MessageBatchSchema.parse(body);
    const conversation = await getConversation(c.env.DB, conversationId);
    if (!conversation || conversation.user_id !== parsed.user_id) {
      return c.json({ ok: false, data: null, error: { code: "MEMORY_CONVERSATION_NOT_FOUND", message: "会话不存在或无权访问" }, meta: { request_id: c.get("requestId") } }, 404);
    }

    const hasExplicitSequence = parsed.messages.some((message) => message.sequence_no !== undefined);
    let formatted = [];
    for (let attempt = 0; attempt < MAX_SEQUENCE_INSERT_ATTEMPTS; attempt += 1) {
      const nextSequence = await getNextSequenceNumber(c.env.DB, conversationId);
      formatted = formatMessageBatch(conversationId, parsed.user_id, parsed.messages, nextSequence);
      try {
        await createMessageBatch(c.env.DB, formatted);
        break;
      } catch (error) {
        if (hasExplicitSequence || !isSequenceConflict(error) || attempt === MAX_SEQUENCE_INSERT_ATTEMPTS - 1) {
          throw error;
        }
      }
    }

    return c.json({
      ok: true,
      data: { count: formatted.length },
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });

  // 查询消息
  app.get("/internal/v1/conversations/:conversation_id/messages", async (c: any) => {
    const conversationId = c.req.param("conversation_id");
    const limit = parseInt((c.req.query("limit") as string) || "50", 10);
    const offset = parseInt((c.req.query("offset") as string) || "0", 10);
    const direction = c.req.query("direction") === "desc" ? "desc" : "asc";
    if (!await getConversation(c.env.DB, conversationId)) {
      return c.json({ ok: false, data: null, error: { code: "MEMORY_CONVERSATION_NOT_FOUND", message: "会话不存在" }, meta: { request_id: c.get("requestId") } }, 404);
    }

    const result = await getMessagesByConversation(c.env.DB, conversationId, limit, offset, direction);

    return c.json({
      ok: true,
      data: result,
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });

  // 清空消息
  app.delete("/internal/v1/conversations/:conversation_id/messages", async (c: any) => {
    const conversationId = c.req.param("conversation_id");
    if (!await getConversation(c.env.DB, conversationId)) {
      return c.json({ ok: false, data: null, error: { code: "MEMORY_CONVERSATION_NOT_FOUND", message: "会话不存在" }, meta: { request_id: c.get("requestId") } }, 404);
    }
    await clearMessages(c.env.DB, conversationId);

    return c.json({
      ok: true,
      data: { conversation_id: conversationId, cleared: true },
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });
}
