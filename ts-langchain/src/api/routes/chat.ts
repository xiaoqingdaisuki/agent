import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createDirectChatAgent,
  createToolAgent,
  getFastPathAnswer,
  isDirectChatMessage,
} from "../../agents/tool-agent.js";
import { getHistoryBeforeInput } from "../../memory/conversation.js";
import { runWithToolCallContext } from "../../tools/runtime/executor.js";
import {
  isAgentDeadlineError,
  runWithAgentDeadline,
} from "../../agents/deadline.js";
import {
  getFinishReason,
  isLikelyTruncated,
  maybeAppendContinuationHint,
} from "../../agents/response-handler.js";
import {
  BusinessError,
  ConversationService,
  extractAgentOutputText,
  loadMemoryContext,
  scheduleAnswerPersistence,
  TurnService,
  waitForConversationPersistence,
} from "../../services/index.js";
import { getAgentToolIdentity, requireAgentUserId } from "../middleware/auth.js";
import { logRequestError } from "../middleware/error.js";
import type { ReActRunSummary } from "../../agents/react-policy.js";
import { config } from "../../config/index.js";

// 注册旧版非流式对话接口，并按消息意图选择本地快答、轻量对话或完整工具 Agent。
export async function registerChatRoutes(app: FastifyInstance) {
  app.post<{ Body: { message: string; thread_id?: string; user_id?: string; client_message_id?: string } }>(
    "/chat",
    async (
      request: FastifyRequest<{ Body: { message: string; thread_id?: string; user_id?: string; client_message_id?: string } }>,
      reply: FastifyReply,
    ) => {
      let activeTurn: { id: string; userId: string } | null = null;
      try {
        const { message, thread_id, user_id, client_message_id } = request.body;
        const trustedUserId = requireAgentUserId(request, user_id);
        const toolIdentity = getAgentToolIdentity(request, user_id);
        if (typeof message !== "string" || message.length < 1 || message.length > 16_000) {
          return reply.status(400).send({
            error: { code: "VALIDATION_ERROR", message: "请求参数无效" },
          });
        }

        const threadId = thread_id || crypto.randomUUID();
        await ConversationService.ensure(threadId, trustedUserId);
        const turnResult = await TurnService.begin(threadId, trustedUserId, message, client_message_id);
        if (!turnResult.created) {
          const completed = TurnService.completedMessage(turnResult.turn);
          if (completed) return { reply: completed.content, thread_id: threadId, turn_id: turnResult.turn.id };
          throw TurnService.duplicateError(turnResult.turn.status);
        }
        activeTurn = { id: turnResult.turn.id, userId: trustedUserId };

        const fastAnswer = getFastPathAnswer(message);
        if (fastAnswer) {
          scheduleAnswerPersistence(
            threadId,
            threadId,
            message,
            fastAnswer,
            trustedUserId,
          );
          const assistantMessage = { id: crypto.randomUUID(), role: "assistant" as const, content: fastAnswer, createdAt: new Date().toISOString() };
          await TurnService.complete(turnResult.turn.id, trustedUserId, assistantMessage);
          activeTurn = null;
          return { reply: fastAnswer, thread_id: threadId, turn_id: turnResult.turn.id };
        }

        // 注入缓存记忆并异步刷新，避免旧接口被记忆网关阻塞。
        const memoryContext = trustedUserId
          ? await loadMemoryContext(trustedUserId)
          : [];

        const agentHistoryThreadId = threadId;
        const history = await getHistoryBeforeInput(agentHistoryThreadId, message);
        const agent = await (isDirectChatMessage(message)
          ? createDirectChatAgent()
          : createToolAgent());

        // 设置工具调用上下文，确保 invokeTool 管线能获取到 user_id 等信息
        const toolContext = {
          request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          trace_id: `trace_${Date.now()}`,
          conversation_id: threadId,
          tenant_id: toolIdentity.tenantId,
          user_id: trustedUserId,
          actor_type: "user",
          roles: toolIdentity.roles,
        } as const;

        const result = await runWithAgentDeadline<{
          output?: unknown;
          react?: ReActRunSummary;
        }>(
          (deadline) =>
            runWithToolCallContext(
              toolContext,
              () =>
                (agent as any).invoke(
                  {
                    input: message,
                    chat_history: history,
                    memory_context: memoryContext,
                  },
                  { signal: deadline.signal },
                ),
              {
                onToolProgress: (event) =>
                  event.type === "started" && deadline.enableToolBudget(),
              },
            ),
          undefined,
          config.AGENT_DEADLINE_MS,
        );

        let replyText = extractAgentOutputText(result) || "抱歉，我没有理解您的问题。";

        // 检测 LLM 输出截断（finish_reason=length 或文本 abrupt ending）
        const finishReason = getFinishReason(result as any);
        if (isLikelyTruncated(replyText, finishReason)) {
          replyText = maybeAppendContinuationHint(replyText, finishReason);
        }

        scheduleAnswerPersistence(
          threadId,
          agentHistoryThreadId,
          message,
          replyText,
          trustedUserId,
        );
        const assistantMessage = { id: crypto.randomUUID(), role: "assistant" as const, content: replyText, createdAt: new Date().toISOString() };
        await TurnService.complete(turnResult.turn.id, trustedUserId, assistantMessage);
        activeTurn = null;

        return {
          reply: replyText,
          thread_id: threadId,
          turn_id: turnResult.turn.id,
          stop_reason: result.react?.stop_reason,
          react: result.react,
        };
      } catch (error: any) {
        if (activeTurn) {
          await TurnService.terminate(activeTurn.id, activeTurn.userId, false, error?.code || "INTERNAL_ERROR").catch(() => undefined);
        }
        logRequestError(request, error);
        if (error instanceof BusinessError) {
          return reply.status(error.statusCode).send(error.toJSON());
        }
        if (isAgentDeadlineError(error)) {
          return reply.status(504).send({
            error: {
              code: "AGENT_TIMEOUT",
              message: "AI助手响应超时，请稍后重试。",
            },
          });
        }
        if (error.message?.includes("API key")) {
          return reply
            .status(500)
            .send({
              error: { code: "MODEL_NOT_CONFIGURED", message: "AI 服务尚未配置" },
            });
        }
        return reply.status(500).send({
          error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        });
      }
    },
  );
}
