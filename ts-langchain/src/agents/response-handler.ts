/**
 * 不完整响应处理器
 *
 * 统一处理三类响应中断场景，确保前端永远收到可读内容而非报错：
 *
 *   1. 工具调用迭代耗尽 (AgentExecutor maxIterations)
 *      → returnStoppedResponse 已处理，此处提供检测辅助
 *   2. LLM 输出截断 (model finish_reason === "length")
 *      → 模型在 max_tokens 限制下返回不完整文本
 *   3. 请求超时 (AgentDeadline / AbortSignal)
 *      → stream 中断时返回已累积的部分内容
 *
 * 所有场景统一输出格式：部分结果 + 继续提示
 * 前端识别到继续提示后，可展示「继续」按钮让用户决定是否续写。
 */

import { AIMessage } from "@langchain/core/messages";

// ============ 截断检测 ============

/**
 * 终端标点集合 — 以这些字符结尾的文本大概率是完整句子。
 */
const TERMINAL_PUNCTUATION = new Set([
  "。",
  "！",
  "？",
  "！",
  ".",
  "!",
  "?",
  "»",
  "…",
  "～",
  "」",
  "』",
  "\"",
  "'",
  ")",
  "】",
  "〗",
  "〉",
  "》",
  "]",
  "}",
  "；",
  ";",
  "：",
  ":",
  "，",
  ",",
]);

/**
 * 检测一段文本是否可能被 LLM 截断。
 *
 * 检测策略（按优先级）：
 *   a) finish_reason === "length" → 确定截断
 *   b) 文本 < 100 字符 → 不视为截断（短回答正常）
 *   c) 末字符是终端标点/空白 → 大概率完整
 *   d) 末字符不是终端标点且文本 > 200 字符 → 可能截断
 */
// 校验并判断 isLikelyTruncated 对应的状态
export function isLikelyTruncated(
  text: string,
  finishReason?: string,
): boolean {
  if (finishReason === "length" || finishReason === "MAX_TOKENS") {
    return true;
  }

  if (!text || text.length < 100) {
    return false;
  }

  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return false;

  const lastChar = trimmed[trimmed.length - 1];

  if (TERMINAL_PUNCTUATION.has(lastChar)) {
    return false;
  }

  if (lastChar === "\n") {
    return false;
  }

  // 不以终端标点/换行结尾，且文本较长 → 大概率被截断
  return true;
}

/**
 * 从 LangChain AIMessage 的 response_metadata 中提取 finish_reason。
 */
// 获取 getFinishReason 对应的数据
export function getFinishReason(message: AIMessage): string | undefined {
  const meta = (message as any).response_metadata;
  if (!meta || typeof meta !== "object") return undefined;

  // OpenAI 格式: { finish_reason: "stop" | "length" | ... }
  const openAIReason = (meta as any).finish_reason;
  if (openAIReason) return openAIReason;

  // Anthropic 格式: { stop_reason: "end_turn" | "max_tokens" | ... }
  const anthropicReason = (meta as any).stop_reason;
  if (anthropicReason === "max_tokens") return "length";
  if (anthropicReason) return anthropicReason;

  return undefined;
}

// ============ 继续提示 ============

const CONTINUATION_PROMPT = "\n\n---\n⚠️ 以上回答尚未完成。如需继续，请回复「继续」。";

/**
 * 为不完整响应追加继续提示，并返回完整文本。
 */
// 创建或注册 appendContinuationHint 所需的数据
export function appendContinuationHint(text: string): string {
  return text + CONTINUATION_PROMPT;
}

/**
 * 检查响应是否需要附加继续提示。
 * 如果已包含继续提示则不再重复添加。
 */
// 执行 maybeAppendContinuationHint 对应的业务逻辑
export function maybeAppendContinuationHint(
  text: string,
  finishReason?: string,
): string {
  if (CONTINUATION_PROMPT.includes(text.slice(-CONTINUATION_PROMPT.length))) {
    return text;
  }
  if (!isLikelyTruncated(text, finishReason)) {
    return text;
  }
  return appendContinuationHint(text);
}

// ============ AgentStep 辅助 ============

import type { AgentStep } from "@langchain/core/agents";

/**
 * 判断 AgentStep 数组是否表明迭代已耗尽（至少有一条有效观察结果）。
 */
// 校验并判断 hasCollectedObservations 对应的状态
export function hasCollectedObservations(steps: AgentStep[]): boolean {
  return steps.some((step) => {
    const obs = step.observation;
    return typeof obs === "string" && obs.trim().length > 0;
  });
}
