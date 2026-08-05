/**
 * web.search — 实时互联网搜索（Tavily 后端）
 *
 * 核心能力：
 * 1. 多级缓存（新鲜缓存 + 过期降级缓存）避免重复请求
 * 2. 并发去重（in-flight dedup）防止同一查询重复发出
 * 3. 熔断器（circuit breaker）在连续失败后自动降级，避免压垮上游
 * 4. 自动重试 + 退避，提升网络波动下的鲁棒性
 * 5. 返回结构化结果（标题、URL、摘要、发布时间），供 Agent 或工具管线消费
 *
 * 设计要点：
 * - 纯函数式组织：settings / 私有 helper / 公开 API 三层分离
 * - 缓存键使用 query 的小写规范化形式，保证命中一致性
 * - stale 缓存允许在上游不可用时返回降级结果，而非硬失败
 * - resetSearchStateForTests 暴露内部状态，便于单元测试隔离
 */

import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  provider: "tavily";
  rank: number;
  published_at?: string;
  retrieved_at: string;
}

export interface SearchOutcome {
  results: SearchResultItem[];
  providers: string[];
  failedProviders: string[];
  cached: boolean;
  stale: boolean;
}

interface SearchSettings {
  apiKey?: string;
  timeoutMs: number;
  maxResults: number;
  cacheTtlMs: number;
  staleTtlMs: number;
  searchDepth: "basic" | "advanced";
}

interface CacheEntry {
  outcome: SearchOutcome;
  freshUntil: number;
  staleUntil: number;
}

interface CircuitState {
  failures: number;
  openUntil: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SearchOutcome>>();
let circuit: CircuitState = { failures: 0, openUntil: 0 };
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

class NonRetryableSearchError extends Error {}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.trunc(parsed)))
    : fallback;
}

function getSettings(): SearchSettings {
  return {
    apiKey: process.env.TAVILY_API_KEY?.trim() || undefined,
    timeoutMs: boundedInteger(
      process.env.SEARCH_TIMEOUT_MS,
      4_500,
      1_000,
      15_000,
    ),
    maxResults: boundedInteger(process.env.SEARCH_MAX_RESULTS, 8, 1, 20),
    cacheTtlMs:
      boundedInteger(process.env.SEARCH_CACHE_TTL_SECONDS, 30, 0, 3_600) *
      1_000,
    staleTtlMs:
      boundedInteger(process.env.SEARCH_STALE_TTL_SECONDS, 600, 0, 86_400) *
      1_000,
    searchDepth:
      process.env.TAVILY_SEARCH_DEPTH === "advanced" ? "advanced" : "basic",
  };
}

function cleanHtml(text: string): string {
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

// 向 Tavily API 发送搜索请求并返回原始响应
async function fetchTavily(
  settings: SearchSettings,
  query: string,
): Promise<Response> {
  const attempts = 2;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          topic: "general",
          search_depth: settings.searchDepth,
          max_results: settings.maxResults,
          include_answer: false,
          include_raw_content: false,
        }),
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
      if (response.ok) return response;
      const error = new Error(`Tavily HTTP ${response.status}`);
      if (!RETRYABLE_STATUSES.has(response.status))
        throw new NonRetryableSearchError(error.message);
      if (attempt === attempts - 1) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error instanceof NonRetryableSearchError) throw error;
      if (attempt === attempts - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Tavily request failed");
}

// 调用 Tavily 搜索并将结果解析为结构化格式
async function searchTavily(
  query: string,
  settings: SearchSettings,
): Promise<SearchResultItem[]> {
  const response = await fetchTavily(settings, query);
  const data = (await response.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      published_date?: string;
    }>;
  };
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();
  for (const item of data.results || []) {
    const url = normalizeUrl(item.url || "");
    const title = cleanHtml(item.title || "");
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title,
      url,
      snippet: cleanHtml(item.content || "").slice(0, 500),
      provider: "tavily",
      rank: results.length + 1,
      published_at: item.published_date,
      retrieved_at: new Date().toISOString(),
    });
  }
  return results;
}

// 执行搜索，处理缓存、熔断和重试逻辑
async function executeSearch(
  query: string,
  cacheKey: string,
  settings: SearchSettings,
): Promise<SearchOutcome> {
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (!settings.apiKey) {
    return {
      results: [],
      providers: [],
      failedProviders: ["tavily:not_configured"],
      cached: false,
      stale: false,
    };
  }
  if (circuit.openUntil > now) {
    if (cached && cached.staleUntil > now)
      return { ...cached.outcome, cached: true, stale: true };
    return {
      results: [],
      providers: [],
      failedProviders: ["tavily:circuit_open"],
      cached: false,
      stale: false,
    };
  }

  const startedAt = Date.now();
  try {
    const results = await searchTavily(query, settings);
    if (results.length === 0)
      throw new Error("Tavily returned an empty result set");
    circuit = { failures: 0, openUntil: 0 };
    const outcome: SearchOutcome = {
      results: results.slice(0, settings.maxResults),
      providers: ["tavily"],
      failedProviders: [],
      cached: false,
      stale: false,
    };
    cache.set(cacheKey, {
      outcome,
      freshUntil: now + settings.cacheTtlMs,
      staleUntil: now + settings.cacheTtlMs + settings.staleTtlMs,
    });
    console.info(
      JSON.stringify({
        event: "web_search_succeeded",
        provider: "tavily",
        duration_ms: Date.now() - startedAt,
        result_count: outcome.results.length,
      }),
    );
    return outcome;
  } catch (error) {
    circuit.failures += 1;
    if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD)
      circuit.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    const reason = error instanceof Error ? error.message : "unknown error";
    console.warn(
      JSON.stringify({
        event: "web_search_failed",
        provider: "tavily",
        duration_ms: Date.now() - startedAt,
        reason,
        consecutive_failures: circuit.failures,
      }),
    );
    if (cached && cached.staleUntil > now)
      return { ...cached.outcome, cached: true, stale: true };
    return {
      results: [],
      providers: [],
      failedProviders: [`tavily:${reason}`],
      cached: false,
      stale: false,
    };
  }
}

export async function multiSourceSearch(query: string): Promise<SearchOutcome> {
  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  const cacheKey = normalizedQuery.toLocaleLowerCase();
  const settings = getSettings();
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.freshUntil > now)
    return { ...cached.outcome, cached: true, stale: false };

  const running = inFlight.get(cacheKey);
  if (running) return running;
  const request = executeSearch(normalizedQuery, cacheKey, settings).finally(
    () => inFlight.delete(cacheKey),
  );
  inFlight.set(cacheKey, request);
  return request;
}

export function searchResultsToText(
  outcome: SearchOutcome,
  query: string,
): string {
  if (outcome.results.length === 0) {
    const reason = outcome.failedProviders.join(", ");
    return `Tavily 实时搜索暂时不可用（${reason}）。不要把训练数据描述为实时结果；请告知用户稍后重试。`;
  }
  const freshness = outcome.stale
    ? "⚠️ Tavily 暂时不可用，以下为降级缓存结果"
    : "Tavily 实时搜索结果";
  const lines: string[] = [
    `🔍 ${freshness}（${query}）— 共 ${outcome.results.length} 条：\n`,
  ];
  for (const [index, result] of outcome.results.entries()) {
    lines.push(`[${index + 1}] ${result.title}`);
    lines.push(`    ${result.url}`);
    lines.push(`    ${result.snippet.slice(0, 300)}`);
    if (result.published_at) lines.push(`    发布时间：${result.published_at}`);
    lines.push("");
  }
  return lines.join("\n");
}

// 重置搜索状态（缓存、飞行中请求、熔断器），供测试使用
export function resetSearchStateForTests(): void {
  cache.clear();
  inFlight.clear();
  circuit = { failures: 0, openUntil: 0 };
}

export const webSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(400).describe("简洁明确的搜索关键词"),
});

export const webSearchDescriptor: ToolDescriptor = {
  name: "web.search",
  version: "2.0.0",
  title: "互联网搜索",
  description:
    "通过 Tavily 搜索实时互联网信息，返回可核查的标题、链接、摘要与发布时间。",
  category: "SEARCH",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 12000,
  required_permissions: ["web.search"],
  data_classification: ["internal"],
  owner: "tools",
  tags: ["web", "search", "internet", "realtime", "tavily"],
  input_schema: webSearchInputSchema,
};

export const webSearchTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "web_search",
  description:
    "使用 Tavily 搜索实时互联网信息并返回来源链接。涉及新闻、当前数据、政策、人物或公司动态时必须使用。",
  schema: webSearchInputSchema,
  func: async ({ query }) =>
    searchResultsToText(await multiSourceSearch(query), query),
});
