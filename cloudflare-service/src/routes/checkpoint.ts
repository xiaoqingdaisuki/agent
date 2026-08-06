/**
 * Checkpoint Routes — LangGraph 图状态持久化
 *
 * POST   /internal/v1/checkpoints/{thread_id}    — 保存 checkpoint
 * GET    /internal/v1/checkpoints/{thread_id}    — 获取最新 checkpoint
 * DELETE /internal/v1/checkpoints/{thread_id}    — 删除线程所有 checkpoints
 */

import {
  upsertCheckpoint,
  getLatestCheckpoint,
  deleteThreadCheckpoints,
} from "../repositories/checkpoint.js";

export function registerCheckpointRoutes(app: any) {
  // 保存或更新 checkpoint（upsert）
  app.post("/internal/v1/checkpoints/:thread_id", async (c: any) => {
    try {
      const threadId = c.req.param("thread_id");
      const body = await c.req.json();

      const checkpointId = body.checkpoint_id as string;
      if (!checkpointId) {
        return c.json(
          { ok: false, data: null, error: { code: "CHECKPOINT_BAD_REQUEST", message: "checkpoint_id is required" }, meta: { request_id: c.get("requestId") } },
          400,
        );
      }

      await upsertCheckpoint(c.env.DB, {
        threadId,
        checkpointId,
        parentCheckpointId: body.parent_checkpoint_id ?? null,
        checkpointData: JSON.stringify(body.checkpoint_data ?? {}),
        metadata: JSON.stringify(body.metadata ?? {}),
      });

      return c.json({
        ok: true,
        data: { thread_id: threadId, checkpoint_id: checkpointId },
        error: null,
        meta: { request_id: c.get("requestId") },
      });
    } catch (err: any) {
      console.error("Checkpoint save failed:", err);
      return c.json(
        { ok: false, data: null, error: { code: "CHECKPOINT_SAVE_FAILED", message: err.message || "Save failed" }, meta: { request_id: c.get("requestId") } },
        500,
      );
    }
  });

  // 获取最新 checkpoint
  app.get("/internal/v1/checkpoints/:thread_id", async (c: any) => {
    try {
      const threadId = c.req.param("thread_id");
      const checkpoint = await getLatestCheckpoint(c.env.DB, threadId);

      if (!checkpoint) {
        return c.json(
          { ok: false, data: null, error: { code: "CHECKPOINT_NOT_FOUND", message: "No checkpoint found" }, meta: { request_id: c.get("requestId") } },
          404,
        );
      }

      return c.json({
        ok: true,
        data: {
          thread_id: checkpoint.thread_id,
          checkpoint_id: checkpoint.checkpoint_id,
          parent_checkpoint_id: checkpoint.parent_checkpoint_id,
          checkpoint_data: JSON.parse(checkpoint.checkpoint_data),
          metadata: JSON.parse(checkpoint.metadata),
          created_at: checkpoint.created_at,
        },
        error: null,
        meta: { request_id: c.get("requestId") },
      });
    } catch (err: any) {
      console.error("Checkpoint get failed:", err);
      return c.json(
        { ok: false, data: null, error: { code: "CHECKPOINT_GET_FAILED", message: err.message || "Get failed" }, meta: { request_id: c.get("requestId") } },
        500,
      );
    }
  });

  // 删除线程所有 checkpoints
  app.delete("/internal/v1/checkpoints/:thread_id", async (c: any) => {
    try {
      const threadId = c.req.param("thread_id");
      await deleteThreadCheckpoints(c.env.DB, threadId);

      return c.json({
        ok: true,
        data: { thread_id: threadId, deleted: true },
        error: null,
        meta: { request_id: c.get("requestId") },
      });
    } catch (err: any) {
      console.error("Checkpoint delete failed:", err);
      return c.json(
        { ok: false, data: null, error: { code: "CHECKPOINT_DELETE_FAILED", message: err.message || "Delete failed" }, meta: { request_id: c.get("requestId") } },
        500,
      );
    }
  });
}
