import { config } from "../config/index.js";

// 汇总不含秘密的关键依赖配置状态，供 readiness 探针与编排器使用。
export function getReadiness() {
  const modelReady = Boolean(config.OPENAI_API_KEY || config.ANTHROPIC_API_KEY);
  const memoryReady = !config.MEMORY_ENABLED || Boolean(config.CLOUDFLARE_MEMORY_SECRET);
  const ready = modelReady && memoryReady;
  return {
    status: ready ? "ok" : "degraded",
    ready,
    version: "0.2.0",
    timestamp: new Date().toISOString(),
    components: {
      model: modelReady ? "configured" : "missing_configuration",
      memory_gateway: memoryReady ? "configured" : "missing_configuration",
    },
  };
}
