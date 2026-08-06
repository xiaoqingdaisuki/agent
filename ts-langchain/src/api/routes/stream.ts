import type { FastifyInstance } from "fastify";
import { createToolAgent } from "../../agents/tool-agent.js";
import { appendMessage, getHistoryBeforeInput } from "../../memory/conversation.js";
import { ConversationService } from "../../services/index.js";
import { MemoryService, ProfileService } from "../../profile/service.js";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { createToolCallScope } from "../../tools/runtime/executor.js";
import {
  executeAgentCommand,
  getAgentPromptOverride,
} from "../../commands/index.js";
import { AgentDeadline, isAgentDeadlineError } from "../../agents/deadline.js";
import { maybeAppendContinuationHint } from "../../agents/response-handler.js";

// 创建或注册 registerStreamRoutes 所需的数据
export async function registerStreamRoutes(app: FastifyInstance) {
  app.post<{ Body: { message: string; thread_id?: string; user_id?: string } }>(
    "/stream",
    async (request, reply) => {
      const { message, thread_id, user_id } = request.body;
      if (!message) {
        return reply.status(400).send({ error: "message is required" });
      }

      const threadId = thread_id || crypto.randomUUID();

      // 确保会话记录存在于 D1（前端传入的 thread_id 需关联 conversations 表）
      await ConversationService.ensure(threadId, user_id);

      const command = executeAgentCommand(message, threadId);
      if (command) {
        await ConversationService.appendUserMessage(threadId, message);
        await ConversationService.appendAssistantMessage(threadId, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: command.reply,
          createdAt: new Date().toISOString(),
        });
        reply.raw.setHeader("Content-Type", "text/event-stream");
        reply.raw.setHeader("Cache-Control", "no-cache");
        reply.raw.setHeader("Connection", "keep-alive");
        reply.raw.write(`data: ${JSON.stringify({ text: command.reply })}\n\n`);
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return;
      }
      const memoryContext: SystemMessage[] = [];
      if (user_id) {
        try {
          await ProfileService.getOrCreate(user_id);
          const context = await MemoryService.buildMemoryContext(user_id);
          if (context) memoryContext.push(new SystemMessage(context));
        } catch {
          // Memory is optional; continue with the default prompt.
        }
      }

      const toolAgent = await createToolAgent(
        getAgentPromptOverride(threadId, message),
      );
      const history = await getHistoryBeforeInput(threadId, message);
      await ConversationService.appendUserMessage(threadId, message);

      const toolContext = {
        request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        trace_id: `trace_${Date.now()}`,
        conversation_id: threadId,
        tenant_id: "",
        user_id: user_id || "anonymous",
        actor_type: "user",
      } as const;

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.flushHeaders();
      reply.raw.write(`data: ${JSON.stringify({ thread_id: threadId })}\n\n`);

      let fullAnswer = "";
      const deadline = new AgentDeadline();
      try {
        const scope = createToolCallScope(toolContext, {
          onToolProgress: (event) =>
            event.type === "started" && deadline.enableToolBudget(),
        });
        const stream = await deadline.run(
          scope.run(() =>
            toolAgent.stream(
              {
                input: message,
                chat_history: history,
                memory_context: memoryContext,
              },
              { tags: ["stream"], signal: deadline.signal },
            ),
          ),
        );
        const iterator = stream[Symbol.asyncIterator]();

        while (true) {
          const next = scope.run(() => iterator.next());
          const { value: chunk, done } = await deadline.run(next);
          if (done) break;
          if (chunk?.output) {
            const text = String(chunk.output);
            fullAnswer += text;
            reply.raw.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        }

        if (fullAnswer) {
          const finalAnswer = maybeAppendContinuationHint(fullAnswer);
          await appendMessage(threadId, new HumanMessage(message));
          await appendMessage(threadId, new AIMessage(finalAnswer));
          await ConversationService.appendAssistantMessage(threadId, {
            id: crypto.randomUUID(),
            role: "assistant",
            content: finalAnswer,
            createdAt: new Date().toISOString(),
          });
        }

        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      } catch (error) {
        console.error("Stream error:", error);
        if (fullAnswer) {
          // 流被中断但有部分结果 → 返回部分内容 + 继续提示，而非报错
          const partialHint = maybeAppendContinuationHint(fullAnswer);
          reply.raw.write(
            `data: ${JSON.stringify({ text: partialHint, partial: true })}\n\n`,
          );
          await appendMessage(threadId, new HumanMessage(message));
          await appendMessage(threadId, new AIMessage(partialHint));
          await ConversationService.appendAssistantMessage(threadId, {
            id: crypto.randomUUID(),
            role: "assistant",
            content: partialHint,
            createdAt: new Date().toISOString(),
          });
        } else {
          // 无任何输出 → 返回错误
          const errMessage = isAgentDeadlineError(error)
            ? "AI助手响应超时，请稍后重试。"
            : "处理请求时发生错误";
          const errCode = isAgentDeadlineError(error)
            ? "AGENT_TIMEOUT"
            : "INTERNAL_ERROR";
          reply.raw.write(
            `data: ${JSON.stringify({ error: { code: errCode, message: errMessage } })}\n\n`,
          );
        }
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      } finally {
        deadline.dispose();
      }
    },
  );
}
