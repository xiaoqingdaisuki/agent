import type { FastifyInstance } from "fastify";
import { createToolAgent } from "../../agents/tool-agent.js";
import { appendMessage, getHistoryBeforeInput } from "../../memory/conversation.js";
import { MemoryService, ProfileService } from "../../profile/service.js";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { runWithToolCallContext } from "../../tools/runtime/executor.js";
import {
  executeAgentCommand,
  getAgentPromptOverride,
} from "../../commands/index.js";
import {
  isAgentDeadlineError,
  runWithAgentDeadline,
} from "../../agents/deadline.js";
import {
  getFinishReason,
  isLikelyTruncated,
  maybeAppendContinuationHint,
} from "../../agents/response-handler.js";
import { BusinessError, ConversationService } from "../../services/index.js";
import { requireAgentUserId } from "../middleware/auth.js";
import { config } from "../../config/index.js";

// 创建或注册 registerChatRoutes 所需的数据
export async function registerChatRoutes(app: FastifyInstance) {
  app.post<{ Body: { message: string; thread_id?: string; user_id?: string } }>(
    "/chat",
    async (request, reply) => {
      try {
        const { message, thread_id, user_id } = request.body;
        const trustedUserId = requireAgentUserId(request, user_id);
        if (!message) {
          return reply.status(400).send({ error: "message is required" });
        }

        const threadId = thread_id || crypto.randomUUID();
        if (config.MEMORY_ENABLED) {
          await ConversationService.ensure(threadId, trustedUserId);
          await ConversationService.appendUserMessage(threadId, message);
        }

        const command = executeAgentCommand(message, threadId);
        if (command) {
          if (config.MEMORY_ENABLED) {
            await ConversationService.appendAssistantMessage(threadId, {
              id: crypto.randomUUID(),
              role: "assistant",
              content: command.reply,
              createdAt: new Date().toISOString(),
            });
          }
          return { reply: command.reply, thread_id: threadId };
        }

        // 注入用户记忆（与 v1 API 保持一致）
        const memoryContext: SystemMessage[] = [];
        if (config.MEMORY_ENABLED && trustedUserId) {
          try {
            await ProfileService.getOrCreate(trustedUserId);
            const context = await MemoryService.buildMemoryContext(trustedUserId);
            if (context) {
              memoryContext.push(new SystemMessage(context));
            }
          } catch {
            // 记忆模块不可用时静默降级
          }
        }

        const agent = await createToolAgent(
          getAgentPromptOverride(threadId, message),
        );
        const history = config.MEMORY_ENABLED
          ? await getHistoryBeforeInput(threadId, message)
          : [];

        // 设置工具调用上下文，确保 invokeTool 管线能获取到 user_id 等信息
        const toolContext = {
          request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          trace_id: `trace_${Date.now()}`,
          conversation_id: threadId,
          tenant_id: "",
          user_id: trustedUserId,
          actor_type: "user",
        } as const;

        const result = await runWithAgentDeadline<{ output?: unknown }>(
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
        );

        let replyText =
          typeof result.output === "string"
            ? result.output
            : "抱歉，我没有理解您的问题。";

        // 检测 LLM 输出截断（finish_reason=length 或文本 abrupt ending）
        const finishReason = getFinishReason(result as any);
        if (isLikelyTruncated(replyText, finishReason)) {
          replyText = maybeAppendContinuationHint(replyText, finishReason);
        }

        if (config.MEMORY_ENABLED) {
          await appendMessage(threadId, new HumanMessage(message));
          await appendMessage(threadId, new AIMessage(replyText));
          await ConversationService.appendAssistantMessage(threadId, {
            id: crypto.randomUUID(),
            role: "assistant",
            content: replyText,
            createdAt: new Date().toISOString(),
          });
        }

        return { reply: replyText, thread_id: threadId };
      } catch (error: any) {
        console.error("Chat error:", error);
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
              error: "API key not configured. Set OPENAI_API_KEY in .env",
            });
        }
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );
}
