import type { FastifyInstance } from "fastify";
import {
  AgentService,
  ConversationService,
  TurnService,
} from "../../services/index.js";
import { getAgentToolIdentity, requireAgentUserId } from "../middleware/auth.js";
import { streamTurn } from "../stream-coordinator.js";

// 创建或注册 registerStreamRoutes 所需的数据
export async function registerStreamRoutes(app: FastifyInstance) {
  app.post<{ Body: { message: string; thread_id?: string; user_id?: string; client_message_id?: string } }>(
    "/stream",
    async (request, reply) => {
      const { message, thread_id, user_id, client_message_id } = request.body || {};
      const trustedUserId = requireAgentUserId(request, user_id);
      const toolIdentity = getAgentToolIdentity(request, user_id);
      if (typeof message !== "string" || message.length < 1 || message.length > 16_000) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "请求参数无效" },
        });
      }
      if (client_message_id !== undefined && (typeof client_message_id !== "string" || client_message_id.length < 1 || client_message_id.length > 128)) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "请求参数无效" },
        });
      }

      const threadId = thread_id || crypto.randomUUID();

      // 确保会话存在于当前仓储，并校验传入 thread_id 的用户归属。
      await ConversationService.ensure(threadId, trustedUserId);
      const turnResult = await TurnService.begin(threadId, trustedUserId, message, client_message_id);
      const completed = turnResult.created ? null : TurnService.completedMessage(turnResult.turn);
      if (!turnResult.created && !completed) {
        const error = TurnService.duplicateError(turnResult.turn.status);
        return reply.status(error.statusCode).send(error.toJSON());
      }

      await streamTurn(request, reply, {
        conversationId: threadId, userId: trustedUserId, turnId: turnResult.turn.id, completed,
        events: (signal) => AgentService.chatStream(threadId, message, trustedUserId, signal, toolIdentity),
      });
    },
  );
}
