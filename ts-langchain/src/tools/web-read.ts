/**
 * web.read — 安全读取指定 URL 的网页内容
 *
 * 安全特性:
 * - SSRF 防护: 仅允许 http/https，拒绝私有 IP、内网地址、本地回环
 * - 响应大小限制: 最大 200KB
 * - 内容类型检查: 仅允许 text/* 等文本类型
 * - 重定向复检: 跟随重定向后再次检查目标 URL
 * - 超时控制: 默认 10 秒
 */

import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";

// ============ SSRF 防护 ============

const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1",
  "169.254.169.254", // AWS metadata
  "metadata.google.internal", // GCP metadata
]);

function isSafeUrl(url: string): { safe: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { safe: false, reason: `不支持的协议: ${parsed.protocol}` };
    }

    const hostname = parsed.hostname;
    if (!hostname) return { safe: false, reason: "URL 缺少主机名" };

    if (BLOCKED_HOSTS.has(hostname.toLowerCase())) {
      return { safe: false, reason: `目标主机在黑名单中: ${hostname}` };
    }

    // 检查是否为私有 IP
    const parts = hostname.split(".").map(Number);
    if (parts.length === 4 && parts.every((p) => !Number.isNaN(p))) {
      const [a, b] = parts;
      // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8
      if (
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a === 127
      ) {
        return { safe: false, reason: `目标 IP 是内网/私有地址: ${hostname}` };
      }
    }

    return { safe: true };
  } catch {
    return { safe: false, reason: "URL 格式无效" };
  }
}

// ============ 正文清洗 ============

function cleanHtml(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

// ============ 内容类型判断 ============

const TEXT_CONTENT_TYPES = new Set([
  "text/html",
  "text/plain",
  "text/xml",
  "application/xml",
  "application/json",
  "application/xhtml+xml",
]);

function isTextContent(contentType: string): boolean {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  return TEXT_CONTENT_TYPES.has(ct) || ct.startsWith("text/");
}

// ============ Tool Descriptor ============

export const webReadDescriptor: ToolDescriptor = {
  name: "web.read",
  version: "1.0.0",
  title: "网页读取",
  description:
    "读取指定 URL 的网页正文内容。自动去除 HTML 标签、脚本和样式，提取可读文本。用于在 web_search 之后获取网页详细信息。",
  category: "READ",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 10000,
  required_permissions: ["web.read"],
  data_classification: ["internal"],
  owner: "tools",
  tags: ["web", "read", "http"],
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "要读取的网页 URL，必须是完整的 URL（https:// 或 http://）",
      },
    },
    required: ["url"],
  },
};

// ============ LangChain Tool ============

export const webReadTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "web.read",
  description:
    "读取指定 URL 的网页正文内容。自动去除 HTML 标签、脚本和样式，提取可读文本。通常在 web_search 之后使用来获取详细信息。",
  schema: z.object({
    url: z.string().url().describe("要读取的网页 URL，必须是完整的 URL（https:// 或 http://）"),
  }),
  func: async ({ url }) => {
    // 1. URL 安全检查
    const { safe, reason } = isSafeUrl(url);
    if (!safe) {
      return `URL 安全拒绝：${reason}`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AI-Agent/1.0)",
          Accept: "text/html,application/xhtml+xml,application/xml,text/plain,*/*",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        return `无法获取网页：HTTP ${res.status} ${res.statusText}`;
      }

      // 2. 重定向复检
      if (res.redirected) {
        const finalUrl = res.url;
        const check = isSafeUrl(finalUrl);
        if (!check.safe) {
          return `重定向目标 URL 安全拒绝：${check.reason}`;
        }
      }

      // 3. 内容类型检查
      const contentType = res.headers.get("content-type") || "";
      if (!isTextContent(contentType)) {
        return `不支持的内容类型：${contentType.split(";")[0]}（仅支持文本类内容）`;
      }

      // 4. 大小限制（200KB）
      const html = await res.text();
      const maxBytes = 200 * 1024;
      if (new TextEncoder().encode(html).length > maxBytes) {
        // 截断
        const truncated = html.slice(0, maxBytes / 2);
        const text = cleanHtml(truncated) + "\n\n[内容过长，已截断]";
        return `📄 网页内容（${url}）\n大小：${text.length} 字符\n${"─".repeat(40)}\n\n${text}`;
      }

      // 5. 正文提取
      const text = cleanHtml(html);

      if (text.length < 30) {
        return `网页内容过少或无法解析（${text.length} 字符）：${text.slice(0, 200)}`;
      }

      const title = extractTitle(html);
      const header = `📄 网页内容（${url}）\n${title ? `标题：${title}\n` : ""}大小：${text.length} 字符\n${"─".repeat(40)}\n\n`;

      return header + text;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        return `获取网页超时（10秒）：${url}`;
      }
      return `获取网页出错：${error instanceof Error ? error.message : "未知错误"}`;
    }
  },
});

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match) {
    const title = match[1].replace(/<[^>]+>/g, "").trim().slice(0, 200);
    return title || undefined;
  }
  return undefined;
}
