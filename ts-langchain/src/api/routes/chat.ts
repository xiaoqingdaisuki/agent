import type { FastifyInstance } from "fastify";
import { createChatAgent, chat } from "../../agents/chat-agent.js";

let chatAgent: ReturnType<typeof createChatAgent> | null = null;

export async function registerChatRoutes(app: FastifyInstance) {
  app.post<{ Body: { message: string; thread_id?: string } }>(
    "/chat",
    async (request, reply) => {
      try {
        const { message, thread_id } = request.body;
        if (!message) {
          return reply.status(400).send({ error: "message is required" });
        }

        if (!chatAgent) {
          chatAgent = createChatAgent();
        }

        const threadId = thread_id || crypto.randomUUID();
        const result = await chat(chatAgent, message, threadId);

        return { reply: result.reply, thread_id: result.threadId };
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
