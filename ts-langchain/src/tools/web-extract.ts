/**
 * web.extract — 网页结构化信息提取
 *
 * 在 web.read 的 SSRF 防护基础上抓取网页，并从重复卡片、表格和字段标签中提取结构化数据。
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";
import { isSafeUrl, validateNetworkUrl } from "./web-read.js";

const MAX_RESPONSE_CHARS = 200 * 1024;

export const webExtractInputSchema = z.object({
  url: z.string().url().describe("要提取数据的网页 URL"),
  fields: z.array(z.string().min(1).max(80)).min(1).max(20).describe("需要提取的字段名，如 name、price、rating"),
});

export const webExtractDescriptor: ToolDescriptor = {
  name: "web.extract",
  version: "1.0.0",
  title: "网页结构化提取",
  description: "从指定网页提取结构化字段，例如产品名称、价格和评分。适合批量列表页，不用于文章总结。",
  category: "READ",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 15000,
  required_permissions: ["web.extract"],
  data_classification: ["public"],
  owner: "tools",
  tags: ["web", "extract", "structured"],
  input_schema: webExtractInputSchema,
};

// 解码网页中常见的 HTML 实体。
function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

// 清理 HTML 标签、脚本和样式，保留可供字段匹配的文本。
function cleanHtml(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t\r\n]+/g, " ")
      .trim(),
  );
}

// 生成字段的宽松匹配键，兼容 class、id 和 data-field 命名。
function fieldKeys(field: string): string[] {
  const normalized = field.trim().toLowerCase().replace(/[_-]+/g, " ");
  const aliases: Record<string, string[]> = {
    name: ["name", "title", "product name"],
    title: ["title", "name"],
    price: ["price", "cost", "amount"],
    rating: ["rating", "score", "stars"],
  };
  return [normalized, ...(aliases[normalized] ?? [])];
}

// 从一个 HTML 片段中按字段名提取值。
function extractField(fragment: string, field: string): string {
  const keys = fieldKeys(field).map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const keyPattern = keys.join("|");
  const elementPattern = new RegExp(
    `<([a-z0-9]+)[^>]*(?:class|id|data-field|itemprop)=["'][^"']*(?:${keyPattern})[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    "i",
  );
  const elementMatch = fragment.match(elementPattern);
  if (elementMatch) return cleanHtml(elementMatch[2]).slice(0, 500);

  const labelPattern = new RegExp(`(?:${keyPattern})\\s*[:：]\\s*([^|;,]+)`, "i");
  const labelMatch = cleanHtml(fragment).match(labelPattern);
  return labelMatch?.[1]?.trim().slice(0, 500) ?? "";
}

// 提取表格中的行，并以表头作为字段名。
function extractTableItems(html: string, fields: string[]): Array<Record<string, string>> {
  const tables: Array<Record<string, string>> = [];
  const tableMatches = html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi);
  for (const tableMatch of tableMatches) {
    const rows = [...tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cleanHtml(cell[1])),
    );
    if (rows.length < 2) continue;
    const headers = rows[0].map((header) => header.toLowerCase());
    for (const row of rows.slice(1)) {
      const item: Record<string, string> = {};
      for (const field of fields) {
        const index = headers.findIndex((header) => fieldKeys(field).some((key) => header.includes(key)));
        if (index >= 0 && row[index]) item[field] = row[index].slice(0, 500);
      }
      if (Object.keys(item).length > 0) tables.push(item);
    }
  }
  return tables;
}

// 提取产品卡片、列表项或语义化 article 中的字段。
function extractBlockItems(html: string, fields: string[]): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [];
  const blockPattern = /<(article|li|div|section)[^>]*(?:class|id|itemtype)=["'][^"']*(?:product|item|card|listing|offer)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(blockPattern)) {
    const item: Record<string, string> = {};
    for (const field of fields) {
      const value = extractField(match[0], field);
      if (value) item[field] = value;
    }
    if (Object.keys(item).length > 0) items.push(item);
  }
  return items;
}

// 从网页 HTML 中提取请求字段并生成结构化结果。
export function extractStructuredItems(html: string, fields: string[]): Array<Record<string, string>> {
  const tableItems = extractTableItems(html, fields);
  if (tableItems.length > 0) return tableItems;
  const blockItems = extractBlockItems(html, fields);
  if (blockItems.length > 0) return blockItems;

  const fallback: Record<string, string> = {};
  for (const field of fields) {
    const value = extractField(html, field);
    if (value) fallback[field] = value;
  }
  return Object.keys(fallback).length > 0 ? [fallback] : [];
}

// 在每次重定向前执行 SSRF 安全检查并读取网页正文。
async function fetchSafeHtml(url: string): Promise<string> {
  const initialCheck = await validateNetworkUrl(url);
  if (!initialCheck.safe) throw new Error(`URL 安全拒绝：${initialCheck.reason}`);

  let currentUrl = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const targetCheck = await validateNetworkUrl(currentUrl);
    if (!targetCheck.safe) throw new Error(`重定向目标 URL 安全拒绝：${targetCheck.reason}`);
    const response = await fetch(currentUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AI-Agent/1.0)", Accept: "text/html,text/plain,application/json,*/*" },
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("重定向响应缺少 Location");
      if (redirects === 3) throw new Error("重定向次数超过 3 次");
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
    if (contentType && !contentType.startsWith("text/") && !["application/json", "application/xhtml+xml"].includes(contentType)) {
      throw new Error(`不支持的内容类型：${contentType}`);
    }
    return (await response.text()).slice(0, MAX_RESPONSE_CHARS);
  }
  throw new Error("重定向次数超过 3 次");
}

export const webExtractTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "web_extract",
  description: "从网页列表或表格中提取结构化字段，例如产品名称、价格和评分。",
  schema: webExtractInputSchema,
  func: async ({ url, fields }) => {
    if (!isSafeUrl(url).safe) {
      return JSON.stringify({ items: [], error: "URL 安全拒绝" });
    }
    try {
      const html = await fetchSafeHtml(url);
      return JSON.stringify({ items: extractStructuredItems(html, fields) });
    } catch (error) {
      return JSON.stringify({
        items: [],
        error: `网页结构化提取失败：${error instanceof Error ? error.message : "未知错误"}`,
      });
    }
  },
});

