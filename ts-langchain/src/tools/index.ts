import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";

// ============ WMO Weather Codes ============

const WEATHER_CODES: Record<number, string> = {
  0: "晴朗",
  1: "大部晴朗",
  2: "多云",
  3: "阴天",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "中毛毛雨",
  55: "大毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "中阵雨",
  82: "大阵雨",
  85: "小阵雪",
  86: "大阵雪",
  95: "雷暴",
  96: "雷暴伴小冰雹",
  99: "雷暴伴大冰雹",
};

// ============ Weather Tool ============

export const weatherTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "get_weather",
  description:
    "【天气查询工具】查询指定城市的实时天气。用户问天气、气温、下雨、下雪、冷不冷、热不热时，必须先调用此工具。优先通过 Open-Meteo 获取，如果失败再用 web_search 搜索。",
  schema: z.object({
    city: z.string().describe("城市名称，支持中文如 '北京' '上海' '深圳'，也支持英文如 'Beijing' 'Shanghai'"),
  }),
  func: async ({ city }) => {
    // 尝试 Open-Meteo
    try {
      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`
      );
      if (!geoRes.ok) throw new Error(`Geocoding HTTP ${geoRes.status}`);
      const geoData = await geoRes.json();
      if (!geoData.results?.length) throw new Error(`找不到城市: ${city}`);

      const { latitude, longitude, name, country } = geoData.results[0];
      const weatherRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&timezone=auto`
      );
      if (!weatherRes.ok) throw new Error(`Weather HTTP ${weatherRes.status}`);
      const weatherData = await weatherRes.json();

      const c = weatherData.current_weather;
      const desc = WEATHER_CODES[c.weathercode] || "未知";
      return `🌤 ${name}（${country}）当前天气：\n🌡 温度：${c.temperature}°C\n🌦 天气：${desc}\n💨 风速：${c.windspeed} km/h`;
    } catch {
      // Open-Meteo 失败，尝试 wttr.in 备用
      try {
        const wttrRes = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`, {
          headers: { "User-Agent": "curl/7.68" },
          signal: AbortSignal.timeout(8000),
        });
        if (wttrRes.ok) {
          const wData = await wttrRes.json();
          const curr = wData.current_condition[0];
          const area = wData.nearest_area[0];
          const areaName = area.areaName[0].value;
          const country = area.country[0].value;
          return `🌤 ${areaName}（${country}）当前天气：\n🌡 温度：${curr.temp_C}°C（体感 ${curr.FeelsLikeC}°C）\n🌦 天气：${curr.weatherDesc[0].value}\n💨 风速：${curr.windspeedKmph} km/h\n💧 湿度：${curr.humidity}%`;
        }
      } catch {
        // wttr.in 也失败了
      }
      return `❌ 天气查询暂时不可用（网络或服务异常）。请使用 web_search 工具搜索"${city}天气"获取信息。`;
    }
  },
});

// ============ Web Search Tool (Multi-source) ============

async function searchBing(query: string): Promise<string | null> {
  const res = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=zh-CN`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!res.ok) return null;
  const html = await res.text();

  const results: string[] = [];
  const seen = new Set<string>();
  const itemRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let match;

  while ((match = itemRegex.exec(html)) && results.length < 5) {
    const item = match[1];
    const titleMatch = item.match(/<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/);
    if (!titleMatch) continue;

    const url = titleMatch[1];
    const title = titleMatch[2]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .trim();

    if (!title || seen.has(url)) continue;
    seen.add(url);

    const snippetMatch = item.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = snippetMatch
      ? snippetMatch[1]
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .trim()
      : "无摘要";

    results.push(`• ${title}\n  ${url}\n  ${snippet}`);
  }

  return results.length > 0 ? `🔍 搜索结果（${query}）：\n\n${results.join("\n\n")}` : null;
}

async function searchSearx(query: string): Promise<string | null> {
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
          signal: AbortSignal.timeout(8000),
        }
      );

      if (!res.ok) continue;
      const data = await res.json();

      if (data.results?.length) {
        const results = data.results
          .slice(0, 5)
          .map((r: any) => `• ${r.title}\n  ${r.url}\n  ${(r.content || "").slice(0, 100)}`);
        return `🔍 搜索结果（${query}）：\n\n${results.join("\n\n")}`;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function searchDuckDuckGo(query: string): Promise<string | null> {
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    { signal: AbortSignal.timeout(8000) }
  );

  if (!res.ok) return null;
  const data = await res.json();

  const results: string[] = [];
  if (data.Abstract) {
    results.push(`📋 ${data.Abstract}`);
    if (data.AbstractURL) results.push(`   来源：${data.AbstractURL}`);
  }
  if (data.RelatedTopics?.length) {
    results.push("\n📌 相关结果：");
    for (const topic of data.RelatedTopics.slice(0, 5)) {
      if (topic.Text && !topic.Text.includes("search for")) {
        results.push(`• ${topic.Text}`);
        if (topic.FirstURL) results.push(`  链接：${topic.FirstURL}`);
      }
    }
  }

  return results.length > 0 ? results.join("\n") : null;
}

export const webSearchTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "web_search",
  description:
    "在互联网上搜索最新信息。当用户问及时事、新闻、最新动态、知识查询、活动信息，或你不知道答案时使用此工具获取最新信息。",
  schema: z.object({
    query: z.string().describe("搜索关键词，尽量简洁明确，例如'深圳8月28日活动'"),
  }),
  func: async ({ query }) => {
    // 1) Bing
    try {
      const bing = await searchBing(query);
      if (bing) return bing;
    } catch {
      // continue
    }

    // 2) Searx
    try {
      const searx = await searchSearx(query);
      if (searx) return searx;
    } catch {
      // continue
    }

    // 3) DuckDuckGo
    try {
      const ddg = await searchDuckDuckGo(query);
      if (ddg) return ddg;
    } catch {
      // all failed
    }

    return `❌ 搜索暂时不可用，无法获取关于"${query}"的信息。请稍后重试。`;
  },
});

// ============ Fetch URL Tool ============

export const fetchUrlTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "fetch_url",
  description:
    "获取指定网页的文本内容。当需要从网页获取详细信息时使用，通常在 web_search 之后使用来获取网页的完整内容。",
  schema: z.object({
    url: z.string().describe("要获取内容的网页URL，必须是完整的URL（包含 https:// 或 http://）"),
  }),
  func: async ({ url }) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AI-Agent/1.0)",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        return `无法获取网页：HTTP ${res.status} ${res.statusText}`;
      }

      const html = await res.text();

      // Strip HTML tags
      let text = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();

      // Truncate to 5000 chars
      const truncated = text.length > 5000 ? text.slice(0, 5000) + "...\n[内容过长，已截断]" : text;

      if (truncated.length < 50) {
        return `网页内容过少或无法解析：${truncated}`;
      }

      return `📄 网页内容（${url}）：\n${truncated}`;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return `获取网页超时（10秒）：${url}`;
      }
      return `获取网页出错：${error instanceof Error ? error.message : "未知错误"}`;
    }
  },
});

// ============ Calculator Tool ============

export const calculatorTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "calculator",
  description: "计算数学表达式。当用户需要进行数学计算时使用此工具。",
  schema: z.object({
    expression: z.string().describe("数学表达式，如 '2 + 2' 或 '10 * 5'"),
  }),
  func: async ({ expression }) => {
    try {
      const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
      const result = Function(`"use strict"; return (${sanitized})`)();
      return `计算结果：${result}`;
    } catch {
      return `错误：无法计算 '${expression}'`;
    }
  },
} as any);

// ============ Tools Export ============

export const tools = [weatherTool, webSearchTool, calculatorTool, fetchUrlTool];
