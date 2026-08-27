import type { FastifyInstance } from "fastify";
import { getToolMetadata } from "../../tools/registry.js";
import { permissionsForRoles } from "../../tools/runtime/authorization.js";
import { getAgentToolIdentity } from "../middleware/auth.js";

// 创建或注册 registerToolRoutes 所需的数据
export async function registerToolRoutes(app: FastifyInstance) {
  app.get("/tools", async (request) => {
    const identity = getAgentToolIdentity(request);
    return getToolMetadata([...permissionsForRoles(identity.roles)]);
  });
}
