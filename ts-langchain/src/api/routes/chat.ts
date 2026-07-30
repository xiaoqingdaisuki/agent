import type { FastifyInstance } from "fastify";
import { createToolAgent } from "../../agents/tool-agent.js";
import { getHistory, appendMessage } from "../../memory/conversation.js";
import { MemoryService, ProfileService } from "../../profile/service.js";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { runWithToolCallContext } from "../../tools/runtime/executor.js";
import { executeAgentCommand, getAgentPromptOverride } from "../../commands/index.js";

export async function registerChatRoutes(app: FastifyInstance) {
  app.post<{ Body: { message: string; thread_id?: string; user_id?: string } }>(
    "/chat",
    async (request, reply) => {
      try {
        const { message, thread_id, user_id } = request.body;
        if (!message) {
          return reply.status(400).send({ error: "message is required" });
        }

        const threadId = thread_id || crypto.randomUUID();

        const command = executeAgentCommand(message, threadId);
        if (command) {
          return { reply: command.reply, thread_id: threadId };
        }

        // 注入用户记忆（与 v1 API 保持一致）
        const memoryContext: SystemMessage[] = [];
        if (user_id) {
          try {
            ProfileService.getOrCreate(user_id);
            const context = MemoryService.buildMemoryContext(user_id);
            if (context) {
              memoryContext.push(new SystemMessage(context));
            }
          } catch {
            // 记忆模块不可用时静默降级
          }
        }

        const agent = await createToolAgent(getAgentPromptOverride(threadId, message));
        const history = getHistory(threadId);

        // 设置工具调用上下文，确保 invokeTool 管线能获取到 user_id 等信息
        const toolContext = {
          request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          trace_id: `trace_${Date.now()}`,
          conversation_id: threadId,
          tenant_id: "",
          user_id: user_id || "anonymous",
          actor_type: "user",
        } as const;

        const result = await runWithToolCallContext(toolContext, () => (agent as any).invoke({
            input: message,
            chat_history: history,
            memory_context: memoryContext,
          }));

          const reply_text =
            typeof result.output === "string" ? result.output : "抱歉，我没有理解您的问题。";

          appendMessage(threadId, new HumanMessage(message));
          appendMessage(threadId, new AIMessage(reply_text));

        return { reply: reply_text, thread_id: threadId };
      } catch (error: any) {
        console.error("Chat error:", error);
        if (error.message?.includes("API key")) {
          return reply.status(500).send({ error: "API key not configured. Set OPENAI_API_KEY in .env" });
        }
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );
}
