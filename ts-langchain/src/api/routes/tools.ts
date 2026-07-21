import type { FastifyInstance } from "fastify";
import { tools } from "../../tools/index.js";

export async function registerToolRoutes(app: FastifyInstance) {
  app.get("/tools", async () => {
    return [
      { name: "get_weather", description: "Get weather for a city" },
      { name: "calculator", description: "Evaluate a math expression" },
    ];
  });
}
