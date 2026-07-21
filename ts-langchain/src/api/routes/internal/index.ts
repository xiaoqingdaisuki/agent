/**
 * Internal API — 给 QQ Bot 和其他内部消费者使用
 *
 * 可直接操作 Agent，暴露更多调试能力
 */

import type { FastifyInstance } from "fastify";
import { AgentService } from "../../../services/index.js";

export async function registerInternalRoutes(app: FastifyInstance) {
  // 内部直接对话（跳过会话管理）
  app.post<{ Body: { content: string; channel_id: string } }>(
    "/agent/chat",
    async (request, reply) => {
      try {
        const { content, channel_id } = request.body;
        if (!content) {
          return reply.status(400).send({
            error: { code: "INVALID_REQUEST", message: "content is required" },
          });
        }

        const result = await AgentService.chat(channel_id, content);
        return { reply: result.content, channel_id };
      } catch (error: any) {
        return reply.status(500).send({
          error: {
            code: "INTERNAL_ERROR",
            message: error.message || "Agent 调用失败",
          },
        });
      }
    }
  );

  // 流式对话
  app.post<{ Body: { content: string; channel_id: string } }>(
    "/agent/chat/stream",
    async (request, reply) => {
      const { content, channel_id } = request.body;
      if (!content) {
        return reply.status(400).send({
          error: { code: "INVALID_REQUEST", message: "content is required" },
        });
      }

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");

      try {
        const stream = AgentService.chatStream(channel_id, content);
        for await (const chunk of stream) {
          reply.raw.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
        }
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      } catch (error: any) {
        reply.raw.write(
          `data: ${JSON.stringify({ error: error.message || "Stream failed" })}\n\n`
        );
        reply.raw.end();
      }
    }
  );
}
