import { FastifyInstance } from "fastify";
import { buildApp } from "./api/index.js";
import { config } from "./config/index.js";
import { flushBackgroundTasks } from "./services/index.js";
import { flushAuditLogs } from "./tools/runtime/executor.js";
import { flushToolMetrics } from "./tools/observability.js";

// 在有限时间内停止接流、等待持久化并刷新审计与指标。
async function shutdown(app: FastifyInstance, signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down gracefully`);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  await app.close();
  await Promise.race([
    Promise.allSettled([flushBackgroundTasks(), flushAuditLogs(), flushToolMetrics()]).then(() => undefined),
    timeout,
  ]);
}

// 执行 main 对应的业务逻辑
async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    console.log(`TS Agent server running on http://localhost:${config.PORT}`);
    let stopping = false;
    // 仅处理一次停止信号，并在收敛后台任务后退出进程。
    const handleSignal = (signal: string) => {
      if (stopping) return;
      stopping = true;
      void shutdown(app, signal).finally(() => process.exit(0));
    };
    process.once("SIGTERM", () => handleSignal("SIGTERM"));
    process.once("SIGINT", () => handleSignal("SIGINT"));
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
