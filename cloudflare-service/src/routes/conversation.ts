/**
 * Conversation Routes — 会话管理
 *
 * POST   /internal/v1/conversations                          — 创建会话
 * GET    /internal/v1/users/{user_id}/conversations          — 用户会话列表
 * GET    /internal/v1/conversations/{conversation_id}        — 会话详情
 * DELETE /internal/v1/conversations/{conversation_id}        — 删除会话
 */

import { createConversation, getConversation, listConversationsByUser, deleteConversation } from "../repositories/conversation.js";
import { getOrCreateProfile } from "../repositories/profile.js";
import { ConversationCreateSchema } from "../schemas/memory-models.js";

// 创建或注册 registerConversationRoutes 所需的数据
export function registerConversationRoutes(app: any) {
  // 创建会话
  app.post("/internal/v1/conversations", async (c: any) => {
    const body = await c.req.json();
    const parsed = ConversationCreateSchema.parse(body);

    // 会话外键依赖用户画像，新用户首次建会话时自动初始化画像
    await getOrCreateProfile(c.env.DB, parsed.user_id);

    const conv = await createConversation(c.env.DB, {
      id: parsed.id || crypto.randomUUID(),
      user_id: parsed.user_id,
      title: parsed.title.slice(0, 200),
      mode: parsed.mode || "chat",
    });

    return c.json(
      {
        ok: true,
        data: conv,
        error: null,
        meta: { request_id: c.get("requestId") },
      },
      201,
    );
  });

  // 列出用户会话
  app.get("/internal/v1/users/:user_id/conversations", async (c: any) => {
    const userId = c.req.param("user_id");
    const limit = Math.min(parseInt((c.req.query("limit") as string) || "20", 10), 100);
    const offset = Math.max(parseInt((c.req.query("offset") as string) || "0", 10), 0);

    const conversations = await listConversationsByUser(c.env.DB, userId, limit, offset);

    return c.json({
      ok: true,
      data: conversations,
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });

  // 获取会话详情
  app.get("/internal/v1/conversations/:conversation_id", async (c: any) => {
    const id = c.req.param("conversation_id");
    const conv = await getConversation(c.env.DB, id);

    if (!conv) {
      return c.json(
        {
          ok: false,
          data: null,
          error: { code: "MEMORY_CONVERSATION_NOT_FOUND", message: "会话不存在" },
          meta: { request_id: c.get("requestId") },
        },
        404,
      );
    }

    return c.json({
      ok: true,
      data: conv,
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });

  // 删除会话
  app.delete("/internal/v1/conversations/:conversation_id", async (c: any) => {
    const id = c.req.param("conversation_id");
    const deleted = await deleteConversation(c.env.DB, id);

    if (!deleted) {
      return c.json(
        {
          ok: false,
          data: null,
          error: { code: "MEMORY_CONVERSATION_NOT_FOUND", message: "会话不存在" },
          meta: { request_id: c.get("requestId") },
        },
        404,
      );
    }

    return c.json({
      ok: true,
      data: { id, deleted: true },
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });
}
