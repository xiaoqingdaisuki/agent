import type { FastifyInstance } from "fastify";
import { createToolAgent } from "../../agents/tool-agent.js";

let toolAgent: Awaited<ReturnType<typeof createToolAgent>> | null = null;

export async function registerStreamRoutes(app: FastifyInstance) {
  app.post<{ Body: { message: string; thread_id?: string } }>(
    "/stream",
    async (request, reply) => {
      const { message } = request.body;
      if (!message) {
        return reply.status(400).send({ error: "message is required" });
      }

      if (!toolAgent) {
        toolAgent = await createToolAgent();
      }

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");

      try {
        const stream = await toolAgent.stream(
          { input: message, chat_history: [] },
          { tags: ["stream"] }
        );

        for await (const chunk of stream) {
          if (chunk?.output) {
            reply.raw.write(`data: ${JSON.stringify({ text: chunk.output })}\n\n`);
          }
        }

        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      } catch (error) {
        console.error("Stream error:", error);
        reply.raw.end();
      }
    }
  );
}
