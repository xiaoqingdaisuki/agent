/** 根据配置创建聊天模型并统一模型调用参数 */

import { config } from "./index.js";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

// 为 OpenAI 兼容客户端生成一致的 AI Gateway 地址和认证头
export function getModelConfiguration() {
  const headers: Record<string, string> = {};
  if (config.CLOUDFLARE_AI_GATEWAY_TOKEN) {
    headers["cf-aig-authorization"] = `Bearer ${config.CLOUDFLARE_AI_GATEWAY_TOKEN}`;
  }
  return {
    apiKey: config.OPENAI_API_KEY,
    baseURL: normalizeOpenAIBaseUrl(config.CLOUDFLARE_AI_GATEWAY_URL || config.OPENAI_BASE_URL),
    defaultHeaders: headers,
  };
}

// 规范化 OpenAI 兼容服务地址，保持与 Python 版相同的根路径行为
function normalizeOpenAIBaseUrl(value: string | undefined): string | undefined {
  if (!value) return value;
  const normalized = value.replace(/\/+$/, "");
  const host = normalized.split("://", 2)[1] || normalized;
  return host.includes("/") ? normalized : `${normalized}/v1`;
}

// 根据统一 provider 配置创建 OpenAI 或 Anthropic 聊天模型
export function createChatModel(options: { model?: string } = {}): BaseChatModel {
  if (config.LLM_PROVIDER === "anthropic") {
    return new ChatAnthropic({
      model: options.model || config.ANTHROPIC_MODEL,
      apiKey: config.ANTHROPIC_API_KEY,
      maxTokens: config.LLM_MAX_OUTPUT_TOKENS,
      clientOptions: { timeout: config.LLM_TIMEOUT_MS },
      maxRetries: config.LLM_MAX_RETRIES,
    });
  }
  return new ChatOpenAI({
    model: options.model || config.OPENAI_MODEL,
    maxTokens: config.LLM_MAX_OUTPUT_TOKENS,
    timeout: config.LLM_TIMEOUT_MS,
    maxRetries: config.LLM_MAX_RETRIES,
    configuration: getModelConfiguration(),
  });
}
