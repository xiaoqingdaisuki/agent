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

// 创建或注册 registerMessageRoutes 所需的数据
export function registerMessageRoutes(app: any) {
  // 批量写入消息
  app.post("/internal/v1/conversations/:conversation_id/messages:batch", async (c: any) => {
    const conversationId = c.req.param("conversation_id");
    const body = await c.req.json();
    const parsed = MessageBatchSchema.parse(body);

    let nextSequence = await getNextSequenceNumber(c.env.DB, conversationId);
    const explicitSequences = new Set(
      parsed.messages
        .map((message) => message.sequence_no)
        .filter((sequence): sequence is number => sequence !== undefined),
    );
    const formatted = parsed.messages.map((msg) => {
      while (explicitSequences.has(nextSequence)) nextSequence += 1;
      const sequenceNumber = msg.sequence_no ?? nextSequence++;
      return {
      id: msg.id || crypto.randomUUID(),
      conversation_id: conversationId,
      user_id: parsed.user_id,
      sequence_no: sequenceNumber,
      role: msg.role || "user",
      content_json: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || {}),
      created_at: msg.created_at || new Date().toISOString(),
      };
    });

    await createMessageBatch(c.env.DB, formatted);

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

    const result = await getMessagesByConversation(c.env.DB, conversationId, limit, offset);

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
    await clearMessages(c.env.DB, conversationId);

    return c.json({
      ok: true,
      data: { conversation_id: conversationId, cleared: true },
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });
}
