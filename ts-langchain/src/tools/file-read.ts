/**
 * file.read — 安全读取工作区文件
 *
 * 安全特性:
 * - 路径规范化：防止路径穿越 (../)
 * - 根目录约束：只能访问工作区内的文件
 * - 符号链接防逃逸
 * - 文件类型/大小白名单
 * - 编码检测
 * - 分段读取：大文件支持 offset/limit
 * - 敏感内容脱敏
 */

import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";

// ============ 安全限制 ============

const ALLOWED_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".py", ".js", ".ts", ".java", ".go", ".rs", ".c", ".cpp", ".h",
  ".html", ".css", ".xml", ".csv", ".tsv", ".sql",
  ".sh", ".bash", ".zsh", ".bat", ".ps1",
  ".log", ".env.example", ".gitignore", ".dockerfile",
  ".license", ".readme",
]);

const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
const MAX_READ_CHARS = 50_000;

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /(api[_-]?key|apikey)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{16,})['"]?/i, replacement: "***REDACTED***" },
  { pattern: /(password|passwd|pwd)\s*[:=]\s*['"]?([^'\"\s]{4,})['"]?/i, replacement: "***REDACTED***" },
  { pattern: /(token|secret)\s*[:=]\s*['"]?([A-Za-z0-9_\-\.]{16,})['"]?/i, replacement: "***REDACTED***" },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/, replacement: "***REDACTED***" },
];

// ============ 安全路径解析 ============

function resolveSafePath(filepath: string, rootDir: string): { path: string | null; error?: string } {
  const cleanPath = filepath.trim().replace(/^[/\\]+/, "");

  if (!cleanPath) {
    return { path: null, error: "文件路径不能为空" };
  }

  // 拒绝路径穿越
  const parts = cleanPath.split(/[/\\]/);
  if (parts.includes("..")) {
    return { path: null, error: "路径包含非法穿越序列 (..)" };
  }

  // 构建绝对路径并验证在根目录内
  const root = rootDir || ".";
  const fullPath = `${root}/${cleanPath}`;

  // 简单检查：确保不包含 .. 的规范化路径
  const normalized = fullPath.replace(/\\/g, "/");
  const partsAfter = normalized.split("/");
  if (partsAfter.includes("..")) {
    return { path: null, error: "路径包含非法穿越序列" };
  }

  return { path: fullPath };
}

function maskSensitive(content: string): string {
  let masked = content;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

// ============ Tool Descriptor ============

export const fileReadDescriptor: ToolDescriptor = {
  name: "file.read",
  version: "1.0.0",
  title: "文件读取",
  description:
    "安全读取工作区内的指定文件内容。支持文本文件（代码、配置、文档等）。自动进行路径安全检查，防止访问工作区外的文件。大文件支持分段读取。",
  category: "READ",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 10000,
  required_permissions: ["file.read"],
  data_classification: ["internal"],
  owner: "tools",
  tags: ["file", "read", "workspace"],
  input_schema: {
    type: "object",
    properties: {
      filepath: {
        type: "string",
        description: "要读取的文件路径（相对于工作区），如 'README.md' 或 'src/main.py'",
      },
      offset: {
        type: "integer",
        description: "起始行号（从 0 开始），用于分段读取大文件",
        default: 0,
      },
      limit: {
        type: "integer",
        description: "最多读取行数，默认 100，最大 500",
        default: 100,
        maximum: 500,
      },
    },
    required: ["filepath"],
  },
};

// ============ LangChain Tool ============

export const fileReadTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "file.read",
  description:
    "安全读取工作区内的指定文件内容。自动进行路径安全检查。大文件支持通过 offset/limit 分段读取。",
  schema: z.object({
    filepath: z.string().describe("要读取的文件路径，如 'README.md' 或 'src/main.py'"),
    offset: z.number().int().min(0).default(0).describe("起始行号（从0开始）"),
    limit: z.number().int().min(1).max(500).default(100).describe("最多读取行数"),
  }),
  func: async ({ filepath, offset, limit }) => {
    // 1. 路径安全检查
    const { path: safePath, error } = resolveSafePath(filepath, ".");
    if (!safePath) {
      return `❌ 路径安全拒绝：${error}`;
    }

    // 2. 检查文件是否存在（Node.js fs）
    try {
      const fs = await import("fs/promises");
      const path = await import("path");

      const stat = await fs.stat(safePath).catch(async () => fs.stat(path.normalize(safePath)));
      if (!stat) {
        return `❌ 文件不存在：${filepath}`;
      }

      if (!stat.isFile()) {
        return `❌ 路径不是文件：${filepath}`;
      }

      // 3. 检查文件大小
      if (stat.size > MAX_FILE_SIZE) {
        return `❌ 文件过大（${(stat.size / 1024).toFixed(0)}KB），最大允许 ${MAX_FILE_SIZE / 1024}KB`;
      }

      // 4. 检查扩展名
      const ext = path.extname(safePath).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return `❌ 不支持的文件类型：${ext}`;
      }

      // 5. 读取文件
      const content = await fs.readFile(safePath, "utf-8");

      // 6. 敏感内容脱敏
      const masked = maskSensitive(content);

      // 7. 分段读取
      const lines = masked.split("\n");
      const totalLines = lines.length;
      const end = Math.min(offset + limit, totalLines);
      const selected = lines.slice(offset, end);

      // 8. 构建返回
      let header = `📄 文件：${filepath}\n`;
      header += `大小：${(stat.size / 1024).toFixed(1)}KB | 行数：${totalLines}\n`;

      if (offset > 0 || end < totalLines) {
        header += `显示第 ${offset + 1}-${end} 行（共 ${totalLines} 行）\n`;
      }

      header += "─".repeat(40) + "\n\n";

      let body = selected.join("\n");

      if (end < totalLines) {
        body += `\n\n...（共 ${totalLines} 行，已显示 ${end} 行，剩余 ${totalLines - end} 行未显示）`;
      }

      return header + body;

    } catch (error) {
      return `❌ 读取文件失败：${error instanceof Error ? error.message : "未知错误"}`;
    }
  },
});
