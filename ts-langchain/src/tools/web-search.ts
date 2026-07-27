/**
 * web.search — 多来源互联网搜索，返回结构化结果
 *
 * 特性:
 * - 多来源降级: Bing → Searx → DuckDuckGo
 * - 结构化返回: title, url, snippet, provider, rank, published_at, retrieved_at
 * - 结果去重: 基于 URL
 * - 超时控制: 各源独立超时
 */

import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";

// ============ 搜索结果模型 ============

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  provider: string;
  rank: number;
  published_at?: string;
  retrieved_at: string;
}

function searchResultsToText(results: SearchResultItem[], query: string): string {
  if (results.length === 0) {
    return `联网搜索未返回结果。你可以基于你的知识直接回答用户关于"${query}"的问题，同时说明这是基于训练数据而非实时搜索。`;
  }

  const lines: string[] = [`🔍 搜索结果（${query}） — 共 ${results.length} 条：\n`];
  for (const [i, r] of results.entries()) {
    lines.push(`[${i + 1}] ${r.title}`);
    lines.push(`    ${r.url}`);
    lines.push(`    ${r.snippet.slice(0, 150)}`);
    if (r.published_at) {
      lines.push(`    发布时间：${r.published_at}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============ HTML 清洗 ============

function cleanHtml(text: string): string {
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============ 搜索源实现 ============

async function searchBing(query: string): Promise<SearchResultItem[] | null> {
  try {
    const res = await fetch(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=zh-CN`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(6000),
      },
    );

    if (!res.ok) return null;

    const html = await res.text();
    const results: SearchResultItem[] = [];
    const seen = new Set<string>();

    const itemRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(html)) && results.length < 5) {
      const item = match[1];

      // 允许 <h2> 带额外属性（class 等）
      const titleMatch = item.match(/]<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/);
      if (!titleMatch) continue;

      const url = titleMatch[1];
      const title = cleanHtml(titleMatch[2]);
      if (!title || seen.has(url)) continue;
      seen.add(url);

      // 优先使用 b_lineclamp 类摘要，回退到第一个 <p>
      let snippet = "无摘要";
      const lineclampMatch = item.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/);
      if (lineclampMatch) {
        snippet = cleanHtml(lineclampMatch[1]).slice(0, 300);
      } else {
        const snippetMatch = item.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        snippet = snippetMatch ? cleanHtml(snippetMatch[1]).slice(0, 300) : snippet;
      }

      results.push({
        title,
        url,
        snippet,
        provider: "bing",
        rank: results.length + 1,
        retrieved_at: new Date().toISOString(),
      });
    }

    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

async function searchSearx(query: string): Promise<SearchResultItem[] | null> {
  const instances = [
    "https://search.sapti.me",
    "https://searx.be",
    "https://search.bus-hit.me",
  ];

  for (const instance of instances) {
    try {
      const res = await fetch(
        `${instance}/search?q=${encodeURIComponent(query)}&format=json&engines=google,bing,duckduckgo&pageno=1`,
        {
          headers: { Accept: "application/json", "User-Agent": "curl/7.68" },
          signal: AbortSignal.timeout(3500),
        },
      );

      if (!res.ok) continue;
      const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }> };

      if (data.results?.length) {
        return data.results.slice(0, 5).map((r, i) => ({
          title: r.title || "",
          url: r.url || "",
          snippet: (r.content || "").slice(0, 300),
          provider: "searx",
          rank: i + 1,
          published_at: r.publishedDate || "",
          retrieved_at: new Date().toISOString(),
        }));
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function searchDuckDuckGo(query: string): Promise<SearchResultItem[] | null> {
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { signal: AbortSignal.timeout(5000) },
    );

    if (!res.ok) return null;

    const data = (await res.json()) as {
      Abstract?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    };

    const results: SearchResultItem[] = [];

    if (data.Abstract) {
      results.push({
        title: "摘要",
        url: data.AbstractURL || "",
        snippet: data.Abstract.slice(0, 300),
        provider: "duckduckgo",
        rank: 1,
        retrieved_at: new Date().toISOString(),
      });
    }

    if (data.RelatedTopics?.length) {
      for (let i = 0; i < Math.min(data.RelatedTopics.length, 5); i++) {
        const topic = data.RelatedTopics[i];
        if (topic.Text && !topic.Text.toLowerCase().includes("search for")) {
          results.push({
            title: topic.Text.slice(0, 100),
            url: topic.FirstURL || "",
            snippet: topic.Text.slice(0, 300),
            provider: "duckduckgo",
            rank: results.length + 1,
            retrieved_at: new Date().toISOString(),
          });
        }
      }
    }

    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

async function multiSourceSearch(query: string): Promise<SearchResultItem[]> {
  const allResults: SearchResultItem[] = [];
  const seenUrls = new Set<string>();

  const sources: Array<[string, (q: string) => Promise<SearchResultItem[] | null>]> = [
    ["bing", searchBing],
    ["searx", searchSearx],
    ["duckduckgo", searchDuckDuckGo],
  ];

  const sourceResults = await Promise.all(
    sources.map(async ([providerName, searchFn]) => {
      try {
        return [providerName, await searchFn(query)] as const;
      } catch {
        return [providerName, null] as const;
      }
    }),
  );

  for (const [providerName, results] of sourceResults) {
    if (results) {
      for (const r of results) {
        if (r.url && !seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          r.provider = providerName;
          allResults.push(r);
        }
      }
    }
  }

  // 重新编号
  for (let i = 0; i < allResults.length; i++) {
    allResults[i].rank = i + 1;
  }

  return allResults;
}

// ============ Tool Descriptor ============

export const webSearchDescriptor: ToolDescriptor = {
  name: "web.search",
  version: "1.0.0",
  title: "互联网搜索",
  description:
    "在互联网上搜索最新信息并返回事实核查结果。当用户问及可能需要事实核查的内容时使用：历史事件、时事新闻、政策法规、具体数据、人物动态、公司信息、体育赛事、学术研究、百科知识等。",
  category: "SEARCH",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 12000,
  required_permissions: ["web.search"],
  data_classification: ["internal"],
  owner: "tools",
  tags: ["web", "search", "internet"],
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词，尽量简洁明确，如'深圳8月28日活动'",
      },
    },
    required: ["query"],
  },
};

// ============ LangChain Tool ============

export const webSearchTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "web.search",
  description:
    "在互联网上搜索最新信息并返回结果。当用户问及可能需要事实核查的内容时使用：历史事件、时事新闻、政策法规、具体数据、人物动态、公司/产品信息、体育赛事、学术研究、百科知识等。如果搜索结果不理想，可以基于你的知识直接回答。",
  schema: z.object({
    query: z.string().describe("搜索关键词，尽量简洁明确，如'深圳8月28日活动'"),
  }),
  func: async ({ query }) => {
    const results = await multiSourceSearch(query);
    return searchResultsToText(results, query);
  },
});
