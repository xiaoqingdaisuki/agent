import type { FastifyInstance } from "fastify";
import { createToolAgent } from "../../agents/tool-agent.js";
import { appendMessage, getHistory } from "../../memory/conversation.js";
import { MemoryService, ProfileService } from "../../profile/service.js";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createToolCallScope } from "../../tools/runtime/executor.js";
import { executeAgentCommand, getAgentPromptOverride } from "../../commands/index.js";

export async function registerStreamRoutes(app: FastifyInstance) {
  app.post<{ Body: { message: string; thread_id?: string; user_id?: string } }>(
    "/stream",
    async (request, reply) => {
      const { message, thread_id, user_id } = request.body;
      if (!message) {
        return reply.status(400).send({ error: "message is required" });
      }

      const threadId = thread_id || crypto.randomUUID();

      const command = executeAgentCommand(message, threadId);
      if (command) {
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
          ProfileService.getOrCreate(user_id);
          const context = MemoryService.buildMemoryContext(user_id);
          if (context) memoryContext.push(new SystemMessage(context));
        } catch {
          // Memory is optional; continue with the default prompt.
        }
      }

      const toolAgent = await createToolAgent(getAgentPromptOverride(threadId, message));
      const history = getHistory(threadId);

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

      try {
        const scope = createToolCallScope(toolContext);
        const stream = await scope.run(() => toolAgent.stream(
          { input: message, chat_history: history, memory_context: memoryContext },
          { tags: ["stream"] }
        ));
        const iterator = stream[Symbol.asyncIterator]();

        let fullAnswer = "";
        while (true) {
          const { value: chunk, done } = await scope.run(() => iterator.next());
          if (done) break;
          if (chunk?.output) {
            const text = String(chunk.output);
            fullAnswer += text;
            reply.raw.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        }

        if (fullAnswer) {
          appendMessage(threadId, new HumanMessage(message));
          appendMessage(threadId, new AIMessage(fullAnswer));
        }

        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      } catch (error) {
        console.error("Stream error:", error);
        reply.raw.write(`data: ${JSON.stringify({ error: "Internal server error" })}\n\n`);
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      }
    }
  );
}
