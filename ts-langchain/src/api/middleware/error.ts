import type { FastifyInstance } from "fastify";

export function registerErrorMiddleware(app: FastifyInstance) {
  app.setErrorHandler((error: any, request: any, reply: any) => {
    console.error("Error:", error);
    reply.status(error.statusCode || 500).send({
      error: error.message || "Internal server error",
    });
  });
}
