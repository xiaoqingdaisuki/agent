import type { FastifyInstance } from "fastify";
import {
  AgentService,
  ConversationService,
  waitForConversationPersistence,
} from "../../services/index.js";
import { requireAgentUserId } from "../middleware/auth.js";
import { logRequestError } from "../middleware/error.js";
import { encodeSseDone, encodeSseEvent } from "../sse.js";

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

      // 确保会话存在于当前仓储，并校验传入 thread_id 的用户归属。
      await ConversationService.ensure(threadId, trustedUserId);
      await waitForConversationPersistence(threadId);
      await ConversationService.appendUserMessage(threadId, message);

      reply.raw.setHeader("Content-Type", "text/event-stream");
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

      try {
        await writeSse(reply.raw, encodeSseEvent("meta", { thread_id: threadId }));
        for await (const event of AgentService.chatStream(
          threadId,
          message,
          trustedUserId,
          requestController.signal,
        )) {
          if (event.type === "text") {
            await writeSse(
              reply.raw,
              encodeSseEvent("text", {
                text: event.text,
                partial: event.partial ?? false,
              }),
            );
          } else if (event.type === "tool") {
            await writeSse(
              reply.raw,
              encodeSseEvent("tool", {
                event: "tool",
                tool_name: event.toolName,
                status: event.status,
                call_id: event.callId,
                duration_ms: event.durationMs ?? null,
              }),
            );
          } else {
            await writeSse(
              reply.raw,
              encodeSseEvent(event.event, {
                state: event.state,
                stop_reason: event.stopReason,
                react: event.react,
              }),
            );
          }
        }
      } catch (error: any) {
        logRequestError(request, error, {
          thread_id: threadId,
          user_id: trustedUserId,
          stream: true,
        });
        await writeSse(
          reply.raw,
          encodeSseEvent("error", {
            ok: false,
            error: {
              code: error?.code || "INTERNAL_ERROR",
              message: error?.message || "处理请求时发生错误",
            },
          }),
        );
      } finally {
        request.raw.removeListener("aborted", abortOnDisconnect);
        reply.raw.removeListener("close", abortOnDisconnect);
        try {
          await writeSse(reply.raw, encodeSseDone());
        } finally {
          reply.raw.end();
        }
      }
    },
  );
}
