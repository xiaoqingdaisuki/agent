import { FastifyInstance } from "fastify";
import { buildApp } from "./api/index.js";
import { config } from "./config/index.js";

// 执行 main 对应的业务逻辑
async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    console.log(`TS Agent server running on http://localhost:${config.PORT}`);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
