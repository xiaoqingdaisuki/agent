import { config } from "./index.js";

// 为所有 OpenAI 兼容客户端生成一致的 AI Gateway 地址和认证头。
export function getModelConfiguration() {
  const headers: Record<string, string> = {};
  if (config.CLOUDFLARE_AI_GATEWAY_TOKEN) {
    headers["cf-aig-authorization"] = `Bearer ${config.CLOUDFLARE_AI_GATEWAY_TOKEN}`;
  }
  return {
    apiKey: config.OPENAI_API_KEY,
    baseURL: config.CLOUDFLARE_AI_GATEWAY_URL || config.OPENAI_BASE_URL,
    defaultHeaders: headers,
  };
}
