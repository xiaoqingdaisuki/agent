/** Turn Routes — Agent 单轮执行的幂等与状态恢复接口。 */

import { z } from "zod";
import { getConversation } from "../repositories/conversation.js";
import { beginTurnWithUserMessage, completeTurnWithAssistantMessage, createOrGetTurn, getTurn, TurnConversationBusyError, TurnTransitionError, updateTurn } from "../repositories/turn.js";

const CreateTurnSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  user_id: z.string().min(1).max(128),
  client_message_id: z.string().min(1).max(128),
});
const UpdateTurnSchema = z.object({
  user_id: z.string().min(1).max(128),
  status: z.enum(["pending", "streaming", "completed", "failed", "cancelled"]),
  user_message_id: z.string().max(128).optional(),
  assistant_message_id: z.string().max(128).optional(),
  assistant_content_json: z.string().max(1_000_000).optional(),
  error_code: z.string().max(128).optional(),
});
const GetTurnQuerySchema = z.object({
  user_id: z.string().min(1).max(128),
});
const BeginTurnSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  user_id: z.string().min(1).max(128),
  client_message_id: z.string().min(1).max(128),
  user_message_id: z.string().min(1).max(128).optional(),
  content: z.string().min(1).max(16_000),
  created_at: z.string().optional(),
});
const CompleteTurnSchema = z.object({
  user_id: z.string().min(1).max(128),
  assistant_message_id: z.string().min(1).max(128),
  content: z.string().max(1_000_000),
  assistant_content_json: z.string().max(1_000_000),
  created_at: z.string().optional(),
});

// 注册 Turn 的创建、查询和状态更新路由。
export function registerTurnRoutes(app: any) {
  app.post("/internal/v1/conversations/:conversation_id/turns:begin",
  // 处理原子开始 Turn 并写入用户消息的请求。
  async (c: any) => {
    const conversationId = c.req.param("conversation_id");
    const body = BeginTurnSchema.parse(await c.req.json());
    const conversation = await getConversation(c.env.DB, conversationId);
    if (!conversation || conversation.user_id !== body.user_id) {
      return c.json({ ok: false, data: null, error: { code: "MEMORY_CONVERSATION_NOT_FOUND", message: "会话不存在或无权访问" }, meta: { request_id: c.get("requestId") } }, 404);
    }
    try {
      const turnId = body.id || crypto.randomUUID();
      const result = await beginTurnWithUserMessage(c.env.DB, {
        id: turnId,
        conversation_id: conversationId,
        user_id: body.user_id,
        client_message_id: body.client_message_id,
        user_message_id: body.user_message_id || `msg_${turnId}_user`,
        user_content_json: body.content,
        created_at: body.created_at,
      });
      return c.json({ ok: true, data: { ...result.turn, created: result.created, user_message: result.userMessage }, error: null, meta: { request_id: c.get("requestId") } }, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof TurnConversationBusyError) {
        return c.json({ ok: false, data: null, error: { code: "MEMORY_CONVERSATION_BUSY", message: "会话中已有请求正在处理" }, meta: { request_id: c.get("requestId") } }, 409);
      }
      throw error;
    }
  });

  app.post("/internal/v1/turns/:turn_id/complete",
  // 处理原子完成 Turn 并写入助手消息的请求。
  async (c: any) => {
    const turnId = c.req.param("turn_id");
    const body = CompleteTurnSchema.parse(await c.req.json());
    const existing = await getTurn(c.env.DB, turnId);
    if (!existing || existing.user_id !== body.user_id) {
      return c.json({ ok: false, data: null, error: { code: "MEMORY_TURN_NOT_FOUND", message: "Turn 不存在或无权访问" }, meta: { request_id: c.get("requestId") } }, 404);
    }
    try {
      const result = await completeTurnWithAssistantMessage(c.env.DB, turnId, {
        user_id: body.user_id,
        assistant_message_id: body.assistant_message_id,
        assistant_content_json: body.assistant_content_json,
        message_content_json: body.content,
        created_at: body.created_at,
      });
      return c.json({ ok: true, data: { ...result.turn, assistant_message: result.assistantMessage }, error: null, meta: { request_id: c.get("requestId") } });
    } catch (error) {
      if (error instanceof TurnTransitionError) {
        return c.json({ ok: false, data: null, error: { code: "MEMORY_TURN_STATE_CONFLICT", message: error.message }, meta: { request_id: c.get("requestId") } }, 409);
      }
      throw error;
    }
  });

  app.post("/internal/v1/conversations/:conversation_id/turns",
  // 处理兼容的 Turn 创建或复用请求。
  async (c: any) => {
    const conversationId = c.req.param("conversation_id");
    const body = CreateTurnSchema.parse(await c.req.json());
    const conversation = await getConversation(c.env.DB, conversationId);
    if (!conversation || conversation.user_id !== body.user_id) {
      return c.json({ ok: false, data: null, error: { code: "MEMORY_CONVERSATION_NOT_FOUND", message: "会话不存在或无权访问" }, meta: { request_id: c.get("requestId") } }, 404);
    }
    try {
      const result = await createOrGetTurn(c.env.DB, {
        id: body.id || crypto.randomUUID(),
        conversation_id: conversationId,
        user_id: body.user_id,
        client_message_id: body.client_message_id,
      });
      return c.json({ ok: true, data: { ...result.turn, created: result.created }, error: null, meta: { request_id: c.get("requestId") } }, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof TurnConversationBusyError) {
        return c.json({ ok: false, data: null, error: { code: "MEMORY_CONVERSATION_BUSY", message: "会话中已有请求正在处理" }, meta: { request_id: c.get("requestId") } }, 409);
      }
      throw error;
    }
  });

  app.get("/internal/v1/turns/:turn_id",
  // 按可信用户读取指定 Turn。
  async (c: any) => {
    const query = GetTurnQuerySchema.parse(c.req.query());
    const turn = await getTurn(c.env.DB, c.req.param("turn_id"));
    const conversation = turn ? await getConversation(c.env.DB, turn.conversation_id) : null;
    if (!turn || !conversation || turn.user_id !== query.user_id) return c.json({ ok: false, data: null, error: { code: "MEMORY_TURN_NOT_FOUND", message: "Turn 不存在或无权访问" }, meta: { request_id: c.get("requestId") } }, 404);
    return c.json({ ok: true, data: turn, error: null, meta: { request_id: c.get("requestId") } });
  });

  app.patch("/internal/v1/turns/:turn_id",
  // 按不可逆状态机更新指定 Turn。
  async (c: any) => {
    const turnId = c.req.param("turn_id");
    const body = UpdateTurnSchema.parse(await c.req.json());
    const existing = await getTurn(c.env.DB, turnId);
    const conversation = existing ? await getConversation(c.env.DB, existing.conversation_id) : null;
    if (!existing || !conversation || existing.user_id !== body.user_id) return c.json({ ok: false, data: null, error: { code: "MEMORY_TURN_NOT_FOUND", message: "Turn 不存在或无权访问" }, meta: { request_id: c.get("requestId") } }, 404);
    try {
      const turn = await updateTurn(c.env.DB, turnId, body);
      return c.json({ ok: true, data: turn, error: null, meta: { request_id: c.get("requestId") } });
    } catch (error) {
      if (error instanceof TurnTransitionError) {
        return c.json({ ok: false, data: null, error: { code: "MEMORY_TURN_STATE_CONFLICT", message: error.message }, meta: { request_id: c.get("requestId") } }, 409);
      }
      throw error;
    }
  });
}
