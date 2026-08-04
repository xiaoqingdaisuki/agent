import type { FastifyInstance } from "fastify";

// 注册全局错误处理中间件，将异常转换为统一 JSON 响应
export function registerErrorMiddleware(app: FastifyInstance) {
  app.setErrorHandler((error: any, request: any, reply: any) => {
    console.error("Error:", error);
    reply.status(error.statusCode || 500).send({
      error: error.message || "Internal server error",
    });
  });
}
