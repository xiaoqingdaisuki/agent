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
 * - Mutex 保护共享状态（缓存、电路 breaker），对齐 Python threading.Lock
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";

// ============ 类型定义 ============

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
  maxAttempts: number;
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

interface InFlightSearch {
  /** 结果就绪时 resolve，多个等待者共享同一个 Promise */
  done: Promise<SearchOutcome>;
  /** resolve 函数 — 由执行者调用以通知所有等待者 */
  resolve: (outcome: SearchOutcome) => void;
  outcome: SearchOutcome | null;
}

// ============ 共享状态 ============

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, InFlightSearch>();
let circuit: CircuitState = { failures: 0, openUntil: 0 };
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

class NonRetryableSearchError extends Error {}

// ============ 辅助函数 ============

/**
 * 将字符串安全地限制在整数范围内
 */
// 执行 boundedInteger 对应的业务逻辑
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

/**
 * Mutex — 保护共享状态的并发访问
 *
 * TS 单线程事件循环中，await 会交出控制权，可能导致状态不一致。
 * 使用显式 Mutex 确保关键区段原子性，对齐 Python 的 threading.Lock。
 */
class Mutex {
  private _locked = false;
  private _waiters: Array<(unlock: () => void) => void> = [];

  // 获取互斥锁；等待者会在前一持有者释放时直接接管锁
  async lock(): Promise<() => void> {
    if (!this._locked) {
      this._locked = true;
      return () => this._unlock();
    }

    return new Promise<() => void>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  // 释放互斥锁并把所有权交给队列中的下一个等待者
  private _unlock(): void {
    const next = this._waiters.shift();
    if (next) {
      next(() => this._unlock());
    } else {
      this._locked = false;
    }
  }
}

const stateMutex = new Mutex();

// 获取 getSettings 对应的数据
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
    maxAttempts: boundedInteger(process.env.SEARCH_MAX_ATTEMPTS, 1, 1, 2),
  };
}

// 执行 cleanHtml 对应的业务逻辑
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

// 执行 normalizeUrl 对应的业务逻辑
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

// ============ HTTP 请求 ============

// 向 Tavily API 发送搜索请求并返回原始响应
async function fetchTavily(
  settings: SearchSettings,
  query: string,
): Promise<Response> {
  const attempts = settings.maxAttempts;
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

// ============ 搜索执行（mutex 保护共享状态） ============

// 执行搜索，处理缓存、熔断和重试逻辑
async function executeSearch(
  query: string,
  cacheKey: string,
  settings: SearchSettings,
  cached: CacheEntry | undefined,
): Promise<SearchOutcome> {
  const now = Date.now();
  if (!settings.apiKey) {
    return {
      results: [],
      providers: [],
      failedProviders: ["tavily:not_configured"],
      cached: false,
      stale: false,
    };
  }

  // mutex 保护电路 breaker 状态读取
  const release = await stateMutex.lock();
  try {
    if (circuit.openUntil > now) {
      if (cached && cached.staleUntil > now) {
        return { ...cached.outcome, cached: true, stale: true };
      }
      return {
        results: [],
        providers: [],
        failedProviders: ["tavily:circuit_open"],
        cached: false,
        stale: false,
      };
    }
  } finally {
    release();
  }

  const startedAt = Date.now();
  try {
    const results = await searchTavily(query, settings);
    if (results.length === 0)
      throw new Error("Tavily returned an empty result set");

    const outcome: SearchOutcome = {
      results: results.slice(0, settings.maxResults),
      providers: ["tavily"],
      failedProviders: [],
      cached: false,
      stale: false,
    };

    // mutex 保护缓存写入和电路 breaker 重置
    const release2 = await stateMutex.lock();
    try {
      circuit = { failures: 0, openUntil: 0 };
      cache.set(cacheKey, {
        outcome,
        freshUntil: now + settings.cacheTtlMs,
        staleUntil: now + settings.cacheTtlMs + settings.staleTtlMs,
      });
    } finally {
      release2();
    }

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
    const reason = error instanceof Error ? error.message : "unknown error";

    // mutex 保护电路 breaker 递增
    const release3 = await stateMutex.lock();
    try {
      circuit.failures += 1;
      if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD)
        circuit.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    } finally {
      release3();
    }

    console.warn(
      JSON.stringify({
        event: "web_search_failed",
        provider: "tavily",
        duration_ms: Date.now() - startedAt,
        reason,
        consecutive_failures: circuit.failures,
      }),
    );

    // mutex 保护缓存读取
    const release4 = await stateMutex.lock();
    try {
      if (cached && cached.staleUntil > now)
        return { ...cached.outcome, cached: true, stale: true };
    } finally {
      release4();
    }

    return {
      results: [],
      providers: [],
      failedProviders: [`tavily:${reason}`],
      cached: false,
      stale: false,
    };
  }
}

// ============ In-Flight 去重 ============

/**
 * 创建一个带 Event 信号的 in-flight 条目。
 * 多个并发请求共享同一个 Promise，任一请求完成后所有等待者同时收到结果。
 * 对齐 Python 的 InFlightSearch(event=Event(), result=None) 模式。
 */
// 创建或注册 createInFlightEntry 所需的数据
function createInFlightEntry(
  task: Promise<SearchOutcome>,
): InFlightSearch {
  // 执行 resolveEntry 对应的业务逻辑
  let resolveEntry: (outcome: SearchOutcome) => void = () => {};
  const done = task.then((outcome) => {
    resolveEntry(outcome);
    return outcome;
  });

  return {
    done,
    resolve: (outcome: SearchOutcome) => resolveEntry(outcome),
    outcome: null,
  };
}

// 多源搜索入口：处理缓存、去重和并发合并
export async function multiSourceSearch(
  query: string,
): Promise<SearchOutcome> {
  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  const cacheKey = normalizedQuery.toLocaleLowerCase();
  const settings = getSettings();
  const now = Date.now();

  // mutex 保护缓存读取和 in-flight map 操作
  const release = await stateMutex.lock();
  let entry: InFlightSearch | undefined;
  try {
    const cached = cache.get(cacheKey);
    if (cached && cached.freshUntil > now) {
      return { ...cached.outcome, cached: true, stale: false };
    }

    // 检查是否有相同查询的在飞请求
    entry = inFlight.get(cacheKey);
    if (entry) {
      // 已有请求在飞：等待其完成（对齐 Python InFlightSearch.event.wait）
      return entry.done;
    }

    // 创建新的 in-flight 条目并注册
    entry = createInFlightEntry(
      executeSearch(normalizedQuery, cacheKey, settings, cached),
    );
    inFlight.set(cacheKey, entry);
  } finally {
    release();
  }

  // 不在锁内 await，避免阻塞其他请求
  try {
    return await entry.done;
  } finally {
    // 清理 in-flight 条目
    const release2 = await stateMutex.lock();
    try {
      const current = inFlight.get(cacheKey);
      if (current === entry) {
        inFlight.delete(cacheKey);
      }
    } finally {
      release2();
    }
  }
}

// ============ 格式化输出 ============

// 查询 searchResultsToText 对应的结果
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

// ============ Tool 定义 ============

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
