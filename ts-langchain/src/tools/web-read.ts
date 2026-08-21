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

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { ToolDescriptor } from "./contracts.js";

// ============ SSRF 防护 ============

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "169.254.169.254", // AWS metadata
  "metadata.google.internal", // GCP metadata
]);

// 检查 URL 是否安全，防止 SSRF 攻击
export function isSafeUrl(url: string): { safe: boolean; reason?: string } {
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

    if (parsed.username || parsed.password) {
      return { safe: false, reason: "URL 不允许包含用户名或密码" };
    }

    // 检查是否为私有 IP
    const parts = hostname.split(".").map(Number);
    if (parts.length === 4 && parts.every((p) => !Number.isNaN(p))) {
      const [a, b] = parts;
      // Private, loopback, link-local, carrier-grade NAT, multicast/reserved.
      if (
        a === 0 ||
        a === 10 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a === 127 ||
        (a === 169 && b === 254) ||
        a >= 224
      ) {
        return { safe: false, reason: `目标 IP 是内网/私有地址: ${hostname}` };
      }
    }

    return { safe: true };
  } catch {
    return { safe: false, reason: "URL 格式无效" };
  }
}

// 检查 IP 地址是否为内网/保留地址
function isBlockedIp(address: string): boolean {
  if (isIP(address) === 4) {
    return !isSafeUrl(`http://${address}`).safe;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    );
  }
  return true;
}

// 对 URL 进行 DNS 解析并验证所有解析结果的安全性
export async function validateNetworkUrl(
  url: string,
): Promise<{ safe: boolean; reason?: string }> {
  const syntaxCheck = isSafeUrl(url);
  if (!syntaxCheck.safe) return syntaxCheck;

  const parsed = new URL(url);
  if (isIP(parsed.hostname)) return syntaxCheck;

  try {
    const addresses = await lookup(parsed.hostname, { all: true });
    const blocked = addresses.find(({ address }) => isBlockedIp(address));
    if (blocked) {
      return {
        safe: false,
        reason: `目标域名解析到内网/保留地址: ${blocked.address}`,
      };
    }
  } catch {
    return { safe: false, reason: `无法解析目标主机: ${parsed.hostname}` };
  }
  return { safe: true };
}

// 流式读取响应体，限制最大字节数并返回截断标记
async function readTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      chunks.push(Buffer.from(value.subarray(0, remaining)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(Buffer.from(value));
    total += value.byteLength;
    if (total >= maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }

  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

// ============ 正文清洗 ============

// 执行 cleanHtml 对应的业务逻辑
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

  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

// 校验并判断 isTextContent 对应的状态
function isTextContent(contentType: string): boolean {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  return TEXT_CONTENT_TYPES.has(ct) || ct.startsWith("text/");
}

// ============ Tool Descriptor ============

export const webReadInputSchema = z.object({
  url: z
    .string()
    .url()
    .describe("要读取的网页 URL，必须是完整的 URL（https:// 或 http://）"),
});

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
  input_schema: webReadInputSchema,
};

// ============ LangChain Tool ============

export const webReadTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "web_read",
  description:
    "读取指定 URL 的网页正文内容。自动去除 HTML 标签、脚本和样式，提取可读文本。通常在 web_search 之后使用来获取详细信息。",
  schema: webReadInputSchema,
  func: async ({ url }) => {
    // 1. URL 和 DNS 安全检查
    const { safe, reason } = await validateNetworkUrl(url);
    if (!safe) {
      return `URL 安全拒绝：${reason}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      let currentUrl = url;
      let res: Response | undefined;
      for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
        const targetCheck = await validateNetworkUrl(currentUrl);
        if (!targetCheck.safe) {
          return `重定向目标 URL 安全拒绝：${targetCheck.reason}`;
        }

        res = await fetch(currentUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; AI-Agent/1.0)",
            Accept:
              "text/html,application/xhtml+xml,application/xml,text/plain,*/*",
          },
          signal: controller.signal,
          redirect: "manual",
        });

        if (![301, 302, 303, 307, 308].includes(res.status)) break;
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) return "无法获取网页：重定向响应缺少 Location";
        if (redirectCount === 3) return "无法获取网页：重定向次数超过 3 次";
        currentUrl = new URL(location, currentUrl).toString();
        res = undefined;
      }

      if (!res) return "无法获取网页：无有效响应";

      if (!res.ok) {
        return `无法获取网页：HTTP ${res.status} ${res.statusText}`;
      }

      // 2. 内容类型检查
      const contentType = res.headers.get("content-type") || "";
      if (!isTextContent(contentType)) {
        return `不支持的内容类型：${contentType.split(";")[0]}（仅支持文本类内容）`;
      }

      // 3. 流式读取并限制响应体（200KB）
      const maxBytes = 200 * 1024;
      const body = await readTextWithLimit(res, maxBytes);
      const html = body.text;
      if (body.truncated) {
        const text = cleanHtml(html) + "\n\n[内容过长，已截断]";
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
    } finally {
      clearTimeout(timeoutId);
    }
  },
});

// 从 HTML 中提取 <title> 标签的文本内容
function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match) {
    const title = match[1]
      .replace(/<[^>]+>/g, "")
      .trim()
      .slice(0, 200);
    return title || undefined;
  }
  return undefined;
}
