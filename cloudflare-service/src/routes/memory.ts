/**
 * Memory Routes — 长期记忆管理
 *
 * PUT    /internal/v1/users/{user_id}/memories/{memory_id}    — 保存记忆
 * GET    /internal/v1/users/{user_id}/memories                — 列出记忆
 * PATCH  /internal/v1/users/{user_id}/memories/{memory_id}    — 更新记忆
 * DELETE /internal/v1/users/{user_id}/memories/{memory_id}    — 删除记忆
 * POST   /internal/v1/users/{user_id}/memories:search         — 语义搜索
 * DELETE /internal/v1/users/{user_id}/memories                — 清空用户记忆
 */

import {
  saveMemory,
  searchMemories,
  listMemories,
  updateMemory,
  deleteMemory,
  clearUserMemories,
  getMemoryById,
  normalizeContent,
} from "../repositories/memory.js";
import { validateMemoryContent, redactSensitive } from "../middleware/security.js";
import { MemorySaveRequestSchema, MemorySearchRequestSchema } from "../schemas/memory-models.js";

// 创建或注册 registerMemoryRoutes 所需的数据
export function registerMemoryRoutes(app: any) {
  // 保存记忆（幂等，自动去重 + embedding + Vectorize）
  app.put("/internal/v1/users/:user_id/memories/:memory_id", async (c: any) => {
    const userId = c.req.param("user_id");
    const memoryId = c.req.param("memory_id");
    const body = await c.req.json();
    const parsed = MemorySaveRequestSchema.parse(body);

    const rawContent = parsed.content;
    const validation = validateMemoryContent(rawContent);
    if (!validation.valid) {
      return c.json(
        {
          ok: false,
          data: null,
          error: { code: "MEMORY_INVALID_REQUEST", message: validation.error },
          meta: { request_id: c.get("requestId") },
        },
        400,
      );
    }

    const content = redactSensitive(rawContent.trim());

    try {
      const result = await saveMemory(c.env.DB, c.env.MEMORY_INDEX, c.env.AI, {
        id: memoryId,
        user_id: userId,
        content,
        category: parsed.category || "fact",
        importance: parsed.importance || 3,
        source: parsed.source || "user_explicit",
        source_conversation_id: parsed.source_conversation_id ?? null,
      });

      const meta: any = { request_id: c.get("requestId") };
      if (!result.indexed) {
        meta.warnings = ["Index not yet ready"];
      }

      return c.json({
        ok: true,
        data: result.memory,
        error: null,
        meta,
      });
    } catch (err: any) {
      if (err?.code === "SQLITE_CONSTRAINT_UNIQUE" || err?.message?.includes("UNIQUE constraint")) {
        return c.json(
          {
            ok: false,
            data: null,
            error: { code: "MEMORY_CONFLICT", message: "相同内容已存在" },
            meta: { request_id: c.get("requestId") },
          },
          409,
        );
      }
      throw err;
    }
  });

  // 列出用户记忆（支持 category 过滤，默认最多 50 条）
  app.get("/internal/v1/users/:user_id/memories", async (c: any) => {
    const userId = c.req.param("user_id");
    const category = (c.req.query("category") as string) || undefined;
    const limit = Math.min(parseInt((c.req.query("limit") as string) || "50", 10), 100);

    const memories = await listMemories(c.env.DB, userId, {
      category: category as any,
      limit,
    });

    return c.json({
      ok: true,
      data: memories,
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });

  // 更新记忆（内容变更后 index_status 重置为 pending，触发重新 embedding）
  app.patch("/internal/v1/users/:user_id/memories/:memory_id", async (c: any) => {
    const userId = c.req.param("user_id");
    const memoryId = c.req.param("memory_id");
    const body = await c.req.json();

    const existing = await getMemoryById(c.env.DB, memoryId, userId);
    if (!existing || existing.status === "deleted") {
      return c.json(
        {
          ok: false,
          data: null,
          error: { code: "MEMORY_NOT_FOUND", message: "记忆不存在" },
          meta: { request_id: c.get("requestId") },
        },
        404,
      );
    }

    const updates: any = {};
    if ((body as any).content !== undefined) {
      const validation = validateMemoryContent((body as any).content);
      if (!validation.valid) {
        return c.json(
          {
            ok: false,
            data: null,
            error: { code: "MEMORY_INVALID_REQUEST", message: validation.error },
            meta: { request_id: c.get("requestId") },
          },
          400,
        );
      }
      updates.content = redactSensitive((body as any).content.trim());
      updates.normalized_content = normalizeContent(updates.content);
    }
    if ((body as any).category) updates.category = (body as any).category;
    if ((body as any).importance) updates.importance = Math.min(Math.max((body as any).importance, 1), 5);

    const updated = await updateMemory(
      c.env.DB,
      c.env.MEMORY_INDEX,
      c.env.AI,
      userId,
      memoryId,
      updates,
    );
    if (!updated) {
      return c.json(
        {
          ok: false,
          data: null,
          error: { code: "MEMORY_NOT_FOUND", message: "记忆不存在" },
          meta: { request_id: c.get("requestId") },
        },
        404,
      );
    }

    return c.json({
      ok: true,
      data: updated,
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });

  // 删除记忆（D1 软删除 + Vectorize deleteByIds）
  app.delete("/internal/v1/users/:user_id/memories/:memory_id", async (c: any) => {
    const userId = c.req.param("user_id");
    const memoryId = c.req.param("memory_id");

    const deleted = await deleteMemory(c.env.DB, c.env.MEMORY_INDEX, userId, memoryId);
    if (!deleted) {
      return c.json(
        {
          ok: false,
          data: null,
          error: { code: "MEMORY_NOT_FOUND", message: "记忆不存在" },
          meta: { request_id: c.get("requestId") },
        },
        404,
      );
    }

    return c.json({
      ok: true,
      data: { id: memoryId, deleted: true },
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });

  // 清空用户所有记忆并批量清理 Vectorize
  app.delete("/internal/v1/users/:user_id/memories", async (c: any) => {
    const userId = c.req.param("user_id");
    const count = await clearUserMemories(c.env.DB, c.env.MEMORY_INDEX, userId);

    return c.json({
      ok: true,
      data: { user_id: userId, cleared_count: count },
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });

  // 语义搜索（Vectorize topK → D1 回表 → 综合评分排序；失败时降级为纯 SQL）
  app.post("/internal/v1/users/:user_id/memories:search", async (c: any) => {
    const userId = c.req.param("user_id");
    const body = await c.req.json();
    const parsed = MemorySearchRequestSchema.parse(body);
    const query = parsed.query;

    try {
      const result = await searchMemories(c.env.DB, c.env.MEMORY_INDEX, c.env.AI, userId, query, {
        category: parsed.category ?? undefined,
        limit: parsed.limit || 10,
        minScore: parsed.min_score || 0.65,
      });

      const meta: any = { request_id: c.get("requestId") };
      if (result.degraded) {
        meta.degraded = true;
        meta.warnings = ["Vectorize unavailable, degraded to SQL"];
      }

      return c.json({
        ok: true,
        data: { items: result.results, degraded: result.degraded },
        error: null,
        meta,
      });
    } catch {
      const fallback = await searchMemories(c.env.DB, c.env.MEMORY_INDEX, c.env.AI, userId, query, { limit: 10 }, true);
      return c.json({
        ok: true,
        data: { items: fallback.results, degraded: fallback.degraded },
        error: null,
        meta: { request_id: c.get("requestId"), degraded: true, warnings: ["Search degraded to SQL fallback"] },
      });
    }
  });
}
