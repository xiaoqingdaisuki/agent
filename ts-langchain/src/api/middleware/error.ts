import type { FastifyInstance } from "fastify";
import { BusinessError } from "../../services/index.js";

// 注册全局错误处理中间件，将异常转换为统一 JSON 响应
export function registerErrorMiddleware(app: FastifyInstance) {
  app.setErrorHandler((error: any, request: any, reply: any) => {
    console.error("Error:", error);
    if (error instanceof BusinessError) {
      return reply.status(error.statusCode).send(error.toJSON());
    }
    reply.status(error.statusCode || 500).send({
      error: error.message || "Internal server error",
    });
  });
}
