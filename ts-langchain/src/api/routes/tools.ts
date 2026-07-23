import type { FastifyInstance } from "fastify";
import { tools } from "../../tools/index.js";

export async function registerToolRoutes(app: FastifyInstance) {
  app.get("/tools", async () => {
    return tools.map((t) => ({ name: t.name, description: t.description }));
  });
}
