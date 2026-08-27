/** Turn Routes — Agent 单轮执行的幂等与状态恢复接口。 */

import { z } from "zod";
import { getConversation } from "../repositories/conversation.js";
import { createOrGetTurn, getTurn, TurnConversationBusyError, TurnTransitionError, updateTurn } from "../repositories/turn.js";

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

// 注册 Turn 的创建、查询和状态更新路由。
export function registerTurnRoutes(app: any) {
  app.post("/internal/v1/conversations/:conversation_id/turns", async (c: any) => {
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

  app.get("/internal/v1/turns/:turn_id", async (c: any) => {
    const query = GetTurnQuerySchema.parse(c.req.query());
    const turn = await getTurn(c.env.DB, c.req.param("turn_id"));
    const conversation = turn ? await getConversation(c.env.DB, turn.conversation_id) : null;
    if (!turn || !conversation || turn.user_id !== query.user_id) return c.json({ ok: false, data: null, error: { code: "MEMORY_TURN_NOT_FOUND", message: "Turn 不存在或无权访问" }, meta: { request_id: c.get("requestId") } }, 404);
    return c.json({ ok: true, data: turn, error: null, meta: { request_id: c.get("requestId") } });
  });

  app.patch("/internal/v1/turns/:turn_id", async (c: any) => {
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
