import type { FastifyInstance } from "fastify";
import {
  AgentService,
  ConversationService,
  waitForConversationPersistence,
  TurnService,
} from "../../services/index.js";
import { getAgentToolIdentity, requireAgentUserId } from "../middleware/auth.js";
import { logRequestError } from "../middleware/error.js";
import { SseEventSequencer, encodeSseHeartbeat } from "../sse.js";

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
  app.post<{ Body: { message: string; thread_id?: string; user_id?: string; client_message_id?: string } }>(
    "/stream",
    async (request, reply) => {
      const { message, thread_id, user_id, client_message_id } = request.body;
      const trustedUserId = requireAgentUserId(request, user_id);
      const toolIdentity = getAgentToolIdentity(request, user_id);
      if (typeof message !== "string" || message.length < 1 || message.length > 16_000) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "请求参数无效" },
        });
      }

      const threadId = thread_id || crypto.randomUUID();

      // 确保会话存在于当前仓储，并校验传入 thread_id 的用户归属。
      await ConversationService.ensure(threadId, trustedUserId);
      const turnResult = await TurnService.begin(threadId, trustedUserId, client_message_id);
      const completed = turnResult.created ? null : TurnService.completedMessage(turnResult.turn);
      if (!turnResult.created && !completed) {
        const error = TurnService.duplicateError(turnResult.turn.status);
        return reply.status(error.statusCode).send(error.toJSON());
      }
      if (turnResult.created) {
        await waitForConversationPersistence(threadId);
        const userMessage = await ConversationService.appendUserMessage(threadId, message);
        await TurnService.start(turnResult.turn.id, trustedUserId, userMessage.id);
      }

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
      const heartbeat = setInterval(() => {
        void writeSse(reply.raw, encodeSseHeartbeat());
      }, 15_000);
      heartbeat.unref();
      const sseEvents = new SseEventSequencer(turnResult.turn.id);
      let fullAnswer = "";
      let turnCompleted = Boolean(completed);

      try {
        await writeSse(reply.raw, sseEvents.event("meta", {
          conversation_id: threadId,
          thread_id: threadId,
          turn_id: turnResult.turn.id,
        }));
        if (completed) {
          await writeSse(reply.raw, sseEvents.event("text", { delta: completed.content, text: completed.content, partial: false, replayed: true }));
          return;
        }
        for await (const event of AgentService.chatStream(
          threadId,
          message,
          trustedUserId,
          requestController.signal,
          toolIdentity,
        )) {
          if (event.type === "text") {
            fullAnswer += event.text;
            await writeSse(
              reply.raw,
              sseEvents.event("text", {
                delta: event.text,
                text: event.text,
                partial: event.partial ?? false,
              }),
            );
          } else if (event.type === "tool") {
            await writeSse(
              reply.raw,
              sseEvents.event("tool", {
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
              sseEvents.event(event.event, {
                state: event.state,
                stop_reason: event.stopReason,
                react: event.react,
              }),
            );
          }
        }
        const assistantMessage = (await ConversationService.getMessages(threadId)).reverse().find((item) => item.role === "assistant")
          ?? { id: crypto.randomUUID(), role: "assistant" as const, content: fullAnswer, createdAt: new Date().toISOString() };
        await TurnService.complete(turnResult.turn.id, trustedUserId, assistantMessage);
        turnCompleted = true;
      } catch (error: any) {
        logRequestError(request, error, {
          thread_id: threadId,
          user_id: trustedUserId,
          stream: true,
        });
        await writeSse(
          reply.raw,
          sseEvents.event("error", {
            ok: false,
            error: {
              code: error?.code || "INTERNAL_ERROR",
              message: error?.message || "处理请求时发生错误",
            },
          }),
        );
        if (!turnCompleted) {
          await TurnService.terminate(
            turnResult.turn.id,
            trustedUserId,
            requestController.signal.aborted,
            requestController.signal.aborted ? "CLIENT_CANCELLED" : error?.code || "INTERNAL_ERROR",
          ).catch(() => undefined);
        }
      } finally {
        clearInterval(heartbeat);
        request.raw.removeListener("aborted", abortOnDisconnect);
        reply.raw.removeListener("close", abortOnDisconnect);
        try {
          await writeSse(reply.raw, sseEvents.done());
        } finally {
          reply.raw.end();
        }
      }
    },
  );
}
