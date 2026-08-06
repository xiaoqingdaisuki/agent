import type { FastifyInstance } from "fastify";
import { getToolMetadata } from "../../tools/registry.js";

// 创建或注册 registerToolRoutes 所需的数据
export async function registerToolRoutes(app: FastifyInstance) {
  app.get("/tools", async (request) => {
    // 从 query 参数获取用户权限列表（简化版）
    const permissions = (request.query as any)?.permissions?.split(",") || [];
    return getToolMetadata(permissions);
  });
}
