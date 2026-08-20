import type { FastifyInstance } from "fastify";
import { AgentService, ConversationService } from "../../services/index.js";
import { requireAgentUserId } from "../middleware/auth.js";
import { logRequestError } from "../middleware/error.js";

// 创建或注册 registerStreamRoutes 所需的数据
export async function registerStreamRoutes(app: FastifyInstance) {
  app.post<{ Body: { message: string; thread_id?: string; user_id?: string } }>(
    "/stream",
    async (request, reply) => {
      const { message, thread_id, user_id } = request.body;
      const trustedUserId = requireAgentUserId(request, user_id);
      if (!message) {
        return reply.status(400).send({ error: "message is required" });
      }

      const threadId = thread_id || crypto.randomUUID();

      // 确保会话记录存在于 D1（前端传入的 thread_id 需关联 conversations 表）
      await ConversationService.ensure(threadId, trustedUserId);
      await ConversationService.appendUserMessage(threadId, message);

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.flushHeaders();
      reply.raw.write(`data: ${JSON.stringify({ thread_id: threadId })}\n\n`);

      try {
        for await (const event of AgentService.chatStream(
          threadId,
          message,
          trustedUserId,
        )) {
          if (event.type === "text") {
            reply.raw.write(
              `data: ${JSON.stringify({ text: event.text, partial: event.partial })}\n\n`,
            );
          }
        }
      } catch (error: any) {
        logRequestError(request, error, {
          thread_id: threadId,
          user_id: trustedUserId,
          stream: true,
        });
        reply.raw.write(
          `data: ${JSON.stringify({
            error: {
              code: error?.code || "INTERNAL_ERROR",
              message: error?.message || "处理请求时发生错误",
            },
          })}\n\n`,
        );
      } finally {
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      }
    },
  );
}
